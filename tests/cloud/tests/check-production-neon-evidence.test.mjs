#!/usr/bin/env node
// check-production-neon-evidence.test.mjs — task fb1240c0 (Slice D preparation)
// sentinel tests for the AC2 evidence gate.
//
// The checker (tests/cloud/scripts/check-production-neon-evidence.mjs)
// decides whether a redacted operator artifact proves the production Neon
// treatment. A gate that cannot go red asserts nothing, so every case below
// is a SENTINEL: the passing artifact with exactly ONE fact changed, and the
// assertion that the checker notices.
//
//   1. The unmodified artifact passes.
//   2. A missing schema fails.
//   3. A schema the production manifest does not define fails.
//   4. A schema with no role fails.
//   5. A schema with two roles fails.
//   6. A read-only role fails.
//   7. A role that cannot log in fails.
//   8. An unconfigured IP allowlist fails.
//   9. An empty IP allowlist fails.
//  10. A staging role that could still connect fails.
//  11. A dev role that could still connect fails.
//  12. A non-production branch fails.
//  13. A staging environment fails.
//  14. A missing timestamp fails.
//  15. An artifact carrying a credential URL fails.
//  16. An artifact carrying a populated secret-named field fails.
//  17. An artifact that does not declare its redaction fails.
//
// Run with: node --test tests/cloud/tests/check-production-neon-evidence.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { evaluateNeonEvidence } from '../scripts/check-production-neon-evidence.mjs';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-production-neon-evidence.mjs');
const FIXTURE = join(REPO_ROOT, 'tests/cloud/fixtures/production-neon-evidence.example.json');

const EXPECTED_SCHEMAS = ['tasks_api', 'budget_api', 'content_scheduler'];

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function mutate(mutator) {
  const evidence = loadFixture();
  mutator(evidence);
  return evidence;
}

function assertFails(evidence, expectedCode) {
  const { ok, failures } = evaluateNeonEvidence(evidence, {
    expectedSchemas: EXPECTED_SCHEMAS,
  });
  assert.equal(ok, false, 'expected the evidence to be rejected');
  const codes = failures.map((failure) => failure.code);
  assert.ok(
    codes.includes(expectedCode),
    `expected failure code ${expectedCode}, got ${codes.join(', ') || '<none>'}`,
  );
}

test('the unmodified artifact passes the gate', () => {
  const { ok, failures } = evaluateNeonEvidence(loadFixture(), {
    expectedSchemas: EXPECTED_SCHEMAS,
  });
  assert.deepEqual(failures, []);
  assert.equal(ok, true);
});

test('a missing schema is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.database.schemas = ['tasks_api', 'budget_api'];
    }),
    'schema_missing',
  );
});

test('a schema the production manifest does not define is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.database.schemas.push('staging_extra');
    }),
    'schema_unexpected',
  );
});

test('a schema with no role is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.roles = evidence.roles.filter((role) => role.schema !== 'budget_api');
    }),
    'role_missing_for_schema',
  );
});

test('a schema with two roles is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.roles.push({ ...evidence.roles[0] });
    }),
    'role_ambiguous_for_schema',
  );
});

test('a read-only role is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.roles[0].canWrite = false;
    }),
    'role_not_write_capable',
  );
});

test('a role that cannot log in is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.roles[0].canLogin = false;
    }),
    'role_not_login_capable',
  );
});

test('an unconfigured IP allowlist is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.connectivity.ipAllowlistConfigured = false;
    }),
    'ip_allowlist_not_configured',
  );
});

test('an empty IP allowlist is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.connectivity.ipAllowlistEntryCount = 0;
    }),
    'ip_allowlist_empty',
  );
});

test('a staging role that could still connect is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.connectivity.stagingRoleConnectDenied = false;
    }),
    'staging_role_not_denied',
  );
});

test('a dev role that could still connect is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.connectivity.devRoleConnectDenied = false;
    }),
    'dev_role_not_denied',
  );
});

test('a non-production branch is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.database.branch = 'production-staging';
    }),
    'database_branch_not_production',
  );
});

test('a staging environment is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.environment = 'staging';
    }),
    'environment_not_production',
  );
});

test('a missing timestamp is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.capturedAt = '2026-11-15';
    }),
    'captured_at_not_iso8601',
  );
});

test('an artifact carrying a credential URL is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.database.project = 'postgresql://sindustries_tasks_api:hunter2@ep-x.neon.tech/sindustries';
    }),
    'evidence_contains_secret_values',
  );
});

test('an artifact carrying a populated secret-named field is rejected', () => {
  assertFails(
    mutate((evidence) => {
      evidence.database.password = 'not-a-real-value';
    }),
    'evidence_contains_secret_values',
  );
});

test('an artifact that does not declare its redaction is rejected', () => {
  assertFails(
    mutate((evidence) => {
      delete evidence.redaction;
    }),
    'redaction_not_declared',
  );
});

test('the CLI accepts the example artifact and rejects a tampered one', async () => {
  const ok = await exec('node', [SCRIPT, FIXTURE, REPO_ROOT]);
  assert.match(ok.stdout, /OK/);

  const dir = mkdtempSync(join(tmpdir(), 'neon-evidence-'));
  try {
    const tampered = join(dir, 'tampered.json');
    writeFileSync(
      tampered,
      JSON.stringify(mutate((evidence) => {
        evidence.connectivity.ipAllowlistEntryCount = 0;
      })),
      'utf8',
    );
    await assert.rejects(
      () => exec('node', [SCRIPT, tampered, REPO_ROOT]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /ip_allowlist_empty/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI fails closed when the evidence file is missing', async () => {
  await assert.rejects(
    () => exec('node', [SCRIPT, join(tmpdir(), 'definitely-not-here.json'), REPO_ROOT]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /cannot read/);
      return true;
    },
  );
});
