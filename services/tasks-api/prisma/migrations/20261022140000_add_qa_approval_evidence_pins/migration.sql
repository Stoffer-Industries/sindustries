-- Record what a `qa_agent` approval actually verified, so the grant can be
-- re-checked against the PR's *current* state (task ad8346ee, AC2 + AC3).
--
-- Background: task 39667e62 — PR #803's AC-evidence section was blanked to
-- "test body update" *after* Ash's `qa_agent` approval was granted. Nothing
-- re-checked the approval, so the task sat silently in `doing` for ~10 days.
-- Three columns close that gap:
--
--   verifiedPrNumber        pins WHICH PR  (AC2 "verified against")
--   verifiedPrHeadSha       pins the CODE  (AC2 as written)
--   verifiedAcSectionDigest pins the EVIDENCE (AC3 as written)
--
-- The SHA and digest are required together. The incident was a PR *body*
-- edit, which need not move the head SHA at all, so a SHA-only pin cannot
-- fire for the exact failure mode that created this task. See
-- docs/specs/qa-agent-evidence-gate-tech-design.md (D2).
--
-- verifiedPrNumber was added in PR review (Quinn, 2026-10-22): the two pins
-- record what was verified but not which PR it was verified on, so AC3's
-- invalidation pass had nothing to compare the task's currently-linked PR
-- against — leaving a stale grant survivable across a #803 -> replacement-PR
-- swap. Folded into this migration rather than a second one because neither
-- has shipped to main yet.
--
-- Additive and backward-compatible: both are NULLable, so no row rewrite, no
-- lock contention on a hot table, and pre-migration rows stay valid. A NULL
-- read means "verified nothing" and is treated as STALE by the invalidation
-- pass (re-route the task to its assignee) rather than trusted — deliberately
-- fail-safe, never crash. Design note: 0 open tasks currently hold an approved
-- `qa_agent`, so there is nothing to grandfather this cycle; the treat-NULL-as-
-- stale path is implemented regardless so it is correct the day a legacy row exists.

ALTER TABLE "TaskApproval" ADD COLUMN IF NOT EXISTS "verifiedPrNumber" INTEGER;
ALTER TABLE "TaskApproval" ADD COLUMN IF NOT EXISTS "verifiedPrHeadSha" TEXT;
ALTER TABLE "TaskApproval" ADD COLUMN IF NOT EXISTS "verifiedAcSectionDigest" TEXT;

-- Preflight (run before applying):
--   SELECT count(*) FROM "TaskApproval" WHERE type = 'qa_agent' AND state = 'approved';
-- Expected: 0 rows. Any row here predates this migration and will read NULL on
-- all three pins — i.e. stale — until re-verified and re-approved with an attestation.

-- Post-apply (run after):
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--     WHERE table_name = 'TaskApproval'
--       AND column_name IN ('verifiedPrNumber','verifiedPrHeadSha','verifiedAcSectionDigest');
-- Expected: three rows; verifiedPrNumber type integer, the other two text,
-- all three is_nullable = 'YES'.

-- Rollback (if the migration must be reversed):
--   ALTER TABLE "TaskApproval" DROP COLUMN IF EXISTS "verifiedPrNumber";
--   ALTER TABLE "TaskApproval" DROP COLUMN IF EXISTS "verifiedPrHeadSha";
--   ALTER TABLE "TaskApproval" DROP COLUMN IF EXISTS "verifiedAcSectionDigest";
-- Note: this DESTROYS the pinning evidence for every row written since the
-- migration, after which stale grants cannot be detected again. Only revert if
-- the enforcement code that reads these columns is reverted in the same change.
