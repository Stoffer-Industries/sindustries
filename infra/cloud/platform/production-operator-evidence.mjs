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
// A slot carries a boolean, an ISO-8601 read-back time and a POINTER to
// the read-back (a file name or path). A value must never reach the
// artifact: the artifact is committed and pasted into public task
// comments. The checker scans the whole artifact for credential-shaped
// values, and this module keeps the operator section to shapes that
// cannot carry one.
//
// Usage:
//   import { validateOperatorEvidence, operatorEvidenceRecorded } from
//     './production-operator-evidence.mjs';

/** The operator obligations and the evidence slot that closes each one. */
export const OPERATOR_EVIDENCE_SLOTS = [
  {
    slot: 'flySpendLimit',
    gate: 'fly.spend-limit-readback',
    label: 'Fly organization spend limit',
    step: 'Slice D step 6',
    owner: 'Quinn / Tom',
    hint:
      'the Fly Billing → Limits read-back for the production app scope, recorded once the limit is set',
  },
  {
    slot: 'neonSeparationDenialProof',
    gate: 'neon.separation-denial-proof',
    label: 'Staging/dev denial proof',
    step: 'Slice D step 2',
    owner: 'Quinn (operator)',
    hint:
      'the staging/dev connection attempts that were refused against the production branch',
  },
  {
    slot: 'productionProbeInterval',
    gate: 'health.production-probe-interval',
    label: 'One successful production probe interval',
    step: 'Slice D step 7',
    owner: 'Quinn (operator)',
    hint: 'one successful production probe interval and when it was observed',
  },
  {
    slot: 'productionApiHealthResponses',
    gate: 'health.production-api-responses',
    label: 'Production API health responses',
    step: 'Slice D step 9',
    owner: 'Quinn (operator)',
    hint: 'the HTTPS health responses from all three production API hostnames',
  },
  {
    slot: 'dnsResolutionAndTlsReadback',
    gate: 'dns.resolution-and-tls-readback',
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
const SLOT_FIELDS = ['recorded', 'readBackAt', 'scope', 'evidenceRef'];

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** A short human label — no value, no punctuation that could hide one. */
const SAFE_SCOPE = /^[A-Za-z0-9 ._:/-]{1,120}$/;

/** A pointer to a read-back: a file name or path, never the value itself. */
const SAFE_EVIDENCE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

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
