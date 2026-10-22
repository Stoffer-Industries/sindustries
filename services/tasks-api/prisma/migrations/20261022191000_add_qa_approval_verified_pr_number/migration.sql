-- Record WHICH PR a `qa_agent` approval was verified against (task ad8346ee,
-- review feedback on PR #863, point 3).
--
-- `20261022140000_add_qa_approval_evidence_pins` added two pins:
--
--   verifiedPrHeadSha       pins the CODE     — but not which PR carried it
--   verifiedAcSectionDigest pins the EVIDENCE — but not which PR carried it
--
-- Both record *what* was verified. Neither records *where*. `evaluateQaAttestation`
-- already parses and returns `attestation.prNumber`, and the write path dropped
-- it on the floor, so a task whose linked PR is swapped (#803 -> replacement PR,
-- the exact shape this whole task exists to catch) would leave the invalidation
-- pass with nothing to compare the task's currently-linked PR against.
--
-- This closes that: one nullable INTEGER, persisted through the same write path
-- as the other two pins, so a re-approval overwrites all three atomically.
--
-- Additive and backward-compatible: nullable, so no row rewrite and no lock
-- contention. Pre-existing rows read NULL, which the invalidation pass treats as
-- stale (re-route to the assignee) rather than trusted — consistent with the
-- treat-NULL-as-stale rule the other two pins already rely on.

ALTER TABLE "TaskApproval" ADD COLUMN IF NOT EXISTS "verifiedPrNumber" INTEGER;

-- Preflight (run before applying):
--   SELECT count(*) FROM "TaskApproval"
--     WHERE type = 'qa_agent' AND state = 'approved'
--       AND "verifiedPrHeadSha" IS NOT NULL;
-- Expected: 0 rows. Any row here was attested before this migration and will
-- read NULL on verifiedPrNumber — i.e. partially pinned — until re-approved
-- with a fresh attestation that carries a PR number.

-- Post-apply (run after):
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--     WHERE table_name = 'TaskApproval' AND column_name = 'verifiedPrNumber';
-- Expected: one row, type integer, is_nullable = 'YES'.

-- Rollback (if the migration must be reversed):
--   ALTER TABLE "TaskApproval" DROP COLUMN IF EXISTS "verifiedPrNumber";
-- Note: this DESTROYS the record of which PR each grant was verified on, after
-- which a linked-PR swap is undetectable again. Only revert if the enforcement
-- code that reads this column is reverted in the same change.