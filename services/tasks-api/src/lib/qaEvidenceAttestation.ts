/**
 * AC-evidence attestation gate for `qa_agent` approvals — task `ad8346ee`
 * ("Gate Ash's `qa_agent` approval on live AC-evidence + SHA-pinned
 * invalidation"), AC1.
 *
 * ## Why this exists
 *
 * Task `39667e62`: PR #803's AC-evidence section was blanked to
 * `"test body update"` *after* Ash's `qa_agent` approval had already been
 * granted. Nothing re-checked the grant against the PR's current state, so
 * the task sat silently parked in `doing` for ~10 days before a human
 * noticed. Two gates that both claim to answer "is this task's acceptance
 * evidence real?" — the structured `qa_agent` approval and the lobster's
 * mechanical AC-evidence check — could each pass or fail independently.
 *
 * ## Compute lives in Rust; this file is only the enforcement
 *
 * Per design decision D1, the mechanical check itself has exactly ONE
 * implementation: `ac_parsing::mechanical_evidence_failures` in the Rust
 * `feature-task` crate. Ash mints an attestation by invoking that logic
 * (the `mechanical-evidence-check` subcommand) immediately before its
 * approval write. The API cannot recompute the check — that is Rust — but it
 * CAN refuse a grant that arrives without a matching, fresh attestation. That
 * is what makes the gate *structural* rather than advisory: a future writer
 * cannot bypass it by forgetting to call something.
 *
 * Porting the check to TypeScript here would create a third implementation
 * (Rust + Ash's `verify.ts` already exist) and a guaranteed-drift bug — the
 * exact duplicated-source-of-truth shape this design rejects.
 *
 * ## What is verified here (and what is deliberately NOT)
 *
 * Verified: the attestation is present, complete, reports no mechanical
 * failures, and is fresh.
 *
 * NOT verified: that the pinned values match the PR's *current* state. The
 * API has no GitHub access by design, and it must not grow one. That re-check
 * is AC3's job, and it lives in the lobster's `verify_delivery` stage, which
 * already has the PR fetchers. Splitting it this way is deliberate: the write
 * path stays hermetic, and the drift detection stays where the PR data already
 * is.
 *
 * ## On "single-use"
 *
 * The approved design (Quinn, 2026-10-22) makes the attestation single-use —
 * consumed by the approval write that stores its pins — with a 15-minute TTL
 * retained only as a replay guard for an attestation minted but never spent.
 *
 * Implemented honestly: the TTL below is a real bound, and the pins are
 * consumed onto the row at write time so a later grant must present a *fresh*
 * attestation that overwrites them. What is NOT enforced is single-use *within*
 * the 15-minute window — replaying a byte-identical attestation in that window
 * is idempotent (the route's existing same-owner/same-note branch returns the
 * existing row) rather than rejected. Closing that residual needs the mint
 * timestamp persisted, i.e. a third column, which D2 did not approve. Flagged
 * rather than quietly widened; Slice 3 can tighten it if Quinn wants it closed.
 */

/** Error code returned when the gate refuses a `qa_agent` approval. */
export const QA_EVIDENCE_GATE_BLOCKED = 'QA_EVIDENCE_GATE_BLOCKED';

/**
 * Replay guard for an attestation minted but never spent.
 *
 * Deliberately short. It is not a "how stale is too stale" policy — the
 * attestation describes a check that must be *current* at the moment of
 * approval, so a long TTL would let a grant certify evidence nobody re-checked.
 */
export const ATTESTATION_TTL_MS = 15 * 60 * 1000;

/**
 * Machine-readable reasons a grant was refused. Surfaced as
 * `error.details.reason` so a caller can distinguish "mint a new attestation"
 * (stale/expired) from "fix the evidence" (failures) and post the right
 * `[qa-agent-blocked]` comment.
 */
export const ATTESTATION_REASONS = {
  MISSING: 'attestation_missing',
  MALFORMED: 'attestation_malformed',
  FAILURES: 'attestation_reports_failures',
  EXPIRED: 'attestation_expired'
} as const;

/**
 * @typedef {{ prNumber?: unknown, headSha?: unknown, acSectionDigest?: unknown,
 *            failures?: unknown, verifiedAt?: unknown }} QaAttestation
 * @typedef {{ ok: true, prNumber: number|null, headSha: string, acSectionDigest: string }
 *          | { ok: false, reason: string, message: string, failures: string[] }} AttestationVerdict
 */

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asFailures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Evaluate a `qa_agent` attestation supplied with an approval write.
 *
 * Pure and synchronous: no I/O, no clock read beyond the injected `now`, so
 * the TTL boundary is directly testable.
 *
 * @param {unknown} body raw request body (attestation is read from `.attestation`)
 * @param {Date} [now] injectable clock for the TTL check
 * @returns {AttestationVerdict}
 */
export function evaluateQaAttestation(body: unknown, now: Date = new Date()): AttestationVerdict {
  const attestation = (body as { attestation?: QaAttestation } | null | undefined)?.attestation;

  if (attestation === null || attestation === undefined) {
    return {
      ok: false,
      reason: ATTESTATION_REASONS.MISSING,
      message:
        'qa_agent approvals require an `attestation` minted by `feature-task mechanical-evidence-check`. ' +
        'Run that subcommand against the current PR head immediately before approving.',
      failures: []
    };
  }

  if (typeof attestation !== 'object' || Array.isArray(attestation)) {
    return {
      ok: false,
      reason: ATTESTATION_REASONS.MALFORMED,
      message: '`attestation` must be an object.',
      failures: []
    };
  }

  const headSha = asNonEmptyString(attestation.headSha);
  const acSectionDigest = asNonEmptyString(attestation.acSectionDigest);

  if (!headSha || !acSectionDigest) {
    return {
      ok: false,
      reason: ATTESTATION_REASONS.MALFORMED,
      message: '`attestation` requires non-empty `headSha` and `acSectionDigest` fields.',
      failures: []
    };
  }

  // Checked BEFORE the TTL so a caller with real evidence problems is told
  // what to fix, rather than being sent away to re-mint an attestation that
  // will fail identically.
  const failures = asFailures(attestation.failures);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: ATTESTATION_REASONS.FAILURES,
      message:
        'The live mechanical AC-evidence check reported failures; this PR cannot receive a qa_agent approval yet.',
      failures
    };
  }

  const verifiedAt = new Date(asNonEmptyString(attestation.verifiedAt) ?? '');
  if (Number.isNaN(verifiedAt.getTime())) {
    return {
      ok: false,
      reason: ATTESTATION_REASONS.MALFORMED,
      message: '`attestation.verifiedAt` must be an ISO-8601 timestamp.',
      failures: []
    };
  }

  // A verifiedAt far in the *future* means a clock skew or a forged value.
  // Tolerance is one TTL so minor skew is forgiven, not the whole 15 minutes.
  const ageMs = now.getTime() - verifiedAt.getTime();
  if (ageMs > ATTESTATION_TTL_MS || ageMs < -ATTESTATION_TTL_MS) {
    return {
      ok: false,
      reason: ATTESTATION_REASONS.EXPIRED,
      message:
        `The attestation is outside the ${Math.round(ATTESTATION_TTL_MS / 60000)}-minute validity window. ` +
        'Re-run `feature-task mechanical-evidence-check` against the current PR head and approve again.',
      failures: []
    };
  }

  const prNumber = typeof attestation.prNumber === 'number' && Number.isFinite(attestation.prNumber)
    ? attestation.prNumber
    : null;

  return { ok: true, prNumber, headSha, acSectionDigest };
}