#!/usr/bin/env node
// check-production-cutover-readiness.test.mjs — task f2c23e26
// sentinel tests for the production cutover's pre-dispatch readiness gate.
//
// The checker (tests/cloud/scripts/check-production-cutover-readiness.mjs)
// decides whether the production data cutover may be dispatched: the
// `production` GitHub Environment must refuse an unapproved dispatch, and
// every cutover DSN secret must be registered on it.
//
// A gate that cannot go red asserts nothing, so every case below is a
// SENTINEL: the passing artifact with exactly ONE fact changed, and the
// assertion that the checker notices.
//
//   1. The unmodified artifact passes.
//   2. A missing required DSN secret fails and names the secret.
//   3. A missing recovery-only DSN secret fails and names the secret.
//   4. An Environment with no required reviewer fails.
//   5. An Environment whose admins may bypass the gate fails.
//   6. An unreadable GitHub provider fails.
//   7. An unreadable approval gate fails.
//   8. The checker's secret list matches the workflow's secret reads.
//   9. The CLI exits 0 on a ready artifact and 1 on an unready one.
//
// Run with: node --test tests/cloud/tests/check-production-cutover-readiness.test.mjs

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CUTOVER_DSN_SECRET_NAMES,
  evaluateCutoverReadiness,
} from '../scripts/check-production-cutover-readiness.mjs';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-production-cutover-readiness.mjs');
const FIXTURE = join(REPO_ROOT, 'tests/cloud/fixtures/production-cutover-readiness.example.json');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/cloud-production-db-cutover.yml');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

/** A deep-enough copy that a case can change one fact and nothing else. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function gateFor(rows, gate) {
  const found = rows.find((entry) => entry.gate === gate);
  assert.ok(found, `expected a row for gate ${gate}`);
  return found;
}

test('the unmodified artifact passes every gate', () => {
  const { ok, rows } = evaluateCutoverReadiness(loadFixture());
  assert.equal(ok, true);
  assert.deepEqual(
    rows.map((entry) => entry.status),
    ['met', 'met', 'met'],
  );
});

test('a missing required DSN secret fails and names the secret', () => {
  const state = loadFixture();
  state.providers.github.secretNames = state.providers.github.secretNames.filter(
    (name) => name !== 'TASKS_API_DEST_DSN',
  );

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.cutover-dsn-secrets');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /TASKS_API_DEST_DSN/);
});

test('every missing secret is named, not only the required ones', () => {
  // The reason is what the operator acts on. A message that named only the
  // always-required secrets would send them to fix four, hit the workflow's
  // secret check again on the recovery secrets, and discover the rest by
  // failing at dispatch — which is exactly what this gate exists to
  // prevent.
  const state = loadFixture();
  state.providers.github.secretNames = state.providers.github.secretNames.filter(
    (name) => !CUTOVER_DSN_SECRET_NAMES.includes(name),
  );

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.cutover-dsn-secrets');
  assert.equal(gate.status, 'unmet');
  for (const name of CUTOVER_DSN_SECRET_NAMES) {
    assert.ok(gate.reason.includes(name), `the reason must name ${name}`);
  }
  assert.match(gate.reason, /missing 6 cutover secret/);
});

test('a missing recovery-only DSN secret fails and names the secret', () => {
  const state = loadFixture();
  state.providers.github.secretNames = state.providers.github.secretNames.filter(
    (name) => name !== 'RECOVERY_TASKS_API_DSN',
  );

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.cutover-dsn-secrets');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /RECOVERY_TASKS_API_DSN/);
  assert.match(gate.reason, /recovery/i);
});

test('an Environment with no required reviewer fails', () => {
  const state = loadFixture();
  state.providers.github.approvalGate = {
    captured: true,
    protectionRuleTypes: [],
    requiredReviewerCount: 0,
    waitTimerMinutes: null,
    canAdminsBypass: false,
  };

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.production-approval-gate');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /NO required reviewer/i);
});

test('an Environment whose admins may bypass the gate fails', () => {
  const state = loadFixture();
  state.providers.github.approvalGate.canAdminsBypass = true;

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.production-approval-gate');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /bypass/i);
});

test('an unreadable GitHub provider fails rather than passing vacuously', () => {
  const state = loadFixture();
  state.providers.github = { captured: false, error: 'HTTP 403' };

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.production-environment-captured');
  assert.equal(gate.status, 'unmet');
  assert.equal(rows.length, 1, 'no other gate may be decided from an unreadable provider');
});

test('an unreadable approval gate fails', () => {
  const state = loadFixture();
  state.providers.github.approvalGate = { captured: false, error: 'HTTP 403' };

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'github.production-approval-gate');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /could not be read/i);
});

test("the checker's secret list matches the workflow's secret reads", () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const read = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]));

  assert.deepEqual(
    [...read].sort(),
    [...CUTOVER_DSN_SECRET_NAMES].sort(),
    'the checker and the cutover workflow must agree on the DSN secret names',
  );
});

test('the CLI exits 0 on a ready artifact and 1 on an unready one', async () => {
  const ready = join(tmpdir(), `cutover-ready-${process.pid}.json`);
  const unready = join(tmpdir(), `cutover-unready-${process.pid}.json`);
  try {
    writeFileSync(ready, `${JSON.stringify(loadFixture())}\n`);

    const state = clone(loadFixture());
    state.providers.github.approvalGate.requiredReviewerCount = 0;
    writeFileSync(unready, `${JSON.stringify(state)}\n`);

    await exec('node', [SCRIPT, ready]);
    await assert.rejects(
      () => exec('node', [SCRIPT, unready]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /FAILED/);
        assert.match(error.stderr, /github\.production-approval-gate/);
        return true;
      },
    );
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(ready, { force: true });
    rmSync(unready, { force: true });
  }
});
