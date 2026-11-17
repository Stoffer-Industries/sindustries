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
//  42. A deployed probe pointed at a staging Fly app fails.
//  43. A deployed probe pointed at another environment's database fails.
//  44. A deployed probe pointed at the staging Redis fails.
//  45. A deployed probe that carries no target list for a key fails.
//  46. Duplicate target metrics that disagree fail.
//  47. An unreadable deployed probe target capture fails.
//  48. An expectation set with no production host fails the probe target gate.
//  49. A deployed CORS allow-list that names a staging origin fails.
//  50. A deployed CORS allow-list that is missing entirely fails.
//  51. A deployed platform app that runs as another environment fails.
//  52. A deployed platform app that carries no environment id fails.
//  53. Machines that disagree on the deployed environment id fail.
//  54. A deployed platform app that runs another process group fails.
//  55. An artifact with no deployed platform configuration fails rather than
//      passing.
//  56. A deployed origin that is not an https origin fails.
//  57. An expectation set with no expected environment id fails the
//      environment-id gate.
//  58. An expectation set with no expected process group fails the
//      process-group gate.
//  59. An artifact with no operator evidence reports the five obligations
//      as operator-required instead of closing them.
//  60. A published production hostname with no spend-limit read-back fails
//      the ordering gate.
//  61. A running production health probe with no spend-limit read-back
//      fails the ordering gate.
//  62. The ordering gate is not applicable when nothing is exposed.
//  63. A malformed operator evidence section fails.
//  64. A recorded read-back with no read-back time fails.
//  65. An unknown operator evidence slot fails.
//  66. An operator evidence value that carries a credential fails both the
//      shape gate and the redaction guard.
//  67. A recorded read-back closes the obligation it belongs to.
//  68. A recorded read-back that names no production surface stays open.
//  69. A recorded read-back that names only some surfaces stays open.
//  70. A recorded read-back that names a non-production surface stays open.
//  71. The ordering gate refuses a spend-limit read-back for another scope.
//  72. A non-array operator evidence target fails the shape gate.
//  73. A non-surface operator evidence target fails the shape gate.
//  74. A repeated operator evidence target fails the shape gate.
//  75. An operator obligation with no expected surface stays open.
//  76. A recorded read-back without an inspectable pointer fails.
//  77. A read-back stamped after the artifact capture fails.
//  78. The spend-bound ORDER gate passes when the bound was read back
//      before production was publicly exposed.
//  79. A spend bound read back AFTER the public exposure fails the order
//      gate — the order the approved design requires cannot be asserted.
//  80. A recorded acceptance of the ordering deviation closes the order
//      gate.
//  81. An acceptance that does not cover every exposed surface stays open.
//  82. A public exposure with no readable exposure time fails the order
//      gate.
//  83. A live production platform app with no spend-bound read-back
//      fails the before-exposure gate — the consolidated platform app is
//      public exposure on its own .fly.dev hostname.
//  84. The order gate reads the production platform app release as the
//      exposure time, so a bound read back after the app was deployed
//      fails the order gate.
//  85. An acceptance that omits the exposed production platform app
//      stays open.
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

test('the passing artifact passes and every operator obligation is backed by a read-back', () => {
  const { ok, failures, rows } = evaluateProvisioningState(loadFixture(), EXPECTATIONS);
  assert.equal(ok, true);
  assert.deepEqual(failures, []);

  const operatorRows = rows.filter(
    (row) =>
      row.gate === 'fly.spend-limit-readback' ||
      row.gate === 'neon.separation-denial-proof' ||
      row.gate === 'health.production-probe-interval' ||
      row.gate === 'health.production-api-responses' ||
      row.gate === 'dns.resolution-and-tls-readback',
  );
  assert.equal(operatorRows.length, 5, 'the five operator-only obligations are reported');
  for (const row of operatorRows) {
    assert.equal(row.status, 'met', `${row.gate} is closed by the recorded read-back`);
    assert.ok(row.reason.length > 0, `${row.gate} explains why it cannot be machine-verified`);
    assert.ok(row.owner.length > 0, `${row.gate} names an owner`);
  }
});

test('an artifact with no operator evidence reports the five obligations as operator-required', () => {
  const state = mutate((artifact) => {
    delete artifact.operatorEvidence;
  });
  const { rows, failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const operatorRequired = rows.filter((row) => row.status === 'operator-required');
  assert.equal(operatorRequired.length, 5, 'every obligation stays open without a read-back');
  for (const row of operatorRequired) {
    assert.ok(row.reason.includes('operatorEvidence'), `${row.gate} says where to record it`);
  }
  // The example artifact publishes the production hostnames, so the
  // ordering gate must fail closed rather than let the exposure stand.
  assert.ok(
    failures.map((failure) => failure.gate).includes('fly.spend-limit-before-public-exposure'),
    'an exposure without a spend-limit read-back fails the ordering gate',
  );
});

test('a published production hostname with no spend-limit read-back fails the ordering gate', () => {
  assertFails(
    mutate((state) => {
      delete state.operatorEvidence.flySpendLimit;
    }),
    'fly.spend-limit-before-public-exposure',
  );
});

test('a recorded spend read-back that names no control fails the ordering gate', () => {
  const state = mutate((artifact) => {
    delete artifact.operatorEvidence.flySpendLimit.control;
  });
  const { failures, rows } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.ok(
    failures.map((failure) => failure.gate).includes('fly.spend-limit-before-public-exposure'),
    'a read-back that does not say what bounded the spend cannot close the gate',
  );
  const ordering = rows.find((row) => row.gate === 'fly.spend-limit-before-public-exposure');
  assert.ok(ordering, 'the ordering gate is always reported');
  assert.match(ordering.reason, /does not name the control/);
  assert.ok(
    failures.map((failure) => failure.gate).includes('fly.spend-limit-readback'),
    'the obligation itself stays open too',
  );
});

test('a recorded spend read-back that names an unknown control fails the ordering gate', () => {
  const state = mutate((artifact) => {
    artifact.operatorEvidence.flySpendLimit.control = 'hope';
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.ok(
    failures.map((failure) => failure.gate).includes('fly.spend-limit-before-public-exposure'),
    'an unknown control is refused',
  );
});

test('the ordering gate names the control that bounded production spend', () => {
  const { rows } = evaluateProvisioningState(loadFixture(), EXPECTATIONS);
  const ordering = rows.find((row) => row.gate === 'fly.spend-limit-before-public-exposure');
  assert.ok(ordering, 'the ordering gate is always reported');
  assert.equal(ordering.status, 'met');
  assert.match(
    ordering.reason,
    /prepaid-capped-billing-method/,
    'the gate names WHICH control was read back',
  );
});

test('a running production health probe with no spend-limit read-back fails the ordering gate', () => {
  const state = mutate((artifact) => {
    delete artifact.operatorEvidence.flySpendLimit;
    // No DNS exposure at all: the public surfaces left are the running
    // probe and the running production platform app.
    artifact.providers.cloudflare.records = artifact.providers.cloudflare.records.filter(
      (record) => !record.name.endsWith('.sindustries.co.nz'),
    );
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.ok(
    failures.map((failure) => failure.gate).includes('fly.spend-limit-before-public-exposure'),
    'the running probe is public exposure on its own',
  );
});

test('the ordering gate is not applicable when nothing is exposed', () => {
  const state = mutate((artifact) => {
    delete artifact.operatorEvidence.flySpendLimit;
    artifact.providers.cloudflare.records = artifact.providers.cloudflare.records.filter(
      (record) => !record.name.endsWith('.sindustries.co.nz'),
    );
    const probe = artifact.providers.fly.apps.find(
      (app) => app.name === 'sindustries-health-probe-production',
    );
    if (probe) probe.machineStates = ['stopped'];
    // The consolidated production platform app is exposure too — it
    // answers on its own .fly.dev hostname — so "nothing is exposed"
    // means no running production app at all.
    const platform = artifact.providers.fly.apps.find(
      (app) => app.name === EXPECTATIONS.platformApp,
    );
    if (platform) platform.machineStates = ['stopped'];
  });
  const { rows, failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const ordering = rows.find((row) => row.gate === 'fly.spend-limit-before-public-exposure');
  assert.ok(ordering, 'the ordering gate is always reported');
  assert.equal(ordering.status, 'not-applicable');
  assert.ok(
    !failures.map((failure) => failure.gate).includes('fly.spend-limit-before-public-exposure'),
    'nothing is exposed, so the limit cannot have been skipped yet',
  );
});

test('a malformed operator evidence section fails', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.recorded = 'yes';
    }),
    'artifact.operator-evidence',
  );
});

test('a recorded read-back with no read-back time fails', () => {
  assertFails(
    mutate((state) => {
      delete state.operatorEvidence.flySpendLimit.readBackAt;
    }),
    'artifact.operator-evidence',
  );
});


test('a recorded read-back without an inspectable pointer fails', () => {
  // A boolean, timestamp and target list still prove only that a statement
  // was made. Without a pointer to the read-back, nobody can inspect it.
  assertFails(
    mutate((state) => {
      delete state.operatorEvidence.flySpendLimit.evidenceRef;
    }),
    'artifact.operator-evidence',
  );
});

test('a recorded read-back whose pointer names no existing file fails', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.evidenceRef =
        'tests/cloud/fixtures/does-not-exist.txt';
    }),
    'artifact.operator-evidence',
  );
});

test('a read-back stamped after the artifact capture fails', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.readBackAt = '2099-01-01T00:00:00.000Z';
    }),
    'artifact.operator-evidence',
  );
});

test('an unknown operator evidence slot fails', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.somethingElse = { recorded: true, readBackAt: '2026-11-16T00:00:00.000Z' };
    }),
    'artifact.operator-evidence',
  );
});

test('an operator evidence value that carries a credential fails the shape and redaction gates', () => {
  const state = mutate((artifact) => {
    artifact.operatorEvidence.flySpendLimit.scope =
      'postgresql://someone:secret@db.example.neon.tech/production';
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const failed = failures.map((failure) => failure.gate);
  assert.ok(failed.includes('artifact.operator-evidence'), 'the shape gate refuses the value');
  assert.ok(failed.includes('artifact.redaction'), 'the redaction guard refuses the value');
});

test('a recorded read-back closes the obligation it belongs to', () => {
  const { rows } = evaluateProvisioningState(loadFixture(), EXPECTATIONS);
  const spendLimit = rows.find((row) => row.gate === 'fly.spend-limit-readback');
  assert.equal(spendLimit.status, 'met');
  assert.ok(spendLimit.reason.includes('read back'), 'the reason names the read-back');
});

test('a recorded read-back that names no production surface leaves the obligation open', () => {
  // A boolean proves that a statement was made, not what was read back.
  // A record that names nothing can close the DNS read-back while no
  // production hostname resolves at all.
  assertFails(
    mutate((state) => {
      state.operatorEvidence.dnsResolutionAndTlsReadback.targets = [];
    }),
    'dns.resolution-and-tls-readback',
  );
});

test('a recorded read-back that names only some of the surfaces leaves the obligation open', () => {
  const state = mutate((artifact) => {
    artifact.operatorEvidence.dnsResolutionAndTlsReadback.targets = [
      'tasks-api.sindustries.co.nz',
      'budget-api.sindustries.co.nz',
      'content-scheduler-api.sindustries.co.nz',
    ];
  });
  const { failures } = evaluateProvisioningState(state, EXPECTATIONS);
  const dns = failures.find((failure) => failure.gate === 'dns.resolution-and-tls-readback');
  assert.ok(dns, 'the DNS read-back gate fails');
  assert.ok(
    dns.reason.includes('health-probe.sindustries.co.nz'),
    'the reason names the surface that was left out',
  );
});

test('a recorded read-back that names a surface production does not use leaves the obligation open', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.productionProbeInterval.targets = [
        'sindustries-health-probe-staging',
      ];
    }),
    'health.production-probe-interval',
  );
});

test('the ordering gate refuses a spend-limit read-back that is not bound to the production app scope', () => {
  // The exposure is already present in the fixture, so the ordering gate
  // applies. A read-back against another scope must not stand in for the
  // production app's scope.
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.targets = ['sindustries-platform-staging'];
    }),
    'fly.spend-limit-before-public-exposure',
  );
});

test('an operator evidence target that is not an array fails the shape gate', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.targets = 'sindustries-platform-production';
    }),
    'artifact.operator-evidence',
  );
});

test('an operator evidence target that is not a surface name fails the shape gate', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.targets = ['postgresql://someone:pw@db.example.com/x'];
    }),
    'artifact.operator-evidence',
  );
});

test('a repeated operator evidence target fails the shape gate', () => {
  assertFails(
    mutate((state) => {
      state.operatorEvidence.flySpendLimit.targets = [
        'sindustries-platform-production',
        'sindustries-platform-production',
      ];
    }),
    'artifact.operator-evidence',
  );
});

test('an operator obligation with no expected surface cannot be proven', () => {
  // The same rule the other gates follow: an expectation set that names
  // nothing cannot prove anything, so the obligation stays open and the
  // owner is the repository, not the operator.
  const { failures } = evaluateProvisioningState(loadFixture(), {
    ...EXPECTATIONS,
    expectedOperatorTargets: {
      ...EXPECTATIONS.expectedOperatorTargets,
      platformAppScope: [],
    },
  });
  const spendLimit = failures.find(
    (failure) => failure.gate === 'fly.spend-limit-readback',
  );
  assert.ok(spendLimit, 'the obligation stays open');
  assert.equal(spendLimit.owner, 'Rowan', 'the missing repository fact is owned here');
});

test('the ordering gate cannot be proven without an expected production app scope', () => {
  const { failures } = evaluateProvisioningState(loadFixture(), {
    ...EXPECTATIONS,
    expectedOperatorTargets: {
      ...EXPECTATIONS.expectedOperatorTargets,
      platformAppScope: [],
    },
  });
  const ordering = failures.find(
    (failure) => failure.gate === 'fly.spend-limit-before-public-exposure',
  );
  assert.ok(ordering, 'the ordering gate stays open');
  assert.equal(ordering.owner, 'Rowan', 'the missing repository fact is owned here');
  assert.match(ordering.reason, /expected production app scope/);
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

test('a missing Fly-managed production Redis database fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.redis.exists = false;
    }),
    'fly.production-redis-database',
  );
});

test('a Fly-managed production Redis database on the wrong plan or region fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.redis.plan = 'Free';
      state.providers.fly.redis.primaryRegion = 'iad';
    }),
    'fly.production-redis-database',
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
    'health.production-probe-fly-targets',
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

// --- AC6: the DEPLOYED production probe is pointed at production targets --

test('a deployed probe pointed at a staging Fly app fails', () => {
  // The cadence gate proves the probe runs the production cadence; this
  // gate proves it WATCHES production. A probe with the right cadence and
  // a staging target passes every other check the repository owns while
  // watching the wrong environment.
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeTargets.targets.HEALTH_PROBE_FLY_APPS = [
        { label: 'platform', hostFingerprint: '5a8612fe623fef6d' },
      ];
    }),
    'health.production-probe-fly-targets',
  );
});

test('a deployed probe pointed at another environment database fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeTargets.targets.HEALTH_PROBE_DATABASES = [
        { label: 'tasks_api', hostFingerprint: '7475ba14c306eada' },
      ];
    }),
    'health.production-probe-database-targets',
  );
});

test('a production branch that exposes no endpoint host fails the database target gate', () => {
  // The expectation set names no host, so the gate cannot compare
  // anything. It must NOT pass vacuously — a gate that compares against
  // an empty set is satisfied by any target at all.
  assertFails(
    mutate((state) => {
      state.providers.neon.branch.endpointHostFingerprints = [];
    }),
    'health.production-probe-database-targets',
  );
});

test('an endpoint host read that failed fails the database target gate and says why', () => {
  // An unreadable read is not an empty list. The failure must name the
  // capture as the owner, because the operator cannot fix a read the
  // repository never managed.
  const state = mutate((mutated) => {
    mutated.providers.neon.branch.endpointHostFingerprints = [];
    mutated.providers.neon.branch.endpointHostsReadError = 'HTTP 401';
  });
  assertFails(state, 'health.production-probe-database-targets');

  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const row = rows.find((entry) => entry.gate === 'health.production-probe-database-targets');
  assert.equal(row.owner, 'Rowan');
  assert.match(row.reason, /HTTP 401/);
});

test('a deployed probe pointed at the staging Redis fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeTargets.targets.HEALTH_PROBE_REDIS = [
        { label: 'content_scheduler', hostFingerprint: '356d21d35ee6b7ec' },
      ];
    }),
    'health.production-probe-redis-targets',
  );
});

test('a deployed probe that carries no target list for a key fails', () => {
  // A probe that watches no database watches nothing: the absence of a
  // target list is not the absence of a problem.
  assertFails(
    mutate((state) => {
      delete state.providers.fly.healthProbeTargets.targets.HEALTH_PROBE_DATABASES;
    }),
    'health.production-probe-database-targets',
  );
});

test('duplicate deployed target metrics that disagree fail', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeTargets.conflictingKeys = ['HEALTH_PROBE_REDIS'];
    }),
    'health.production-probe-redis-targets',
  );
});

test('an unreadable deployed probe target capture fails', () => {
  // "The targets could not be read" is not "the probe carries no targets":
  // an unreadable read leaves the gate open.
  assertFails(
    mutate((state) => {
      state.providers.fly.healthProbeTargets = {
        captured: false,
        error: 'the Fly app sindustries-health-probe-production does not exist',
      };
    }),
    'health.production-probe-fly-targets',
  );
});

test('an expectation set with no production host fails the probe target gate', () => {
  // The expected production hosts are derived from the environment
  // manifest. If the checker is given none, the comparison would be
  // vacuous, and that is a missing repository fact rather than an operator
  // failure.
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, expectedProductionHostFingerprints: [] },
    'health.production-probe-fly-targets',
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

// --- The deployed production platform app's configuration (task fb1240c0)
//
// The app's existence, its release and its secret NAMES are proved
// elsewhere. None of them says WHICH configuration the running app was
// deployed with: an app deployed from the shared staging config passes
// every one of those gates while still serving staging's environment id,
// staging's CORS allow-lists and staging's process group.

test('a deployed CORS allow-list that names a staging origin fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.platformConfig.corsOrigins.PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS = [
        'https://tasks.staging.sindustries.co.nz',
        'https://mission-control.sindustries.co.nz',
      ];
    }),
    'fly.production-platform-app-cors-origins',
  );
});

test('a deployed CORS allow-list that is missing entirely fails', () => {
  assertFails(
    mutate((state) => {
      delete state.providers.fly.platformConfig.corsOrigins
        .PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS;
    }),
    'fly.production-platform-app-cors-origins',
  );
});

test('a deployed platform app that runs as another environment fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.platformConfig.environmentId = 'staging';
    }),
    'fly.production-platform-app-environment-id',
  );
});

test('a deployed platform app that carries no environment id fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.platformConfig.environmentId = null;
    }),
    'fly.production-platform-app-environment-id',
  );
});

test('machines that disagree on the deployed environment id fail', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.platformConfig.conflictingKeys = ['PLATFORM_ENVIRONMENT_ID'];
      state.providers.fly.platformConfig.environmentId = null;
    }),
    'fly.production-platform-app-environment-id',
  );
});

test('a deployed platform app that runs another process group fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.platformConfig.processGroup = 'tasks-api';
    }),
    'fly.production-platform-app-process-group',
  );
});

test('an artifact with no deployed platform configuration fails rather than passing', () => {
  assertFails(
    mutate((state) => {
      delete state.providers.fly.platformConfig;
    }),
    'fly.production-platform-app-environment-id',
  );
});

test('a deployed origin that is not an https origin fails', () => {
  assertFails(
    mutate((state) => {
      state.providers.fly.platformConfig.malformedOrigins = 1;
    }),
    'fly.production-platform-app-cors-origins',
  );
});

test('an expectation set with no expected environment id fails the environment-id gate', () => {
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, expectedPlatformEnvironmentId: '' },
    'fly.production-platform-app-environment-id',
  );
});

test('an expectation set with no expected process group fails the process-group gate', () => {
  assertFailsWithExpectations(
    loadFixture(),
    { ...EXPECTATIONS, expectedPlatformProcessGroups: [] },
    'fly.production-platform-app-process-group',
  );
});

test('the spend-bound order gate passes when the bound was read back before the exposure', () => {
  const { ok, rows } = evaluateProvisioningState(loadFixture(), EXPECTATIONS);
  assert.equal(ok, true);
  const ordering = rows.find((row) => row.gate === 'fly.spend-bound-ordering');
  assert.ok(ordering, 'the order gate is reported');
  assert.equal(ordering.status, 'met');
  assert.match(ordering.reason, /before production was publicly exposed/);
});

test('a spend bound read back after the public exposure fails the order gate', () => {
  const state = mutate((artifact) => {
    // The fixture's production DNS was published at 2026-11-15T23:00Z;
    // a bound read back afterwards is the deviation the design forbids.
    artifact.operatorEvidence.flySpendLimit.readBackAt = '2026-11-16T00:00:00.000Z';
  });
  assertFails(state, 'fly.spend-bound-ordering');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const ordering = rows.find((row) => row.gate === 'fly.spend-bound-ordering');
  assert.match(ordering.reason, /AFTER production was publicly exposed/);
  assert.match(ordering.reason, /flySpendOrderingDeviation/);
});

test('a recorded acceptance of the ordering deviation closes the order gate', () => {
  const state = mutate((artifact) => {
    artifact.operatorEvidence.flySpendLimit.readBackAt = '2026-11-16T00:00:00.000Z';
    artifact.operatorEvidence.flySpendOrderingDeviation = {
      recorded: true,
      readBackAt: '2026-11-16T00:10:00.000Z',
      scope: 'Tom acceptance of the retroactive production spend bound',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: [...EXPECTATIONS.expectedOperatorTargets.productionExposure],
    };
  });
  const { ok, rows } = evaluateProvisioningState(state, EXPECTATIONS);
  assert.equal(ok, true, JSON.stringify(rows.filter((row) => row.status === 'unmet'), null, 2));
  const ordering = rows.find((row) => row.gate === 'fly.spend-bound-ordering');
  assert.equal(ordering.status, 'met');
  assert.match(ordering.reason, /the order the approved design requires was not met/);
  assert.match(ordering.reason, /recorded acceptance/);
});

test('an acceptance that does not cover every exposed surface stays open', () => {
  const state = mutate((artifact) => {
    artifact.operatorEvidence.flySpendLimit.readBackAt = '2026-11-16T00:00:00.000Z';
    artifact.operatorEvidence.flySpendOrderingDeviation = {
      recorded: true,
      readBackAt: '2026-11-16T00:10:00.000Z',
      scope: 'Tom acceptance of the retroactive production spend bound',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      targets: ['sindustries-platform-production'],
    };
  });
  assertFails(state, 'fly.spend-bound-ordering');
});

test('a public exposure with no readable exposure time fails the order gate', () => {
  const state = mutate((artifact) => {
    for (const record of artifact.providers.cloudflare.records) {
      delete record.createdOn;
    }
    for (const app of artifact.providers.fly.apps) {
      delete app.releaseCreatedAt;
    }
  });
  assertFails(state, 'fly.spend-bound-ordering');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const ordering = rows.find((row) => row.gate === 'fly.spend-bound-ordering');
  assert.equal(ordering.owner, 'Rowan', 'the capture owns a missing exposure time');
});

test('a live production platform app with no spend-bound read-back fails the before-exposure gate', () => {
  const state = mutate((artifact) => {
    // No production DNS record is published and the probe is stopped, so
    // the ONLY public exposure left is the consolidated production
    // platform app — the app every production API hostname points at, and
    // the app that answers on its own .fly.dev hostname. Counting only
    // DNS records and the probe reported this state as "nothing is
    // publicly exposed yet", which is how a live production API app
    // passed the spend-bound gate without a bound.
    const productionHostnames = new Set(
      EXPECTATIONS.expectedOperatorTargets.productionHostnames,
    );
    artifact.providers.cloudflare.records = artifact.providers.cloudflare.records.filter(
      (record) => !productionHostnames.has(record?.name),
    );
    const probe = artifact.providers.fly.apps.find(
      (app) => app?.name === EXPECTATIONS.healthProbeApp,
    );
    if (probe) probe.machineStates = [];
    delete artifact.operatorEvidence.flySpendLimit;
  });
  assertFails(state, 'fly.spend-limit-before-public-exposure');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const gate = rows.find((row) => row.gate === 'fly.spend-limit-before-public-exposure');
  assert.match(gate.reason, /production platform app/);
});

test('the order gate reads the production platform app release as the exposure time', () => {
  const state = mutate((artifact) => {
    // The platform app was released at 20:00Z, BEFORE the spend bound
    // was read back at 20:55Z and before any DNS record was published.
    // The order the approved design requires was violated, so the gate
    // has to say so instead of reading the DNS publication as the first
    // exposure.
    const platform = artifact.providers.fly.apps.find(
      (app) => app?.name === EXPECTATIONS.platformApp,
    );
    if (platform) platform.releaseCreatedAt = '2026-11-15T20:00:00.000Z';
  });
  assertFails(state, 'fly.spend-bound-ordering');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const ordering = rows.find((row) => row.gate === 'fly.spend-bound-ordering');
  assert.match(ordering.reason, /AFTER production was publicly exposed/);
  assert.match(ordering.reason, /sindustries-platform-production/);
});

test('an acceptance that omits the exposed production platform app stays open', () => {
  const state = mutate((artifact) => {
    artifact.operatorEvidence.flySpendLimit.readBackAt = '2026-11-16T00:00:00.000Z';
    artifact.operatorEvidence.flySpendOrderingDeviation = {
      recorded: true,
      readBackAt: '2026-11-16T00:10:00.000Z',
      scope: 'Tom acceptance of the retroactive production spend bound',
      evidenceRef: 'tests/cloud/fixtures/operator-evidence-readback.txt',
      // Every exposed surface EXCEPT the production platform app — the
      // app that actually serves all three production API hostnames.
      targets: EXPECTATIONS.expectedOperatorTargets.productionExposure.filter(
        (target) => target !== EXPECTATIONS.platformApp,
      ),
    };
  });
  assertFails(state, 'fly.spend-bound-ordering');
});

test('a production app with no allocated app-scoped egress address fails the source gate', () => {
  // The Neon allowlist is built from Fly's app-scoped static egress
  // addresses. An app that has allocated none leaves the allowlist with
  // nothing to list, whatever the Neon plan allows — so the gate has to
  // fail on the FLY side and name the allocation, not the Neon plan.
  const state = mutate((artifact) => {
    const platform = artifact.providers.fly.apps.find(
      (app) => app?.name === EXPECTATIONS.platformApp,
    );
    if (platform) {
      platform.egressAddresses = {
        captured: true,
        ipv4Count: 0,
        ipv6Count: 0,
        regions: [],
        fingerprints: [],
      };
    }
  });
  assertFails(state, 'neon.ip-allowlist-source');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const gate = rows.find((row) => row.gate === 'neon.ip-allowlist-source');
  assert.match(gate.reason, /no app-scoped static egress address/);
  assert.match(gate.reason, /allocate-egress/);
  assert.match(gate.owner, /Quinn/, 'the allocation is an operator action');
});

test('an unreadable egress-address read fails the source gate and names the capture', () => {
  const state = mutate((artifact) => {
    const probe = artifact.providers.fly.apps.find(
      (app) => app?.name === EXPECTATIONS.healthProbeApp,
    );
    if (probe) {
      probe.egressAddresses = {
        captured: false,
        ipv4Count: 0,
        ipv6Count: 0,
        regions: [],
        fingerprints: [],
        error: 'the egress addresses of the Fly app could not be read (HTTP 500)',
      };
    }
  });
  assertFails(state, 'neon.ip-allowlist-source');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const gate = rows.find((row) => row.gate === 'neon.ip-allowlist-source');
  assert.match(gate.reason, /could not be read/);
  assert.equal(gate.owner, 'Rowan', 'a read that failed is the capture’s, not the operator’s');
});

test('a Neon allowlist that omits an allocated source address fails the match gate', () => {
  const state = mutate((artifact) => {
    artifact.providers.neon.project.allowedIpFingerprints =
      artifact.providers.neon.project.allowedIpFingerprints.slice(0, 3);
    artifact.providers.neon.project.allowedIpCount = 3;
  });
  assertFails(state, 'neon.ip-allowlist-match');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const gate = rows.find((row) => row.gate === 'neon.ip-allowlist-match');
  assert.match(gate.reason, /source address\(es\) are missing/);
});

test('a Neon allowlist that names an address production does not use fails the match gate', () => {
  const state = mutate((artifact) => {
    artifact.providers.neon.project.allowedIpFingerprints = [
      ...artifact.providers.neon.project.allowedIpFingerprints.slice(0, 3),
      'ffffffffffffffff',
    ];
    artifact.providers.neon.project.allowedIpCount = 4;
  });
  assertFails(state, 'neon.ip-allowlist-match');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const gate = rows.find((row) => row.gate === 'neon.ip-allowlist-match');
  assert.match(gate.reason, /not allocated to a production app/);
});

test('an allowlist count with no fingerprints for it fails the match gate rather than passing', () => {
  const state = mutate((artifact) => {
    artifact.providers.neon.project.allowedIpFingerprints = [];
    artifact.providers.neon.project.allowedIpCount = 4;
  });
  assertFails(state, 'neon.ip-allowlist-match');
  const { rows } = evaluateProvisioningState(state, EXPECTATIONS);
  const gate = rows.find((row) => row.gate === 'neon.ip-allowlist-match');
  assert.match(gate.reason, /only 0 fingerprint\(s\)/);
  assert.equal(gate.owner, 'Rowan');
});

test('the artifact records no address in the clear', () => {
  // The artifact is committed, compared between runs and pasted into task
  // comments. An egress address or a Neon allowlist entry must reach it
  // as a fingerprint only.
  //
  // The values are inspected one by one rather than as a serialized blob:
  // an ISO timestamp contains colons, so a blob-wide pattern cannot tell
  // a timestamp from an address.
  const strings = [];
  const walk = (node) => {
    if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(loadFixture());

  const bare = strings.map((value) => value.trim().split('/')[0].replace(/^\[|\]$/g, ''));
  const ipv4 = bare.filter((value) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value));
  const ipv6 = bare.filter(
    (value) =>
      /^[0-9a-f:]+$/.test(value) &&
      value.includes(':') &&
      (value.includes('::') || value.split(':').length >= 7),
  );
  assert.deepEqual(ipv4, [], 'no IPv4 address in the artifact');
  assert.deepEqual(ipv6, [], 'no IPv6 address in the artifact');
});
