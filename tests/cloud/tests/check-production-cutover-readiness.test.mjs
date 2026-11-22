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
//   8. A Neon project serving no database fails, and ONE database is enough.
//   9. An unreadable Neon provider fails.
//   10. An incomplete Neon inventory fails rather than counting a lower bound.
//  11. The checker's secret list matches the workflow's secret reads.
//  12. The CLI exits 0 on a ready artifact and 1 on an unready one.
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
    ['met', 'met', 'met', 'met'],
  );
});

test('the cutover workflow is pinned to the Mac mini runner contract', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  assert.match(
    workflow,
    /runs-on:\s*\[self-hosted, macOS, ARM64, self-hosted-production-cutover\]/,
  );
  assert.match(
    workflow,
    /shell: \/opt\/homebrew\/bin\/bash --noprofile --norc -e -o pipefail \{0\}/,
  );
  assert.match(workflow, /echo "\/opt\/homebrew\/bin" >> "\$GITHUB_PATH"/);
  assert.match(workflow, /\/opt\/homebrew\/bin\/pg_dump --version/);
  assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
  assert.doesNotMatch(workflow, /apt-get/);
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

test('a Neon project serving no database fails — the destination must exist', () => {
  // The destination is the EXISTING production Neon database (Tom's
  // 2026-11-19 execution decision): no new permanent production
  // database is created for this cutover. If the production environment
  // serves no database at all, the destination DSNs cannot point at one
  // that exists — a secret can be registered against a database that
  // does not exist, and the workflow's secret check would pass it, so
  // the shortfall has to be caught here or the cutover fails at the
  // RESTORE — after the dump, with the source already quiesced.
  const state = loadFixture();
  state.providers.neon.project.databaseCount = 0;

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'neon.cutover-destination-database');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /0 distinct database\(s\)/);
  assert.match(gate.reason, /EXISTING production database/);
  // The reason names what does NOT count as a database, because the
  // operator's obvious move — scaling out read replicas of the branch
  // that is already there — would add addresses, not databases.
  assert.match(gate.reason, /read replica/i);
});

test('ONE existing production database is enough — the three-database rule is obsolete', () => {
  // The live production project served ONE database on 2026-11-19. Under
  // the old topology that was a shortfall (three distinct databases were
  // demanded). Under the current topology the destination IS that one
  // existing database and the recovery target is temporary, so ONE
  // database is exactly what the cutover needs. This case pins that, so
  // the obsolete three-database rule cannot creep back in.
  const state = loadFixture();
  state.providers.neon.project.databaseCount = 1;

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, true);
  const gate = gateFor(rows, 'neon.cutover-destination-database');
  assert.equal(gate.status, 'met');
  assert.match(gate.reason, /1 distinct database\(s\)/);
  assert.match(gate.reason, /No new permanent production database is created/);
  // The recovery target is temporary and isolated, and its isolation is
  // enforced in code at dispatch — the gate says so rather than implying
  // it proved it.
  assert.match(gate.reason, /recovery target is a temporary isolated database/);
});

test('an unreadable Neon provider fails rather than passing vacuously', () => {
  const state = loadFixture();
  state.providers.neon = { captured: false, error: 'HTTP 403' };

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'neon.cutover-destination-database');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /could not be read/i);
});

test('an incomplete Neon inventory fails rather than counting a lower bound', () => {
  // One branch of the project could not be read. The count that came back
  // is a LOWER BOUND, so it must not read as "the databases exist".
  const state = loadFixture();
  state.providers.neon.project.databaseCount = 3;
  state.providers.neon.project.databaseCountReadError =
    'the databases of branch staging could not be read: HTTP 500';

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'neon.cutover-destination-database');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /LOWER BOUND/);
});

test('an artifact captured under the endpoint-host schema cannot answer the gate', () => {
  // Schema 12 counted Neon ENDPOINT HOSTS. A branch can serve one
  // database behind several read-replica endpoints, so that count can
  // read as three capacity slots when one database exists. An artifact
  // captured under it must not be read as capacity — the gate has to
  // refuse it and ask for a re-capture.
  const state = loadFixture();
  state.schemaVersion = 12;
  state.providers.neon.project.databaseCount = 3;

  const { ok, rows } = evaluateCutoverReadiness(state);
  assert.equal(ok, false);
  const gate = gateFor(rows, 'neon.cutover-destination-database');
  assert.equal(gate.status, 'unmet');
  assert.match(gate.reason, /schema version 12/);
  assert.match(gate.reason, /ENDPOINT HOSTS/);
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
