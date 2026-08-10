// Content Scheduler — auto-post diagnostics endpoint.
//
// Exposes the queue provider, queue depth, overdue approved items, and
// Redis liveness for the Content Scheduler auto-post path. Used by both
// humans (Tom checking the queue) and the brittle reconciliation sweep
// on the worker side. Returns a structured JSON payload with no auth
// in dev (single-user MVP); production should keep this endpoint behind
// the existing network ACLs.
//
// GET /api/v1/content-scheduler/auto-post/health
//   -> { adapter, queue, overdue, redis, recommended }
//
// POST /api/v1/content-scheduler/auto-post/reconcile
//   -> triggers reconcileAutoPostItems() inline; for ops use only
//      (the worker runs reconciliation on every boot).

import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import {
  getJobSchedulerAdapter,
  getJobSchedulerAdapterKind
} from './contentSchedulerJobs.ts';
import { reconcileAutoPostItems, describeItemForReconcile } from './autoPostReconciliation.ts';

export const contentSchedulerAutoPostRouter = Router();

type QueueStats = {
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
  completed: number;
};

type OverdueSummary = {
  count: number;
  oldestScheduledFor: Date | null;
  itemIds: string[];
};

contentSchedulerAutoPostRouter.get('/content-scheduler/auto-post/health', async (_req, res, next) => {
  try {
    const adapterKind = getJobSchedulerAdapterKind() ?? 'in-process';
    const adapter = getJobSchedulerAdapter();

    // Queue stats: only the BullMQ adapter supports this. The in-process
    // adapter reports pending jobs by introspection.
    let queue: QueueStats | null = null;
    const anyAdapter = adapter as typeof adapter & {
      queueStats?: () => Promise<QueueStats>;
      pendingJobs?: () => Array<unknown>;
    };
    if (typeof anyAdapter.queueStats === 'function') {
      try {
        queue = await anyAdapter.queueStats();
      } catch (err: any) {
        queue = null;
        // swallowed; surfaced via `redis.ok` below
      }
    } else if (typeof anyAdapter.pendingJobs === 'function') {
      queue = {
        waiting: 0,
        delayed: anyAdapter.pendingJobs().length,
        active: 0,
        failed: 0,
        completed: 0
      };
    }

    // Redis health: only meaningful for the BullMQ adapter. The in-process
    // adapter never touches Redis, so reporting `ok: true` is misleading
    // — the operator has no Redis to health-check. Return `null` so the
    // UI / curl consumer can distinguish "no Redis is configured" from
    // "Redis is configured and reachable".
    let redis: { ok: true; latencyMs: number } | { ok: false; error: string } | null =
      adapterKind === 'in-process' ? null : null;
    if (adapterKind !== 'in-process' && typeof (adapter as any).ping === 'function') {
      try {
        const pingResult = await (adapter as any).ping();
        if (pingResult.ok) {
          redis = { ok: true, latencyMs: pingResult.latencyMs };
        } else {
          redis = { ok: false, error: pingResult.error };
        }
      } catch (err: any) {
        redis = { ok: false, error: err?.message ?? String(err) };
      }
    }

    // Overdue summary: count approved items whose scheduledFor is in the
    // past and which have not yet been published. Listed so Tom can see
    // which items the queue/worker is currently behind on.
    const now = new Date();
    const overdueRows = await prisma.contentSchedulerItem.findMany({
      where: {
        status: 'approved',
        scheduledFor: { not: null, lt: now }
      },
      orderBy: { scheduledFor: 'asc' },
      take: 25,
      select: { id: true, scheduledFor: true }
    });
    const overdueCount = await prisma.contentSchedulerItem.count({
      where: {
        status: 'approved',
        scheduledFor: { not: null, lt: now }
      }
    });
    const overdue: OverdueSummary = {
      count: overdueCount,
      oldestScheduledFor: overdueRows[0]?.scheduledFor ?? null,
      itemIds: overdueRows.map((r) => r.id)
    };

    // Recommendation: surface the obvious next step for the operator.
    let recommended: string | null = null;
    if (adapterKind === 'in-process') {
      recommended = 'Set CONTENT_SCHEDULER_JOB_ADAPTER=bullmq and provide CONTENT_SCHEDULER_REDIS_URL to make auto-post durable across restarts.';
    } else if (redis && redis.ok === false) {
      recommended = `Redis ping failed: ${redis.error}. Auto-post will not run until Redis is reachable.`;
    } else if (overdueCount > 0) {
      recommended = 'Restart the worker or POST /content-scheduler/auto-post/reconcile to drain overdue approved items.';
    }

    res.json({
      data: {
        adapter: adapterKind,
        queue,
        overdue,
        redis,
        recommended,
        now: now.toISOString()
      }
    });
  } catch (err) {
    next(err);
  }
});

contentSchedulerAutoPostRouter.post('/content-scheduler/auto-post/reconcile', async (_req, res, next) => {
  try {
    const report = await reconcileAutoPostItems();
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
});

/**
 * Per-item status: useful for the Mission Control UI's auto-post panel
 * to surface which items are queued, overdue, or stuck. Not paginated;
 * the dataset is bounded by the daily cap (1 publish per day) so the
 * volume is small.
 */
contentSchedulerAutoPostRouter.get('/content-scheduler/auto-post/items', async (_req, res, next) => {
  try {
    const now = new Date();
    const items = await prisma.contentSchedulerItem.findMany({
      where: {
        status: 'approved',
        OR: [
          { scheduledFor: { not: null } },
          { autoPostJobId: { not: null } }
        ]
      },
      orderBy: { scheduledFor: 'asc' },
      take: 100,
      select: {
        id: true,
        status: true,
        scheduledFor: true,
        autoPostJobId: true,
        autoPostScheduleVersion: true,
        autoPostLastEnqueuedAt: true,
        publishError: true
      }
    });
    const data = items.map((i) => {
      const description = describeItemForReconcile(i, now);
      return {
        id: i.id,
        status: i.status,
        scheduledFor: i.scheduledFor,
        autoPostJobId: i.autoPostJobId,
        autoPostScheduleVersion: i.autoPostScheduleVersion,
        autoPostLastEnqueuedAt: i.autoPostLastEnqueuedAt,
        publishError: i.publishError,
        ...description
      };
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});
