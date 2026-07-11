-- Analytics schema for pipeline transition history.
--
-- Populated by agents/workflows/bookmarks/scripts/analytics_db.py::insert_transition()
-- and (future) the feature-task workflow's equivalent helper.
-- Read directly by Pulse and any future analytics endpoint.
--
-- These tables are intentionally NOT declared in schema.prisma:
-- they live outside the Tasks API domain and are queried via raw SQL.
-- This migration is idempotent — running it twice is a no-op.

CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.bookmark_transitions (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bookmark_key    TEXT,
    bookmark_url    TEXT,
    bookmark_slug   TEXT,
    from_status     TEXT,
    to_status       TEXT,
    topic           TEXT,
    approval_status TEXT,
    actor           TEXT,
    source          TEXT NOT NULL DEFAULT 'bookmark-workflow',
    payload         JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS bookmark_transitions_occurred_at_idx
    ON analytics.bookmark_transitions (occurred_at DESC);
CREATE INDEX IF NOT EXISTS bookmark_transitions_bookmark_key_idx
    ON analytics.bookmark_transitions (bookmark_key);
CREATE INDEX IF NOT EXISTS bookmark_transitions_to_status_idx
    ON analytics.bookmark_transitions (to_status);

CREATE TABLE IF NOT EXISTS analytics.task_transitions (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    task_id         UUID,
    bookmark_key    TEXT,
    from_status     TEXT,
    to_status       TEXT,
    actor           TEXT,
    source          TEXT NOT NULL DEFAULT 'feature-task-workflow',
    payload         JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS task_transitions_occurred_at_idx
    ON analytics.task_transitions (occurred_at DESC);
CREATE INDEX IF NOT EXISTS task_transitions_task_id_idx
    ON analytics.task_transitions (task_id);