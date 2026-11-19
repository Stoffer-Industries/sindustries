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
 * THE ROUTE IS THE CALLERS, NOT THIS FILE
 * ---------------------------------------
 * This file is the JOURNAL of what was applied. It is not the source
 * of truth: the source of truth is the set of caller files the
 * manifest names, each of which carries the base URL its owner
 * resolves. The adapter MOVES those callers (see route-callers.mjs),
 * reads them back to confirm the move landed, and refuses to record a
 * version whose live state does not match what the journal claims.
 *
 * A hand-edit of a caller file therefore MOVES THE ROUTE UNDERNEATH
 * the operator: the journal's recorded snapshot no longer matches the
 * live one, and the next compare-and-set is refused. That is the
 * property a JSON file on its own could never have.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { baseUrlFor, inScopeSurfaces, loadManifest, rollbackSurfaces } from './manifest.mjs';
import {
  applyCallerBinding,
  callerSnapshot,
  readCallerBinding,
  readSurfaceCallers,
} from './route-callers.mjs';

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
 * The repository root, derived from this module's own location.
 *
 * The caller paths in the manifest are relative to the repository
 * root, so the adapter needs to know where that root is without
 * being told. Deriving it from the module's own path means the
 * adapter cannot be pointed at a different tree by accident, and
 * `--caller-root` remains available for the tests, which need a
 * fixture tree rather than the real repository.
 *
 * @returns {string}
 */
export function defaultCallerRoot() {
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

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
 * Find a caller descriptor by its id.
 *
 * @param {object} manifest
 * @param {string} id
 * @returns {object|null}
 */
export function findCaller(manifest, id) {
  for (const surface of manifest.surfaces) {
    for (const caller of surface.callers ?? []) {
      if (caller.id === id) return caller;
    }
  }
  return null;
}

/**
 * MOVE the route: apply a binding to every in-scope caller's file.
 *
 * The documented rollback surfaces are skipped: they stay where they
 * are, which is what makes the rollback honest.
 *
 * If a surface's switch FAILS part-way, the callers that already moved
 * in that surface are REVERTED. A surface with some callers on
 * prodlike and some on production is exactly the half-switched state
 * the cutover exists to prevent, and it is the state that is hardest
 * to notice and easiest to serve traffic from.
 *
 * @param {string} root
 * @param {object} manifest
 * @param {string} binding
 * @returns {object} { applied, failures }
 */
export function applyRouteSwitch(root, manifest, binding) {
  const applied = [];
  const failures = [];
  const opposite = binding === 'production' ? 'prodlike' : 'production';

  // Refuse the whole switch before the first write if any managed
  // caller is missing, ambiguous, or carries neither declared target.
  // This avoids creating a half-switched route from a known-bad input.
  for (const surface of manifest.surfaces) {
    if (surface.rollbackSurface) continue;
    for (const caller of surface.callers ?? []) {
      if (caller.owner !== 'managed') continue;
      const observation = readCallerBinding(root, caller);
      if (![binding, opposite].includes(observation.binding)) {
        failures.push({
          id: caller.id,
          path: caller.path,
          surface: surface.id,
          changed: false,
          occurrences: observation.occurrences,
          detail: observation.detail,
        });
      }
    }
  }
  if (failures.length > 0) return { applied, failures };

  switchLoop: for (const surface of manifest.surfaces) {
    if (surface.rollbackSurface) continue;
    for (const caller of surface.callers ?? []) {
      if (caller.owner !== 'managed') continue;
      try {
        applied.push({
          ...applyCallerBinding(root, caller, binding),
          surface: surface.id,
        });
      } catch (error) {
        failures.push({
          id: caller.id,
          path: caller.path,
          surface: surface.id,
          changed: false,
          occurrences: 0,
          detail: error.message,
        });
        break switchLoop;
      }
    }
  }

  if (failures.length > 0) {
    const rollbackFailures = [];
    for (const record of [...applied].reverse()) {
      if (!record.changed) continue;
      const caller = findCaller(manifest, record.id);
      if (!caller) continue;
      try {
        applyCallerBinding(root, caller, opposite);
      } catch (error) {
        rollbackFailures.push(`${record.id}: ${error.message}`);
      }
    }
    if (rollbackFailures.length > 0) {
      failures[0].detail += `; automatic revert also failed for ${rollbackFailures.join(', ')}`;
    }
  }

  return { applied, failures };
}

/**
 * The managed callers that did NOT land on the requested binding.
 *
 * The documented rollback surfaces are EXCLUDED, and they have to be.
 * applyRouteSwitch() deliberately leaves the rollback surfaces where
 * they are — a retained rollback caller on prodlike is the evidence
 * that the rollback stayed honest, not evidence that the switch
 * failed. Asserting on it made every production switch report "the
 * route was NOT moved" AFTER it had already rewritten the callers, so
 * the command exited non-zero and never wrote the route state: a
 * half-moved route with no journal entry.
 *
 * @param {object} manifest
 * @param {object} snapshot caller id -> observed binding
 * @param {string} binding the requested binding
 * @returns {Array<[string, string]>} the callers that did not move
 */
export function routeSwitchNotMoved(manifest, snapshot, binding) {
  const retainedRollbackCallers = new Set(
    rollbackSurfaces(manifest).flatMap((surface) =>
      (surface.callers ?? []).map((caller) => caller.id),
    ),
  );
  return Object.entries(snapshot).filter(([id, observed]) => {
    if (retainedRollbackCallers.has(id)) return false;
    const caller = findCaller(manifest, id);
    if (!caller || caller.owner !== 'managed') return false;
    return observed !== binding;
  });
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
 * @param {object} [options.liveSnapshot] the caller bindings observed right now
 * @returns {object} the new route state
 */
export function applyBinding(manifest, live, { binding, expectedVersion, runId, confirm, liveSnapshot = null }) {
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

  // A hand-edit of a caller file MOVES the route underneath the
  // operator: the journal's recorded snapshot no longer describes the
  // live one. Refusing here is what makes the journal trustworthy —
  // without this check a stale operator could overwrite somebody
  // else's deliberate change.
  if (liveSnapshot && live.callers && typeof live.callers === 'object') {
    const drifted = Object.entries(liveSnapshot).filter(
      ([id, observed]) => live.callers[id] !== undefined && live.callers[id] !== observed,
    );
    if (drifted.length > 0) {
      throw new Error(
        `traffic-route: the live route moved underneath this operator (${drifted
          .map(([id, observed]) => `${id} is now ${observed}`)
          .join(', ')}) — re-read the route with 'traffic-route get' before applying a change`,
      );
    }
  }

  const now = new Date().toISOString();
  const next = {
    version: liveVersion + 1,
    environment: manifest.environment,
    binding,
    surfaces: targetBindings(manifest, binding),
    callers: liveSnapshot ?? {},
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
 * The read-back reads the LIVE caller files, not the journal. That is
 * the whole point of the change: a read-back that reads back the file
 * the adapter just wrote proves only that the adapter wrote what it
 * meant to write, not that any caller moved.
 *
 * @param {object} manifest
 * @param {object} live the journal
 * @param {object} [options]
 * @param {string} [options.root] the directory the caller paths resolve against
 * @returns {object} a read-back document
 */
export function prodlikeReadBack(manifest, live, options = {}) {
  const root = options.root ?? null;
  const stillProdlike = [];
  const callerObservations = [];
  const surfaceBindings = [];

  for (const surface of manifest.surfaces) {
    const observations = root ? readSurfaceCallers(root, surface) : [];
    for (const observation of observations) {
      callerObservations.push({ ...observation, surface: surface.id });
    }
    const owned = observations.filter((observation) => observation.owner === 'managed');
    const bindings = [...new Set(owned.map((observation) => observation.binding))];

    // The LIVE binding of a surface is the binding its managed
    // callers actually resolve. The journal is only the fallback for
    // a surface with no managed caller to read.
    let binding = live.surfaces?.[surface.id] ?? null;
    let source = 'journal';
    if (bindings.length === 1) {
      binding = bindings[0];
      source = 'live';
    } else if (bindings.length > 1) {
      binding = 'mixed';
      source = 'live';
    }

    surfaceBindings.push({
      surface: surface.id,
      binding,
      source,
      repoCallers: owned.length,
      externalCallers: observations.length - owned.length,
    });

    // The documented rollback surfaces are the EXPLICIT exception to
    // "no in-scope caller still targets prodlike": they are supposed
    // to stay on prodlike until Tom accepts the observation period.
    // They are reported in surfaceBindings and in
    // documentedRollbackSurfaces, but they never make the read-back
    // unclean — otherwise the fallback the cutover relies on would
    // read as the drift it exists to prevent.
    if (binding === 'prodlike' && !surface.rollbackSurface) {
      stillProdlike.push({
        surface: surface.id,
        callerClass: surface.callerClass,
        url: surface.prodlikeBaseUrl,
      });
    }
  }

  const managedCallersNotOnProduction = callerObservations.filter(
    (observation) =>
      observation.owner === 'managed' && observation.binding !== 'production',
  );
  const externalOutstanding = callerObservations.filter(
    (observation) => observation.owner === 'external',
  );

  return {
    environment: manifest.environment,
    binding: live.binding ?? null,
    version: live.version ?? 0,
    // EVERY declared surface, rollback surfaces included. A caller of
    // the route inventory needs the whole declared set to compare
    // against; `inScopeSurfaces` deliberately excludes the documented
    // rollback surfaces.
    declaredSurfaces: manifest.surfaces.map((s) => s.id),
    // The surfaces the LIVE ROUTE knows about. This is the other
    // half of the inventory check: the declared set is what the
    // manifest requires, and this is what the route actually carries.
    // A surface the manifest declares and the route does not know is
    // route drift.
    routeSurfaces: Object.keys(live.surfaces ?? {}).sort(),
    inScopeSurfaces: inScopeSurfaces(manifest).map((s) => s.id),
    surfaceBindings,
    stillTargetingProdlike: stillProdlike,
    documentedRollbackSurfaces: rollbackSurfaces(manifest).map((s) => ({
      surface: s.id,
      url: s.prodlikeBaseUrl,
      reason: 'documented rollback surface — retained until Tom accepts the observation period',
    })),
    managedCallersNotOnProduction: managedCallersNotOnProduction.map((observation) => ({
      id: observation.id,
      surface: observation.surface,
      path: observation.path,
      binding: observation.binding,
      detail: observation.detail,
    })),
    externalCallersOutstanding: externalOutstanding.map((observation) => ({
      id: observation.id,
      surface: observation.surface,
      path: observation.path,
      detail: observation.detail,
    })),
    callerObservations,
    clean:
      stillProdlike.length === 0 &&
      managedCallersNotOnProduction.length === 0 &&
      externalOutstanding.length === 0,
    // The window is only COMPLETE when every managed caller is
    // observed on production and no external caller is outstanding.
    complete:
      stillProdlike.length === 0 &&
      managedCallersNotOnProduction.length === 0 &&
      externalOutstanding.length === 0,
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
    callerRoot: process.env.SINDUSTRIES_CUTOVER_CALLER_ROOT || defaultCallerRoot(),
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
      case '--caller-root':
        options.callerRoot = next();
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

  traffic-route get    [--state-file <path>] [--caller-root <dir>]
  traffic-route plan   --manifest <path> --binding <prodlike|production>
                       [--state-file <path>] [--caller-root <dir>]
  traffic-route set    --manifest <path> --binding <prodlike|production>
                       --expected-version <n> --run-id <id> --confirm <id>
                       [--state-file <path>] [--caller-root <dir>]
  traffic-route wait   --binding <prodlike|production> --expected-version <n>
                       --timeout <s> [--state-file <path>]
  traffic-route readback --manifest <path> [--state-file <path>] [--caller-root <dir>]

Every command prints one JSON document on stdout. Errors print a message
on stderr and exit non-zero; nothing is written unless the command says
it writes.

'set' MOVES the route: it rewrites the caller files the manifest names,
reads them back to confirm the move landed, and only then records the
new version. '--caller-root' is the directory the caller paths resolve
against; it defaults to this repository's root.
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
        const root = options.callerRoot;

        // What the callers resolve RIGHT NOW. This is the state the
        // compare-and-set is taken against, and the state the drift
        // check compares with the journal's recorded snapshot.
        const before = callerSnapshot(root, manifest);

        const next = applyBinding(manifest, live, {
          binding: options.binding,
          expectedVersion: options.expectedVersion,
          runId: options.runId,
          confirm: options.confirm,
          liveSnapshot: before,
        });

        // MOVE THE CALLERS. This is the switch: the caller files the
        // manifest names are rewritten to the requested origin.
        const switched = applyRouteSwitch(root, manifest, options.binding);
        if (switched.failures.length > 0) {
          const first = switched.failures[0];
          throw new Error(
            `traffic-route: the caller switch failed for ${switched.failures
              .map((failure) => failure.id)
              .join(', ')} — ${first.detail}`,
          );
        }

        // READ IT BACK. A switch that did not land is not a switch, so
        // the caller files are re-read and every managed caller must
        // now resolve the requested origin.
        const after = callerSnapshot(root, manifest);
        const notMoved = routeSwitchNotMoved(manifest, after, options.binding);
        if (notMoved.length > 0) {
          throw new Error(
            `traffic-route: the caller switch did not land for ${notMoved
              .map(([id]) => id)
              .join(', ')} — the route was NOT moved`,
          );
        }

        next.callers = after;
        writeRouteState(options.stateFile, next);
        process.stdout.write(
          `${JSON.stringify({ ...next, callerSwitch: { root, applied: switched.applied } }, null, 2)}\n`,
        );
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
        process.stdout.write(
          `${JSON.stringify(prodlikeReadBack(manifest, live, { root: options.callerRoot }), null, 2)}\n`,
        );
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
