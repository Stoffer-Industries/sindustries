#!/usr/bin/env node
// check-production-provisioning-state.test.mjs — task fb1240c0 (Slice D)
// sentinel tests for the production provisioning state gate.
//
// The checker (tests/cloud/scripts/check-production-provisioning-state.mjs)
// decides whether a captured state artifact proves the production
// provisioning gates. A gate that cannot go red asserts nothing, so every
// case below is a SENTINEL: the passing artifact with exactly ONE fact
// changed, and the assertion that the checker notices.
//
//   1. The unmodified artifact passes, and the operator-only obligations are
//      reported without being counted as failures.
//   2. A Neon provider that could not be read fails.
//   3. A missing Neon provider section fails.
//   4. A production branch that is not ready fails.
//   5. A schema with no service role fails.
//   6. An empty IP allowlist fails.
//   7. A protected-branch allowlist without a protected branch fails.
//   8. A missing production platform app fails.
//   9. A production app with no started Machine fails.
//  10. A missing production Environment source secret fails.
//  11. No production Redis database fails.
//  12. A non-production environment fails.
//  13. An unknown schema version fails.
//  14. A missing capture timestamp fails.
//  15. An artifact carrying a credential URL fails.
//  16. The command line exits 0 on the passing artifact and 1 on a failing
//      one.
//
// Run with: node --test tests/cloud/tests/check-production-provisioning-state.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  evaluateProvisioningState,
  loadProductionExpectations,
} from '../scripts/check-production-provisioning-state.mjs';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-production-provisioning-state.mjs');
const FIXTURE = join(REPO_ROOT, 'tests/cloud/fixtures/production-provisioning-state.example.json');

const EXPECTATIONS = await loadProductionExpectations(REPO_ROOT);

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function mutate(mutator) {
  const state = loadFixture();
  mutator(state);
  return state;
}

function assertFails(state, expectedGate) {
  const { ok, failures } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.equal(ok, false, `expected the checker to fail for gate ${expectedGate}`);
  const failed = failures.map((failure) => failure.gate);
  assert.ok(
    failed.includes(expectedGate),
    `expected gate ${expectedGate} to fail, got: ${failed.join(', ') || 'none'}`,
  );
}

test('the passing artifact passes and reports the operator-only obligations', () => {
  const { ok, failures, rows } = evaluateProvisioningState(loadFixture(), EXPECTATIONS);
  assert.equal(ok, true);
  assert.deepEqual(failures, []);

  const operatorOnly = rows.filter((row) => row.status === 'operator-required');
  assert.equal(operatorOnly.length, 4, 'the four operator-only obligations are reported');
  for (const row of operatorOnly) {
    assert.ok(row.reason.length > 0, `${row.gate} explains why it cannot be machine-verified`);
    assert.ok(row.owner.length > 0, `${row.gate} names an owner`);
  }
});

test('a Neon provider that could not be read fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.neon = { captured: false, error: 'HTTP 401' };
    }),
    'neon.captured',
  );
});

test('a missing Neon provider section fails', () => {
  assertFails(
    mutate((state) => {
      delete state.providers.neon;
    }),
    'neon.captured',
  );
});

test('a production branch that is not ready fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.neon.branch.state = 'starting';
    }),
    'neon.production-branch',
  );
});

test('a schema with no service role fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.neon.roleNames = [
        'neondb_owner',
        'authenticator',
        'anonymous',
        'authenticated',
        'sindustries_budget_api',
        'sindustries_content_scheduler',
      ];
    }),
    'neon.service-roles',
  );
});

test('an empty IP allowlist fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.neon.project.allowedIpCount = 0;
    }),
    'neon.ip-allowlist',
  );
});

test('a protected-branch allowlist without a protected branch fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.neon.project.protectedBranchesOnly = true;
      state.providers.neon.branch.protected = false;
    }),
    'neon.branch-protection',
  );
});

test('a missing production platform app fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.apps = state.providers.fly.apps.filter(
        (app) => app.name !== 'sindustries-platform-production',
      );
    }),
    'fly.production-platform-app',
  );
});

test('a production app with no started Machine fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.apps[0].machineStates = ['destroyed'];
    }),
    'fly.production-platform-app',
  );
});

test('a missing production Environment source secret fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.github.secretNames = state.providers.github.secretNames.filter(
        (name) => name !== 'PRODUCTION_TASKS_API_DATABASE_URL',
      );
    }),
    'github.production-environment-sources',
  );
});

test('no production Redis database fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.upstash.databaseNames = ['sindustries-content-scheduler-staging'];
    }),
    'upstash.production-redis-database',
  );
});

test('a non-production environment fails', () => {
  assertFails(
    mutate((state) => {
      state.environment = 'staging';
    }),
    'artifact.environment',
  );
});

test('an unknown schema version fails', () => {
  assertFails(
    mutate((state) => {
      state.schemaVersion = 99;
    }),
    'artifact.schema-version',
  );
});

test('a missing capture timestamp fails', () => {
  assertFails(
    mutate((state) => {
      delete state.capturedAt;
    }),
    'artifact.captured-at',
  );
});

test('an artifact carrying a credential URL fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.neon.project.notes = 'postgres://role:password@example.neon.tech/db';
    }),
    'artifact.redaction',
  );
});

test('the command line exits 0 on the passing artifact and 1 on a failing one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'provisioning-state-'));
  try {
    const passing = join(directory, 'passing.json');
    writeFileSync(passing, `${JSON.stringify(loadFixture(), null, 2)}\n`);
    const passed = await exec('node', [SCRIPT, passing, REPO_ROOT]);
    assert.equal(passed.code ?? 0, 0);
    assert.match(passed.stdout, /machine-verifiable gate\(s\) are met/);

    const failing = join(directory, 'failing.json');
    const broken = loadFixture();
    broken.providers.neon.project.allowedIpCount = 0;
    writeFileSync(failing, `${JSON.stringify(broken, null, 2)}\n`);
    await assert.rejects(
      exec('node', [SCRIPT, failing, REPO_ROOT]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /neon\.ip-allowlist/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
