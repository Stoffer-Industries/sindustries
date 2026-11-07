#!/usr/bin/env node
/**
 * platform-provision-order.test.mjs — static contract for the staging
 * platform's provisioning/deploy ORDER (task 219fb673).
 *
 * There is one invariant here that is invisible in the happy path and
 * expensive when it breaks: the step that registers the platform's
 * secrets must not be able to fail because of the state of the image it
 * is about to replace.
 *
 * `flyctl secrets set` does more than write values — it also restarts the
 * app's Machines, and in the flyctl the deploy workflow pins (0.4.102)
 * that restart is a Machine deployment whose progress flyctl follows.
 * When the running image is unhealthy — exactly the state a deploy exists
 * to repair — the follow fails, the command exits non-zero, and the
 * workflow aborts BEFORE the canary deploy that carries the fix. Main CI
 * run 42366203146 on merge commit 27269dbb failed in the provisioning
 * step for exactly that reason and never reached "Deploy (canary)".
 *
 * The invariant is expressed in text (a flag on the flyctl argv, and the
 * order of two workflow steps), so it is checked here the same way the
 * other cloud contract tests are: read the files and assert on their
 * content.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/platform-provision-order.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const REPO_ROOT = new URL('../../../../', import.meta.url);

const DEPLOY_WORKFLOW = '.github/workflows/deploy-staging-platform.yml';
const PROVISIONING = 'infra/cloud/platform/platform-provision-secrets.mjs';
const PROVISIONER_CLI_TEST =
  'infra/cloud/platform/tests/platform-provision-secrets-cli.test.mjs';

/**
 * Read a repository file as text.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function read(relativePath) {
  return readFileSync(new URL(relativePath, REPO_ROOT), 'utf8');
}

/**
 * The workflow's executable lines — the YAML comments are stripped.
 *
 * The comments explain WHY the write is detached and name the flyctl
 * command they describe, so a plain text search would match the
 * explanation rather than a command.
 *
 * @param {string} workflow
 * @returns {string}
 */
function executableLines(workflow) {
  return workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('platform provisioning order', () => {
  it('registers the secrets before the canary deploy', () => {
    const workflow = read(DEPLOY_WORKFLOW);
    // The step DECLARATIONS, not the prose: the workflow's comments name
    // both steps, and a prose match would order the comment against the
    // step rather than the step against the step.
    const provisioning = workflow.indexOf('- name: Provision the platform app and its secrets');
    const canary = workflow.indexOf('- name: Deploy (canary)');
    assert.notEqual(provisioning, -1, 'the workflow must have a provisioning step');
    assert.notEqual(canary, -1, 'the workflow must have a canary deploy step');
    assert.ok(
      provisioning < canary,
      "the secrets must be live on the app before the canary Machine is created, because the canary boots with the app's live secret values",
    );
  });

  it('never writes the platform secrets from the workflow directly', () => {
    const workflow = executableLines(read(DEPLOY_WORKFLOW));
    // A raw `flyctl secrets set` in the workflow would be a health-gated
    // restart with no --detach, which is the failure this contract
    // exists to prevent. The mapping lives in the provisioner so the
    // write has exactly one implementation.
    assert.ok(
      !/flyctl\s+secrets\s+set/.test(workflow),
      'the workflow must not write secrets directly; the provisioner owns the write so it cannot bypass the detached, non-health-gated path',
    );
    assert.ok(
      workflow.includes('platform-provision-secrets.mjs'),
      'the workflow must provision through infra/cloud/platform/platform-provision-secrets.mjs',
    );
  });

  it('detaches the secret write and keeps it live (not staged)', () => {
    const provisioner = read(PROVISIONING);
    // The argv the provisioner hands to flyctl. `--detach` removes the
    // health gate; `--stage` would hold the values for the next release
    // instead of making them the app's live values, and the staged
    // values never reached the Machine a deploy created.
    const secretsSet = provisioner.match(/const args = \['secrets', 'set'[^\]]*\];/);
    assert.ok(secretsSet, 'the provisioner must build its flyctl secrets argv in one place');
    assert.ok(
      secretsSet[0].includes("'--detach'"),
      'the secret write must be detached so a health-gated restart cannot abort the deploy that fixes it',
    );
    assert.ok(
      !secretsSet[0].includes("'--stage'"),
      'the values must be set directly: staged values never reached the Machine a deploy created',
    );
  });

  it('locks the detached write in the CLI test', () => {
    const cliTest = read(PROVISIONER_CLI_TEST);
    assert.ok(
      cliTest.includes("secrets.includes('--detach')"),
      'the CLI test must assert the detached write, or the flag can be dropped without a failing test',
    );
  });
});
