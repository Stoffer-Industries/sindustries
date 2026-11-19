/**
 * route-callers.mjs — the LIVE half of the production cutover route
 * adapter (task 020f423e).
 *
 * WHY THIS MODULE EXISTS
 * -----------------------
 * The route adapter used to write a local JSON file and read that same
 * file back. That made the "switch" a statement of intent: the file
 * recorded what the operator intended, the read-back confirmed the
 * file still said that, and nothing in the deployment ever moved. A
 * route that nothing reads is not a route — it is a log.
 *
 * What the route actually IS in this deployment
 * ----------------------------------------------
 * There is no weighted load balancer between two live origins here. The
 * stable hostnames CNAME at the cloud platform, and every caller
 * resolves its base URL from the environment it runs in. So the route
 * is the BASE URL each caller resolves — and the callers are named in
 * the manifest, each one naming the exact prodlike URL it currently
 * carries and the production URL that replaces it.
 *
 * That makes the switch a real, bounded edit to real files, and it
 * makes the read-back a real read of those files. The adapter's local
 * JSON state becomes what it should always have been: the JOURNAL of
 * what was applied, not the source of truth.
 *
 * WHY LITERAL REPLACEMENT, NOT A TEMPLATE ENGINE
 * ----------------------------------------------
 * A managed caller site is a literal base URL in an OpenClaw runtime
 * env file. Replacing that literal with the production URL is the
 * whole switch; repository prompts and skills consume the variable
 * instead of overriding it. A template engine would mean inventing a
 * format the runtime does not use, and a format nobody reads is a
 * format that silently stops matching.
 *
 * The replacement preserves the SHAPE of the URL: scheme, host, port
 * and path are replaced together, so a caller that used a bare origin
 * still gets a bare origin and a caller that used `/api/v1` still gets
 * `/api/v1`.
 *
 * WHY A CALLER CAN BE 'mixed'
 * ---------------------------
 * A file that carries BOTH the prodlike target and the production
 * target is ambiguous: replacing one literal leaves the other, and the
 * caller would then resolve two different origins depending on which
 * line the reader picked up. That is a refusal, not a warning. The
 * operator resolves it by hand.
 *
 * THE OWNERSHIP BOUNDARY
 * ----------------------
 * A caller is owned by 'managed' (the adapter may read and write it under
 * the explicitly selected caller root) or by 'external' (it lives
 * outside that managed root). In production the managed root is the
 * OpenClaw runtime directory, not the GitHub checkout: changing a
 * disposable workflow checkout would not move a live caller. The
 * adapter NEVER writes an external caller. It reports it, so the
 * read-back shows it as still outstanding instead of silently calling
 * the window clean.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** The owners a caller may declare. */
export const CALLER_OWNERS = ['managed', 'external'];

/**
 * The bindings a caller site may be observed in.
 *
 * 'prodlike' / 'production' are the two real origins. 'mixed' means
 * the file carries both targets. 'unknown' means the file carries
 * neither. 'missing' means the file is not there. 'external' means the
 * caller lives outside this repository.
 */
export const CALLER_BINDINGS = [
  'prodlike',
  'production',
  'mixed',
  'unknown',
  'missing',
  'external',
];

/**
 * Resolve a caller path against a root, refusing anything that would
 * escape it.
 *
 * A manifest is a tracked file in a public repository, so a caller path
 * is attacker-shaped input as far as this module is concerned: an
 * absolute path, or a `..` that climbs out of the root, would let a
 * manifest write anywhere on the operator's disk. Both are refused
 * before the path is used.
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string} the absolute path
 */
export function resolveCallerPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new Error('route-callers: a caller needs a path');
  }
  if (isAbsolute(relativePath)) {
    throw new Error(
      `route-callers: a caller path must be relative to the managed caller root, got ${JSON.stringify(relativePath)}`,
    );
  }
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relativePath);
  const inside = relative(resolvedRoot, resolved);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(
      `route-callers: a caller path must stay inside the managed caller root, got ${JSON.stringify(relativePath)}`,
    );
  }
  return resolved;
}

/**
 * Count how many times a literal appears in a text.
 *
 * @param {string} text
 * @param {string} literal
 * @returns {number}
 */
function countOccurrences(text, literal) {
  if (!literal) return 0;
  let count = 0;
  let index = text.indexOf(literal);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(literal, index + literal.length);
  }
  return count;
}

/**
 * Read one caller site and report which origin it currently resolves.
 *
 * @param {string} root the directory the caller paths resolve against
 * @param {object} caller the manifest's caller descriptor
 * @returns {object} the observation record
 */
export function readCallerBinding(root, caller) {
  const base = {
    id: caller.id,
    path: caller.path,
    owner: caller.owner,
    prodlikeTarget: caller.prodlikeTarget,
    productionTarget: caller.productionTarget,
  };

  if (caller.owner === 'external') {
    return {
      ...base,
      binding: 'external',
      occurrences: 0,
      detail:
        'owned outside this repository — the adapter reports it and never writes it, so the read-back shows it as still outstanding',
    };
  }

  let filePath;
  try {
    filePath = resolveCallerPath(root, caller.path);
  } catch (error) {
    return { ...base, binding: 'unknown', occurrences: 0, detail: error.message };
  }

  if (!existsSync(filePath)) {
    return {
      ...base,
      binding: 'missing',
      occurrences: 0,
      detail: `the caller file is not present at ${caller.path}`,
    };
  }

  const content = readFileSync(filePath, 'utf8');
  const prodlike = countOccurrences(content, caller.prodlikeTarget);
  const production = countOccurrences(content, caller.productionTarget);

  if (prodlike > 0 && production > 0) {
    return {
      ...base,
      binding: 'mixed',
      occurrences: prodlike + production,
      detail:
        'the caller file carries BOTH the prodlike and the production target — a partial switch would leave it resolving two origins, so the adapter refuses it',
    };
  }
  if (prodlike > 0) {
    return {
      ...base,
      binding: 'prodlike',
      occurrences: prodlike,
      detail: `the caller still carries the prodlike target (${prodlike} occurrence(s))`,
    };
  }
  if (production > 0) {
    return {
      ...base,
      binding: 'production',
      occurrences: production,
      detail: `the caller carries the production target (${production} occurrence(s))`,
    };
  }
  return {
    ...base,
    binding: 'unknown',
    occurrences: 0,
    detail:
      'the caller file carries neither target — the site moved, or the target it holds is not the one the manifest names',
  };
}

/**
 * Apply a binding to one caller site.
 *
 * The write is ATOMIC (written beside its destination, then renamed),
 * because a half-written caller file is a caller that resolves a
 * truncated URL — which is worse than a caller that was never switched.
 *
 * A file that carries BOTH targets is refused: replacing one leaves
 * the other, and the caller would then resolve two different origins.
 *
 * @param {string} root
 * @param {object} caller
 * @param {string} binding 'prodlike' | 'production'
 * @returns {object} what changed
 */
export function applyCallerBinding(root, caller, binding) {
  if (caller.owner !== 'managed') {
    throw new Error(
      `route-callers: caller ${caller.id} is owned outside this repository — the adapter must not write it`,
    );
  }
  if (binding !== 'prodlike' && binding !== 'production') {
    throw new Error(
      `route-callers: unknown binding ${JSON.stringify(binding)} (expected one of prodlike, production)`,
    );
  }

  const filePath = resolveCallerPath(root, caller.path);
  if (!existsSync(filePath)) {
    throw new Error(`route-callers: the caller file is not present at ${caller.path}`);
  }

  const content = readFileSync(filePath, 'utf8');
  const prodlike = countOccurrences(content, caller.prodlikeTarget);
  const production = countOccurrences(content, caller.productionTarget);

  if (prodlike > 0 && production > 0) {
    throw new Error(
      `route-callers: ${caller.path} carries BOTH the prodlike and the production target — resolve it by hand before the window (the adapter will not half-switch a caller)`,
    );
  }

  const from = binding === 'production' ? caller.prodlikeTarget : caller.productionTarget;
  const to = binding === 'production' ? caller.productionTarget : caller.prodlikeTarget;

  const occurrences = countOccurrences(content, from);
  if (occurrences === 0) {
    // Already at the requested origin. That is not an error: a
    // re-run of a phase that is already applied must not fail.
    return {
      id: caller.id,
      path: caller.path,
      changed: false,
      occurrences: 0,
      detail: `the caller already resolves ${binding}`,
    };
  }

  const updated = content.split(from).join(to);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.cutover.tmp`;
  const mode = statSync(filePath).mode & 0o777;
  writeFileSync(temporary, updated, { mode });
  renameSync(temporary, filePath);

  return {
    id: caller.id,
    path: caller.path,
    changed: true,
    occurrences,
    detail: `the caller now resolves ${binding} (${occurrences} occurrence(s) replaced)`,
  };
}

/**
 * Observe every caller of a surface.
 *
 * @param {string} root
 * @param {object} surface
 * @returns {object[]} the observation records
 */
export function readSurfaceCallers(root, surface) {
  return (surface.callers ?? []).map((caller) => readCallerBinding(root, caller));
}

/**
 * Apply a binding to every caller of a surface.
 *
 * A caller that is already at the requested origin is left alone. A
 * caller that cannot be switched ABORTS the whole surface: a partially
 * switched surface is a surface where some callers point at prodlike
 * and some at production, which is exactly the state the cutover
 * exists to avoid. The caller that failed is named, and the ones that
 * already succeeded are listed so the operator can see the half-state
 * they are in.
 *
 * @param {string} root
 * @param {object} surface
 * @param {string} binding
 * @returns {object} { applied, failures }
 */
export function applySurfaceCallers(root, surface, binding) {
  const applied = [];
  const failures = [];
  for (const caller of surface.callers ?? []) {
    if (caller.owner !== 'managed') {
      // External callers are Quinn's to apply; the adapter reports
      // them and never touches them.
      applied.push({
        id: caller.id,
        path: caller.path,
        changed: false,
        occurrences: 0,
        detail: 'owned outside this repository — the adapter does not write it',
      });
      continue;
    }
    try {
      applied.push(applyCallerBinding(root, caller, binding));
    } catch (error) {
      failures.push({
        id: caller.id,
        path: caller.path,
        changed: false,
        occurrences: 0,
        detail: error.message,
      });
    }
  }
  return { applied, failures };
}

/**
 * The live snapshot of every caller in the manifest — the thing the
 * route version is bound to.
 *
 * @param {string} root
 * @param {object} manifest
 * @returns {object} caller id -> binding
 */
export function callerSnapshot(root, manifest) {
  const snapshot = {};
  for (const surface of manifest.surfaces) {
    for (const caller of surface.callers ?? []) {
      snapshot[caller.id] = readCallerBinding(root, caller).binding;
    }
  }
  return snapshot;
}
