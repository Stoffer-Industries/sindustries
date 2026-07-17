// Content Scheduler routes — Express router mounted at /api/v1/content-scheduler.
//
// Implements AC1-AC6 from task 115e8d89-be43-4b81-9e0e-9ab422810f5f
// (Content Scheduler tab) and AC1-AC6 from task ac74e9bb-beb6-4d97-b604-8102d35176ee
// (Event-Driven Auto-Post):
//  - GET    /items               list non-removed items, optional status filter
//  - POST   /items               create
//  - PATCH  /items/:id           edit body / scheduledFor / source / sourceRef
//  - POST   /items/:id/approve   mark approved (AC6 — explicit gate) + enqueue
//  - POST   /items/:id/unapprove clear approval + cancel auto-post
//  - POST   /items/:id/publish   publish (guarded; X integration via shared service)
//  - POST   /items/:id/remove    soft-delete + cancel auto-post
//  - POST   /reorder             rewrite positions from an id list
//  - GET    /today-status        daily cap (Pacific/Auckland)
//
// All write endpoints accept an `x-actor` header that defaults to "unknown"
// — there is no auth in v1 (single-user MVP per the tech design).
//
// Auto-post enqueue uses the provider-neutral `JobSchedulerAdapter` so the
// trigger is event-driven (no polling loop) and the cloud swap is a
// single-class change.
//
// Tech design: docs/specs/content-scheduler-tab-tech-design.md
//              docs/specs/content-scheduler-auto-post-2026-07-16-tech-design.md

import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';
import {
  guardPublish,
  getAucklandTodayParts,
  getXClient,
  TERMINAL_STATUSES
} from './contentSchedulerPublish.ts';
import {
  decideAutoPostAction,
  getJobSchedulerAdapter
} from './contentSchedulerJobs.ts';
import { publishContentSchedulerItem } from './contentSchedulerPublishService.ts';

const MAX_BODY = 1000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validSources = new Set(['ops_notes', 'cto_craft', 'manual', 'other']);
const validStatuses = new Set(['draft', 'queued', 'approved', 'published', 'removed']);

function actor(req: any): string {
  const header = req.headers['x-actor'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  return 'unknown';
}

function parseId(raw: string): string | null {
  return uuidPattern.test(raw) ? raw.toLowerCase() : null;
}

function parseDate(value: unknown): Date | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value as string);
  return Number.isNaN(d.valueOf()) ? 'invalid' : d;
}

function validateBody(body: unknown): string | null {
  if (typeof body !== 'string') return 'body must be a string';
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'body must not be empty';
  if (body.length > MAX_BODY) return `body must be <= ${MAX_BODY} characters`;
  return null;
}

/**
 * Apply the auto-post schedule decision after a write. Best-effort: if the
 * adapter throws (e.g. Redis is down), we surface a 503 from the route so
 * Tom sees the failure rather than silently dropping the schedule. The
 * database write has already committed at this point, so the item state
 * is the source of truth.
 */
async function applyAutoPostSchedule(
  itemId: string,
  prior: {
    id: string;
    status: typeof TERMINAL_STATUSES[number] | 'draft' | 'queued' | 'approved';
    scheduledFor: Date | null;
    autoPostJobId: string | null;
    autoPostScheduleVersion: number;
  },
  next: { status: typeof TERMINAL_STATUSES[number] | 'draft' | 'queued' | 'approved'; scheduledFor: Date | null }
): Promise<void> {
  const decision = decideAutoPostAction({ prior, next });
  const adapter = getJobSchedulerAdapter();
  if (decision.kind === 'cancel') {
    try {
      await adapter.cancelAutoPost(decision.jobId);
    } catch (err) {
      // Cancellation is best-effort. The stale-version check in the worker
      // is the defense in depth.
    }
    await prisma.contentSchedulerItem.update({
      where: { id: itemId },
      data: {
        autoPostJobId: null,
        autoPostScheduleVersion: prior.autoPostScheduleVersion + 1,
        autoPostLastEnqueuedAt: new Date()
      }
    });
    return;
  }
  if (decision.kind === 'schedule') {
    const job = {
      itemId,
      scheduledFor: next.scheduledFor as Date,
      scheduleVersion: prior.autoPostScheduleVersion + 1
    };
    const scheduled = await adapter.scheduleAutoPost(job);
    await prisma.contentSchedulerItem.update({
      where: { id: itemId },
      data: {
        autoPostJobId: scheduled.jobId,
        autoPostScheduleVersion: prior.autoPostScheduleVersion + 1,
        autoPostScheduledAt: next.scheduledFor,
        autoPostLastEnqueuedAt: new Date()
      }
    });
    return;
  }
  // noop
}

export const contentSchedulerRouter = Router();

contentSchedulerRouter.get('/content-scheduler/items', async (req, res, next) => {
  try {
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusFilter && !validStatuses.has(statusFilter)) {
      return badRequest(res, 'INVALID_STATUS_FILTER', 'Invalid status filter');
    }

    const items = await prisma.contentSchedulerItem.findMany({
      where: statusFilter
        ? { status: statusFilter as any }
        : { status: { not: 'removed' as const } },
      orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }]
    });

    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/items', async (req, res, next) => {
  try {
    const { body, source, sourceRef, scheduledFor } = req.body ?? {};

    const bodyError = validateBody(body);
    if (bodyError) return badRequest(res, 'INVALID_BODY', bodyError);

    if (source !== undefined && !validSources.has(source)) {
      return badRequest(res, 'INVALID_SOURCE', 'Invalid source value');
    }

    const schedParsed = parseDate(scheduledFor);
    if (schedParsed === 'invalid') {
      return badRequest(res, 'INVALID_SCHEDULED_FOR', 'Invalid scheduledFor value');
    }

    // Position: append after the current max within status=queued.
    const maxPosition = await prisma.contentSchedulerItem.aggregate({
      where: { status: 'queued' },
      _max: { position: true }
    });
    const nextPosition = (maxPosition._max.position ?? -1) + 1;

    const created = await prisma.contentSchedulerItem.create({
      data: {
        body: (body as string).trim(),
        source: source ?? 'manual',
        sourceRef: typeof sourceRef === 'string' ? sourceRef : null,
        scheduledFor: schedParsed ?? null,
        status: 'queued',
        position: nextPosition
      }
    });

    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.patch('/content-scheduler/items/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const existing = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (!existing) return notFound(res, 'NOT_FOUND', 'Item not found');
    if (TERMINAL_STATUSES.includes(existing.status as any)) {
      return sendError(res, 409, 'TERMINAL_STATUS', `Cannot edit item in status ${existing.status}`);
    }

    const { body, source, sourceRef, scheduledFor } = req.body ?? {};
    const updates: Record<string, unknown> = {};

    if (body !== undefined) {
      const bodyError = validateBody(body);
      if (bodyError) return badRequest(res, 'INVALID_BODY', bodyError);
      updates.body = (body as string).trim();
    }
    if (source !== undefined) {
      if (!validSources.has(source)) {
        return badRequest(res, 'INVALID_SOURCE', 'Invalid source value');
      }
      updates.source = source;
    }
    if (sourceRef !== undefined) {
      updates.sourceRef = typeof sourceRef === 'string' ? sourceRef : null;
    }
    if (scheduledFor !== undefined) {
      const schedParsed = parseDate(scheduledFor);
      if (schedParsed === 'invalid') {
        return badRequest(res, 'INVALID_SCHEDULED_FOR', 'Invalid scheduledFor value');
      }
      updates.scheduledFor = schedParsed ?? null;
    }

    if (Object.keys(updates).length === 0) {
      return badRequest(res, 'NO_UPDATES', 'No updatable fields provided');
    }

    const updated = await prisma.contentSchedulerItem.update({
      where: { id },
      data: updates
    });

    // Re-evaluate auto-post schedule when scheduledFor changed. Body /
    // source / sourceRef do not affect auto-post timing.
    if (Object.prototype.hasOwnProperty.call(updates, 'scheduledFor')) {
      try {
        await applyAutoPostSchedule(
          id,
          {
            id: existing.id,
            status: existing.status as any,
            scheduledFor: existing.scheduledFor,
            autoPostJobId: existing.autoPostJobId,
            autoPostScheduleVersion: existing.autoPostScheduleVersion
          },
          { status: updated.status as any, scheduledFor: updated.scheduledFor }
        );
        // Re-read so the response reflects the latest autoPost* fields.
        const refreshed = await prisma.contentSchedulerItem.findUnique({ where: { id } });
        if (refreshed) return res.json({ data: refreshed });
      } catch (err) {
        // Adapter failure surfaces as 503; DB has already been updated so
        // Tom can still see the new scheduledFor value.
        return sendError(res, 503, 'AUTO_POST_SCHEDULE_FAILED', 'Failed to enqueue auto-post job');
      }
    }

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/items/:id/approve', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const existing = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (!existing) return notFound(res, 'NOT_FOUND', 'Item not found');
    if (existing.status === 'published') {
      return sendError(res, 409, 'ALREADY_PUBLISHED', 'Cannot approve a published item');
    }
    if (existing.status === 'removed') {
      return sendError(res, 409, 'REMOVED', 'Cannot approve a removed item');
    }

    const updated = await prisma.contentSchedulerItem.update({
      where: { id },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        approvedBy: actor(req)
      }
    });

    if (updated.scheduledFor) {
      try {
        await applyAutoPostSchedule(
          id,
          {
            id: existing.id,
            status: existing.status as any,
            scheduledFor: existing.scheduledFor,
            autoPostJobId: existing.autoPostJobId,
            autoPostScheduleVersion: existing.autoPostScheduleVersion
          },
          { status: 'approved', scheduledFor: updated.scheduledFor }
        );
        const refreshed = await prisma.contentSchedulerItem.findUnique({ where: { id } });
        if (refreshed) return res.json({ data: refreshed });
      } catch (err) {
        return sendError(res, 503, 'AUTO_POST_SCHEDULE_FAILED', 'Failed to enqueue auto-post job');
      }
    }

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/items/:id/unapprove', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const existing = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (!existing) return notFound(res, 'NOT_FOUND', 'Item not found');
    if (existing.status === 'published') {
      return sendError(res, 409, 'ALREADY_PUBLISHED', 'Cannot unapprove a published item');
    }

    const updated = await prisma.contentSchedulerItem.update({
      where: { id },
      data: {
        status: 'queued',
        approvedAt: null,
        approvedBy: null
      }
    });

    try {
      await applyAutoPostSchedule(
        id,
        {
          id: existing.id,
          status: existing.status as any,
          scheduledFor: existing.scheduledFor,
          autoPostJobId: existing.autoPostJobId,
          autoPostScheduleVersion: existing.autoPostScheduleVersion
        },
        { status: 'queued', scheduledFor: null }
      );
    } catch (err) {
      // Best-effort; the worker stale-version check covers missed cancels.
    }
    const refreshed = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (refreshed) return res.json({ data: refreshed });

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/items/:id/publish', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const result = await publishContentSchedulerItem(id, 'manual');

    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return notFound(res, 'NOT_FOUND', result.message);
      if (result.code === 'MISSING_CREDENTIALS')
        return sendError(res, 503, 'MISSING_CREDENTIALS', result.message);
      if (result.code === 'PUBLISH_FAILED')
        return sendError(res, 502, 'PUBLISH_FAILED', result.message);
      return sendError(res, 409, result.code, result.message);
    }

    // On successful manual publish, cancel any in-flight auto-post job and
    // bump the schedule version so a stale delayed job exits cleanly.
    if (result.item?.autoPostJobId) {
      try {
        await getJobSchedulerAdapter().cancelAutoPost(result.item.autoPostJobId);
      } catch (err) {
        // Stale-version check is the safety net.
      }
      await prisma.contentSchedulerItem.update({
        where: { id },
        data: {
          autoPostJobId: null,
          autoPostScheduleVersion: (result.item.autoPostScheduleVersion ?? 0) + 1,
          autoPostLastEnqueuedAt: new Date()
        }
      });
    }

    const { date } = getAucklandTodayParts();
    res.json({ data: result.item, today: date });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/items/:id/remove', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const existing = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (!existing) return notFound(res, 'NOT_FOUND', 'Item not found');
    if (existing.status === 'published') {
      return sendError(res, 409, 'ALREADY_PUBLISHED', 'Cannot remove a published item');
    }

    const updated = await prisma.contentSchedulerItem.update({
      where: { id },
      data: {
        status: 'removed',
        removedAt: new Date()
      }
    });

    try {
      await applyAutoPostSchedule(
        id,
        {
          id: existing.id,
          status: existing.status as any,
          scheduledFor: existing.scheduledFor,
          autoPostJobId: existing.autoPostJobId,
          autoPostScheduleVersion: existing.autoPostScheduleVersion
        },
        { status: 'removed', scheduledFor: null }
      );
    } catch (err) {
      // best-effort
    }
    const refreshed = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (refreshed) return res.json({ data: refreshed });

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/reorder', async (req, res, next) => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids)) {
      return badRequest(res, 'INVALID_IDS', 'ids must be an array');
    }
    if (ids.some((id) => typeof id !== 'string' || !uuidPattern.test(id))) {
      return badRequest(res, 'INVALID_IDS', 'ids must contain valid UUIDs');
    }
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length !== ids.length) {
      return badRequest(res, 'DUPLICATE_IDS', 'ids must be unique');
    }

    const items = await prisma.contentSchedulerItem.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, status: true }
    });
    if (items.length !== uniqueIds.length) {
      return notFound(res, 'NOT_FOUND', 'One or more ids do not exist');
    }
    const blocked = items.find((i) => TERMINAL_STATUSES.includes(i.status as any));
    if (blocked) {
      return sendError(res, 409, 'TERMINAL_STATUS', `Cannot reorder item in status ${blocked.status}`);
    }

    await prisma.$transaction(
      uniqueIds.map((id, index) =>
        prisma.contentSchedulerItem.update({
          where: { id },
          data: { position: index }
        })
      )
    );

    res.json({ data: { ok: true, count: uniqueIds.length } });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.get('/content-scheduler/today-status', async (_req, res, next) => {
  try {
    const { startUtc, endUtc, date } = getAucklandTodayParts();
    const todays = await prisma.contentSchedulerItem.findMany({
      where: {
        status: 'published',
        publishedAt: { gte: startUtc, lt: endUtc }
      },
      select: { id: true, publishedAt: true, publishedUrl: true }
    });

    res.json({
      data: {
        date,
        publishedCount: todays.length,
        publishedItemId: todays[0]?.id ?? null,
        publishedAt: todays[0]?.publishedAt ?? null,
        publishedUrl: todays[0]?.publishedUrl ?? null,
        cap: 1
      }
    });
  } catch (err) {
    next(err);
  }
});
