#!/usr/bin/env node
/**
 * render-fly-config.test.mjs — contract tests for the environment overlay
 * renderer and the production Fly artefacts (task fb1240c0, Slice B).
 *
 * Slice B adds a production platform config and a production health-probe
 * config WITHOUT duplicating the staging topology. The topology lives in
 * one shared file; each environment owns a small overlay carrying only
 * environment-owned values. That split is only safe if the renderer is
 * strict and the overlays are provably in step with the manifest, so the
 * tests here cover three directions:
 *
 *   1. THE OVERLAY CANNOT FORK THE TOPOLOGY. An overlay may set `app` and
 *      `[env]` values and nothing else. A second `[processes]` table or a
 *      changed `release_command` in an overlay must fail closed, because
 *      either would silently fork the platform away from the shared file.
 *   2. THE OVERLAYS MATCH THE MANIFEST. The app names and CORS origins in
 *      the overlays are derived from the environment manifest. If the
 *      manifest moves and an overlay does not, the rendered config would
 *      point production at a stale app — so the two are bound here.
 *   3. PRODUCTION IS SEPARATE. The rendered production config must carry
 *      production values, must not carry staging hostnames, and must keep
 *      the one-app / one-process-group shape that makes the consolidated
 *      platform a single crash domain.
 *
 * No secret value appears in this file: every fixture is obviously fake.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/render-fly-config.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PLATFORM_ENVIRONMENTS } from '../platform-environments.mjs';
import { mergeFlyConfig, parseOverlay, renderFlyConfig } from '../render-fly-config.mjs';

const PLATFORM_SHARED = 'infra/cloud/fly/platform.fly.toml';
const PLATFORM_PRODUCTION_OVERLAY = 'infra/cloud/fly/platform.production.overlay.toml';
const HEALTH_PROBE_SHARED = 'infra/cloud/observability/health-probe/fly.toml';
const HEALTH_PROBE_PRODUCTION_OVERLAY =
  'infra/cloud/observability/health-probe/fly.production.overlay.toml';

/**
 * Resolve a repository-relative path from this test file's location.
 *
 * @param {string} relativePath
 * @returns {URL}
 */
function repoUrl(relativePath) {
  return new URL(`../../../../${relativePath}`, import.meta.url);
}

/**
 * Read a repository-relative file from the repo root.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function read(relativePath) {
  return readFileSync(repoUrl(relativePath), 'utf8');
}

/**
 * Extract the value of a single-quoted key from rendered TOML text.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
function valueOf(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'`, 'm').exec(text);
  return match ? match[1] : null;
}

/**
 * Count the occurrences of a table header in rendered TOML text.
 *
 * Handles both `[table]` and `[[table]]` (an array of tables, which Fly
 * uses for repeated blocks such as `[[vm]]`).
 *
 * @param {string} text
 * @param {string} table
 * @returns {number}
 */
function countTables(text, table) {
  const matches = text.match(new RegExp(`^\\[\\[*${table}\\]*\\]$`, 'gm'));
  return matches ? matches.length : 0;
}

/**
 * Extract the `[env]` table's assigned values from rendered TOML text.
 *
 * Only the VALUES are returned: the shared file's comment block legitimately
 * mentions staging (it describes the shared topology and the staging
 * cutover), so a whole-file search for a staging hostname would match
 * prose rather than a configuration fact.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function envValues(text) {
  const values = {};
  let inEnv = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^\[.*\]$/.test(line)) {
      inEnv = line === '[env]';
      continue;
    }
    if (!inEnv || !line || line.startsWith('#')) continue;
    const assignment = parseAssignmentForTest(line);
    if (assignment) values[assignment.key] = assignment.value;
  }
  return values;
}

/**
 * Parse a single-quoted TOML assignment.
 *
 * @param {string} line
 * @returns {{key: string, value: string}|null}
 */
function parseAssignmentForTest(line) {
  const match = /^([A-Za-z0-9_-]+)\s*=\s*'([^']*)'$/.exec(line);
  return match ? { key: match[1], value: match[2] } : null;
}

describe('overlay parsing fails closed', () => {
  it('rejects a top-level key other than app', () => {
    assert.throws(
      () => parseOverlay("app = 'x'\nprimary_region = 'syd'\n"),
      /may not set the top-level key/,
    );
  });

  it('rejects a table other than [env]', () => {
    assert.throws(
      () => parseOverlay("app = 'x'\n\n[processes]\n  platform = 'node x'\n"),
      /may not define the \[processes\] table/,
    );
  });

  it('rejects an unsupported line shape', () => {
    assert.throws(
      () => parseOverlay('[env]\n  PORT = 8080\n'),
      /unsupported line/,
    );
  });

  it('accepts app and [env] values', () => {
    const overlay = parseOverlay(
      "app = 'sindustries-platform-production'\n\n[env]\n" +
        "  PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS = 'https://mission-control.sindustries.co.nz'\n",
    );
    assert.equal(overlay.app, 'sindustries-platform-production');
    assert.deepEqual(overlay.env, {
      PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS: 'https://mission-control.sindustries.co.nz',
    });
  });

  it('rejects an [env] key outside the allow-list', () => {
    // The allow-list is KEY-level: an overlay that could set NODE_ENV or
    // the router port could fork the app it is supposed to configure.
    assert.throws(
      () => parseOverlay("app = 'x'\n\n[env]\n  NODE_ENV = 'development'\n"),
      /may not set the \[env\] key/,
    );
    assert.throws(
      () => parseOverlay("app = 'x'\n\n[env]\n  PLATFORM_ROUTER_PORT = '9999'\n"),
      /may not set the \[env\] key/,
    );
  });
});

describe('the overlay is bound to the environment manifest', () => {
  it('refuses an overlay that names another environment app', () => {
    // The app name is what Fly deploys to. An overlay edited to name the
    // staging app renders successfully and then deploys production to
    // staging, so the renderer refuses it.
    const directory = mkdtempSync(join(tmpdir(), 'render-fly-config-'));
    const overlayPath = join(directory, 'platform.staging.overlay.toml');
    writeFileSync(overlayPath, "app = 'sindustries-platform-staging'\n", 'utf8');
    try {
      assert.throws(
        () =>
          renderFlyConfig({
            sharedPath: repoUrl(PLATFORM_SHARED).pathname,
            overlayPath,
            environment: 'production',
          }).rendered,
        /overlay names app "sindustries-platform-staging".*renders the production platform app/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a probe overlay that names the platform app', () => {
    // The binding is to the app the SHARED CONFIG renders, not to "any
    // app of this environment". The probe's shared config renders the
    // probe app, so a probe overlay naming the platform app is a
    // mismatch even though both apps belong to production — and the
    // rendered config would then say the probe deploys to the platform
    // app.
    const directory = mkdtempSync(join(tmpdir(), 'render-fly-config-'));
    const overlayPath = join(directory, 'probe.platform-app.overlay.toml');
    writeFileSync(overlayPath, "app = 'sindustries-platform-production'\n", 'utf8');
    try {
      assert.throws(
        () =>
          renderFlyConfig({
            sharedPath: repoUrl(HEALTH_PROBE_SHARED).pathname,
            overlayPath,
            environment: 'production',
          }).rendered,
        /overlay names app "sindustries-platform-production".*renders the production health-probe app/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a platform overlay that names the probe app', () => {
    const directory = mkdtempSync(join(tmpdir(), 'render-fly-config-'));
    const overlayPath = join(directory, 'platform.probe-app.overlay.toml');
    writeFileSync(overlayPath, "app = 'sindustries-health-probe-production'\n", 'utf8');
    try {
      assert.throws(
        () =>
          renderFlyConfig({
            sharedPath: repoUrl(PLATFORM_SHARED).pathname,
            overlayPath,
            environment: 'production',
          }).rendered,
        /overlay names app "sindustries-health-probe-production".*renders the production platform app/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an overlay whose shared config is not a known artefact', () => {
    // The app is bound to the app the shared config renders. If the
    // shared config is not one of the environment's known artefacts,
    // that app cannot be determined — and an overlay that names an app
    // is refused rather than accepted unchecked.
    const directory = mkdtempSync(join(tmpdir(), 'render-fly-config-'));
    const sharedPath = join(directory, 'unknown.fly.toml');
    const overlayPath = join(directory, 'unknown.overlay.toml');
    writeFileSync(sharedPath, "app = 'sindustries-platform-staging'\n", 'utf8');
    writeFileSync(overlayPath, "app = 'sindustries-platform-production'\n", 'utf8');
    try {
      assert.throws(
        () =>
          renderFlyConfig({
            sharedPath,
            overlayPath,
            environment: 'production',
          }).rendered,
        /cannot tell which app the shared config .* renders/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an overlay env key the shared config does not define', () => {
    const shared = [
      "app = 'sindustries-platform-staging'",
      '',
      '[env]',
      "  NODE_ENV = 'production'",
      '',
    ].join('\n');
    assert.throws(
      () =>
        mergeFlyConfig(shared, {
          app: null,
          env: {
            PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS: 'https://mission-control.sindustries.co.nz',
          },
        }),
      /the shared config does not define/,
    );
  });
});

describe('the merge preserves the shared file', () => {
  it('renders the shared file unchanged when no overlay is given', () => {
    const shared = read(PLATFORM_SHARED);
    assert.equal(mergeFlyConfig(shared, { app: null, env: {} }), shared);
  });

  it('changes only the lines the overlay owns', () => {
    const shared = read(PLATFORM_SHARED);
    const rendered = mergeFlyConfig(shared, {
      app: 'sindustries-platform-production',
      env: { PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS: 'https://mission-control.sindustries.co.nz' },
    });

    const sharedLines = shared.split('\n');
    const renderedLines = rendered.split('\n');
    assert.equal(sharedLines.length, renderedLines.length);

    const changed = sharedLines
      .map((line, index) => (line === renderedLines[index] ? null : index))
      .filter((index) => index !== null);
    // Exactly two lines change: the top-level `app` and the one [env] value.
    assert.equal(changed.length, 2);
    assert.match(renderedLines[changed[0]], /^app = 'sindustries-platform-production'$/);
    assert.match(
      renderedLines[changed[1]],
      /^\s*PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS = 'https:\/\/mission-control\.sindustries\.co\.nz'$/,
    );
  });

  it('keeps the shared file indentation on an overridden [env] value', () => {
    const shared = read(PLATFORM_SHARED);
    const rendered = mergeFlyConfig(shared, {
      app: null,
      env: { PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS: 'https://tasks.sindustries.co.nz' },
    });
    assert.match(
      rendered,
      /^  PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS = 'https:\/\/tasks\.sindustries\.co\.nz'$/m,
    );
  });

  it('keeps a commented-out shared value as a comment', () => {
    const shared = [
      "app = 'sindustries-platform-staging'",
      '',
      '[env]',
      "  # PORT = '8080'",
      "  PORT = '8080'",
      '',
    ].join('\n');
    const rendered = mergeFlyConfig(shared, { app: null, env: { PORT: '9090' } });
    assert.match(rendered, /# PORT = '8080'/);
    assert.match(rendered, /^\s*PORT = '9090'$/m);
  });
});

describe('the production platform overlay matches the manifest', () => {
  const overlay = parseOverlay(read(PLATFORM_PRODUCTION_OVERLAY));
  const production = PLATFORM_ENVIRONMENTS.production;

  it('names the manifest production platform app', () => {
    assert.equal(overlay.app, production.platformApp);
  });

  it('carries the manifest production CORS origins', () => {
    assert.equal(
      overlay.env.PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS,
      production.corsAllowedOrigins.tasksApi.join(','),
    );
    assert.equal(
      overlay.env.PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS,
      production.corsAllowedOrigins.budgetApi.join(','),
    );
    assert.equal(
      overlay.env.PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS,
      production.corsAllowedOrigins.contentSchedulerApi.join(','),
    );
  });
});

describe('the rendered production platform config', () => {
  const rendered = renderFlyConfig({
    sharedPath: repoUrl(PLATFORM_SHARED).pathname,
    overlayPath: repoUrl(PLATFORM_PRODUCTION_OVERLAY).pathname,
    environment: 'production',
  }).rendered;

  it('deploys to the consolidated production app', () => {
    assert.equal(valueOf(rendered, 'app'), 'sindustries-platform-production');
  });

  it('keeps the one-app / one-process-group / one-http-service shape', () => {
    assert.equal(countTables(rendered, 'processes'), 1);
    assert.equal(countTables(rendered, 'http_service'), 1);
    assert.equal(countTables(rendered, 'vm'), 1);
    assert.match(rendered, /platform = 'node infra\/cloud\/platform\/platform-supervisor\.mjs'/);
  });

  it('keeps the shared image, migration chain and canary strategy', () => {
    const shared = read(PLATFORM_SHARED);
    assert.equal(valueOf(rendered, 'release_command'), valueOf(shared, 'release_command'));
    assert.match(rendered, /strategy = 'canary'/);
    assert.match(rendered, /dockerfile = '\.\.\/docker\/platform\.Dockerfile'/);
    assert.match(rendered, /context = '\.\.\/\.\.\/\.\.'/);
  });

  it('carries the production CORS origins and no staging hostname', () => {
    assert.equal(
      valueOf(rendered, 'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS'),
      'https://tasks.sindustries.co.nz,https://mission-control.sindustries.co.nz',
    );
    assert.equal(
      valueOf(rendered, 'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS'),
      'https://mission-control.sindustries.co.nz',
    );

    // The shared file's comment block legitimately mentions staging (it
    // documents the shared topology and the staging cutover), so the
    // separation check runs against the CONFIGURATION VALUES.
    const values = Object.values(envValues(rendered));
    for (const value of values) {
      assert.doesNotMatch(value, /\.staging\./);
      assert.doesNotMatch(value, /sindustries-platform-staging/);
    }
    assert.equal(valueOf(rendered, 'app'), 'sindustries-platform-production');
  });

  it('stamps the provenance of the rendered file', () => {
    assert.match(rendered, /^# GENERATED FILE — do not edit by hand\./m);
    assert.match(rendered, /^#   environment:  production$/m);
    assert.match(rendered, /^#   overlay file: .*platform\.production\.overlay\.toml$/m);
  });
});

describe('the production health-probe overlay', () => {
  const overlay = parseOverlay(read(HEALTH_PROBE_PRODUCTION_OVERLAY));
  const production = PLATFORM_ENVIRONMENTS.production;

  it('names the manifest production health-probe app', () => {
    assert.equal(overlay.app, production.healthProbeApp);
  });

  it('tightens the Fly-app cadence to two minutes and the DB cadence to hourly', () => {
    assert.equal(overlay.env.FLY_APP_PROBE_INTERVAL_SECONDS, '120');
    assert.equal(overlay.env.DB_PROBE_INTERVAL_SECONDS, '3600');
  });

  it('is strictly tighter than the staging daily cadence', () => {
    const shared = read(HEALTH_PROBE_SHARED);
    const stagingFly = Number(valueOf(shared, 'FLY_APP_PROBE_INTERVAL_SECONDS'));
    const stagingDb = Number(valueOf(shared, 'DB_PROBE_INTERVAL_SECONDS'));
    assert.ok(
      Number(overlay.env.FLY_APP_PROBE_INTERVAL_SECONDS) < stagingFly,
      'production Fly-app cadence must be tighter than staging',
    );
    assert.ok(
      Number(overlay.env.DB_PROBE_INTERVAL_SECONDS) < stagingDb,
      'production DB cadence must be tighter than staging',
    );
  });

  it('renders without touching the shared probe topology', () => {
    const rendered = renderFlyConfig({
      sharedPath: repoUrl(HEALTH_PROBE_SHARED).pathname,
      overlayPath: repoUrl(HEALTH_PROBE_PRODUCTION_OVERLAY).pathname,
      environment: 'production',
    }).rendered;

    assert.equal(valueOf(rendered, 'app'), 'sindustries-health-probe-production');
    assert.equal(valueOf(rendered, 'FLY_APP_PROBE_INTERVAL_SECONDS'), '120');
    assert.equal(valueOf(rendered, 'DB_PROBE_INTERVAL_SECONDS'), '3600');
    assert.match(rendered, /PROBE_INTERVAL_SECONDS = '30'/);
    assert.equal(countTables(rendered, 'vm'), 1);
  });
});
