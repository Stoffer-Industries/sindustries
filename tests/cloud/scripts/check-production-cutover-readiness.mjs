#!/usr/bin/env node
// check-production-cutover-readiness.mjs — task f2c23e26
// Pre-dispatch readiness gate for the production data cutover.
//
// WHY THIS EXISTS
//
// The production cutover has three independent keys (the runbook's §2):
//
//   1. The `production` GitHub Environment's required reviewers.
//   2. The typed confirmation `MIGRATE PRODUCTION`.
//   3. The declared source and destination endpoints.
//
// Keys 2 and 3 are enforced IN CODE: the workflow refuses a mistyped
// confirmation (exit 10) and the harness refuses any endpoint outside the
// declared list. Key 1 was enforced in PROSE ONLY. The runbook said the
// Environment's reviewers are the approval gate and that "a dispatch that
// has not been approved never starts" — but nothing in the repository READ
// the Environment's protection rules, so the key could be completely inert
// (no protection rules, no reviewer, no approval) while the runbook still
// claimed it was live.
//
// The six DSN secrets were in the same position. The workflow fails closed
// on them (exit 11, "Required production environment secret ... is missing
// or empty"), which is safe — but the failure surfaces AT DISPATCH, on an
// operator's machine, mid-procedure, with no named owner and no statement
// of which of the six is missing.
//
// This checker moves both facts OUT of the dispatch moment and INTO a
// named gate with an owner. It reads the redacted provisioning-state
// artifact (names, flags and counts only — never a value) and decides
// whether the cutover MAY be dispatched.
//
// A THIRD fact sat in the same position. A cutover DSN secret can be
// REGISTERED against a database that does not exist: the workflow's
// secret check asks only whether the secret is non-empty, so a DSN
// pointing at a database that was never created passes it and fails at
// the RESTORE — after the dump, with the source already quiesced. The
// cutover also needs three DISTINCT databases (the source, a destination
// that is empty before the restore, and a recovery database the
// destination's archive is restored into and reconciled against), and
// the destination and the recovery database must be PRODUCTION
// databases: the endpoint allowlist is operator-declared, so a staging
// host that is declared passes it.
//
// It fails closed. An environment that could not be read is an OPEN gate,
// not a silent pass: "not captured" is not "fine".
//
// Pure Node, no deps. Exits 0 when the cutover may be dispatched, 1 when
// any gate is unmet, 2 on a usage error.
//
// Usage:
//   node tests/cloud/scripts/check-production-cutover-readiness.mjs <state-file>

import { readFileSync } from 'node:fs';
import { exit, stderr, stdout } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The DSN secrets the production cutover workflow reads from the
 * `production` GitHub Environment.
 *
 * The names are the workflow's contract, not a convenience list: the
 * staging Environment carries the SAME six names for the same six roles
 * (verified 2026-11-19), so the production set is the staging set and
 * not a second naming convention.
 *
 * `tests/cloud/tests/check-production-cutover-readiness.test.mjs` binds
 * this list to the workflow file, so the checker cannot drift away from
 * the workflow it is a gate for.
 */
export const CUTOVER_DSN_SECRET_NAMES = Object.freeze([
  'TASKS_API_SOURCE_DSN',
  'BUDGET_API_SOURCE_DSN',
  'TASKS_API_DEST_DSN',
  'BUDGET_API_DEST_DSN',
  'RECOVERY_TASKS_API_DSN',
  'RECOVERY_BUDGET_API_DSN',
]);

/** The DSN secrets that must exist even for a run without --recovery. */
const REQUIRED_WITHOUT_RECOVERY = CUTOVER_DSN_SECRET_NAMES.filter(
  (name) => !name.startsWith('RECOVERY_'),
);

/**
 * The artifact schema version whose `databaseCount` counts DISTINCT
 * LOGICAL DATABASES.
 *
 * The capture counted Neon ENDPOINT HOSTS up to schema version 12, and a
 * Neon branch can carry several compute endpoints — a read-write endpoint
 * plus read-only replicas — that share one branch's storage. Under that
 * count, one database could read as three capacity slots, so an artifact
 * captured before version 13 cannot answer whether three databases exist:
 * its number means something else. Refusing the stale artifact is the
 * difference between a gate that measures the right thing and one that
 * measures a proxy and believes it.
 */
export const DATABASE_IDENTITY_SCHEMA_VERSION = 13;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function row(gate, status, { owner, label, reason }) {
  return { gate, status, owner, label, reason };
}

/**
 * Decide the cutover's readiness from the provisioning-state artifact.
 *
 * Exported so the sentinel tests can drive it directly.
 */
export function evaluateCutoverReadiness(state) {
  const rows = [];
  const github = state?.providers?.github;

  // --- Gate 1: the `production` Environment could be read at all ---------
  if (!github || github.captured !== true) {
    rows.push(
      row('github.production-environment-captured', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The `production` GitHub Environment is readable',
        reason:
          'the production Environment could not be read, so neither its secret inventory nor its approval gate can be proven — a provider that cannot be read is an OPEN gate, not a pass',
      }),
    );
    return { ok: false, rows };
  }

  rows.push(
    row('github.production-environment-captured', 'met', {
      owner: 'Quinn (operator)',
      label: 'The `production` GitHub Environment is readable',
      reason: `the ${github.environment ?? 'production'} Environment was read from ${github.repository ?? 'the repository'}`,
    }),
  );

  // --- Gate 2: the cutover's DSN secrets --------------------------------
  const secretNames = new Set(asArray(github.secretNames).filter(Boolean));
  const missing = CUTOVER_DSN_SECRET_NAMES.filter((name) => !secretNames.has(name));
  const missingRequired = REQUIRED_WITHOUT_RECOVERY.filter((name) => !secretNames.has(name));

  if (missingRequired.length > 0) {
    rows.push(
      row('github.cutover-dsn-secrets', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The cutover DSN secrets are registered on the Environment',
        reason: `the production Environment is missing ${missing.length} cutover secret(s): ${missing.join(', ')} — ${missingRequired.length} of them (${missingRequired.join(', ')}) are required for every run, so a dispatch today fails closed at the workflow's secret check (exit 11) instead of moving data`,
      }),
    );
  } else if (missing.length > 0) {
    rows.push(
      row('github.cutover-dsn-secrets', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The cutover DSN secrets are registered on the Environment',
        reason: `the production Environment is missing ${missing.length} cutover secret(s) needed only for a --recovery run: ${missing.join(', ')} — AC3's restore evidence cannot be produced without them`,
      }),
    );
  } else {
    rows.push(
      row('github.cutover-dsn-secrets', 'met', {
        owner: 'Quinn (operator)',
        label: 'The cutover DSN secrets are registered on the Environment',
        reason: `all ${CUTOVER_DSN_SECRET_NAMES.length} cutover DSN secret(s) are registered on the production Environment`,
      }),
    );
  }

  // --- Gate 3: the Environment's approval gate --------------------------
  const gate = github.approvalGate;

  if (!gate || gate.captured !== true) {
    rows.push(
      row('github.production-approval-gate', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The `production` Environment refuses an unapproved dispatch',
        reason:
          'the production Environment\'s protection rules could not be read, so the approval gate can be neither proven nor denied — the cutover\'s first key is unverified',
      }),
    );
  } else {
    const reviewerCount = Number.isFinite(gate.requiredReviewerCount)
      ? gate.requiredReviewerCount
      : 0;
    const ruleTypes = asArray(gate.protectionRuleTypes).filter(Boolean);
    const bypass = gate.canAdminsBypass;

    if (reviewerCount === 0) {
      rows.push(
        row('github.production-approval-gate', 'unmet', {
          owner: 'Quinn (operator)',
          label: 'The `production` Environment refuses an unapproved dispatch',
          reason: `the production Environment has ${ruleTypes.length ? `protection rule(s) of type ${ruleTypes.join(', ')}` : 'no protection rules'} and NO required reviewer, so a dispatch starts unapproved — the runbook's first key is inert as configured`,
        }),
      );
    } else if (bypass === true) {
      rows.push(
        row('github.production-approval-gate', 'unmet', {
          owner: 'Quinn (operator)',
          label: 'The `production` Environment refuses an unapproved dispatch',
          reason: `the production Environment has ${reviewerCount} required reviewer(s) but admins may bypass the gate, so the approval gate is advisory rather than binding`,
        }),
      );
    } else {
      rows.push(
        row('github.production-approval-gate', 'met', {
          owner: 'Quinn (operator)',
          label: 'The `production` Environment refuses an unapproved dispatch',
          reason: `the production Environment requires ${reviewerCount} reviewer(s) and admins cannot bypass the gate`,
        }),
      );
    }
  }

  // --- Gate 4: the cutover's databases exist -----------------------------
  //
  // Six DSN secrets can be REGISTERED against databases that do not
  // exist. The workflow only checks that the secrets are non-empty, so a
  // secret pointing at a database that was never created passes the
  // secret check and fails at the RESTORE — after the dump, after the
  // source has been quiesced, with the operator mid-procedure.
  //
  // The cutover needs three DISTINCT databases: the source, a
  // destination that is empty before the restore, and a recovery
  // database that the destination's archive is restored into and
  // reconciled against. A recovery database that IS the destination
  // would make the reconcile compare a database with itself: evidence
  // that looks green and proves nothing.
  const neon = state?.providers?.neon;
  const requiredDatabases = 3;

  if (!neon || neon.captured !== true) {
    rows.push(
      row('neon.cutover-database-capacity', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The cutover\'s source, destination and recovery databases exist',
        reason:
          'the Neon project could not be read, so the destination and recovery databases cannot be proven to exist — a cutover that restores into a database that does not exist fails after the dump, with the source already quiesced',
      }),
    );
  } else if (state?.schemaVersion !== DATABASE_IDENTITY_SCHEMA_VERSION) {
    rows.push(
      row('neon.cutover-database-capacity', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The cutover\'s source, destination and recovery databases exist',
        reason: `the artifact was captured under schema version ${JSON.stringify(state?.schemaVersion ?? null)}, whose \`databaseCount\` counts Neon ENDPOINT HOSTS rather than distinct databases — one branch can serve one database behind several read-replica endpoints — so its count cannot answer this gate. Re-capture the provisioning state with the current capture script`,
      }),
    );
  } else if (neon.project?.databaseCountReadError) {
    rows.push(
      row('neon.cutover-database-capacity', 'unmet', {
        owner: 'Quinn (operator)',
        label: 'The cutover\'s source, destination and recovery databases exist',
        reason: `the Neon database inventory could not be read completely (${neon.project.databaseCountReadError}), so the database count is a LOWER BOUND and the destination and recovery databases cannot be proven to exist`,
      }),
    );
  } else {
    const databaseCount = Number.isFinite(neon.project?.databaseCount)
      ? neon.project.databaseCount
      : 0;

    if (databaseCount < requiredDatabases) {
      rows.push(
        row('neon.cutover-database-capacity', 'unmet', {
          owner: 'Quinn (operator)',
          label: 'The cutover\'s source, destination and recovery databases exist',
          reason: `the production Neon environment serves ${databaseCount} distinct database(s); the cutover needs ${requiredDatabases} — the source, a destination that is empty before the restore, and a recovery database to reconcile against — so ${requiredDatabases - databaseCount} more database(s) must be created before the DSN secrets can point at databases that exist. A read replica of an existing branch does not count: it is another address for the SAME database. The destination and the recovery database must also sit behind an endpoint OTHER than the source's, because the dispatch refuses a destination behind the source's host (exit 10) — create a branch named \`production-*\` and put them there`,
        }),
      );
    } else {
      rows.push(
        row('neon.cutover-database-capacity', 'met', {
          owner: 'Quinn (operator)',
          label: 'The cutover\'s source, destination and recovery databases exist',
          reason: `the production Neon environment serves ${databaseCount} distinct database(s), so the source, the destination and the recovery database can be three distinct databases — the destination and the recovery database must still be behind an endpoint other than the source's, or the dispatch refuses them (exit 10)`,
        }),
      );
    }
  }

  return { ok: rows.every((entry) => entry.status === 'met'), rows };
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 1) return { usage: true };
  return { usage: false, statePath: args[0] };
}

export async function main(argv = process.argv) {
  const { usage, statePath } = parseArgs(argv);
  if (usage) {
    stdout.write(
      'Usage: node tests/cloud/scripts/check-production-cutover-readiness.mjs <state-file>\n',
    );
    return 2;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    stderr.write(
      `[check-production-cutover-readiness] cannot read ${statePath} as JSON: ${error.message}\n`,
    );
    return 1;
  }

  const { ok, rows } = evaluateCutoverReadiness(state);

  for (const entry of rows) {
    const line = `[check-production-cutover-readiness] ${entry.status.toUpperCase()} ${entry.gate} — ${entry.label}\n    owner: ${entry.owner}\n    reason: ${entry.reason}\n`;
    if (entry.status === 'met') stdout.write(line);
    else stderr.write(line);
  }

  if (ok) {
    stdout.write(
      '[check-production-cutover-readiness] OK — the cutover may be dispatched (the Environment ' +
        'refuses an unapproved dispatch and every cutover DSN secret is registered).\n',
    );
    return 0;
  }

  stderr.write(
    '[check-production-cutover-readiness] FAILED — the cutover is NOT ready to dispatch. Every ' +
      'unmet gate names the owner who can close it.\n',
  );
  return 1;
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await main(process.argv);
  exit(code);
}
