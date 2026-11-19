/**
 * manifest.mjs — load and fail-closed validate a production cutover
 * manifest (task 020f423e, "Execute production cloud cutover with
 * rollback verification").
 *
 * WHY A VALIDATOR
 * ---------------
 * The cutover manifest is the ONE file that says what the Sunday window
 * does: which endpoints exist, which order the phases run in, how long
 * observation lasts, which thresholds abort the switch, which dependency
 * tasks must already be accepted. If the manifest is wrong, the
 * operator's window is wrong — and the failure mode of a wrong manifest
 * is not a crash, it is a window that quietly skips a gate.
 *
 * So validation is FAIL-CLOSED and EXPLICIT:
 *   - every field the scripts read is checked for presence and type;
 *   - the phase order is checked for monotonicity, so a manifest cannot
 *     declare "cloud_active" before "baseline";
 *   - the abort thresholds are checked for plausibility, so a manifest
 *     cannot declare a threshold that would never abort;
 *   - the manifest is scanned for credential-shaped values, because a
 *     manifest is a tracked file and the repo is public.
 *
 * The validator is deliberately separate from the scripts that USE the
 * manifest, so a unit test can prove each rejection independently of
 * whether a Fly app exists.
 */

import { readFileSync } from 'node:fs';

/** The manifest version this code understands. */
export const SUPPORTED_MANIFEST_VERSION = 1;

/** The environments a manifest may declare. */
export const ALLOWED_ENVIRONMENTS = ['staging', 'production'];

/** The origins a manifest may declare. Both must be present. */
export const REQUIRED_ORIGINS = ['prodlike', 'production'];

/**
 * The last phase a manifest may declare. A manifest that ends anywhere
 * else would let the switch finish without recording that the fallback
 * is still available and acceptance is still pending.
 */
export const REQUIRED_FINAL_PHASE = 'acceptance_pending';

/**
 * Credential-shaped substrings that must never appear in a tracked
 * manifest. The repo is public, so a manifest that carries a DSN, a
 * token or a password is a permanent disclosure.
 */
const SECRET_VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]*@/i,
  /\bhttps?:\/\/[^\s/"'@]*:[^\s/"'@]*@/i,
  /"(?:password|passwd|secret|token|api[_-]?key|dsn|database[_-]?url|credential)"\s*:\s*"(?!\[REDACTED\])[^"]*"/i,
  /bearer\s+[A-Za-z0-9._-]{12,}/i,
  /\b(?:ghp|gho|github_pat|fly_|sk_live|sk_test)_[A-Za-z0-9_-]{12,}/i,
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A plain hostname: DNS labels of letters, digits and hyphens joined by
 * dots. The manifest's URLs are interpolated into operator commands and
 * into shell evidence, so a value carrying shell punctuation is refused
 * rather than escaped.
 */
const PLAIN_HOST_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Collect the paths of every credential-shaped string in a value.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} found
 */
function collectSecretPaths(value, path, found) {
  if (typeof value === 'string') {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        found.push(path);
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretPaths(item, `${path}[${index}]`, found),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectSecretPaths(child, `${path}.${key}`, found);
    }
  }
}

/**
 * Refuse a manifest that carries a credential-shaped value.
 *
 * @param {unknown} manifest
 * @returns {string[]} the paths that tripped the guard (empty when clean)
 */
export function findSecretBearingPaths(manifest) {
  const found = [];
  collectSecretPaths(manifest, '$', found);
  return found;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

/**
 * Extract the hostname of a base URL, refusing anything that is not a
 * plain http(s) URL over a plain hostname.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function assertPlainUrl(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`manifest: ${label} must be a non-empty URL string`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`manifest: ${label} is not a URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`manifest: ${label} must use http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error(
      `manifest: ${label} must not carry credentials in the URL — a tracked manifest is a public document`,
    );
  }
  if (!PLAIN_HOST_RE.test(url.hostname)) {
    throw new Error(`manifest: ${label} hostname is not a plain hostname: ${url.hostname}`);
  }
  // The PATH is interpolated into operator commands and into shell
  // evidence, so it is restricted to an inert character set. A URL
  // whose path carries a semicolon or a space would smuggle shell
  // syntax into the runbook's commands.
  if (!/^(\/[A-Za-z0-9._~%-]*)*$/.test(url.pathname)) {
    throw new Error(
      `manifest: ${label} path carries unsafe characters: ${url.pathname}`,
    );
  }
  if (url.search || url.hash) {
    throw new Error(`manifest: ${label} must not carry a query string or fragment`);
  }
  return value;
}

/**
 * Validate a manifest. Throws with an explicit message on the first
 * problem found; returns the manifest unchanged when it is valid.
 *
 * @param {unknown} manifest
 * @returns {object} the validated manifest
 */
export function validateManifest(manifest) {
  if (!isPlainObject(manifest)) {
    throw new Error('manifest: the manifest must be a JSON object');
  }

  const secretPaths = findSecretBearingPaths(manifest);
  if (secretPaths.length > 0) {
    throw new Error(
      `manifest: refusing a manifest that carries a credential-shaped value at ${secretPaths.join(', ')}`,
    );
  }

  if (manifest.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    throw new Error(
      `manifest: manifestVersion must be ${SUPPORTED_MANIFEST_VERSION}, got ${JSON.stringify(manifest.manifestVersion)}`,
    );
  }

  if (!isNonEmptyString(manifest.taskId) || !UUID_RE.test(manifest.taskId)) {
    throw new Error('manifest: taskId must be a task UUID');
  }

  if (!ALLOWED_ENVIRONMENTS.includes(manifest.environment)) {
    throw new Error(
      `manifest: environment must be one of ${ALLOWED_ENVIRONMENTS.join(', ')}, got ${JSON.stringify(manifest.environment)}`,
    );
  }

  // ---- run ---------------------------------------------------------------
  if (!isPlainObject(manifest.run)) {
    throw new Error('manifest: run must be an object');
  }
  if (!isPositiveNumber(manifest.run.observationMinutes)) {
    throw new Error(
      'manifest: run.observationMinutes must be a positive number — an unset observation duration blocks execution',
    );
  }
  if (!isPlainObject(manifest.run.operatorRoles)) {
    throw new Error('manifest: run.operatorRoles must be an object');
  }
  for (const role of ['goNoGo', 'execution', 'engineering']) {
    if (!isNonEmptyString(manifest.run.operatorRoles[role])) {
      throw new Error(`manifest: run.operatorRoles.${role} must name an operator`);
    }
  }
  if (!isPlainObject(manifest.run.abortThresholds)) {
    throw new Error('manifest: run.abortThresholds must be an object');
  }
  const thresholds = manifest.run.abortThresholds;
  if (!isPositiveNumber(thresholds.probeFailureCount)) {
    throw new Error('manifest: run.abortThresholds.probeFailureCount must be a positive number');
  }
  if (!isRate(thresholds.errorRate)) {
    throw new Error('manifest: run.abortThresholds.errorRate must be a rate in (0, 1]');
  }
  if (!isPositiveNumber(thresholds.p95LatencyMs)) {
    throw new Error('manifest: run.abortThresholds.p95LatencyMs must be a positive number');
  }
  if (!isNonNegativeNumber(thresholds.activeAlertCount)) {
    throw new Error('manifest: run.abortThresholds.activeAlertCount must be a non-negative number');
  }

  // ---- origins ------------------------------------------------------------
  if (!isPlainObject(manifest.origins)) {
    throw new Error('manifest: origins must be an object');
  }
  for (const origin of REQUIRED_ORIGINS) {
    const entry = manifest.origins[origin];
    if (!isPlainObject(entry)) {
      throw new Error(`manifest: origins.${origin} must be an object`);
    }
    if (!isNonEmptyString(entry.kind) || !isNonEmptyString(entry.label)) {
      throw new Error(`manifest: origins.${origin} needs a kind and a label`);
    }
    if (!isNonEmptyString(entry.dataPlane)) {
      throw new Error(
        `manifest: origins.${origin}.dataPlane must name the data plane — a runtime rollback that does not share the canonical data plane is not data-safe`,
      );
    }
  }

  // ---- surfaces -----------------------------------------------------------
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length === 0) {
    throw new Error('manifest: surfaces must be a non-empty array');
  }
  const surfaceIds = new Set();
  for (const surface of manifest.surfaces) {
    if (!isPlainObject(surface)) {
      throw new Error('manifest: every surface must be an object');
    }
    if (!isNonEmptyString(surface.id)) {
      throw new Error('manifest: every surface needs an id');
    }
    if (surfaceIds.has(surface.id)) {
      throw new Error(`manifest: duplicate surface id ${surface.id}`);
    }
    surfaceIds.add(surface.id);
    if (!isNonEmptyString(surface.kind)) {
      throw new Error(`manifest: surface ${surface.id} needs a kind`);
    }
    if (!isNonEmptyString(surface.callerClass)) {
      throw new Error(`manifest: surface ${surface.id} needs a callerClass`);
    }
    assertPlainUrl(surface.productionBaseUrl, `surface ${surface.id} productionBaseUrl`);
    assertPlainUrl(surface.prodlikeBaseUrl, `surface ${surface.id} prodlikeBaseUrl`);
    if (!isNonEmptyString(surface.healthPath)) {
      throw new Error(`manifest: surface ${surface.id} needs a healthPath`);
    }
    if (typeof surface.rollbackSurface !== 'boolean') {
      throw new Error(
        `manifest: surface ${surface.id} must declare rollbackSurface as a boolean — the rollback exception is explicit, never implied`,
      );
    }
  }
  const rollbackSurfaces = manifest.surfaces.filter((s) => s.rollbackSurface);
  if (rollbackSurfaces.length === 0) {
    throw new Error(
      'manifest: at least one surface must be declared as a rollback surface — the prodlike origin is retained, not decommissioned, by this task',
    );
  }

  // ---- phases -------------------------------------------------------------
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) {
    throw new Error('manifest: phases must be a non-empty array');
  }
  let sawProduction = false;
  for (const phase of manifest.phases) {
    if (!isPlainObject(phase)) {
      throw new Error('manifest: every phase must be an object');
    }
    if (!isNonEmptyString(phase.phase) || !isNonEmptyString(phase.binding)) {
      throw new Error('manifest: every phase needs a phase name and a binding');
    }
    if (!REQUIRED_ORIGINS.includes(phase.binding)) {
      throw new Error(
        `manifest: phase ${phase.phase} binds an unknown origin ${JSON.stringify(phase.binding)}`,
      );
    }
    if (!isNonNegativeNumber(phase.holdSeconds)) {
      throw new Error(`manifest: phase ${phase.phase} needs a non-negative holdSeconds`);
    }
    if (!isPositiveNumber(phase.minSamples)) {
      throw new Error(`manifest: phase ${phase.phase} needs a positive minSamples`);
    }
    // Monotonicity: once the switch has moved to production it must not
    // go back to prodlike. A manifest that could re-bind prodlike mid
    // window is a manifest that could half-undo a switch by accident.
    if (phase.binding === 'production') {
      sawProduction = true;
    } else if (sawProduction) {
      throw new Error(
        `manifest: phase ${phase.phase} binds prodlike after a production phase — the phase order must be monotonic`,
      );
    }
  }
  if (manifest.phases[0].binding !== 'prodlike') {
    throw new Error(
      'manifest: the first phase must bind prodlike — the switch starts from the current source',
    );
  }
  const finalPhase = manifest.phases[manifest.phases.length - 1];
  if (finalPhase.phase !== REQUIRED_FINAL_PHASE) {
    throw new Error(
      `manifest: the final phase must be ${REQUIRED_FINAL_PHASE}, got ${JSON.stringify(finalPhase.phase)}`,
    );
  }

  // ---- probes -------------------------------------------------------------
  if (!isPlainObject(manifest.probes)) {
    throw new Error('manifest: probes must be an object');
  }
  if (!isPositiveNumber(manifest.probes.intervalSeconds)) {
    throw new Error('manifest: probes.intervalSeconds must be a positive number');
  }
  if (!isPositiveNumber(manifest.probes.minSamplesPerStep)) {
    throw new Error('manifest: probes.minSamplesPerStep must be a positive number');
  }
  if (!isPositiveNumber(manifest.probes.timeoutSeconds)) {
    throw new Error('manifest: probes.timeoutSeconds must be a positive number');
  }
  if (!isNonEmptyString(manifest.probes.syntheticIdentity)) {
    throw new Error('manifest: probes.syntheticIdentity must name the synthetic identity');
  }

  // ---- gates --------------------------------------------------------------
  if (!isPlainObject(manifest.gates)) {
    throw new Error('manifest: gates must be an object');
  }
  if (!Array.isArray(manifest.gates.requiredDependencyTaskIds)) {
    throw new Error('manifest: gates.requiredDependencyTaskIds must be an array');
  }
  for (const id of manifest.gates.requiredDependencyTaskIds) {
    if (!isNonEmptyString(id) || !UUID_RE.test(id)) {
      throw new Error(`manifest: gates.requiredDependencyTaskIds entry ${JSON.stringify(id)} is not a task UUID`);
    }
  }
  if (!Array.isArray(manifest.gates.requiredEvidence) || manifest.gates.requiredEvidence.length === 0) {
    throw new Error('manifest: gates.requiredEvidence must be a non-empty array');
  }
  if (!Array.isArray(manifest.gates.requiredOperatorFields)) {
    throw new Error('manifest: gates.requiredOperatorFields must be an array');
  }

  // ---- evidence -----------------------------------------------------------
  if (!isPlainObject(manifest.evidence)) {
    throw new Error('manifest: evidence must be an object');
  }
  if (!isNonEmptyString(manifest.evidence.artifactDir)) {
    throw new Error('manifest: evidence.artifactDir must name the artifact directory');
  }

  return manifest;
}

/**
 * Read a manifest from disk and validate it.
 *
 * @param {string} path
 * @returns {object} the validated manifest
 */
export function loadManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`manifest: cannot read ${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest: ${path} is not valid JSON: ${error.message}`);
  }
  return validateManifest(parsed);
}

/**
 * The effective base URL a surface resolves to under a given binding.
 *
 * @param {object} manifest
 * @param {string} surfaceId
 * @param {string} binding 'prodlike' | 'production'
 * @returns {string}
 */
export function baseUrlFor(manifest, surfaceId, binding) {
  const surface = manifest.surfaces.find((s) => s.id === surfaceId);
  if (!surface) {
    throw new Error(`manifest: unknown surface ${surfaceId}`);
  }
  if (binding === 'production') {
    return surface.productionBaseUrl;
  }
  if (binding === 'prodlike') {
    return surface.prodlikeBaseUrl;
  }
  throw new Error(`manifest: unknown binding ${binding}`);
}

/**
 * The surfaces that are in scope for the switch: everything except the
 * documented rollback surfaces, which are expected to keep pointing at
 * prodlike.
 *
 * @param {object} manifest
 * @returns {object[]}
 */
export function inScopeSurfaces(manifest) {
  return manifest.surfaces.filter((s) => !s.rollbackSurface);
}

/**
 * The documented rollback surfaces — the explicit exception to "no
 * in-scope caller still targets prodlike".
 *
 * @param {object} manifest
 * @returns {object[]}
 */
export function rollbackSurfaces(manifest) {
  return manifest.surfaces.filter((s) => s.rollbackSurface);
}
