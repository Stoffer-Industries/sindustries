#!/usr/bin/env node
// check-vercel-production-promotion-scope.test.mjs — task 1ac03ee8 static
// check (AC3 regression guard).
//
// Pure Node 22, no deps (node:test + node:assert). Exercises
// scripts/check-vercel-production-promotion-scope.mjs against a synthetic
// workflow that satisfies the contract, and against mutated copies that each
// break one rule, proving the guard can actually fail:
//
//   1. A workflow whose production path links the project and scopes every
//      mutating call to $VERCEL_ORG_ID passes.
//   2. A promotion without --scope fails.
//   3. An alias set without --scope fails.
//   4. A production path with no project link fails.
//   5. A link that hard-codes the project instead of using
//      $VERCEL_PROJECT_ID fails.
//   6. A scope bound to a literal team id fails.
//   7. A job whose VERCEL_ORG_ID does not come from the repository secret
//      fails.
//   8. A staging path that no longer creates the candidate fails.
//
// Run with: node --test tests/cloud/tests/check-vercel-production-promotion-scope.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-vercel-production-promotion-scope.mjs');

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
  '',
  'jobs:',
  '  deploy:',
  '    name: Deploy website to Vercel ${{ inputs.target }}',
  '    runs-on: ubuntu-latest',
  '    env:',
  '      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}',
  '      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}',
  '      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}',
  '    steps:',
  '      - name: Pull Vercel environment',
  '        if: inputs.target == \'staging\'',
  '        run: |',
  '          set -euo pipefail',
  '          vercel pull --yes --environment=preview --token="$VERCEL_TOKEN"',
  '',
  '      - name: Build Vercel output',
  '        if: inputs.target == \'staging\'',
  '        run: |',
  '          set -euo pipefail',
  '          vercel build --target=preview --token="$VERCEL_TOKEN"',
  '',
  '      - name: Deploy candidate to staging',
  '        if: inputs.target == \'staging\'',
  '        run: |',
  '          set -euo pipefail',
  '          DEPLOY_URL=$(vercel deploy --prebuilt --target=preview --token="$VERCEL_TOKEN")',
  '',
  '      - name: Link Vercel project and team scope',
  '        if: inputs.target == \'production\'',
  '        run: |',
  '          set -euo pipefail',
  '          vercel link --yes --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
  '',
  '      - name: Promote smoke-tested candidate',
  '        if: inputs.target == \'production\'',
  '        run: |',
  '          set -euo pipefail',
  '          vercel promote "$CANDIDATE_URL" --yes --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
  '          vercel alias set "$CANDIDATE_URL" "$PRODUCTION_DOMAIN" --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
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
  const dir = mkdtempSync(join(tmpdir(), 'check-vercel-production-promotion-scope-'));
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
  } catch (error) {
    err = error;
  }
  assert.ok(err, 'the checker passed a workflow that breaks the contract');
  const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  assert.match(output, expected);
}

test('a workflow whose production path scopes every mutating call passes', async () => {
  const { stdout } = await runChecker(GOOD_WORKFLOW);
  assert.match(stdout, /vercel production promotion scope check passed/);
});

test('a promotion without --scope fails', async () => {
  await expectFailure(
    mutate([
      [
        'vercel promote "$CANDIDATE_URL" --yes --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
        'vercel promote "$CANDIDATE_URL" --yes --token "$VERCEL_TOKEN"',
      ],
    ]),
    /runs `vercel promote` without `--scope`/,
  );
});

test('an alias set without --scope fails', async () => {
  await expectFailure(
    mutate([
      [
        'vercel alias set "$CANDIDATE_URL" "$PRODUCTION_DOMAIN" --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
        'vercel alias set "$CANDIDATE_URL" "$PRODUCTION_DOMAIN" --token "$VERCEL_TOKEN"',
      ],
    ]),
    /runs `vercel alias` without `--scope`/,
  );
});

test('a production path with no project link fails', async () => {
  await expectFailure(
    mutate([
      [
        [
          '      - name: Link Vercel project and team scope',
          '        if: inputs.target == \'production\'',
          '        run: |',
          '          set -euo pipefail',
          '          vercel link --yes --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
          '',
        ].join('\n'),
        '',
      ],
    ]),
    /never links the Vercel project/,
  );
});

test('a link that hard-codes the project fails', async () => {
  await expectFailure(
    mutate([
      [
        'vercel link --yes --project "$VERCEL_PROJECT_ID" --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
        'vercel link --yes --project sindustries --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
      ],
    ]),
    /links the project with `sindustries`/,
  );
});

test('a scope bound to a literal team id fails', async () => {
  await expectFailure(
    mutate([
      [
        'vercel promote "$CANDIDATE_URL" --yes --scope "$VERCEL_ORG_ID" --token "$VERCEL_TOKEN"',
        'vercel promote "$CANDIDATE_URL" --yes --scope team_NZ3r52L37LaEw7ujVOIKL1IW --token "$VERCEL_TOKEN"',
      ],
    ]),
    /a `--scope` argument is not the job-scope/,
  );
});

test('a job whose VERCEL_ORG_ID is not the repository secret fails', async () => {
  await expectFailure(
    mutate([
      [
        'VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}',
        'VERCEL_ORG_ID: ${{ secrets.SOME_OTHER_ORG }}',
      ],
    ]),
    /job-scope `VERCEL_ORG_ID` does not come from `secrets.VERCEL_ORG_ID`/,
  );
});

test('a staging path that no longer creates the candidate fails', async () => {
  await expectFailure(
    mutate([
      [
        'DEPLOY_URL=$(vercel deploy --prebuilt --target=preview --token="$VERCEL_TOKEN")',
        'echo "no deploy here"',
      ],
    ]),
    /the staging path no longer runs `vercel deploy`/,
  );
});
