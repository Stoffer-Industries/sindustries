// Content Scheduler routes — Express router mounted at /api/v1/content-scheduler.
//
// Implements AC1-AC6 from task 115e8d89-be43-4b81-9e0e-9ab422810f5f:
//  - GET    /items               list non-removed items, optional status filter
//  - POST   /items               create
//  - PATCH  /items/:id           edit body / scheduledFor / source / sourceRef
//  - POST   /items/:id/approve   mark approved (AC6 — explicit gate)
//  - POST   /items/:id/unapprove clear approval
//  - POST   /items/:id/publish   publish (guarded; X integration via helper)
//  - POST   /items/:id/remove    soft-delete
//  - POST   /reorder             rewrite positions from an id list
//  - GET    /today-status        daily cap (Pacific/Auckland)
//
// All write endpoints accept an `x-actor` header that defaults to "unknown"
// — there is no auth in v1 (single-user MVP per the tech design).
//
// Tech design: docs/specs/content-scheduler-tab-tech-design.md

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
  parseDate,
  parseId,
  uuidPattern,
  validateBody,
  validSources,
  validStatuses
} from './contentSchedulerValidation.ts';


function actor(req: any): string {
  const header = req.headers['x-actor'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  return 'unknown';
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

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

contentSchedulerRouter.post('/content-scheduler/items/:id/publish', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const item = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (!item) return notFound(res, 'NOT_FOUND', 'Item not found');

    const { startUtc, endUtc, date } = getAucklandTodayParts();
    const todays = await prisma.contentSchedulerItem.findMany({
      where: {
        status: 'published',
        publishedAt: { gte: startUtc, lt: endUtc }
      },
      select: { id: true }
    });
    const publishedCount = todays.length;
    const publishedItemId = publishedCount > 0 ? todays[0].id : null;

    const guard = guardPublish(item, { publishedCount, publishedItemId });
    if (!guard.ok) {
      return sendError(res, 409, guard.code, `Publish refused: ${guard.code}`);
    }

    const client = getXClient();
    if (!client) {
      return sendError(res, 503, 'MISSING_CREDENTIALS', 'X credentials are not configured');
    }

    let result: { url: string; postedAt: Date };
    try {
      result = await client.createTweet({ text: item.body });
    } catch (publishError) {
      const message = publishError instanceof Error ? publishError.message : String(publishError);
      const updated = await prisma.contentSchedulerItem.update({
        where: { id },
        data: { publishError: message }
      });
      return sendError(res, 502, 'PUBLISH_FAILED', message);
    }

    const updated = await prisma.contentSchedulerItem.update({
      where: { id },
      data: {
        status: 'published',
        publishedAt: result.postedAt,
        publishedUrl: result.url,
        publishError: null
      }
    });

    res.json({ data: updated, today: date });
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