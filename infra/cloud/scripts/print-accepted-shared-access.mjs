#!/usr/bin/env node
// print-accepted-shared-access.mjs — task f2c23e26
//
// The declared accepted shared access, as shell exports.
//
// WHY THIS EXISTS. The cutover harness accepts the cross-schema access
// between the two production service roles ONLY when the operator names
// the accepted pair and the decision that accepted it. Those two values
// are facts about the production topology, and the production topology is
// declared in the environment manifest
// (`databaseServiceRoleSharedAccess`). A workflow that carried its own
// copy of the pair could agree with a drifted manifest — the same defect
// class the provisioning gates were fixed for.
//
// So the workflow DERIVES the values from the manifest instead of
// restating them. When the manifest declares no acceptance, the two
// exports are empty and the harness refuses any cross-schema access,
// exactly as it did before the acceptance existed.
//
// Usage:
//   eval "$(node infra/cloud/scripts/print-accepted-shared-access.mjs)"
//
// The output is two `export NAME="value"` lines. The values are JSON-
// encoded, so a reason containing spaces or punctuation cannot break the
// shell that evaluates them.

import { getPlatformEnvironment } from '../platform/platform-environments.mjs';

const declaration =
  getPlatformEnvironment('production')?.databaseServiceRoleSharedAccess ?? null;

const accepted = declaration?.accepted === true;
const roles =
  accepted && Array.isArray(declaration.roles) ? declaration.roles.join(',') : '';
const reason =
  accepted && typeof declaration.reason === 'string' ? declaration.reason : '';

process.stdout.write(
  `export CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES=${JSON.stringify(roles)}\n`,
);
process.stdout.write(
  `export CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON=${JSON.stringify(reason)}\n`,
);
