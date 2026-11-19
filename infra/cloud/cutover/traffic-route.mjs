/**
 * traffic-route.mjs — the route adapter for the SIndustries production
 * cutover (task 020f423e).
 *
 * WHAT THE ROUTE IS
 * -----------------
 * The cutover's route is the BINDING of each in-scope surface to an
 * origin: the prodlike origin (the local stack that holds the rollback
 * source) or the production origin (the consolidated Fly platform).
 *
 * This deployment has no weighted load balancer between two live
 * origins — the stable hostnames CNAME at the cloud platform, and the
 * callers resolve their base URL from the environment they run in. So
 * the route adapter is NOT a traffic splitter: it is the guarded
 * control plane that owns WHICH ORIGIN EACH SURFACE IS BOUND TO, and
 * the cutover scripts drive it through a fixed phase order.
 *
 * The approved tech design anticipated this case explicitly: "If the
 * provider cannot do weighted traffic, it must support an atomic
 * health-checked origin switch at the stable front-door; DNS TTL alone
 * does not satisfy the interface." The binding switch is atomic per
 * run, health-checked before and after, and reversible — which is the
 * property the design was actually protecting.
 *
 * WHY COMPARE-AND-SET
 * -------------------
 * A cutover window has more than one pair of hands in it. Two
 * operators, or an operator and a retry, must not be able to silently
 * overwrite each other's route change. Every write therefore carries
 * the route VERSION the operator believed was live, and is refused if
 * the live version has moved. This is the same guard the cloud
 * database harness uses for its production acknowledgement, expressed
 * on the route instead of the database.
 *
 * The adapter holds NO credentials and makes NO provider calls: the
 * route state is a repo-owned operator artifact, and the adapter's job
 * is to make a mistake impossible to make silently.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { baseUrlFor, inScopeSurfaces, loadManifest, rollbackSurfaces } from './manifest.mjs';

/** The route state version the adapter writes. */
export const ROUTE_STATE_VERSION = 1;

/** The bindings a route may hold. */
export const ROUTE_BINDINGS = ['prodlike', 'production'];

/**
 * The default route state path. The state is an OPERATOR ARTIFACT, not
 * a source file: it lives under the artifact directory the manifest
 * names, and it is never committed.
 */
export const DEFAULT_STATE_FILE = 'artifacts/cutover/production-route.json';

/**
 * @param {string} stateFile
 * @returns {object} the live route state
 */
export function readRouteState(stateFile) {
  if (!existsSync(stateFile)) {
    return {
      version: 0,
      environment: null,
      binding: null,
      surfaces: {},
      updatedAt: null,
      runId: null,
      history: [],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    throw new Error(`traffic-route: route state at ${stateFile} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

/**
 * Write the route state ATOMICALLY: the new state is written beside
 * its destination and renamed into place, so an interrupted write
 * cannot leave a half-written route state that the next operator reads
 * as a real binding.
 *
 * @param {string} stateFile
 * @param {object} state
 */
export function writeRouteState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
}

/**
 * The route state a manifest implies for a given binding: every
 * in-scope surface bound to the chosen origin, and the documented
 * rollback surfaces left where they are.
 *
 * @param {object} manifest
 * @param {string} binding
 * @returns {object} surface -> binding
 */
export function targetBindings(manifest, binding) {
  const bindings = {};
  for (const surface of manifest.surfaces) {
    bindings[surface.id] = surface.rollbackSurface ? 'prodlike' : binding;
  }
  return bindings;
}

/**
 * `plan` — the diff between the live route and the route a binding
 * would produce. This is the read-only half of the adapter: it never
 * writes, so an operator can see exactly what a switch would change
 * before confirming it.
 *
 * @param {object} manifest
 * @param {object} live
 * @param {string} binding
 * @returns {object} a plan document
 */
export function planBinding(manifest, live, binding) {
  const target = targetBindings(manifest, binding);
  const changes = [];
  for (const [surfaceId, wanted] of Object.entries(target)) {
    const surface = manifest.surfaces.find((s) => s.id === surfaceId);
    const current = live.surfaces?.[surfaceId] ?? null;
    // A surface that has never been bound is not "moved" by the switch.
    // For the documented rollback surface an unbound state simply means
    // it has not been touched, and it must not appear as something the
    // switch would move — it is retained exactly as it is.
    const initialBinding = current === null;
    const retainedRollbackSurface = initialBinding && Boolean(surface?.rollbackSurface);
    if (current !== wanted && !retainedRollbackSurface) {
      changes.push({
        surface: surfaceId,
        from: current,
        to: wanted,
        callerClass: surface?.callerClass ?? null,
        rollbackSurface: Boolean(surface?.rollbackSurface),
        url: baseUrlFor(manifest, surfaceId, wanted),
      });
    }
  }
  return {
    manifestVersion: manifest.manifestVersion,
    environment: manifest.environment,
    currentBinding: live.binding ?? null,
    currentVersion: live.version ?? 0,
    requestedBinding: binding,
    changes,
    rollbackSurfaces: rollbackSurfaces(manifest).map((s) => ({
      surface: s.id,
      binding: target[s.id],
      url: s.prodlikeBaseUrl,
      reason: 'documented rollback surface — retained until Tom accepts the observation period',
    })),
  };
}

/**
 * `set` — apply a binding with compare-and-set.
 *
 * @param {object} manifest
 * @param {object} live the route state read BEFORE the write
 * @param {object} options
 * @param {string} options.binding the binding to apply
 * @param {number} options.expectedVersion the version the operator believed was live
 * @param {string} options.runId the immutable run identifier
 * @param {string} options.confirm must equal the run id
 * @returns {object} the new route state
 */
export function applyBinding(manifest, live, { binding, expectedVersion, runId, confirm }) {
  if (!ROUTE_BINDINGS.includes(binding)) {
    throw new Error(
      `traffic-route: unknown binding ${JSON.stringify(binding)} (expected one of ${ROUTE_BINDINGS.join(', ')})`,
    );
  }
  if (!runId || runId.trim() === '') {
    throw new Error('traffic-route: --run-id is required');
  }
  if (confirm !== runId) {
    throw new Error(
      'traffic-route: --confirm must equal the run id — a mistyped confirmation must not move the route',
    );
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new Error('traffic-route: --expected-version must be a non-negative integer');
  }
  const liveVersion = live.version ?? 0;
  if (liveVersion !== expectedVersion) {
    throw new Error(
      `traffic-route: route version moved underneath this operator (live ${liveVersion}, expected ${expectedVersion}) — re-read the route with 'traffic-route get' before applying a change`,
    );
  }
  if (live.environment && live.environment !== manifest.environment) {
    throw new Error(
      `traffic-route: the live route belongs to environment ${live.environment} but the manifest declares ${manifest.environment}`,
    );
  }

  const now = new Date().toISOString();
  const next = {
    version: liveVersion + 1,
    environment: manifest.environment,
    binding,
    surfaces: targetBindings(manifest, binding),
    updatedAt: now,
    runId,
    history: [
      ...(Array.isArray(live.history) ? live.history : []),
      {
        version: liveVersion + 1,
        binding,
        runId,
        at: now,
        fromVersion: liveVersion,
      },
    ],
  };
  return next;
}

/**
 * `wait` — poll the route state until it shows the expected binding
 * at or beyond the expected version.
 *
 * @param {string} stateFile
 * @param {object} options
 * @param {string} options.binding
 * @param {number} options.expectedVersion
 * @param {number} options.timeoutSeconds
 * @param {number} [options.pollMs]
 * @returns {object} the observed state
 */
export function waitForBinding(stateFile, { binding, expectedVersion, timeoutSeconds, pollMs = 1000 }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let observed = readRouteState(stateFile);
  while (Date.now() < deadline) {
    observed = readRouteState(stateFile);
    if (observed.binding === binding && (observed.version ?? 0) >= expectedVersion) {
      return observed;
    }
    // The adapter is synchronous on purpose: the caller is a shell
    // script that polls. Sleeping here keeps the wait logic in ONE
    // place rather than duplicated in bash.
    const until = Math.min(pollMs, Math.max(0, deadline - Date.now()));
    if (until > 0) {
      const shared = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(shared, 0, 0, until);
    }
  }
  throw new Error(
    `traffic-route: timed out after ${timeoutSeconds}s waiting for binding ${binding} at version >= ${expectedVersion} (observed ${observed.binding} at version ${observed.version ?? 0})`,
  );
}

/**
 * The read-back the switch gate requires: which surfaces still resolve
 * to prodlike, and whether each one is a documented rollback surface.
 *
 * @param {object} manifest
 * @param {object} live
 * @returns {object} a read-back document
 */
export function prodlikeReadBack(manifest, live) {
  const stillProdlike = [];
  for (const surface of inScopeSurfaces(manifest)) {
    const binding = live.surfaces?.[surface.id] ?? null;
    if (binding === 'prodlike') {
      stillProdlike.push({
        surface: surface.id,
        callerClass: surface.callerClass,
        url: surface.prodlikeBaseUrl,
      });
    }
  }
  return {
    environment: manifest.environment,
    binding: live.binding ?? null,
    version: live.version ?? 0,
    inScopeSurfaces: inScopeSurfaces(manifest).map((s) => s.id),
    stillTargetingProdlike: stillProdlike,
    documentedRollbackSurfaces: rollbackSurfaces(manifest).map((s) => ({
      surface: s.id,
      url: s.prodlikeBaseUrl,
      reason: 'documented rollback surface — retained until Tom accepts the observation period',
    })),
    clean: stillProdlike.length === 0,
  };
}

/**
 * Parse the CLI arguments for the `traffic-route` command.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    stateFile: process.env.SINDUSTRIES_CUTOVER_STATE_FILE || DEFAULT_STATE_FILE,
    manifest: null,
    binding: null,
    expectedVersion: null,
    runId: null,
    confirm: null,
    timeout: 30,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = () => {
      index += 1;
      if (index >= rest.length) {
        throw new Error(`traffic-route: ${arg} needs a value`);
      }
      return rest[index];
    };
    switch (arg) {
      case '--state-file':
        options.stateFile = next();
        break;
      case '--manifest':
        options.manifest = next();
        break;
      case '--binding':
        options.binding = next();
        break;
      case '--expected-version':
        options.expectedVersion = Number.parseInt(next(), 10);
        break;
      case '--run-id':
        options.runId = next();
        break;
      case '--confirm':
        options.confirm = next();
        break;
      case '--timeout':
        options.timeout = Number.parseInt(next(), 10);
        break;
      case '--help':
      case '-h':
        options.command = 'help';
        break;
      default:
        throw new Error(`traffic-route: unknown argument ${arg}`);
    }
  }
  return options;
}

const USAGE = `traffic-route — guarded route adapter for the production cutover

  traffic-route get    [--state-file <path>]
  traffic-route plan   --manifest <path> --binding <prodlike|production> [--state-file <path>]
  traffic-route set    --manifest <path> --binding <prodlike|production>
                       --expected-version <n> --run-id <id> --confirm <id> [--state-file <path>]
  traffic-route wait   --binding <prodlike|production> --expected-version <n> --timeout <s>
                       [--state-file <path>]
  traffic-route readback --manifest <path> [--state-file <path>]

Every command prints one JSON document on stdout. Errors print a message
on stderr and exit non-zero; nothing is written unless the command says
it writes.
`;

/**
 * The CLI entry point.
 *
 * @param {string[]} argv
 * @returns {number} the exit code
 */
export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  try {
    switch (options.command) {
      case 'help': {
        process.stdout.write(USAGE);
        return 0;
      }
      case 'get': {
        process.stdout.write(`${JSON.stringify(readRouteState(options.stateFile), null, 2)}\n`);
        return 0;
      }
      case 'plan': {
        if (!options.manifest || !options.binding) {
          throw new Error('traffic-route plan needs --manifest and --binding');
        }
        const manifest = loadManifest(options.manifest);
        const live = readRouteState(options.stateFile);
        process.stdout.write(
          `${JSON.stringify(planBinding(manifest, live, options.binding), null, 2)}\n`,
        );
        return 0;
      }
      case 'set': {
        if (!options.manifest || !options.binding) {
          throw new Error('traffic-route set needs --manifest and --binding');
        }
        const manifest = loadManifest(options.manifest);
        const live = readRouteState(options.stateFile);
        const next = applyBinding(manifest, live, {
          binding: options.binding,
          expectedVersion: options.expectedVersion,
          runId: options.runId,
          confirm: options.confirm,
        });
        writeRouteState(options.stateFile, next);
        process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
        return 0;
      }
      case 'wait': {
        if (!options.binding || options.expectedVersion === null) {
          throw new Error('traffic-route wait needs --binding and --expected-version');
        }
        const observed = waitForBinding(options.stateFile, {
          binding: options.binding,
          expectedVersion: options.expectedVersion,
          timeoutSeconds: options.timeout,
        });
        process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
        return 0;
      }
      case 'readback': {
        if (!options.manifest) {
          throw new Error('traffic-route readback needs --manifest');
        }
        const manifest = loadManifest(options.manifest);
        const live = readRouteState(options.stateFile);
        process.stdout.write(`${JSON.stringify(prodlikeReadBack(manifest, live), null, 2)}\n`);
        return 0;
      }
      default: {
        process.stderr.write(`traffic-route: unknown command ${JSON.stringify(options.command)}\n${USAGE}`);
        return 2;
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

// Only run the CLI when this module is the entry point. The unit tests
// import the module, so an unconditional call at import time would run
// the CLI under the test runner.
if (process.argv[1] && process.argv[1].endsWith('traffic-route.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
