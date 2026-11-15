// production-operator-evidence.mjs — task fb1240c0 (Slice D)
//
// The operator read-backs that close the obligations no machine can prove.
//
// WHY THIS EXISTS
//
// Slice D has five obligations the repository cannot decide: the Fly
// spend-limit read-back (Fly exposes no limit API), the staging/dev Neon
// denial proof (it needs credentials), one successful production probe
// interval (time-based), the production API health responses (network and
// time bound) and the DNS resolution/TLS read-back (network bound).
//
// Until now those five were reported as `operator-required` FOREVER. The
// operator had nowhere to record a read-back, so the evidence chain could
// never reach green: AC5 in particular could not be satisfied even after
// the operator had set the Fly spend limit and read it back. A gate that
// can only ever report "someone else must do this" is not a gate.
//
// This module is the shared contract for that record. The capture merges
// it into the artifact and the checker reads it, so the two sides cannot
// drift — the same reason the probe-target facts live in a shared module.
//
// THE RECORD IS VALUE-FREE
//
// A slot carries a boolean, an ISO-8601 read-back time, a POINTER to
// the read-back (a file name or path) and the LIST of production
// surfaces the read-back covered. A value must never reach the
// artifact: the artifact is committed and pasted into public task
// comments. The checker scans the whole artifact for credential-shaped
// values, and this module keeps the operator section to shapes that
// cannot carry one.
//
// THE RECORD MUST BE BOUND TO WHAT IT PROVES
//
// A boolean on its own proves only that a statement was made. It says
// nothing about WHAT was read back: a recorded `true` with the scope
// "done" would close the DNS resolution read-back while no production
// hostname resolved at all. So a recorded slot also names the
// production surfaces the read-back covered, and the checker compares
// that list against the surfaces the repository expects for THAT slot —
// the production app scope for the spend limit, the production
// health-probe app for the probe interval, the three production API
// hostnames for the health responses, the production hostnames for the
// DNS/TLS read-back, and the production branch with the staging and dev
// credentials for the Neon denial proof.
//
// An expectation set that names nothing cannot prove anything, so the
// same rule applies here in both directions: a record that names none
// of the expected surfaces, or names a surface the repository does not
// expect, leaves the obligation open.
//
// Usage:
//   import { validateOperatorEvidence, operatorEvidenceRecorded } from
//     './production-operator-evidence.mjs';

/** The operator obligations and the evidence slot that closes each one. */
export const OPERATOR_EVIDENCE_SLOTS = [
  {
    slot: 'flySpendLimit',
    gate: 'fly.spend-limit-readback',
    coverage: 'platformAppScope',
    label: 'Fly organization spend limit',
    step: 'Slice D step 6',
    owner: 'Quinn / Tom',
    hint:
      'the Fly Billing → Limits read-back for the production app scope, recorded once the limit is set',
  },
  {
    slot: 'neonSeparationDenialProof',
    gate: 'neon.separation-denial-proof',
    coverage: 'neonSeparation',
    label: 'Staging/dev denial proof',
    step: 'Slice D step 2',
    owner: 'Quinn (operator)',
    hint:
      'the staging/dev connection attempts that were refused against the production branch',
  },
  {
    slot: 'productionProbeInterval',
    gate: 'health.production-probe-interval',
    coverage: 'healthProbeApp',
    label: 'One successful production probe interval',
    step: 'Slice D step 7',
    owner: 'Quinn (operator)',
    hint: 'one successful production probe interval and when it was observed',
  },
  {
    slot: 'productionApiHealthResponses',
    gate: 'health.production-api-responses',
    coverage: 'productionApiHostnames',
    label: 'Production API health responses',
    step: 'Slice D step 9',
    owner: 'Quinn (operator)',
    hint: 'the HTTPS health responses from all three production API hostnames',
  },
  {
    slot: 'dnsResolutionAndTlsReadback',
    gate: 'dns.resolution-and-tls-readback',
    coverage: 'productionHostnames',
    label: 'Production DNS resolution and TLS read-back',
    step: 'Slice D step 8',
    owner: 'Quinn (operator)',
    hint:
      'the production hostnames resolving from two resolvers and presenting a valid certificate',
  },
];

/** The slot names the artifact may carry. */
export const OPERATOR_EVIDENCE_SLOT_NAMES = OPERATOR_EVIDENCE_SLOTS.map(
  (entry) => entry.slot,
);

/** The fields a slot may carry. */
const SLOT_FIELDS = ['recorded', 'readBackAt', 'scope', 'evidenceRef', 'targets'];

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** A short human label — no value, no punctuation that could hide one. */
const SAFE_SCOPE = /^[A-Za-z0-9 ._:/-]{1,120}$/;

/** A pointer to a read-back: a file name or path, never the value itself. */
const SAFE_EVIDENCE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * A covered surface: a hostname, an app name or a credential kind.
 *
 * The targets are identifiers, never values — a hostname and an app name
 * are names the repository already publishes, and a credential kind is a
 * word, not a credential.
 */
const SAFE_TARGET = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Is this an ISO-8601 date-time with an explicit timezone?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (!ISO_TIMESTAMP.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * Validate the operator evidence section of an artifact.
 *
 * The section is OPTIONAL: an artifact with no operator evidence is valid
 * and simply leaves every obligation open. A section that is present but
 * malformed is NOT valid — a read-back that cannot be read is not a
 * read-back, and silently dropping it would turn a recorded limit into an
 * unrecorded one without saying so.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, present: boolean, problems: string[]}}
 */
export function validateOperatorEvidence(value) {
  if (value === undefined || value === null) {
    return { ok: true, present: false, problems: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      present: true,
      problems: ['operatorEvidence must be an object'],
    };
  }

  const problems = [];
  for (const [slot, entry] of Object.entries(value)) {
    if (!OPERATOR_EVIDENCE_SLOT_NAMES.includes(slot)) {
      problems.push(`unknown operator evidence slot "${slot}"`);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`the operator evidence slot "${slot}" must be an object`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!SLOT_FIELDS.includes(field)) {
        problems.push(`the operator evidence slot "${slot}" carries an unknown field "${field}"`);
      }
    }
    if (typeof entry.recorded !== 'boolean') {
      problems.push(`the operator evidence slot "${slot}" must carry a boolean "recorded"`);
      continue;
    }
    // A slot that is explicitly NOT recorded is a statement, not a defect:
    // the operator has not done that step yet.
    if (entry.recorded !== true) continue;
    if (!isIsoTimestamp(entry.readBackAt)) {
      problems.push(
        `the operator evidence slot "${slot}" records a read-back without an ISO-8601 "readBackAt"`,
      );
    }
    if (entry.scope !== undefined && !SAFE_SCOPE.test(String(entry.scope))) {
      problems.push(`the operator evidence slot "${slot}" carries an unusable "scope"`);
    }
    if (entry.evidenceRef !== undefined && !SAFE_EVIDENCE_REF.test(String(entry.evidenceRef))) {
      problems.push(
        `the operator evidence slot "${slot}" carries an unusable "evidenceRef" — it must point at the read-back, not carry it`,
      );
    }
    if (!Array.isArray(entry.targets)) {
      problems.push(`the operator evidence slot "${slot}" must carry a "targets" array`);
    } else if (entry.targets.length === 0) {
      problems.push(
        `the operator evidence slot "${slot}" must name at least one production surface in "targets"`,
      );
    } else {
      for (const target of entry.targets) {
        if (typeof target !== 'string' || !SAFE_TARGET.test(target)) {
          problems.push(
            `the operator evidence slot "${slot}" carries an unusable target — a target names a surface, it is never a value`,
          );
          break;
        }
      }
      if (new Set(entry.targets).size !== entry.targets.length) {
        problems.push(`the operator evidence slot "${slot}" repeats a target`);
      }
    }
  }

  return { ok: problems.length === 0, present: true, problems };
}

/**
 * Has the operator recorded this slot?
 *
 * @param {unknown} evidence
 * @param {string} slot
 * @returns {boolean}
 */
export function operatorEvidenceRecorded(evidence, slot) {
  const entry = evidence?.[slot];
  return Boolean(entry && typeof entry === 'object' && entry.recorded === true);
}

/**
 * How well a recorded slot covers the surfaces it must prove.
 *
 * The expected set is the surfaces the REPOSITORY expects for this slot
 * — derived by the checker from the environment manifest and the
 * hostname matrix, never from the artifact. A slot is covered only when
 * it names EVERY expected surface and nothing else:
 *
 * - a slot that names none of them proves nothing and stays open;
 * - a slot that names only some of them proves only part of the
 *   obligation and stays open;
 * - a slot that names a surface the repository does not expect has
 *   proved something else, so it stays open.
 *
 * An EMPTY expected set never counts as covered: there would be nothing
 * to compare, and "all 0 required surfaces are covered" is not evidence.
 *
 * @param {unknown} evidence
 * @param {string} slot
 * @param {string[]} expectedTargets
 * @returns {{recorded: boolean, targets: string[], expected: string[], missing: string[], extra: string[], covered: boolean}}
 */
export function operatorEvidenceCoverage(evidence, slot, expectedTargets) {
  const expected = [...new Set((Array.isArray(expectedTargets) ? expectedTargets : []).filter(
    (target) => typeof target === 'string' && target.length > 0,
  ))];
  const entry = evidence?.[slot];
  const recorded = Boolean(entry && typeof entry === 'object' && entry.recorded === true);
  if (!recorded) {
    return { recorded: false, targets: [], expected, missing: expected, extra: [], covered: false };
  }
  const targets = Array.isArray(entry.targets)
    ? entry.targets.filter((target) => typeof target === 'string')
    : [];
  const targetSet = new Set(targets);
  const missing = expected.filter((target) => !targetSet.has(target));
  const extra = [...targetSet].filter((target) => !expected.includes(target));
  return {
    recorded: true,
    targets,
    expected,
    missing,
    extra,
    covered: expected.length > 0 && missing.length === 0 && extra.length === 0,
  };
}

/**
 * A short, value-free description of a recorded slot.
 *
 * @param {unknown} evidence
 * @param {string} slot
 * @returns {string|null} null when the slot is not recorded
 */
export function operatorEvidenceSummary(evidence, slot) {
  if (!operatorEvidenceRecorded(evidence, slot)) return null;
  const entry = evidence[slot];
  const parts = [];
  if (typeof entry.readBackAt === 'string') parts.push(`read back ${entry.readBackAt}`);
  if (typeof entry.scope === 'string' && entry.scope.length > 0) parts.push(entry.scope);
  if (typeof entry.evidenceRef === 'string' && entry.evidenceRef.length > 0) {
    parts.push(entry.evidenceRef);
  }
  return parts.length > 0 ? parts.join(' — ') : 'recorded';
}
