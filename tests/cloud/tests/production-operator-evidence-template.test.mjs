#!/usr/bin/env node
// production-operator-evidence-template.test.mjs — task fb1240c0 (Slice D)
// contract tests for the operator read-back template.
//
// Five Slice D obligations can only be closed by a person, and the
// repository owns the RECORD for them: the `operatorEvidence` section the
// capture merges and the checker compares. The operator used to have to
// guess the production surface strings a correct record must name, and
// every guess cost a re-capture of five provider APIs because the answer
// arrived as "it does not name X" only after the record was merged.
//
// The template (infra/cloud/scripts/print-operator-evidence-template.mjs)
// exists so the record can be filled in against the repository's own
// facts. These cases are SENTINELS: each one proves the template can go
// wrong, or that it cannot be mistaken for an attestation.
//
//   1. The printed template validates against the operator evidence
//      contract.
//   2. Every slot's surfaces are exactly the surfaces the checker
//      compares against, so the template and the gate cannot drift.
//   3. The template is NOT a record: merged into the artifact it closes
//      nothing, so a blank form can never be read as a read-back.
//   4. A record filled in from the template closes the five operator
//      obligations through the checker — the operator path works end to
//      end from the repository alone.
//   5. A record that names only some of the surfaces stays open.
//   6. The template refuses to print when the repository names no surface
//      for a slot.
//   7. A recorded slot without an inspectable pointer is refused.
//   8. A read-back stamped after the artifact capture is refused.
//
// Run with: node --test tests/cloud/tests/production-operator-evidence-template.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  OPERATOR_EVIDENCE_SLOTS,
  operatorEvidenceTemplate,
  validateOperatorEvidence,
} from '../../../infra/cloud/platform/production-operator-evidence.mjs';
import { loadOperatorTargetExpectations } from '../../../infra/cloud/platform/production-operator-targets.mjs';
import { loadOperatorEvidence } from '../../../infra/cloud/scripts/capture-production-provisioning-state.mjs';
import {
  slotsWithoutSurfaces,
} from '../../../infra/cloud/scripts/print-operator-evidence-template.mjs';
import {
  evaluateProvisioningState,
  loadProductionExpectations,
} from '../scripts/check-production-provisioning-state.mjs';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'infra/cloud/scripts/print-operator-evidence-template.mjs');
const FIXTURE = join(REPO_ROOT, 'tests/cloud/fixtures/production-provisioning-state.example.json');

const EXPECTATIONS = await loadProductionExpectations(REPO_ROOT);
const EXPECTED_TARGETS = await loadOperatorTargetExpectations(REPO_ROOT);

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

/**
 * A record the operator would produce from the template: every slot
 * recorded, with a read-back time and a pointer to the read-back.
 *
 * @returns {object}
 */
function filledInRecord() {
  const record = operatorEvidenceTemplate(EXPECTED_TARGETS);
  for (const entry of Object.values(record)) {
    entry.recorded = true;
    entry.readBackAt = '2026-11-15T23:00:00Z';
    entry.scope = 'production';
    entry.evidenceRef = 'operator-evidence/read-back.txt';
  }
  return record;
}

test('the printed template validates against the operator evidence contract', async () => {
  const { stdout } = await exec(process.execPath, [SCRIPT, '--repo-root', REPO_ROOT]);
  const template = JSON.parse(stdout);

  const validation = validateOperatorEvidence(template);
  assert.equal(validation.ok, true, `the template is valid: ${validation.problems.join('; ')}`);
  assert.equal(validation.present, true, 'the template carries the operator evidence section');

  for (const entry of OPERATOR_EVIDENCE_SLOTS) {
    assert.ok(entry.slot in template, `the template carries the "${entry.slot}" slot`);
    assert.equal(template[entry.slot].recorded, false, 'a template records nothing yet');
  }
});

test('every slot names exactly the surfaces the checker compares against', () => {
  const template = operatorEvidenceTemplate(EXPECTED_TARGETS);

  for (const entry of OPERATOR_EVIDENCE_SLOTS) {
    const expected = EXPECTATIONS.expectedOperatorTargets[entry.coverage];
    assert.ok(Array.isArray(expected), `the checker expects surfaces for "${entry.coverage}"`);
    assert.ok(expected.length > 0, `"${entry.coverage}" names at least one production surface`);
    assert.deepEqual(
      template[entry.slot].targets,
      expected,
      `the template and the gate agree on the surfaces "${entry.slot}" must cover`,
    );
    assert.deepEqual(
      template[entry.slot].targets,
      EXPECTED_TARGETS[entry.coverage],
      'the derivation and the gate read the same surfaces',
    );
  }
});

test('the template is not a record: merged into the artifact it closes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-template-'));
  const path = join(dir, 'operator-evidence.json');
  try {
    const { stdout } = await exec(process.execPath, [SCRIPT, '--repo-root', REPO_ROOT]);
    writeFileSync(path, stdout);

    // The capture merges a well-formed section — an unrecorded slot is a
    // statement ("not read back yet"), not a defect.
    const { evidence, problems } = loadOperatorEvidence(path);
    assert.deepEqual(problems, [], 'the template is a well-formed operator evidence section');
    assert.ok(evidence, 'the template is merged into the artifact');

    // ... but it closes nothing.
    const state = loadFixture();
    state.operatorEvidence = evidence;
    const { ok, rows, failures } = evaluateProvisioningState(state, EXPECTATIONS);
    assert.equal(ok, false, 'a blank record does not close the delivery');

    const operatorRequired = rows.filter((row) => row.status === 'operator-required');
    assert.equal(operatorRequired.length, 5, 'every obligation stays open without a read-back');
    assert.ok(
      failures.map((failure) => failure.gate).includes('fly.spend-limit-before-public-exposure'),
      'the exposure without a spend-limit read-back still fails the ordering gate',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a record filled in from the template closes the five operator obligations', () => {
  const state = loadFixture();
  state.operatorEvidence = filledInRecord();

  const { ok, failures, rows } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.equal(ok, true, `the filled-in record closes every gate: ${failures.map((f) => f.gate).join(', ')}`);

  const operatorRows = rows.filter((row) =>
    [
      'fly.spend-limit-readback',
      'neon.separation-denial-proof',
      'health.production-probe-interval',
      'health.production-api-responses',
      'dns.resolution-and-tls-readback',
    ].includes(row.gate),
  );
  assert.equal(operatorRows.length, 5, 'the five operator-only obligations are reported');
  for (const row of operatorRows) {
    assert.equal(row.status, 'met', `${row.gate} is closed by the recorded read-back`);
  }
});



test('a recorded slot may omit the optional scope', () => {
  const record = filledInRecord();
  delete record.flySpendLimit.scope;

  const validation = validateOperatorEvidence(record, {
    capturedAt: '2026-11-16T10:00:00Z',
  });
  assert.equal(validation.ok, true, `scope is optional: ${validation.problems.join('; ')}`);
});

test('a recorded slot without an inspectable pointer is refused', () => {
  const record = filledInRecord();
  delete record.flySpendLimit.evidenceRef;

  const validation = validateOperatorEvidence(record, {
    capturedAt: '2026-11-16T10:00:00Z',
  });
  assert.equal(validation.ok, false, 'a record with no pointer is not an attestation');
  assert.match(validation.problems.join(' '), /evidenceRef/);
});

test('a recorded slot with a placeholder pointer is refused', () => {
  const record = filledInRecord();
  record.flySpendLimit.evidenceRef = null;

  const validation = validateOperatorEvidence(record, {
    capturedAt: '2026-11-16T10:00:00Z',
  });
  assert.equal(validation.ok, false, 'a null pointer is not an attestation');
  assert.match(validation.problems.join(' '), /evidenceRef/);
});

test('a recorded slot with a non-string pointer is refused', () => {
  const record = filledInRecord();
  record.flySpendLimit.evidenceRef = 123;

  const validation = validateOperatorEvidence(record, {
    capturedAt: '2026-11-16T10:00:00Z',
  });
  assert.equal(validation.ok, false, 'a non-string pointer is not an attestation');
  assert.match(validation.problems.join(' '), /evidenceRef/);
});

test('a read-back stamped after the artifact capture is refused', () => {
  const record = filledInRecord();
  record.flySpendLimit.readBackAt = '2026-11-16T10:00:01Z';

  const validation = validateOperatorEvidence(record, {
    capturedAt: '2026-11-16T10:00:00Z',
  });
  assert.equal(validation.ok, false, 'a future read-back cannot be carried by this artifact');
  assert.match(validation.problems.join(' '), /after the artifact was captured/);
});

test('a record that names only some of the surfaces stays open', () => {
  const state = loadFixture();
  state.operatorEvidence = filledInRecord();
  state.operatorEvidence.flySpendLimit.targets = [];

  const { ok, failures } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.equal(ok, false, 'a record that covers nothing does not close the obligation');
  assert.ok(
    failures.map((failure) => failure.gate).includes('fly.spend-limit-readback'),
    'the uncovered obligation stays open',
  );
});

test('the template refuses to print when the repository names no surface for a slot', () => {
  const empty = slotsWithoutSurfaces({ platformAppScope: ['sindustries-platform-production'] });
  assert.equal(empty.length, 4, 'every slot without an expected surface is named');
  for (const entry of empty) {
    assert.ok(entry.slot.length > 0, 'the refusal names the slot');
    assert.ok(entry.step.length > 0, 'the refusal names the Slice D step');
  }

  const complete = slotsWithoutSurfaces(EXPECTED_TARGETS);
  assert.deepEqual(complete, [], 'the production surfaces cover every slot');
});
