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

import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The controls that can bound production spend, and what each one is.
 *
 * WHY A CONTROL IS NAMED
 *
 * The slot was written for one control: a native Fly organisation/app
 * spend limit, read back from the Fly billing surface. That control does
 * not exist on this account — Fly exposes no spend-limit surface at all
 * (no GraphQL field, no REST path, no `flyctl` flag), which the capture
 * and the blocker register both record.
 *
 * Tom approved a different control on 2026-11-17 (NZDT): a prepaid /
 * capped billing method as the Fly production billing method. A record
 * that cannot say WHICH control bounded the spend would force the
 * operator to either leave AC5 unrecordable forever, or to write a
 * "Fly organization spend limit" attestation for something that is not
 * one. A gate that can only be satisfied by a lie is a broken gate.
 *
 * So a recorded spend slot names its control, and the name is an
 * allow-list: an unknown control is refused rather than trusted, and a
 * recorded slot with no control at all is refused too — a read-back that
 * does not say what bounded the spend proves nothing about the bound.
 */
export const SPEND_BOUND_CONTROLS = {
  'fly-native-spend-limit':
    'a native Fly organisation/app spend limit, read back from the Fly billing surface',
  'prepaid-capped-billing-method':
    'a prepaid or capped billing method on the Fly production billing account, read back from the billing surface',
};

/** The operator obligations and the evidence slot that closes each one. */
export const OPERATOR_EVIDENCE_SLOTS = [
  {
    slot: 'flySpendLimit',
    gate: 'fly.spend-limit-readback',
    coverage: 'platformAppScope',
    label: 'Production spend bound',
    step: 'Slice D step 6',
    owner: 'Quinn / Tom',
    controls: Object.keys(SPEND_BOUND_CONTROLS),
    hint:
      'the read-back of the control that bounds production spend for the production app scope — a native Fly spend limit or the approved prepaid/capped billing method',
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
const SLOT_FIELDS = ['recorded', 'readBackAt', 'scope', 'evidenceRef', 'targets', 'control'];

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** A short human label — no value, no punctuation that could hide one. */
const SAFE_SCOPE = /^[A-Za-z0-9 ._:/-]{1,120}$/;

/** A pointer to a read-back: a file name or path, never the value itself. */
const SAFE_EVIDENCE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Is this an inspectable pointer to a read-back?
 *
 * The pointer is REQUIRED for a recorded slot: without it, a boolean and a
 * timestamp prove only that a statement was made, not that anyone can
 * inspect the read-back behind it. The literal strings "null" and
 * "undefined" are placeholders, not pointers, so they are refused too.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeEvidenceRef(value) {
  return (
    typeof value === 'string' &&
    value !== 'null' &&
    value !== 'undefined' &&
    SAFE_EVIDENCE_REF.test(value)
  );
}

/**
 * Is this a repository-relative path with no traversal or empty segment?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeEvidencePath(value) {
  if (!isSafeEvidenceRef(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Why this evidence reference cannot be inspected, or null when it can.
 *
 * A safe-looking string is not yet an inspectable attestation: the path
 * may name a file that does not exist, may escape the repository, or may
 * point at a directory. The pointer is resolved inside the repository
 * root, so an artifact copied to another checkout still names a file a
 * reviewer can open there.
 *
 * @param {unknown} value
 * @param {unknown} repoRoot
 * @returns {string|null}
 */
function evidenceRefProblem(value, repoRoot) {
  if (!isSafeEvidencePath(value)) {
    return 'must carry a safe repository-relative "evidenceRef" pointer to the read-back';
  }
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    return 'cannot verify the "evidenceRef" pointer without a repository root';
  }

  const root = resolve(repoRoot);
  const candidate = resolve(root, value);
  const relativeCandidate = relative(root, candidate);
  if (
    relativeCandidate === '' ||
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate)
  ) {
    return 'must point inside the repository';
  }
  if (!existsSync(candidate)) {
    return 'does not point to an existing file in the repository';
  }
  if (!statSync(candidate).isFile()) {
    return 'does not point to a regular file in the repository';
  }

  // A symlink inside the repository may still point outside it. Compare
  // the real paths so the pointer cannot escape through a link.
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const relativeRealCandidate = relative(realRoot, realCandidate);
    if (
      relativeRealCandidate === '' ||
      relativeRealCandidate === '..' ||
      relativeRealCandidate.startsWith(`..${sep}`) ||
      isAbsolute(relativeRealCandidate)
    ) {
      return 'must point inside the repository';
    }
  } catch {
    return 'cannot be inspected in the repository';
  }

  return null;
}

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
 * @param {{capturedAt?: string, repoRoot?: string}} [options] artifact context
 *   for cross-field checks; `capturedAt` bounds when a read-back may have
 *   happened and `repoRoot` makes every recorded pointer inspectable
 * @returns {{ok: boolean, present: boolean, problems: string[]}}
 */
export function validateOperatorEvidence(value, options = {}) {
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
  const capturedAt = options.capturedAt;
  const capturedAtIsUsable = capturedAt === undefined || isIsoTimestamp(capturedAt);
  if (!capturedAtIsUsable) {
    problems.push(
      'the artifact capture time is invalid, so a recorded read-back cannot be bounded',
    );
  }
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

    // The control a read-back names. It is an allow-list, never a free
    // string: a control the contract does not define proves nothing, and
    // the VALUE is never echoed back — a control field is an enum, but a
    // malformed artifact can carry anything in it.
    const slotDefinition = OPERATOR_EVIDENCE_SLOTS.find((entry) => entry.slot === slot);
    const allowedControls = Array.isArray(slotDefinition?.controls) ? slotDefinition.controls : [];
    const control = entry.control;
    const controlIsSet = control !== undefined && control !== null;
    if (controlIsSet) {
      if (allowedControls.length === 0) {
        problems.push(
          `the operator evidence slot "${slot}" carries a "control" the contract does not define`,
        );
      } else if (typeof control !== 'string' || !allowedControls.includes(control)) {
        problems.push(
          `the operator evidence slot "${slot}" carries an unknown control — the allowed controls are ${allowedControls.join(', ')}`,
        );
      }
    }

    // A slot that is explicitly NOT recorded is a statement, not a defect:
    // the operator has not done that step yet.
    if (entry.recorded !== true) {
      if (controlIsSet) {
        problems.push(
          `the operator evidence slot "${slot}" names a control but records no read-back`,
        );
      }
      continue;
    }

    // A recorded slot that must name its control has not proved anything
    // until it does: a read-back that does not say WHAT bounded the spend
    // cannot be checked against the control the operator actually set.
    if (allowedControls.length > 0 && !allowedControls.includes(entry.control)) {
      problems.push(
        `the operator evidence slot "${slot}" records a read-back without naming the control it read back — the allowed controls are ${allowedControls.join(', ')}`,
      );
    }
    if (!isIsoTimestamp(entry.readBackAt)) {
      problems.push(
        `the operator evidence slot "${slot}" records a read-back without an ISO-8601 "readBackAt"`,
      );
    } else if (capturedAtIsUsable && capturedAt !== undefined) {
      if (Date.parse(entry.readBackAt) > Date.parse(capturedAt)) {
        problems.push(
          `the operator evidence slot "${slot}" records a read-back after the artifact was captured`,
        );
      }
    }
    if (
      entry.scope !== undefined &&
      entry.scope !== null &&
      (typeof entry.scope !== 'string' || !SAFE_SCOPE.test(entry.scope))
    ) {
      problems.push(`the operator evidence slot "${slot}" carries an unusable "scope"`);
    }
    const evidenceRefIssue = evidenceRefProblem(entry.evidenceRef, options.repoRoot);
    if (evidenceRefIssue) {
      problems.push(`the operator evidence slot "${slot}" ${evidenceRefIssue}`);
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
 * A blank record for the operator to fill in.
 *
 * The template is the SAME contract the checker compares against, so the
 * operator cannot fill it in wrongly by guessing: every slot carries the
 * production surfaces it must cover, pre-filled from the repository's own
 * facts, and the operator only has to say WHEN the read-back happened,
 * WHAT it covered and WHERE the read-back lives.
 *
 * Every slot starts at `recorded: false`, which is a statement — "not yet
 * read back" — rather than a defect, so the template validates. The
 * capture refuses it as a record (a file that records nothing is not a
 * read-back), and that refusal is the point: the template is a form, not
 * an attestation.
 *
 * @param {Record<string, string[]>} expectedTargets the surfaces per coverage
 * @returns {Record<string, object>}
 */
export function operatorEvidenceTemplate(expectedTargets) {
  const template = {};
  for (const entry of OPERATOR_EVIDENCE_SLOTS) {
    const targets = expectedTargets?.[entry.coverage];
    template[entry.slot] = {
      recorded: false,
      readBackAt: null,
      scope: null,
      evidenceRef: null,
      targets: Array.isArray(targets) ? [...targets] : [],
    };
    // A slot whose read-back must name a control carries the field, so the
    // operator is told WHICH control the record is about instead of
    // guessing it. It stays null until a read-back exists — a template
    // names no control, because naming one would be a claim.
    if (Array.isArray(entry.controls) && entry.controls.length > 0) {
      template[entry.slot].control = null;
    }
  }
  return template;
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
  if (typeof entry.control === 'string' && entry.control.length > 0) {
    parts.push(`control ${entry.control}`);
  }
  if (typeof entry.scope === 'string' && entry.scope.length > 0) parts.push(entry.scope);
  if (typeof entry.evidenceRef === 'string' && entry.evidenceRef.length > 0) {
    parts.push(entry.evidenceRef);
  }
  return parts.length > 0 ? parts.join(' — ') : 'recorded';
}
