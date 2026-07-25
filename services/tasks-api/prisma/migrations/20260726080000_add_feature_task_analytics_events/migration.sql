-- Feature-task lifecycle analytics events.
--
-- Append-only except for idempotent upsert by `eventKey`. Emitted by the
-- Feature Factory Rust CLI (agents/workflows/feature-task) and read by
-- the Tasks API routes, the Mission Control flow dashboard, and the
-- replay CLI. See
-- docs/specs/post-merge-feature-factory-analytics-tech-design.md.

CREATE TABLE "FeatureTaskAnalyticsEvent" (
    "id"                        UUID NOT NULL,
    "taskId"                    UUID NOT NULL,
    "eventKey"                  TEXT NOT NULL,
    "eventType"                 TEXT NOT NULL,
    "gate"                      TEXT,
    "cause"                     TEXT,
    "message"                   TEXT,
    "occurredAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminalStatus"            TEXT,
    "completionTimestamp"       TIMESTAMP(3),
    "totalGateFailureCount"     INTEGER,
    "capacityBlockCount"        INTEGER,
    "qualityFailureCount"       INTEGER,
    "prCycleTimeSeconds"        INTEGER,
    "evidenceTypeDistribution"  JSONB,
    "details"                   JSONB,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureTaskAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- Idempotency key per event (gate failure hash + ordinal, or terminal status).
CREATE UNIQUE INDEX "FeatureTaskAnalyticsEvent_eventKey_key"
    ON "FeatureTaskAnalyticsEvent"("eventKey");

-- Per-task replay queries (chronological).
CREATE INDEX "FeatureTaskAnalyticsEvent_taskId_occurredAt_idx"
    ON "FeatureTaskAnalyticsEvent"("taskId", "occurredAt");

-- Weekly bucket scans.
CREATE INDEX "FeatureTaskAnalyticsEvent_occurredAt_idx"
    ON "FeatureTaskAnalyticsEvent"("occurredAt");

-- Filter by event type on dashboard queries.
CREATE INDEX "FeatureTaskAnalyticsEvent_eventType_occurredAt_idx"
    ON "FeatureTaskAnalyticsEvent"("eventType", "occurredAt");

-- Cascades on task archive/delete so analytics never outlive the task.
ALTER TABLE "FeatureTaskAnalyticsEvent"
    ADD CONSTRAINT "FeatureTaskAnalyticsEvent_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
