#!/usr/bin/env node
// stable-hostname-live-verify-workflow.test.mjs — task 5cb4a8fe contract test.
//
// The AC5 live hostname harness has so far only run from the operator's Mac,
// which sits behind a secret egress proxy. Every request to a
// *.sindustries.co.nz host from there came back 502 with the body "Secret
// egress proxy could not reach the upstream host", which the harness
// classifies as failureMode=proxy_blocked — an observer-side block, not a
// deployment verdict. With the proxy unset the same two frontend rows fail
// as failureMode=transport_error.
//
// Neither observation can close the AC5 frontend clause ("frontend roots and
// assets work through the stable hostnames") or the AC2 TLS clause
// ("certificates valid for every public hostname"): both need one run from a
// host that is simply on the public internet.
//
// .github/workflows/stable-hostname-live-verify.yml is that path: a
// dispatch-only, credential-free, proxy-free runner that executes the live
// harness and uploads the redacted result JSON. This test locks that
// contract down, so a later edit cannot quietly turn it into something that
// fires unattended, reads a credential, deploys, or runs behind a proxy
// again.
//
// Pure Node 22, no deps (node:test + node:assert). Reads the workflow from
// the repository tree; it makes no network call and needs no credentials.
//
// Run with: node --test tests/cloud/tests/stable-hostname-live-verify-workflow.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowPath = join(repoRoot, '.github/workflows/stable-hostname-live-verify.yml');
const harnessPath = join(repoRoot, 'tests/cloud/scripts/stable-hostname-verification.mjs');

const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';

// The executable content of the workflow: YAML comment lines are stripped so
// that prose about secrets cannot trip the credential guard, while a real
// reference (in a step, an env block or an `if:`) still does.
const executable = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('the live verification workflow exists and is non-empty', () => {
  assert.ok(existsSync(workflowPath), 'workflow file is missing');
  assert.ok(workflow.length > 0, 'workflow file is empty');
});

test('the harness it invokes exists in the tree', () => {
  assert.ok(existsSync(harnessPath), 'the AC5 live harness is missing');
});

test('it is dispatch-only, so it can never fire unattended', () => {
  assert.match(executable, /^\s*workflow_dispatch:/m);
  for (const trigger of [
    'push:',
    'pull_request:',
    'pull_request_target:',
    'schedule:',
    'workflow_run:',
    'repository_dispatch:',
  ]) {
    assert.ok(
      !new RegExp(`^\\s*${trigger}`, 'm').test(executable),
      `the workflow must not declare the ${trigger} trigger`,
    );
  }
});

test('it needs no credentials', () => {
  assert.ok(!executable.includes('secrets.'), 'the workflow must not reference a secret');
  assert.ok(
    !/^\s*environment:/m.test(executable),
    'the workflow must not require a GitHub environment',
  );
});

test('it clears the proxy environment so the request path is direct', () => {
  assert.match(
    workflow,
    /unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy/,
  );
  assert.match(workflow, /export NO_PROXY='\*'/);
});

test('it runs the live harness on a public-internet runner', () => {
  assert.match(workflow, /tests\/cloud\/scripts\/stable-hostname-verification\.mjs/);
  assert.match(workflow, /--mode live/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
});

test('it uploads the redacted result even when the harness fails', () => {
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /stable-hostname-verification\.json/);
});

test('it never deploys or touches a provider control plane', () => {
  for (const forbidden of [
    'fly deploy',
    'flyctl deploy',
    'vercel deploy',
    'fly secrets set',
    'fly certs add',
  ]) {
    assert.ok(
      !executable.includes(forbidden),
      `the workflow must not run a provider command: ${forbidden}`,
    );
  }
});
