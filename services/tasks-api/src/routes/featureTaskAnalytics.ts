// Feature-task lifecycle analytics routes — Express router mounted at
// /api/v1/feature-task-analytics.
//
// Implements the read/write surface for AC1-AC3 from task
// f170e344-ea5f-4443-bebb-035948686fc1 (Post-Merge Feature Factory
// Analytics). The Rust workflow CLI emits events here on every gate
// failure and terminal transition; the Mission Control flow dashboard
// reads weekly buckets; the replay CLI reads raw events per task.
//
// Endpoints:
//   POST /events                  write one event or { events: [...] }, upsert on eventKey
//   GET  /tasks/:taskId/events    chronological raw events for a task
//   GET  /weekly?weeks=8          Monday-start weekly buckets
//
// All write endpoints accept an `x-actor` header that defaults to
// "unknown" — there is no auth in v1 (single-user MVP per the tech design).
//
// Tech design: docs/specs/post-merge-feature-factory-analytics-tech-design.md

import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound } from '../lib/http.ts';
import { uuidPattern } from './tasks/_constants.ts';

export const featureTaskAnalyticsRouter = Router();

const VALID_EVENT_TYPES = new Set(['gate_failure', 'terminal_summary']);
const VALID_GATES = new Set([
  'spec_check',
  'ready_checks',
  'verify_delivery',
  'feedback_aggregate',
  'post_merge'
]);
const VALID_CAUSES = new Set(['capacity', 'quality']);
const VALID_TERMINAL_STATUSES = new Set(['done', 'accepted']);
const TERMINAL_SUMMARY_VALID_NUMERIC = (value) =>
  value === null || value === undefined || (Number.isInteger(value) && value >= 0);

function validateEvent(event) {
  if (!event || typeof event !== 'object') {
    return 'event must be an object';
  }

  if (typeof event.taskId !== 'string' || !uuidPattern.test(event.taskId)) {
    return 'taskId must be a 36-char UUID';
  }

  if (typeof event.eventKey !== 'string' || !event.eventKey.trim()) {
    return 'eventKey must be a non-empty string';
  }

  if (!VALID_EVENT_TYPES.has(event.eventType)) {
    return 'eventType must be one of: gate_failure, terminal_summary';
  }

  if (event.gate !== undefined && event.gate !== null && !VALID_GATES.has(event.gate)) {
    return 'gate must be one of: spec_check, ready_checks, verify_delivery, feedback_aggregate, post_merge';
  }

  if (event.cause !== undefined && event.cause !== null && !VALID_CAUSES.has(event.cause)) {
    return 'cause must be one of: capacity, quality';
  }

  if (event.message !== undefined && event.message !== null && typeof event.message !== 'string') {
    return 'message must be a string';
  }

  if (event.eventType === 'gate_failure') {
    if (!event.gate) {
      return 'gate_failure events require gate';
    }
    if (!event.cause) {
      return 'gate_failure events require cause';
    }
  }

  if (event.eventType === 'terminal_summary') {
    if (event.gate !== undefined && event.gate !== null) {
      return 'terminal_summary events must not include gate';
    }
    if (event.cause !== undefined && event.cause !== null) {
      return 'terminal_summary events must not include cause';
    }
    if (event.terminalStatus !== undefined && event.terminalStatus !== null
        && !VALID_TERMINAL_STATUSES.has(event.terminalStatus)) {
      return 'terminalStatus must be one of: done, accepted';
    }
    if (!TERMINAL_SUMMARY_VALID_NUMERIC(event.totalGateFailureCount)) {
      return 'totalGateFailureCount must be a non-negative integer';
    }
    if (!TERMINAL_SUMMARY_VALID_NUMERIC(event.capacityBlockCount)) {
      return 'capacityBlockCount must be a non-negative integer';
    }
    if (!TERMINAL_SUMMARY_VALID_NUMERIC(event.qualityFailureCount)) {
      return 'qualityFailureCount must be a non-negative integer';
    }
    if (!TERMINAL_SUMMARY_VALID_NUMERIC(event.prCycleTimeSeconds)) {
      return 'prCycleTimeSeconds must be a non-negative integer';
    }
    if (event.evidenceTypeDistribution !== undefined && event.evidenceTypeDistribution !== null
        && (typeof event.evidenceTypeDistribution !== 'object' || Array.isArray(event.evidenceTypeDistribution))) {
      return 'evidenceTypeDistribution must be a JSON object';
    }
  }

  return null;
}

function normalizeEvent(event) {
  const data = {
    taskId: event.taskId,
    eventKey: event.eventKey.trim(),
    eventType: event.eventType,
    occurredAt: event.occurredAt ? new Date(event.occurredAt) : new Date()
  };

  if (event.gate !== undefined && event.gate !== null) data.gate = event.gate;
  if (event.cause !== undefined && event.cause !== null) data.cause = event.cause;
  if (event.message !== undefined && event.message !== null) data.message = event.message;

  if (event.eventType === 'terminal_summary') {
    if (event.terminalStatus) data.terminalStatus = event.terminalStatus;
    if (event.completionTimestamp) data.completionTimestamp = new Date(event.completionTimestamp);
    if (event.totalGateFailureCount !== undefined && event.totalGateFailureCount !== null) {
      data.totalGateFailureCount = event.totalGateFailureCount;
    }
    if (event.capacityBlockCount !== undefined && event.capacityBlockCount !== null) {
      data.capacityBlockCount = event.capacityBlockCount;
    }
    if (event.qualityFailureCount !== undefined && event.qualityFailureCount !== null) {
      data.qualityFailureCount = event.qualityFailureCount;
    }
    if (event.prCycleTimeSeconds !== undefined && event.prCycleTimeSeconds !== null) {
      data.prCycleTimeSeconds = event.prCycleTimeSeconds;
    }
    if (event.evidenceTypeDistribution) data.evidenceTypeDistribution = event.evidenceTypeDistribution;
  }

  if (event.details) data.details = event.details;

  return data;
}

function eventResponse(event) {
  return {
    id: event.id,
    taskId: event.taskId,
    eventKey: event.eventKey,
    eventType: event.eventType,
    gate: event.gate,
    cause: event.cause,
    message: event.message,
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
    terminalStatus: event.terminalStatus,
    completionTimestamp: event.completionTimestamp instanceof Date
      ? event.completionTimestamp.toISOString()
      : event.completionTimestamp,
    totalGateFailureCount: event.totalGateFailureCount,
    capacityBlockCount: event.capacityBlockCount,
    qualityFailureCount: event.qualityFailureCount,
    prCycleTimeSeconds: event.prCycleTimeSeconds,
    evidenceTypeDistribution: event.evidenceTypeDistribution,
    details: event.details,
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt
  };
}

featureTaskAnalyticsRouter.post('/feature-task-analytics/events', async (req, res, next) => {
  try {
    // Accept either a single event or { events: [...] } for batching.
    const batch = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    if (batch.length === 0) {
      return badRequest(res, 'EVENTS_REQUIRED', 'events array must contain at least one event');
    }
    if (batch.length > 500) {
      return badRequest(res, 'BATCH_TOO_LARGE', 'events batch must contain at most 500 events');
    }

    for (const event of batch) {
      const error = validateEvent(event);
      if (error) return badRequest(res, 'INVALID_EVENT', error);
    }

    const normalized = batch.map(normalizeEvent);
    const results = await prisma.$transaction(
      normalized.map((data) =>
        prisma.featureTaskAnalyticsEvent.upsert({
          where: { eventKey: data.eventKey },
          create: data,
          update: data
        })
      )
    );

    // Track which eventKeys are newly created vs updated by inspecting
    // the createdAt/updatedAt delta. Cheap and correct: if they match,
    // this is a true create (UPSERT inserted a row); if updatedAt > createdAt,
    // we updated an existing row.
    const created = results.filter((row) => row.createdAt.getTime() === row.updatedAt.getTime()).length;
    const updated = results.length - created;

    return res.status(201).json({
      data: {
        created,
        updated,
        events: results.map(eventResponse)
      }
    });
  } catch (error) {
    return next(error);
  }
});

featureTaskAnalyticsRouter.get('/feature-task-analytics/tasks/:taskId/events', async (req, res, next) => {
  try {
    const taskId = typeof req.params.taskId === 'string' ? req.params.taskId.trim() : null;
    if (!taskId || !uuidPattern.test(taskId)) {
      return badRequest(res, 'INVALID_TASK_ID', 'taskId must be a 36-char UUID');
    }

    const task = await prisma.task.findFirst({ where: { id: taskId, archivedAt: null }, select: { id: true } });
    if (!task) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const events = await prisma.featureTaskAnalyticsEvent.findMany({
      where: { taskId },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }]
    });

    return res.status(200).json({ data: events.map(eventResponse) });
  } catch (error) {
    return next(error);
  }
});

/**
 * Compute the Monday-start of the ISO week containing `date`. Matches
 * `flowMetrics.isoMonday()` in apps/mission-control/src/flowMetrics.js so
 * dashboard numbers align with prior Flow Metrics panels.
 */
function isoMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function isoDateOnly(date) {
  // Use local-date components so the week-start label matches the
  // tz-aware isoMonday() above. A 2026-07-20 NZST Monday at midnight
  // is 2026-07-19T12:00:00Z in UTC; `.toISOString().slice(0,10)` would
  // emit '2026-07-19' and break the dashboard's week alignment.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseWeeks(rawWeeks) {
  if (rawWeeks === undefined || rawWeeks === null || rawWeeks === '') return 8;
  const n = Number.parseInt(`${rawWeeks}`, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  if (n > 52) return null;
  return n;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile — same convention used in apps/mission-control
  // flowMetrics if it shows up there. Integer-friendly for seconds.
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

featureTaskAnalyticsRouter.get('/feature-task-analytics/weekly', async (req, res, next) => {
  try {
    const weeks = parseWeeks(req.query?.weeks);
    if (weeks === null) {
      return badRequest(res, 'INVALID_WEEKS', 'weeks must be an integer between 1 and 52');
    }

    const now = new Date();
    const thisMonday = isoMonday(now);
    const buckets = [];
    for (let i = weeks - 1; i >= 0; i -= 1) {
      const start = new Date(thisMonday);
      start.setDate(start.getDate() - i * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      buckets.push({ start, end });
    }

    const earliest = buckets[0].start;
    const events = await prisma.featureTaskAnalyticsEvent.findMany({
      where: {
        occurredAt: { gte: earliest, lt: buckets[buckets.length - 1].end }
      },
      select: {
        taskId: true,
        eventType: true,
        cause: true,
        occurredAt: true,
        prCycleTimeSeconds: true,
        evidenceTypeDistribution: true
      }
    });

    const bucketsByWeek = buckets.map((bucket) => ({
      weekStart: isoDateOnly(bucket.start),
      terminalTaskCount: 0,
      taskWithFailureCount: 0,
      gateFailureCount: 0,
      capacityFailureCount: 0,
      qualityFailureCount: 0,
      gateFailureRate: null,
      medianPrCycleTimeSeconds: null,
      p90PrCycleTimeSeconds: null,
      evidenceTypeDistribution: {},
      _terminalTasks: new Set(),
      _failureTasks: new Set(),
      _prCycleTimes: []
    }));

    for (const event of events) {
      const occurred = event.occurredAt;
      const bucketIndex = buckets.findIndex((b) => occurred >= b.start && occurred < b.end);
      if (bucketIndex === -1) continue;
      const stats = bucketsByWeek[bucketIndex];

      if (event.eventType === 'terminal_summary') {
        stats.terminalTaskCount += 1;
        stats._terminalTasks.add(event.taskId);
        if (typeof event.prCycleTimeSeconds === 'number') {
          stats._prCycleTimes.push(event.prCycleTimeSeconds);
        }
        if (event.evidenceTypeDistribution && typeof event.evidenceTypeDistribution === 'object') {
          for (const [key, count] of Object.entries(event.evidenceTypeDistribution)) {
            stats.evidenceTypeDistribution[key] = (stats.evidenceTypeDistribution[key] || 0) + Number(count);
          }
        }
      } else if (event.eventType === 'gate_failure') {
        stats.gateFailureCount += 1;
        if (event.cause === 'capacity') stats.capacityFailureCount += 1;
        else if (event.cause === 'quality') stats.qualityFailureCount += 1;
        stats._failureTasks.add(event.taskId);
      }
    }

    const response = bucketsByWeek.map((stats) => {
      const taskWithFailureCount = stats._failureTasks.size;
      const denominator = stats.terminalTaskCount;
      const gateFailureRate = denominator === 0 ? null : Number((taskWithFailureCount / denominator).toFixed(4));
      return {
        weekStart: stats.weekStart,
        terminalTaskCount: stats.terminalTaskCount,
        taskWithFailureCount,
        gateFailureCount: stats.gateFailureCount,
        capacityFailureCount: stats.capacityFailureCount,
        qualityFailureCount: stats.qualityFailureCount,
        gateFailureRate,
        medianPrCycleTimeSeconds: median(stats._prCycleTimes),
        p90PrCycleTimeSeconds: percentile(stats._prCycleTimes, 90),
        evidenceTypeDistribution: stats.evidenceTypeDistribution
      };
    });

    return res.status(200).json({ data: response });
  } catch (error) {
    return next(error);
  }
});
