#!/usr/bin/env node
/**
 * platform-cutover-order.test.mjs — static contract for the platform
 * cutover order and its deploy gate (task 219fb673).
 *
 * The cutover has one safety invariant that is easy to break with an
 * innocent-looking edit: the old auto-post worker must be scaled to zero
 * BEFORE the platform is deployed, because the platform's worker is a
 * SECOND consumer of the same BullMQ queue. Two consumers process every
 * scheduled post twice.
 *
 * The invariant and the gate are both expressed in text — the runbook and
 * the deploy scripts — so they are checked here the same way the other
 * cloud contract tests are: read the files and assert on their content.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/platform-cutover-order.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const REPO_ROOT = new URL('../../../../', import.meta.url);

/**
 * Read a repository file as text.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function read(relativePath) {
  return readFileSync(new URL(relativePath, REPO_ROOT), 'utf8');
}

const RUNBOOK = 'docs/runbooks/platform-consolidation-rollback.md';
const DEPLOY_SCRIPT = 'infra/cloud/bin/deploy';
const DEPLOY_WORKFLOW = '.github/workflows/deploy-staging-platform.yml';
const PROVISIONING = 'infra/cloud/platform/platform-provision-secrets.mjs';

/**
 * The cutover sequence section of the runbook — §3 only, so the
 * prerequisites section (which mentions the worker in prose) cannot
 * satisfy the ordering assertion.
 *
 * @returns {string}
 */
function cutoverSection() {
  const text = read(RUNBOOK);
  const start = text.indexOf('## 3. Cutover sequence');
  const end = text.indexOf('## 4. Backout');
  assert.notEqual(start, -1, 'the runbook must have a cutover sequence section');
  assert.notEqual(end, -1, 'the runbook must have a backout section');
  return text.slice(start, end);
}

describe('platform cutover order', () => {
  it('scales the old auto-post worker to zero BEFORE the platform is deployed', () => {
    const section = cutoverSection();
    const workerStop = section.indexOf(
      'fly scale count 0 --app sindustries-auto-post-worker-staging'
    );
    const deployStep = section.indexOf('### Step 2 — deploy the platform app');
    assert.notEqual(workerStop, -1, 'the cutover must scale the old auto-post worker to zero');
    assert.notEqual(deployStep, -1, 'the cutover must have a platform deploy step');
    assert.ok(
      workerStop < deployStep,
      'the old auto-post worker must be scaled to zero before the platform deploy step'
    );
  });

  it('states the ordering invariant explicitly', () => {
    const section = cutoverSection();
    assert.match(section, /BEFORE the\s+platform is deployed/i);
    assert.match(section, /SECOND\s+consumer/i);
  });

  it('does not document the operator deploy path as the cutover route', () => {
    // The operator path is gated by the same opt-in (the deploy script
    // refuses it), but the documented route is the CI workflow: it
    // provisions the app's secrets before the deploy. So the operator
    // path may be MENTIONED in prose, but it must not appear as an
    // instruction in a command block.
    const section = cutoverSection();
    const commandBlocks = [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.ok(commandBlocks.length > 0, 'the cutover must contain command blocks');
    for (const block of commandBlocks) {
      assert.ok(
        !block.includes('infra/cloud/bin/deploy'),
        'the cutover must not instruct the operator to deploy through the operator path'
      );
    }
    assert.match(section, /deploy-staging-platform\.yml/);
    assert.match(section, /STAGING_PLATFORM_DEPLOY_ENABLED/);
  });
});

describe('platform deploy gate', () => {
  it('refuses the platform deploy in the operator path without the opt-in', () => {
    const script = read(DEPLOY_SCRIPT);
    assert.match(script, /SERVICE" == "platform"/);
    assert.match(script, /STAGING_PLATFORM_DEPLOY_ENABLED:-}" != "true"/);
    assert.match(script, /the platform deploy is opt-in/);
  });

  it('gates the CI deploy on the same opt-in', () => {
    const workflow = read(DEPLOY_WORKFLOW);
    assert.match(workflow, /STAGING_PLATFORM_DEPLOY_ENABLED/);
    // The deploy, the config validation and the smoke checks all hang off
    // the gate's output.
    assert.match(workflow, /steps\.deploy\.outputs\.enabled == 'true'/);
  });

  it('provisions the platform from write-capable database sources', () => {
    const workflow = read(DEPLOY_WORKFLOW);
    assert.match(workflow, /STAGING_TASKS_API_DATABASE_URL/);
    assert.match(workflow, /STAGING_BUDGET_API_DATABASE_URL/);
    // The drill's read-only source DSNs must not be mapped onto the live
    // platform: they cannot run the platform's migrations or a normal
    // service write.
    assert.ok(
      !workflow.includes('secrets.TASKS_API_SOURCE_DSN'),
      'the platform must not be provisioned from the read-only drill source DSN'
    );
    assert.ok(
      !workflow.includes('secrets.BUDGET_API_SOURCE_DSN'),
      'the platform must not be provisioned from the read-only drill source DSN'
    );
  });

  it('creates the Fly app with arguments the pinned flyctl accepts', () => {
    const script = read(PROVISIONING);
    assert.match(script, /\['apps', 'create', app, '--org', org, '--yes'\]/);
    assert.ok(
      !script.includes("'--region'"),
      'flyctl 0.4.102 has no --region flag on apps create'
    );
  });
});
