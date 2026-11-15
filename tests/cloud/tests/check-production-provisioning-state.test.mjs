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
//  17. A Cloudflare provider that could not be read fails.
//  18. A missing Cloudflare provider section fails.
//  19. A missing production API DNS record fails.
//  20. A production API record pointing at the wrong target fails.
//  21. A proxied (orange cloud) production record fails.
//  22. A missing production health-probe DNS record fails.
//  23. A production record pointing at a staging deployment fails.
//  24. A staging hostname moved off its staging target fails.
//  25. A missing staging DNS record fails.
//  26. An expectation set with no required source secret name fails.
//  27. An expectation set with no expected schema fails.
//  28. An expectation set with no production app name fails.
//  29. The checker restates no production app name of its own.
//  30. A deployed probe cadence that differs from the declared production
//      cadence fails.
//  31. A deployed health-probe app that carries no cadence key fails.
//  32. An unreadable deployed probe environment fails.
//  33. Machines that disagree on the cadence fail.
//  34. An expectation set with no expected cadence fails.
//  35. An app the provider says does not exist fails and says so.
//  36. An app whose state could not be read fails and names the capture,
//      not the operator.
//  37. An app with no deployed release fails.
//  38. A release that could not be read fails and names the capture.
//  39. An app entry with no existence fact fails rather than passing.
//  40. A health-probe app with no existence fact fails rather than passing.
//  41. A reason field does not trip the redaction guard.
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

/**
 * Assert that a gate fails when the EXPECTATIONS are what changed.
 *
 * The gates below compare the captured state against the environment
 * manifest. If the manifest ever stops naming the things it must name,
 * the comparison can silently become vacuous — "all 0 required source
 * secrets are present" is true without checking anything. These cases
 * change the expectation set, not the artifact, and assert that the
 * checker refuses to call an unprovable gate met.
 */
function assertFailsWithExpectations(state, options, expectedGate) {
  const { ok, failures } = evaluateProvisioningState(state, options);
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
  assert.equal(operatorOnly.length, 5, 'the five operator-only obligations are reported');
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

test('an app the provider says does not exist fails and says so', () => {
  // The existence fact is read from the app itself, not inferred from a
  // listing. An app the provider says is absent is reported as absent,
  // with the operator named — not as "exists but has no release".
  const state = mutate((artifact) => {
    artifact.providers.fly.apps[0].exists = false;
    artifact.providers.fly.apps[0].releaseVersion = null;
    artifact.providers.fly.apps[0].machineStates = [];
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const failed = failures.find((failure) => failure.gate === 'fly.production-platform-app');

  assert.ok(failed, 'expected the production platform app gate to fail');
  assert.match(failed.reason, /does not exist/);
  assert.equal(failed.owner, 'Quinn (operator)');
});

test('an app whose state could not be read fails and names the capture, not the operator', () => {
  // An unreadable read is not an absent app. It is a read that never
  // happened, so the owner is the capture, and the reason carries what
  // stopped it.
  const state = mutate((artifact) => {
    artifact.providers.fly.apps[0].exists = null;
    artifact.providers.fly.apps[0].machineInventoryError =
      'the Machine inventory of the Fly app could not be read (HTTP 500)';
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const failed = failures.find((failure) => failure.gate === 'fly.production-platform-app');

  assert.ok(failed, 'expected the production platform app gate to fail');
  assert.match(failed.reason, /could not be read/);
  assert.match(failed.reason, /HTTP 500/);
  assert.equal(failed.owner, 'Rowan');
});

test('an app with no deployed release fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.apps[0].releaseVersion = null;
    }),
    'fly.production-platform-app',
  );
});

test('a release that could not be read fails and names the capture', () => {
  const state = mutate((artifact) => {
    artifact.providers.fly.apps[0].releaseVersion = null;
    artifact.providers.fly.apps[0].releaseError =
      'the release of the Fly app could not be read (HTTP 502)';
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const failed = failures.find((failure) => failure.gate === 'fly.production-platform-app');

  assert.ok(failed, 'expected the production platform app gate to fail');
  assert.match(failed.reason, /could not be read/);
  assert.equal(failed.owner, 'Rowan');
});

test('a reason field does not trip the redaction guard', () => {
  // The redaction guard fires on a FIELD NAME that promises a credential.
  // A reason field must therefore not be named like one: an artifact that
  // says why an inventory could not be read is not carrying a credential,
  // and the guard must not have to be weakened to say so.
  const state = mutate((artifact) => {
    artifact.providers.fly.apps[0].inventoryReadError =
      'the secret inventory could not be read (HTTP 500)';
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const redacted = failures.filter((failure) => failure.gate === 'artifact.redaction');

  assert.deepEqual(redacted, [], 'a reason field must not read as a credential-shaped field');
});

test('an app entry with no existence fact fails rather than passing', () => {
  // An artifact captured before the existence fact existed must not be
  // able to prove an app is deployed. Absent the fact, the gate fails
  // closed.
  assertFails(
    mutate((state) => {
      delete state.providers.fly.apps[0].exists;
    }),
    'fly.production-platform-app',
  );
});

test('a health-probe app with no existence fact fails rather than passing', () => {
  assertFails(
    mutate((state) => {
      delete state.providers.fly.apps[1].exists;
    }),
    'fly.production-health-probe-app',
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

test('a production app missing a required secret fails the secret-inventory gate', () => {
  // The GitHub source gate proves the Environment carries the values; this
  // gate proves they landed on the app. An app that is missing one of them
  // would boot with a missing credential, so the gate must be red.
  assertFails(
    mutate((state) => {
      state.providers.fly.apps[0].secretNames = state.providers.fly.apps[0].secretNames.filter(
        (name) => name !== 'PLATFORM_TASKS_API_DATABASE_URL',
      );
    }),
    'fly.production-platform-app-secrets',
  );
});

test('an unreadable secret inventory fails the secret-inventory gate', () => {
  // An inventory that could not be read is NOT an empty inventory.
  // Reporting "no secrets" here would name the operator for a read that
  // never happened.
  assertFails(
    mutate((state) => {
      state.providers.fly.apps[0].secretNames = null;
      state.providers.fly.apps[0].inventoryReadError =
        'the secret inventory could not be read (HTTP 500)';
    }),
    'fly.production-platform-app-secrets',
  );
});

test('a secret inventory that was never recorded fails the secret-inventory gate', () => {
  // An artifact written before the inventory was captured carries no
  // `secretNames` key at all. That is an unproven inventory, not a proven
  // empty one.
  assertFails(
    mutate((state) => {
      delete state.providers.fly.apps[0].secretNames;
    }),
    'fly.production-platform-app-secrets',
  );
});

test('an expectation set with no expected secret name fails the secret-inventory gate', () => {
  // "All 0 required secret(s) are registered" proves nothing: the
  // comparison is vacuous, and a vacuous comparison must not report met.
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, expectedPlatformSecretNames: [] },
    'fly.production-platform-app-secrets',
  );
});

test('the expected secret names come from the provisioner, not from the checker', async () => {
  // The provisioner owns the names it registers. The checker reads them
  // from there rather than keeping a copy that could agree with a drifted
  // provisioner.
  const provisioner = await import(
    new URL('../../../infra/cloud/platform/platform-provision-secrets.mjs', import.meta.url).href
  );
  assert.deepEqual(
    [...EXPECTATIONS.expectedPlatformSecretNames],
    [...provisioner.PLATFORM_SECRET_NAMES],
  );
  assert.ok(EXPECTATIONS.expectedPlatformSecretNames.length > 0);
});

test('the example artifact carries exactly the canonical secret names', () => {
  // The fixture must not drift from the provisioner either: an example
  // artifact that names a different set would teach the wrong shape.
  const fixture = loadFixture();
  const platformApp = fixture.providers.fly.apps.find(
    (app) => app.name === 'sindustries-platform-production',
  );
  assert.deepEqual(
    [...platformApp.secretNames].sort(),
    [...EXPECTATIONS.expectedPlatformSecretNames].sort(),
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

test('a Cloudflare provider that could not be read fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.cloudflare = { captured: false, error: 'HTTP 403' };
    }),
    'cloudflare.captured',
  );
});

test('a missing Cloudflare provider section fails', () => {
  assertFails(
    mutate((state) => {
      delete state.providers.cloudflare;
    }),
    'cloudflare.captured',
  );
});

test('a missing production API DNS record fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.cloudflare.records = state.providers.cloudflare.records.filter(
        (record) => record.name !== 'tasks-api.sindustries.co.nz',
      );
    }),
    'cloudflare.production-api-dns-records',
  );
});

test('a production API record pointing at the wrong target fails', () => {
  assertFails(
    mutate((state) => {
      const record = state.providers.cloudflare.records.find(
        (entry) => entry.name === 'budget-api.sindustries.co.nz',
      );
      record.content = 'sindustries-budget-api.fly.dev';
    }),
    'cloudflare.production-api-dns-records',
  );
});

test('a proxied production record fails', () => {
  assertFails(
    mutate((state) => {
      const record = state.providers.cloudflare.records.find(
        (entry) => entry.name === 'content-scheduler-api.sindustries.co.nz',
      );
      record.proxied = true;
    }),
    'cloudflare.production-api-dns-records',
  );
});

test('a missing production health-probe DNS record fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.cloudflare.records = state.providers.cloudflare.records.filter(
        (record) => record.name !== 'health-probe.sindustries.co.nz',
      );
    }),
    'cloudflare.production-probe-dns-record',
  );
});

test('a production record pointing at a staging deployment fails', () => {
  assertFails(
    mutate((state) => {
      const record = state.providers.cloudflare.records.find(
        (entry) => entry.name === 'tasks-api.sindustries.co.nz',
      );
      record.content = 'sindustries-platform-staging.fly.dev';
    }),
    'cloudflare.production-dns-separation',
  );
});

test('a staging hostname moved off its staging target fails', () => {
  assertFails(
    mutate((state) => {
      const record = state.providers.cloudflare.records.find(
        (entry) => entry.name === 'tasks-api.staging.sindustries.co.nz',
      );
      record.content = 'sindustries-platform-production.fly.dev';
    }),
    'cloudflare.staging-dns-unchanged',
  );
});

test('a missing staging DNS record fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.cloudflare.records = state.providers.cloudflare.records.filter(
        (record) => record.name !== 'health-probe.staging.sindustries.co.nz',
      );
    }),
    'cloudflare.staging-dns-unchanged',
  );
});

test('an expectation set with no required source secret name fails the source gate', () => {
  // "All 0 required source secrets are present" proves nothing: the
  // comparison is vacuous, and a vacuous comparison must not report met.
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, requiredSourceNames: [] },
    'github.production-environment-sources',
  );
});

test('an expectation set with no expected schema fails the service-role gate', () => {
  // With no expected schema, every observed role set satisfies "one
  // service role per schema ()". That is a vacuous pass, not a met gate.
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, expectedSchemas: [] },
    'neon.service-roles',
  );
});

test('an expectation set with no production app name fails the Fly app gates', () => {
  // The checker must not fall back to a restated copy of the app name: it
  // has to be told what to look for, or the gate cannot be proven.
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, platformApp: null, healthProbeApp: null },
    'fly.production-platform-app',
  );
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, platformApp: null, healthProbeApp: null },
    'fly.production-health-probe-app',
  );
});

test('the checker restates no production app name of its own', async () => {
  // The production app names live in the environment manifest. A checker
  // that carries its own copy can agree with a drifted manifest, so it
  // must fail when it is given no expectations at all.
  const { ok, failures } = evaluateProvisioningState(loadFixture(), {});
  assert.equal(ok, false);
  const failed = failures.map((failure) => failure.gate);
  for (const gate of [
    'fly.production-platform-app',
    'fly.production-health-probe-app',
    'github.production-environment-sources',
    'neon.service-roles',
    'health.production-probe-cadence',
  ]) {
    assert.ok(failed.includes(gate), `expected gate ${gate} to fail without expectations`);
  }
});

// --- AC6: the deployed production probe cadence --------------------------

test('a deployed probe cadence that differs from the declared cadence fails', () => {
  // The staging cadence (86400s) is the value a production probe must not
  // keep: it would pass every check the repository owns while watching
  // nothing. The declared production cadence lives in the production
  // health-probe overlay, so a deployed value that differs from it is a
  // real disagreement, not a style difference.
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeEnv.env.FLY_APP_PROBE_INTERVAL_SECONDS = '86400';
    }),
    'health.production-probe-cadence',
  );
});

test('a deployed health-probe app that carries no cadence key fails', () => {
  assertFails(
    mutate((state) => {
      delete state.providers.fly.healthProbeEnv.env.DB_PROBE_INTERVAL_SECONDS;
    }),
    'health.production-probe-cadence',
  );
});

test('an unreadable deployed probe environment fails', () => {
  // "The environment could not be read" is not "the environment carried no
  // cadence": an unreadable read leaves the AC6 gate open, owned by the
  // operator rather than by the checker.
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeEnv = {
        captured: false,
        error: 'the Fly app sindustries-health-probe-production does not exist',
      };
    }),
    'health.production-probe-cadence',
  );
});

test('machines that disagree on the cadence fail', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeEnv.conflictingKeys = [
        'FLY_APP_PROBE_INTERVAL_SECONDS',
      ];
    }),
    'health.production-probe-cadence',
  );
});

test('an expectation set with no expected cadence fails the cadence gate', () => {
  // The expected cadence is read from the production health-probe overlay
  // — the file Fly deploys — so the checker carries no copy of its own. If
  // it is given no expected cadence, the gate cannot be proven, and that is
  // a missing repository fact rather than an operator failure.
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, expectedProbeCadence: {} },
    'health.production-probe-cadence',
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
