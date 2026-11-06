#!/usr/bin/env node
// check-vercel-deploy-target.test.mjs — task 37622d4f static check
// (AC2 + AC4 regression guard).
//
// Pure Node 22, no deps (node:test + node:assert). Exercises
// scripts/check-vercel-deploy-target.mjs against a synthetic workflow
// that satisfies the contract, and against mutated copies that each
// break one rule, proving the guard can actually fail:
//
//   1. A workflow that resolves one shared VERCEL_TARGET and uses it for
//      pull, build, and deploy passes.
//   2. A build step that decides the target itself (`--prod`) fails.
//   3. A deploy step without `--skip-domain` fails.
//   4. A pull step that hard-codes its environment fails.
//   5. A step that re-evaluates `production-candidate` fails.
//   6. A deploy step whose target drifts from the build target fails.
//
// Run with: node --test tests/cloud/tests/check-vercel-deploy-target.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-vercel-deploy-target.mjs');

const GOOD_WORKFLOW = [
  'name: Website Deploy',
  '',
  'on:',
  '  workflow_call:',
  '    inputs:',
  '      target:',
  '        description: Deployment target (staging or production)',
  '        required: true',
  '        type: string',
  '      production-candidate:',
  '        description: Build staging with production configuration',
  '        required: false',
  '        default: false',
  '        type: boolean',
  '',
  'jobs:',
  '  deploy:',
  '    name: Deploy website to Vercel ${{ inputs.target }}',
  '    runs-on: ubuntu-latest',
  '    env:',
  '      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}',
  '      # One Vercel target decision for the whole job.',
  '      VERCEL_TARGET: ${{ inputs.production-candidate && \'production\' || \'preview\' }}',
  '    steps:',
  '      - name: Pull Vercel environment',
  '        if: inputs.target == \'staging\'',
  '        run: |',
  '          set -euo pipefail',
  '          vercel pull --yes --environment="$VERCEL_TARGET" --token="$VERCEL_TOKEN"',
  '',
  '      - name: Build Vercel output',
  '        if: inputs.target == \'staging\'',
  '        run: |',
  '          set -euo pipefail',
  '          vercel build --target="$VERCEL_TARGET" --token="$VERCEL_TOKEN"',
  '',
  '      - name: Deploy candidate to staging',
  '        if: inputs.target == \'staging\'',
  '        id: staging_deploy',
  '        run: |',
  '          set -euo pipefail',
  '          deploy_args=(--prebuilt --target="$VERCEL_TARGET")',
  '          if [ "$VERCEL_TARGET" = production ]; then',
  '            deploy_args+=(--skip-domain)',
  '          fi',
  '          DEPLOY_URL=$(vercel deploy "${deploy_args[@]}" --token="$VERCEL_TOKEN")',
  '          vercel alias set "$DEPLOY_URL" "$STAGING_DOMAIN" --token="$VERCEL_TOKEN"',
  '          echo "url=$DEPLOY_URL" >> "$GITHUB_OUTPUT"',
  '',
  '      - name: Smoke check staging candidate',
  '        if: inputs.target == \'staging\'',
  '        run: |',
  '          set -euo pipefail',
  '          URL="${{ steps.staging_deploy.outputs.url }}"',
  '          curl --fail --silent --show-error --max-time 15 "$URL"',
  '',
].join('\n');

function mutate(replacements) {
  let text = GOOD_WORKFLOW;
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `fixture mutation target not found: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}

function makeTree(workflow) {
  const dir = mkdtempSync(join(tmpdir(), 'check-vercel-deploy-target-'));
  const path = join(dir, '.github/workflows/website-deploy.yml');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(path, workflow);
  return dir;
}

async function runChecker(workflow) {
  const dir = makeTree(workflow);
  try {
    return await exec('node', [SCRIPT, dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function expectFailure(workflow, expected) {
  let err;
  try {
    await runChecker(workflow);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected the checker to fail');
  const combined = (err.stderr || '') + (err.stdout || '');
  assert.match(combined, expected, `expected the error to match ${expected}, got: ${combined}`);
}

test('synthetic workflow: one shared VERCEL_TARGET drives pull, build, and deploy', async () => {
  const { stdout, stderr } = await runChecker(GOOD_WORKFLOW);
  assert.match(stdout, /vercel deploy target check passed/, `expected the pass line on stdout, got: ${stdout}`);
  assert.equal(stderr, '', `expected empty stderr, got: ${stderr}`);
});

test('synthetic workflow: a build step that decides the target itself fails', async () => {
  const workflow = mutate([
    ['vercel build --target="$VERCEL_TARGET" --token="$VERCEL_TOKEN"', 'vercel build --prod --token="$VERCEL_TOKEN"'],
  ]);
  await expectFailure(workflow, /does not consume the shared `VERCEL_TARGET`/);
  await expectFailure(workflow, /uses `--prod`/);
});

test('synthetic workflow: a deploy step without --skip-domain fails', async () => {
  const workflow = mutate([
    ['            deploy_args+=(--skip-domain)\n', ''],
  ]);
  await expectFailure(workflow, /does not pass `--skip-domain`/);
});

test('synthetic workflow: a pull step that hard-codes its environment fails', async () => {
  const workflow = mutate([
    ['vercel pull --yes --environment="$VERCEL_TARGET" --token="$VERCEL_TOKEN"', 'vercel pull --yes --environment=preview --token="$VERCEL_TOKEN"'],
  ]);
  await expectFailure(workflow, /step "Pull Vercel environment" does not consume the shared `VERCEL_TARGET`/);
});

test('synthetic workflow: a step that re-evaluates production-candidate fails', async () => {
  const workflow = mutate([
    [
      '          vercel build --target="$VERCEL_TARGET" --token="$VERCEL_TOKEN"',
      '          if [ "${{ inputs.production-candidate }}" = "true" ]; then\n'
      + '            vercel build --prod --token="$VERCEL_TOKEN"\n'
      + '          else\n'
      + '            vercel build --target="$VERCEL_TARGET" --token="$VERCEL_TOKEN"\n'
      + '          fi',
    ],
  ]);
  await expectFailure(workflow, /still evaluate `production-candidate`/);
});

test('synthetic workflow: a deploy step whose target drifts from the build target fails', async () => {
  const workflow = mutate([
    ['deploy_args=(--prebuilt --target="$VERCEL_TARGET")', 'deploy_args=(--prebuilt --target=preview)'],
  ]);
  await expectFailure(workflow, /step "Deploy candidate to staging" does not consume the shared `VERCEL_TARGET`/);
});
