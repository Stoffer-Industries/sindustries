/**
 * render-fly-config.mjs — merge an environment OVERLAY onto a shared Fly
 * config, producing the effective config Fly actually consumes.
 *
 * WHY AN OVERLAY
 * --------------
 * The platform and the health probe share almost all of their topology:
 * the same image, the same supervisor, the same router, the same migration
 * chain, the same one-process-group shape. Only a handful of values are
 * environment-owned — the Fly app name, the CORS allow-lists, the probe
 * cadence. Duplicating `platform.fly.toml` for production would put the
 * topology in two files, and the topology is the part that must not drift.
 *
 * So the shared file stays the DEFAULT (staging), and each environment
 * owns a small overlay that contains ONLY environment-owned values:
 *
 *   infra/cloud/fly/platform.fly.toml                                  (shared, default)
 *   infra/cloud/fly/platform.production.overlay.toml                   (environment-owned)
 *   -> infra/cloud/fly/build/platform.production.fly.toml              (effective)
 *
 * The overlay is deliberately narrow. An overlay may set the top-level
 * `app` key and keys inside the `[env]` table, and nothing else. That
 * restriction is enforced here rather than trusted, so an overlay can
 * never smuggle in a second source of truth for the topology (a second
 * `[processes]` table, a different build context, a different release
 * command) and quietly fork the platform.
 *
 * The `[env]` allow-list is KEY-level, not table-level: the overlay may
 * set only the five environment-owned values (the three CORS allow-lists
 * and the two probe cadences), and only those the shared config already
 * defines. A table-level allow-list would have let an overlay set
 * `NODE_ENV` or a new variable — the same class of fork the table
 * allow-list exists to prevent.
 *
 * The app name in the overlay is BOUND TO THE MANIFEST: when the
 * environment is known, the overlay's `app` must be one of that
 * environment's own app names. Without that binding an overlay edited to
 * `app = 'sindustries-platform-staging'` renders successfully, and the
 * production deploy then targets staging.
 *
 * The merge is LINE-ORIENTED, not parse-and-re-emit: every line of the
 * shared file that the overlay does not own is preserved byte for byte,
 * comments included. That keeps the shared file the single readable
 * description of the topology and keeps the diff between the shared file
 * and a rendered environment config to exactly the environment-owned lines.
 *
 * Usage:
 *   node infra/cloud/platform/render-fly-config.mjs \
 *     --shared infra/cloud/fly/platform.fly.toml \
 *     --overlay infra/cloud/fly/platform.production.overlay.toml \
 *     --out infra/cloud/fly/build/platform.production.fly.toml
 *
 * Exit codes:
 *   0 = rendered
 *   2 = usage error, unreadable input, or an overlay that carries keys
 *       this renderer is not allowed to set (fail closed — no partial
 *       render is written)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getPlatformEnvironment } from './platform-environments.mjs';

/** Tables an overlay may contribute to. */
const ALLOWED_OVERLAY_TABLES = new Set(['env']);

/** Top-level keys an overlay may set (outside any table). */
const ALLOWED_OVERLAY_KEYS = new Set(['app']);

/**
 * The `[env]` keys an overlay may set.
 *
 * These are the environment-owned values: the three CORS allow-lists and
 * the two probe cadences. Everything else in `[env]` belongs to the
 * shared topology (the router port, the status port, NODE_ENV, the
 * probe's own service name) and an overlay that could change it would
 * fork the app it is supposed to configure.
 */
const ALLOWED_OVERLAY_ENV_KEYS = new Set([
  'PLATFORM_TASKS_API_CORS_ALLOWED_ORIGINS',
  'PLATFORM_BUDGET_API_CORS_ALLOWED_ORIGINS',
  'PLATFORM_CONTENT_SCHEDULER_API_CORS_ALLOWED_ORIGINS',
  'FLY_APP_PROBE_INTERVAL_SECONDS',
  'DB_PROBE_INTERVAL_SECONDS',
]);

/**
 * Parse a single TOML assignment line.
 *
 * Only the shapes this repository actually uses are accepted: a bare key
 * and a single-quoted string value. Anything else is a caller error
 * rather than something to guess at.
 *
 * @param {string} line
 * @returns {{key: string, value: string}|null} null when the line is not
 *   an assignment (blank, comment, table header, or an unsupported shape)
 */
function parseAssignment(line) {
  const match = /^([A-Za-z0-9_-]+)\s*=\s*'([^']*)'\s*$/.exec(line);
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

/**
 * Parse an overlay file into the environment-owned values it may set.
 *
 * @param {string} text
 * @returns {{app: string|null, env: Record<string, string>}}
 * @throws {Error} when the overlay contains a key or table this renderer
 *   is not allowed to set
 */
export function parseOverlay(text) {
  const overlay = { app: null, env: {} };
  let table = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tableMatch = /^\[([^\]]+)\]$/.exec(line);
    if (tableMatch) {
      const name = tableMatch[1];
      if (!ALLOWED_OVERLAY_TABLES.has(name)) {
        throw new Error(
          `overlay may not define the [${name}] table — only ${[...ALLOWED_OVERLAY_TABLES]
            .map((t) => `[${t}]`)
            .join(' and ')} may be overridden; the topology is owned by the shared config`,
        );
      }
      table = name;
      continue;
    }

    const assignment = parseAssignment(line);
    if (!assignment) {
      throw new Error(
        `overlay contains an unsupported line: ${rawLine.trim()} — only ` +
          "top-level `app` and single-quoted [env] values are supported",
      );
    }

    if (table === null) {
      if (!ALLOWED_OVERLAY_KEYS.has(assignment.key)) {
        throw new Error(
          `overlay may not set the top-level key \`${assignment.key}\` — only ` +
            `${[...ALLOWED_OVERLAY_KEYS].map((k) => `\`${k}\``).join(' and ')} may be overridden`,
        );
      }
      overlay.app = assignment.value;
      continue;
    }

    if (!ALLOWED_OVERLAY_ENV_KEYS.has(assignment.key)) {
      throw new Error(
        `overlay may not set the [env] key \`${assignment.key}\` — an overlay may set only ` +
          `${[...ALLOWED_OVERLAY_ENV_KEYS].map((k) => `\`${k}\``).join(', ')}; every other ` +
          '[env] value belongs to the shared config',
      );
    }

    overlay.env[assignment.key] = assignment.value;
  }

  return overlay;
}

/**
 * Merge an overlay onto shared Fly config text.
 *
 * @param {string} sharedText
 * @param {{app: string|null, env: Record<string, string>}} overlay
 * @returns {string} the effective config text
 */
export function mergeFlyConfig(sharedText, overlay) {
  const lines = sharedText.split('\n');
  const out = [];
  let table = null;
  let seenApp = false;
  const emittedEnvKeys = new Set();

  // The env keys the SHARED config defines. An overlay may only set a
  // key the shared config already owns: an overlay value for a key the
  // shared config does not define would silently ADD an env var to the
  // rendered app — a new name the supervisor never reads, or worse, one
  // it does.
  const sharedEnvKeys = new Set();
  {
    let sharedTable = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const tableMatch = /^\[([^\]]+)\]$/.exec(line);
      if (tableMatch) {
        sharedTable = tableMatch[1];
        continue;
      }
      if (sharedTable !== 'env' || !line || line.startsWith('#')) continue;
      const assignment = parseAssignment(line);
      if (assignment) sharedEnvKeys.add(assignment.key);
    }
  }

  for (const key of Object.keys(overlay.env)) {
    if (!sharedEnvKeys.has(key)) {
      throw new Error(
        `overlay sets the [env] key \`${key}\`, which the shared config does not define — ` +
          'an overlay may only override a value the shared config already owns',
      );
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const tableMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (tableMatch) {
      // Leaving the [env] table: any overlay env key that the shared file
      // did not already define is appended here, so the rendered config
      // always carries every environment-owned value.
      if (table === 'env') {
        for (const [key, value] of Object.entries(overlay.env)) {
          if (emittedEnvKeys.has(key)) continue;
          out.push(`  ${key} = '${value}'`);
          emittedEnvKeys.add(key);
        }
      }
      table = tableMatch[1];
      out.push(line);
      continue;
    }

    const assignment = trimmed && !trimmed.startsWith('#') ? parseAssignment(trimmed) : null;

    if (assignment && table === null && assignment.key === 'app') {
      seenApp = true;
      out.push(overlay.app === null ? line : `app = '${overlay.app}'`);
      continue;
    }

    if (assignment && table === 'env' && Object.hasOwn(overlay.env, assignment.key)) {
      // Keep the shared file's indentation so the rendered config reads
      // like the file it came from rather than a machine rewrite.
      const indent = line.slice(0, line.length - line.trimStart().length);
      out.push(`${indent}${assignment.key} = '${overlay.env[assignment.key]}'`);
      emittedEnvKeys.add(assignment.key);
      continue;
    }

    out.push(line);
  }

  // The shared file ends with [env] as the last table: the appended keys
  // above only fire when a later table header follows. Close that gap.
  if (table === 'env') {
    for (const [key, value] of Object.entries(overlay.env)) {
      if (emittedEnvKeys.has(key)) continue;
      out.push(`  ${key} = '${value}'`);
      emittedEnvKeys.add(key);
    }
  }

  if (overlay.app !== null && !seenApp) {
    throw new Error('the shared Fly config has no top-level `app` key to override');
  }

  return out.join('\n');
}

/**
 * Build the provenance header stamped onto a rendered config.
 *
 * The shared file's own comment block is written for the default
 * (staging) environment, so a rendered production config would otherwise
 * open with a staging-titled header. The header states where the file
 * came from and which environment it was rendered for, so the inherited
 * comments are read as shared-topology notes rather than as facts about
 * this app.
 *
 * @param {{sharedPath: string, overlayPath?: string|null, environment?: string}} options
 * @returns {string}
 */
export function renderHeader({ sharedPath, overlayPath = null, environment = null }) {
  const lines = [
    '# GENERATED FILE — do not edit by hand.',
    '#',
    '# Rendered by infra/cloud/platform/render-fly-config.mjs.',
    `#   shared file:  ${sharedPath}`,
  ];
  if (overlayPath) lines.push(`#   overlay file: ${overlayPath}`);
  if (environment) lines.push(`#   environment:  ${environment}`);
  lines.push(
    '#',
    '# The shared file owns the topology; the overlay owns the environment-owned',
    '# values. Edit those two sources and re-render — an edit made here is lost',
    '# on the next render.',
    '#',
  );
  return lines.join('\n');
}

/**
 * Bind an overlay's app name to the environment manifest.
 *
 * The overlay's `app` is what Fly deploys to. An overlay edited to name
 * another environment's app renders successfully and then deploys
 * production to staging, so the renderer refuses an app name that is not
 * one of the environment's own apps.
 *
 * @param {string|null} app
 * @param {string} environmentId
 */
export function assertOverlayAppMatchesEnvironment(app, environmentId) {
  if (app === null) return;
  let environment;
  try {
    environment = getPlatformEnvironment(environmentId);
  } catch (error) {
    throw new Error(`unknown environment "${environmentId}" (${error.message})`);
  }
  const owned = [environment.platformApp, environment.healthProbeApp];
  if (!owned.includes(app)) {
    throw new Error(
      `overlay names app "${app}", which is not an app of the ${environmentId} environment — ` +
        `expected one of ${owned.map((name) => `"${name}"`).join(' or ')}`,
    );
  }
}

/**
 * Render the effective Fly config for one environment.
 *
 * @param {{sharedPath: string, overlayPath?: string|null, outPath?: string|null,
 *   environment?: string|null, stampHeader?: boolean}} options
 * @returns {{rendered: string, outPath: string|null}}
 */
export function renderFlyConfig({
  sharedPath,
  overlayPath = null,
  outPath = null,
  environment = null,
  stampHeader = true,
}) {
  const sharedText = readFileSync(resolve(sharedPath), 'utf8');
  const overlay = overlayPath
    ? parseOverlay(readFileSync(resolve(overlayPath), 'utf8'))
    : { app: null, env: {} };

  if (environment) assertOverlayAppMatchesEnvironment(overlay.app, environment);

  const merged = mergeFlyConfig(sharedText, overlay);
  const rendered = stampHeader
    ? `${renderHeader({ sharedPath, overlayPath, environment })}${merged}`
    : merged;

  if (outPath) {
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered, 'utf8');
  }

  return { rendered, outPath: outPath ? resolve(outPath) : null };
}

/**
 * Parse `--flag value` style arguments.
 *
 * @param {string[]} argv
 * @returns {{shared?: string, overlay?: string|null, out?: string|null,
 *   environment?: string|null}}
 */
function parseArgs(argv) {
  const args = { shared: undefined, overlay: null, out: null, environment: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      flag === '--shared' ||
      flag === '--overlay' ||
      flag === '--out' ||
      flag === '--environment'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === '--shared') args.shared = value;
      else if (flag === '--overlay') args.overlay = value;
      else if (flag === '--out') args.out = value;
      else args.environment = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

/**
 * CLI entry point.
 *
 * @param {string[]} [argv]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 2;
  }

  if (!args.shared) {
    console.error('::error::--shared <path> is required');
    return 2;
  }

  try {
    const { rendered, outPath } = renderFlyConfig({
      sharedPath: args.shared,
      overlayPath: args.overlay,
      outPath: args.out,
      environment: args.environment,
    });
    if (outPath) console.error(`rendered ${outPath}`);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
