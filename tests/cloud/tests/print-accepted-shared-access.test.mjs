#!/usr/bin/env node
// print-accepted-shared-access.test.mjs — task f2c23e26
//
// The cutover workflow DERIVES the accepted shared access from the
// environment manifest instead of restating it, because a workflow that
// carried its own copy of the accepted role pair could agree with a
// drifted manifest — and then the harness would accept a shared access
// the topology does not declare.
//
// These cases pin that bridge:
//
//   1. the script exports the pair the manifest declares, and the reason;
//   2. the declared pair is exactly the two production service roles
//      that own the schemas the harness restores;
//   3. the exports are safe to `eval` in a shell: every value is a
//      JSON-encoded string on one line.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { getPlatformEnvironment } from '../../../infra/cloud/platform/platform-environments.mjs';

const exec = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'infra/cloud/scripts/print-accepted-shared-access.mjs');

test('the script exports the accepted pair the manifest declares', async () => {
  const { stdout } = await exec('node', [SCRIPT], { cwd: REPO_ROOT });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 2, 'the script prints exactly two export lines');

  const declaration = getPlatformEnvironment('production').databaseServiceRoleSharedAccess;
  assert.equal(declaration.accepted, true, 'the manifest declares the accepted shared access');

  const rolesLine = lines.find((line) => line.startsWith('export CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES='));
  const reasonLine = lines.find((line) => line.startsWith('export CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON='));
  assert.ok(rolesLine, 'the roles export is present');
  assert.ok(reasonLine, 'the reason export is present');

  const roles = JSON.parse(rolesLine.slice('export CLOUD_DB_ACCEPTED_SHARED_ACCESS_ROLES='.length));
  const reason = JSON.parse(reasonLine.slice('export CLOUD_DB_ACCEPTED_SHARED_ACCESS_REASON='.length));

  assert.deepEqual(roles.split(','), declaration.roles, 'the exported roles are the declared roles');
  assert.equal(reason, declaration.reason, 'the exported reason is the declared reason');
});

test('the declared pair is the two production service roles', () => {
  const environment = getPlatformEnvironment('production');
  const declaration = environment.databaseServiceRoleSharedAccess;
  const serviceRoles = Object.values(environment.databaseServiceRoles);

  assert.deepEqual(
    [...declaration.roles].sort(),
    [environment.databaseServiceRoles.tasks, environment.databaseServiceRoles.contentScheduler].sort(),
    'the accepted pair is the tasks and content-scheduler service roles',
  );
  for (const role of declaration.roles) {
    assert.ok(serviceRoles.includes(role), `the accepted role ${role} is a declared production service role`);
  }
  assert.equal(
    declaration.roles.includes(environment.databaseServiceRoles.budget),
    false,
    'the budget service role is not part of the accepted pair',
  );
});

test('every export line is a single-line JSON-encoded assignment', async () => {
  const { stdout } = await exec('node', [SCRIPT], { cwd: REPO_ROOT });
  for (const line of stdout.trim().split('\n')) {
    assert.match(line, /^export [A-Z_]+="(?:[^"\\]|\\.)*"$/, `the export line is safely quoted: ${line}`);
  }
});
