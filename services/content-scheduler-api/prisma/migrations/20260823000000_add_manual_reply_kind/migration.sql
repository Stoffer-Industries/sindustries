-- Migration: manual_reply kind discriminator + posted-URL fields on ContentSchedulerItem.
-- Task: 5279b310-9a15-43eb-ad31-c42e866728ca (🔧 Bookmark approval — build-in-public
-- tweet + manual reply draft).
-- Tech design: docs/specs/bookmark-approval-author-mention-tweet-2026-08-19-tech-design.md
-- Refresh:     docs/specs/bookmark-approval-author-mention-tweet-2026-08-23-refresh.md
--
-- Adds:
--   1. ContentSchedulerItemKind enum { scheduled | manual_reply }
--   2. ContentSchedulerItem.kind              ContentSchedulerItemKind DEFAULT 'scheduled'
--   3. ContentSchedulerItem.manualPostedUrl   String? (captures the X URL of Tom's
--                                              manually-posted reply, AC5)
--   4. ContentSchedulerItem.manualPostedAt    DateTime? (server clock at PATCH time)
--   5. ContentSchedulerItem.linksToItemId     String? (cross-link from a manual_reply
--                                              item to its companion standalone tweet
--                                              item, both ContentSchedulerItem rows)
--   6. Index on (kind) so the list endpoint can filter manual_reply rows without a
--      sequential scan once the table grows.
--
-- The DEFAULT 'scheduled' on `kind` preserves backwards compatibility for every
-- existing row — no data migration or rewrite needed. Rows that pre-date this
-- migration continue to flow through the publish loop unchanged.
--
-- The `linksToItemId` column is intentionally NOT a foreign key reference to
-- ContentSchedulerItem(id): a manual_reply item and its companion standalone
-- tweet are both created in the same bookmark approval hook, but the link is
-- one-way (reply -> standalone) and is part of the public API contract surfaced
-- via the MC UI. A FK would also require an ON DELETE rule that the rest of the
-- schema doesn't currently express. The link is treated as advisory; the UI
-- gracefully renders a missing-link warning if the standalone item is removed
-- before its reply item.

CREATE TYPE "ContentSchedulerItemKind" AS ENUM ('scheduled', 'manual_reply');

ALTER TABLE "content_scheduler"."ContentSchedulerItem"
  ADD COLUMN "kind" "ContentSchedulerItemKind" NOT NULL DEFAULT 'scheduled',
  ADD COLUMN "manualPostedUrl" TEXT,
  ADD COLUMN "manualPostedAt" TIMESTAMP(3),
  ADD COLUMN "linksToItemId" TEXT;

CREATE INDEX "ContentSchedulerItem_kind_idx" ON "content_scheduler"."ContentSchedulerItem" ("kind");
