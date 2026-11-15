#!/usr/bin/env node
// check-production-blockers-register.test.mjs — task 5cb4a8fe AC6 static check test.
//
// Pure Node, no deps (uses node:test + node:assert). Exercises
// scripts/check-production-blockers-register.mjs against synthetic trees:
//
//   1. A synthetic tree where every public surface has a §1 DNS row
//      carrying the matrix's exact contract identifier, and the
//      non-public surface has a hostname-less row, passes.
//   2. A synthetic tree where a public surface has no register row
//      fails (coverage).
//   3. A synthetic tree where a §1 row names the right hostname but the
//      wrong project/app identifier fails (contract drift).
//   4. A synthetic tree where the identifier is only a PREFIX of the
//      matrix value (`sindustries-tasks` for the `sindustries-tasks-api`
//      surface) fails — substring matching would wrongly pass here.
//   5. A synthetic tree where the non-public surface has no
//      hostname-less row fails.
//   6. A synthetic tree where only a non-§1 row names the hostname and
//      carries the right identifier, while the §1 DNS row names the
//      wrong project, fails — the §1 table is the one an operator
//      follows, so it must carry the matrix identifier itself.
//   7. A synthetic tree where the §1 row names the right identifier and
//      a wrong identifier in the same cell fails.
//   8. A synthetic tree where the §1 DNS row is deleted outright fails.
//   9. A synthetic tree where a row outside §1 names the production
//      hostname with a different project/app identifier fails.
//  10. A synthetic tree where the non-public surface says "Not
//      applicable" without the literal token "none" passes — the
//      no-hostname markers are matched against normalised text.
//  11. A synthetic tree where the non-public surface is also given a
//      hostname row fails.
//  12. A synthetic tree where the matrix records a surface kind the
//      check has no identifier rule for fails (no silent skip).
//  13. A synthetic tree whose §1 CNAME target disagrees with the
//      matrix's `cnameTargets.production` fails.
//  14. A synthetic tree where the hostname cell names a different
//      hostname (`eu.health-probe…`) fails — hostnames match as exact
//      code spans, not as substrings.
//  15. The real repo tree passes.
//
// The test fixtures are constructed to avoid depending on the real tree's
// register contents; the real tree is scanned by running the script
// directly.
//
// Run with: node --test tests/cloud/tests/check-production-blockers-register.test.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exec = promisify(execFile);
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'tests/cloud/scripts/check-production-blockers-register.mjs');

const MATRIX = JSON.stringify({
  apexDomain: 'sindustries.co.nz',
  stagingSubdomainSuffix: 'staging.sindustries.co.nz',
  surfaces: [
    {
      id: 'mission-control',
      kind: 'frontend',
      vercelProject: 'sindustries-mission-control',
      staging: 'mission-control.staging.sindustries.co.nz',
      production: 'mission-control.sindustries.co.nz',
      cnameTargets: { production: 'cname.vercel-dns.com' },
    },
    {
      id: 'tasks-app',
      kind: 'frontend',
      vercelProject: 'sindustries-tasks',
      staging: 'tasks.staging.sindustries.co.nz',
      production: 'tasks.sindustries.co.nz',
      cnameTargets: { production: 'cname.vercel-dns.com' },
    },
    {
      id: 'tasks-api',
      kind: 'api',
      flyApp: 'sindustries-tasks-api',
      staging: 'tasks-api.staging.sindustries.co.nz',
      production: 'tasks-api.sindustries.co.nz',
      cnameTargets: { production: 'sindustries-tasks-api.fly.dev' },
    },
    {
      id: 'health-probe',
      kind: 'api',
      flyApp: 'sindustries-health-probe',
      staging: 'health-probe.staging.sindustries.co.nz',
      production: 'health-probe.sindustries.co.nz',
      cnameTargets: { production: 'sindustries-health-probe.fly.dev' },
    },
    {
      id: 'auto-post-worker',
      kind: 'worker',
      flyApp: 'sindustries-auto-post-worker',
      staging: null,
      production: null,
      publicUrl: false,
    },
  ],
});

const DNS_SECTION = [
  '## Blockers',
  '',
  '### 1. DNS — apex + per-hostname records',
  '',
  '| Surface | Production hostname | Required DNS record | CNAME target (matrix contract) | Owner | Status |',
  '| --- | --- | --- | --- | --- | --- |',
].join('\n');

// The §3 table deliberately names a DIFFERENT project in its "actually
// bound" column — that divergence is what the register exists to record,
// so it must not trip the identifier-set rule.
const BOUND_SECTION = [
  '### 3. Vercel custom domain registration',
  '',
  '| Matrix contract project | Custom domain (production) | Custom domain (preview → staging) | Actually bound in Vercel | Owner | Status |',
  '| --- | --- | --- | --- | --- | --- |',
  '| `sindustries-mission-control` | `mission-control.sindustries.co.nz` | `mission-control.staging.sindustries.co.nz` | `sindustries-mission-control-staging` | Quinn | Staging bound |',
  '| `sindustries-tasks` | `tasks.sindustries.co.nz` | `tasks.staging.sindustries.co.nz` | `sindustries-tasks-app-staging` | Quinn | Staging bound |',
].join('\n');

const DNS_ROWS = {
  apex: '| Apex | `sindustries.co.nz` | apex A/ALIAS to Vercel (frontends) or Fly (apis) | — | Quinn | Pending |',
  missionControl:
    '| Mission Control | `mission-control.sindustries.co.nz` | CNAME → Vercel project `sindustries-mission-control` | `cname.vercel-dns.com` | Quinn | Pending |',
  tasksApp:
    '| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks` | `cname.vercel-dns.com` | Quinn | Pending |',
  tasksApi:
    '| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → Fly app `sindustries-tasks-api` | `sindustries-tasks-api.fly.dev` | Quinn | Pending |',
  healthProbe:
    '| Health probe | `health-probe.sindustries.co.nz` | CNAME → Fly app `sindustries-health-probe` | `sindustries-health-probe.fly.dev` | Quinn | Pending |',
  worker:
    '| Auto-post worker | _(none — no public URL)_ | n/a — the worker has no HTTP surface | — | — | Not applicable |',
};

function register(dnsRows, boundSection = BOUND_SECTION) {
  return [
    '# Production hostname blockers',
    '',
    DNS_SECTION,
    ...dnsRows,
    '',
    boundSection,
    '',
  ].join('\n');
}

const GOOD_REGISTER = register([
  DNS_ROWS.apex,
  DNS_ROWS.missionControl,
  DNS_ROWS.tasksApp,
  DNS_ROWS.tasksApi,
  DNS_ROWS.healthProbe,
  DNS_ROWS.worker,
]);

function makeTree(registerText, matrixText = MATRIX) {
  const dir = mkdtempSync(join(tmpdir(), 'check-production-blockers-register-'));
  const files = {
    'infra/cloud/hostname-matrix.json': matrixText,
    'docs/cloud/production-blockers.md': registerText,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

async function runCheck(treeDir) {
  try {
    const { stdout } = await exec('node', [SCRIPT, treeDir]);
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('passes when every public surface has a §1 DNS row carrying the exact matrix identifier', async () => {
  const dir = makeTree(GOOD_REGISTER);
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 0, `expected pass, got:\n${result.stderr}`);
    assert.match(result.stdout, /production-blockers-register check passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when a public surface has no row in the register', async () => {
  const dir = makeTree(
    register([DNS_ROWS.apex, DNS_ROWS.missionControl, DNS_ROWS.tasksApi, DNS_ROWS.healthProbe, DNS_ROWS.worker])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-app: no row in the §1 DNS table of .*production-blockers\.md.*names the production hostname tasks\.sindustries\.co\.nz/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the row names the right hostname but the wrong project identifier', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      '| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks-app` | `cname.vercel-dns.com` | Quinn | Pending |',
      DNS_ROWS.tasksApi,
      DNS_ROWS.healthProbe,
      DNS_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-app: the §1 DNS row for tasks\.sindustries\.co\.nz must name the matrix vercelProject `sindustries-tasks` as an exact code span/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the identifier is only a prefix of the matrix value', async () => {
  // `sindustries-tasks` is a substring of `sindustries-tasks-api`; a
  // substring comparison would wrongly accept this row.
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      DNS_ROWS.tasksApp,
      '| Tasks API | `tasks-api.sindustries.co.nz` | CNAME → Fly app `sindustries-tasks` | `sindustries-tasks-api.fly.dev` | Quinn | Pending |',
      DNS_ROWS.healthProbe,
      DNS_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-api: the §1 DNS row for tasks-api\.sindustries\.co\.nz must name the matrix flyApp `sindustries-tasks-api` as an exact code span/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the non-public surface has no hostname-less row', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      DNS_ROWS.tasksApp,
      DNS_ROWS.tasksApi,
      DNS_ROWS.healthProbe,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(result.stderr, /auto-post-worker: the matrix records publicUrl:false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when only a non-§1 row names the hostname and the §1 row names the wrong project', async () => {
  // The green-but-wrong state: §3 carries the matrix identifier for the
  // Tasks app, so a document-wide check stays green while the table an
  // operator follows points at the wrong project.
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      '| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks-api` | `cname.vercel-dns.com` | Quinn | Pending |',
      DNS_ROWS.tasksApi,
      DNS_ROWS.healthProbe,
      DNS_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-app: the §1 DNS row for tasks\.sindustries\.co\.nz must name the matrix vercelProject `sindustries-tasks` as an exact code span/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the §1 row names the right identifier and a wrong identifier in the same cell', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      '| Tasks app | `tasks.sindustries.co.nz` | CNAME → Vercel project `sindustries-tasks` (staging: `sindustries-tasks-app-staging`) | `cname.vercel-dns.com` | Quinn | Pending |',
      DNS_ROWS.tasksApi,
      DNS_ROWS.healthProbe,
      DNS_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-app: the §1 DNS row for tasks\.sindustries\.co\.nz names more than one project\/app identifier/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the §1 DNS row is deleted outright', async () => {
  const dir = makeTree(
    register([DNS_ROWS.apex, DNS_ROWS.missionControl, DNS_ROWS.tasksApi, DNS_ROWS.healthProbe, DNS_ROWS.worker])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-app: no row in the §1 DNS table of .*production-blockers\.md.*names the production hostname tasks\.sindustries\.co\.nz/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when a row outside §1 names the production hostname with a different project', async () => {
  const dir = makeTree(
    register(
      [
        DNS_ROWS.apex,
        DNS_ROWS.missionControl,
        DNS_ROWS.tasksApp,
        DNS_ROWS.tasksApi,
        DNS_ROWS.healthProbe,
        DNS_ROWS.worker,
      ],
      [
        '### 3. Vercel custom domain registration',
        '',
        '| Matrix contract project | Custom domain (production) | Actually bound in Vercel | Owner | Status |',
        '| --- | --- | --- | --- | --- |',
        '| `sindustries-tasks-app` | `tasks.sindustries.co.nz` | `sindustries-tasks-app-staging` | Quinn | Staging bound |',
        '',
      ].join('\n')
    )
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /tasks-app: a row in .*production-blockers\.md that names tasks\.sindustries\.co\.nz also names a different project\/app identifier \(`sindustries-tasks-app`\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passes when the non-public surface says "Not applicable" without the literal token "none"', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      DNS_ROWS.tasksApp,
      DNS_ROWS.tasksApi,
      DNS_ROWS.healthProbe,
      '| Auto-post worker | _(no public URL)_ | n/a — the worker has no HTTP surface | — | — | Not applicable |',
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 0, `expected pass, got:\n${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the non-public surface is also given a hostname row', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      DNS_ROWS.tasksApp,
      DNS_ROWS.tasksApi,
      DNS_ROWS.healthProbe,
      DNS_ROWS.worker,
      '| Auto-post worker | `auto-post.sindustries.co.nz` | CNAME → Fly app `sindustries-auto-post-worker` | `sindustries-auto-post-worker.fly.dev` | Quinn | Pending |',
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /auto-post-worker: the matrix records publicUrl:false, but the §1 DNS table row for auto-post-worker gives it the hostname auto-post\.sindustries\.co\.nz/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the matrix records a surface kind the check has no identifier rule for', async () => {
  const matrix = JSON.parse(MATRIX);
  matrix.surfaces[0].kind = 'edge';
  const dir = makeTree(GOOD_REGISTER, JSON.stringify(matrix));
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /mission-control: the matrix records surface kind "edge" with a production hostname, but this check has no contract-identifier rule for that kind/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the §1 CNAME target disagrees with the matrix', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      DNS_ROWS.tasksApp,
      DNS_ROWS.tasksApi,
      '| Health probe | `health-probe.sindustries.co.nz` | CNAME → Fly app `sindustries-health-probe` | `sindustries-platform.fly.dev` | Quinn | Pending |',
      DNS_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /health-probe: the §1 DNS row for health-probe\.sindustries\.co\.nz must record the matrix cnameTargets\.production `sindustries-health-probe\.fly\.dev`/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails when the hostname cell names a different hostname', async () => {
  const dir = makeTree(
    register([
      DNS_ROWS.apex,
      DNS_ROWS.missionControl,
      DNS_ROWS.tasksApp,
      DNS_ROWS.tasksApi,
      '| Health probe | `eu.health-probe.sindustries.co.nz` | CNAME → Fly app `sindustries-health-probe` | `sindustries-health-probe.fly.dev` | Quinn | Pending |',
      DNS_ROWS.worker,
    ])
  );
  try {
    const result = await runCheck(dir);
    assert.equal(result.code, 1, 'expected failure');
    assert.match(
      result.stderr,
      /health-probe: no row in the §1 DNS table of .*production-blockers\.md.*names the production hostname health-probe\.sindustries\.co\.nz/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repo tree passes', async () => {
  const { stdout } = await exec('node', [SCRIPT]);
  assert.match(stdout, /production-blockers-register check passed/);
});
