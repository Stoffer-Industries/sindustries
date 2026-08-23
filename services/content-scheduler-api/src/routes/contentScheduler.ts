// Content Scheduler routes — Express router mounted at /api/v1/content-scheduler.
//
// Implements AC1-AC6 from task 115e8d89-be43-4b81-9e0e-9ab422810f5f
// (Content Scheduler tab) and AC1-AC6 from task ac74e9bb-beb6-4d97-b604-8102d35176ee
// (Event-Driven Auto-Post):
//  - GET    /items               list non-removed items, optional status filter
//  - POST   /items               create
//  - PATCH  /items/:id                  edit body / scheduledFor / source / sourceRef / kind / linksToItemId
//  - POST   /items/:id/approve          mark approved (AC6 — explicit gate) + enqueue
//  - POST   /items/:id/unapprove        clear approval + cancel auto-post
//  - POST   /items/:id/publish          publish (guarded; X integration via shared service)
//                                        — refuses kind=manual_reply rows with MANUAL_REPLY_NOT_PUBLISHABLE
//  - PATCH  /items/:id/posted-url       capture manualPostedUrl for kind=manual_reply rows (task 5279b310 AC5)
//  - POST   /items/:id/remove           soft-delete + cancel auto-post
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
import { config } from '../config/index.ts';
import {
  guardPublish,
  getAucklandTodayParts,
  getXClient,
  checkActorSecret,
  TERMINAL_STATUSES
} from './contentSchedulerPublish.ts';
import {
  parseDate,
  parseId,
  uuidPattern,
  validateBody,
  validateImportItems,
  validateKind,
  validateLinksToItemId,
  validateManualPostedUrl,
  validSources,
  validStatuses
} from './contentSchedulerValidation.ts';
import {
  decideAutoPostAction,
  getJobSchedulerAdapter
} from './contentSchedulerJobs.ts';
import { publishContentSchedulerItem } from './contentSchedulerPublishService.ts';


function actor(req: any): string {
  // After the requireAuthenticatedUser middleware (task 0719a8e3), the
  // authenticated actor is authoritative. The `x-actor` header is kept as
  // a backwards-compatible audit-trail signal: if it is set and disagrees
  // with the authenticated actor, we log a warning but accept the
  // authenticated value. Phase 2 (cloud auth) will drop the header.
  const authenticated = req.user?.actor;
  const header = req.headers['x-actor'];
  const headerValue = typeof header === 'string' && header.trim().length > 0 ? header.trim() : null;
  if (headerValue && authenticated && headerValue !== authenticated) {
    // eslint-disable-next-line no-console
    console.warn(
      `[content-scheduler] x-actor header '${headerValue}' disagrees with authenticated actor '${authenticated}'; using authenticated actor`
    );
  }
  if (authenticated) return authenticated;
  if (headerValue) return headerValue;
  return 'unknown';
}

async function applyAutoPostSchedule(
  itemId: string,
  prior: {
    id: string;
    status: typeof TERMINAL_STATUSES[number] | 'draft' | 'queued' | 'approved';
    scheduledFor: Date | null;
    autoPostJobId: string | null;
    autoPostScheduleVersion: number;
    kind?: 'scheduled' | 'manual_reply';
  },
  next: { status: typeof TERMINAL_STATUSES[number] | 'draft' | 'queued' | 'approved'; scheduledFor: Date | null; kind?: 'scheduled' | 'manual_reply' }
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
    const { body, source, sourceRef, scheduledFor, kind, manualPostedUrl, manualPostedAt, linksToItemId } = req.body ?? {};

    const bodyError = validateBody(body);
    if (bodyError) return badRequest(res, 'INVALID_BODY', bodyError);

    if (source !== undefined && !validSources.has(source)) {
      return badRequest(res, 'INVALID_SOURCE', 'Invalid source value');
    }

    const kindError = validateKind(kind);
    if (kindError) return badRequest(res, 'INVALID_KIND', kindError);

    const schedParsed = parseDate(scheduledFor);
    if (schedParsed === 'invalid') {
      return badRequest(res, 'INVALID_SCHEDULED_FOR', 'Invalid scheduledFor value');
    }

    // manual_reply items never auto-publish — a scheduledFor is rejected
    // outright because there is nothing to schedule. The bookmark approval
    // hook creates manual_reply items with no scheduledFor by design.
    if (kind === 'manual_reply' && schedParsed) {
      return badRequest(
        res,
        'INVALID_SCHEDULED_FOR',
        'manual_reply items must not have a scheduledFor (they are never auto-published)'
      );
    }

    // linksToItemId is only meaningful on manual_reply items; reject
    // setting it on a scheduled item to keep the surface unambiguous.
    if (linksToItemId !== undefined && linksToItemId !== null && kind !== 'manual_reply') {
      return badRequest(
        res,
        'INVALID_LINKS_TO_ITEM_ID',
        'linksToItemId may only be set on kind=manual_reply items'
      );
    }
    const linksToItemIdError = validateLinksToItemId(linksToItemId);
    if (linksToItemIdError) return badRequest(res, 'INVALID_LINKS_TO_ITEM_ID', linksToItemIdError);

    // manualPostedUrl/manualPostedAt are only set via the dedicated
    // PATCH /items/:id/posted-url endpoint (AC5); reject setting them on
    // create so the capture flow stays the single source of truth.
    if (manualPostedUrl !== undefined && manualPostedUrl !== null) {
      return badRequest(
        res,
        'INVALID_MANUAL_POSTED_URL',
        'manualPostedUrl may only be set via PATCH /items/:id/posted-url'
      );
    }
    if (manualPostedAt !== undefined && manualPostedAt !== null) {
      return badRequest(
        res,
        'INVALID_MANUAL_POSTED_AT',
        'manualPostedAt may only be set via PATCH /items/:id/posted-url'
      );
    }

    // Position: append after the current max within status=queued.
    // manual_reply items still occupy a position so the UI renders them
    // alongside scheduled items in the same ordered list.
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
        position: nextPosition,
        kind: kind ?? 'scheduled',
        linksToItemId: typeof linksToItemId === 'string' ? linksToItemId : null
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

    const { body, source, sourceRef, scheduledFor, kind, linksToItemId } = req.body ?? {};
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
      // The PATCH endpoint never transitions kind, so an existing manual_reply
      // item can still have its (already-null) scheduledFor cleared, but it
      // cannot gain a new one. Reading `existing.kind` is sufficient.
      if (schedParsed && existing.kind === 'manual_reply') {
        return badRequest(
          res,
          'INVALID_SCHEDULED_FOR',
          'manual_reply items must not have a scheduledFor (they are never auto-published)'
        );
      }
      updates.scheduledFor = schedParsed ?? null;
    }
    // kind: null would pass validateKind (which treats null/undefined as
    // "not provided") but then set updates.kind = null, bypassing the
    // kind discriminator. Reject explicitly: PATCH cannot clear kind
    // (the field is required as a discriminator — omit to leave unchanged,
    // pass a valid kind value to change).
    if (kind === null) {
      return badRequest(
        res,
        'INVALID_KIND',
        'kind may not be null; omit the field to leave unchanged, or pass a valid kind value'
      );
    }
    if (kind !== undefined) {
      const kindError = validateKind(kind);
      if (kindError) return badRequest(res, 'INVALID_KIND', kindError);
      updates.kind = kind;
    }
    if (linksToItemId !== undefined) {
      const linksToItemIdError = validateLinksToItemId(linksToItemId);
      if (linksToItemIdError) return badRequest(res, 'INVALID_LINKS_TO_ITEM_ID', linksToItemIdError);
      // linksToItemId is meaningful only for manual_reply rows; the kind
      // may have been set in this same PATCH (above) so re-read from
      // updates first, then existing.
      const effectiveKind = (updates.kind as string | undefined) ?? existing.kind;
      if (linksToItemId !== null && effectiveKind !== 'manual_reply') {
        return badRequest(
          res,
          'INVALID_LINKS_TO_ITEM_ID',
          'linksToItemId may only be set on kind=manual_reply items'
        );
      }
      updates.linksToItemId = typeof linksToItemId === 'string' ? linksToItemId : null;
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
            autoPostScheduleVersion: existing.autoPostScheduleVersion,
            kind: existing.kind as 'scheduled' | 'manual_reply'
          },
          {
            status: updated.status as any,
            scheduledFor: updated.scheduledFor,
            kind: (updates.kind as 'scheduled' | 'manual_reply' | undefined) ?? (existing.kind as 'scheduled' | 'manual_reply')
          }
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
            autoPostScheduleVersion: existing.autoPostScheduleVersion,
            kind: existing.kind as 'scheduled' | 'manual_reply'
          },
          {
            status: 'approved',
            scheduledFor: updated.scheduledFor,
            kind: existing.kind as 'scheduled' | 'manual_reply'
          }
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
          autoPostScheduleVersion: existing.autoPostScheduleVersion,
          kind: existing.kind as 'scheduled' | 'manual_reply'
        },
        {
          status: 'queued',
          scheduledFor: null,
          kind: existing.kind as 'scheduled' | 'manual_reply'
        }
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

    // Cloud-readiness gate (task 38d2ee65): when X_ACTOR_SECRET is
    // configured, require an `x-actor-secret` header that matches before
    // any X API call is attempted. When unset, dev/local/CI stays usable.
    const rawHeader = req.headers['x-actor-secret'];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const actorGuard = checkActorSecret(headerValue);
    if (actorGuard.ok === false) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        actorGuard.reason === 'MISSING_HEADER'
          ? 'Missing x-actor-secret header (X_ACTOR_SECRET is configured)'
          : 'Invalid x-actor-secret header'
      );
    }

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

// PATCH /content-scheduler/items/:id/posted-url
//
// AC5 from task 5279b310: once Tom posts the manual reply and supplies
// its resulting URL, that URL is stored against the draft and the draft's
// state reflects that it has been posted.
//
// Only `kind = "manual_reply"` items are accepted; scheduled items must
// flow through POST /items/:id/publish (their `publishedUrl` is the
// authoritative capture). The endpoint is idempotent on the same URL
// (returns 200 with the existing timestamp; does NOT update manualPostedAt
// on a re-PATCH of the same URL — that preserves the original "posted at"
// timestamp as the source of truth).
contentSchedulerRouter.patch('/content-scheduler/items/:id/posted-url', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

    const { manualPostedUrl } = req.body ?? {};
    const urlError = validateManualPostedUrl(manualPostedUrl);
    if (urlError) return badRequest(res, 'INVALID_MANUAL_POSTED_URL', urlError);

    const existing = await prisma.contentSchedulerItem.findUnique({ where: { id } });
    if (!existing) return notFound(res, 'NOT_FOUND', 'Item not found');

    if (existing.kind !== 'manual_reply') {
      return sendError(
        res,
        409,
        'NOT_MANUAL_REPLY',
        'This endpoint only accepts items with kind=manual_reply; scheduled items must use POST /items/:id/publish'
      );
    }

    // Idempotency: re-PATCHing the same URL returns 200 with the existing
    // manualPostedAt untouched.
    if (existing.manualPostedUrl === manualPostedUrl) {
      return res.json({ data: existing, manualPostedAtUpdated: false });
    }

    const manualPostedAt = new Date();
    const updated = await prisma.contentSchedulerItem.update({
      where: { id },
      data: {
        manualPostedUrl,
        manualPostedAt
      }
    });

    res.json({ data: updated, manualPostedAtUpdated: true });
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
          autoPostScheduleVersion: existing.autoPostScheduleVersion,
          kind: existing.kind as 'scheduled' | 'manual_reply'
        },
        {
          status: 'removed',
          scheduledFor: null,
          kind: existing.kind as 'scheduled' | 'manual_reply'
        }
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

// ---------------------------------------------------------------------------
// Trusted internal batch import for the CTO Craft LangGraph pipeline
// (task 9dfe56e4). The endpoint is intentionally narrow:
//
//   - 1–5 items per batch, each item validated by validateImportItems.
//   - Always creates with status='draft', source='cto_craft',
//     scheduledFor=null, position=0. Callers cannot bypass.
//   - Auth: x-content-ingest-secret header is required when
//     CONTENT_SCHEDULER_INGEST_SECRET is configured. When unset
//     (dev/local/CI), the gate is pass-through.
//   - Idempotency: the (source, sourceRef) partial unique index enforces
//     dedup at the database layer. We use createMany({ skipDuplicates: true })
//     so duplicates in the batch or against pre-existing rows are silently
//     skipped and reported via skippedDuplicateCount.
//   - Never approve, schedule, or publish imported items.
// ---------------------------------------------------------------------------

function checkContentIngestSecret(providedHeader: string | undefined | null): {
  ok: boolean;
  configured: boolean;
  reason?: 'MISSING_HEADER' | 'MISMATCH';
} {
  const expected = process.env.CONTENT_SCHEDULER_INGEST_SECRET;
  if (!expected || expected.length === 0) {
    return { ok: true, configured: false };
  }
  if (typeof providedHeader !== 'string' || providedHeader.length === 0) {
    return { ok: false, configured: true, reason: 'MISSING_HEADER' };
  }
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(providedHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, configured: true, reason: 'MISMATCH' };
  }
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  const equal = timingSafeEqual(expectedBuf, providedBuf);
  if (!equal) {
    return { ok: false, configured: true, reason: 'MISMATCH' };
  }
  return { ok: true, configured: true };
}

contentSchedulerRouter.post('/content-scheduler/imports/cto-craft', async (req, res, next) => {
  try {
    const rawHeader = req.headers['x-content-ingest-secret'];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const guard = checkContentIngestSecret(headerValue);
    if (!guard.ok) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        guard.reason === 'MISSING_HEADER'
          ? 'Missing x-content-ingest-secret header (CONTENT_SCHEDULER_INGEST_SECRET is configured)'
          : 'Invalid x-content-ingest-secret header'
      );
    }

    const { items } = req.body ?? {};
    const itemsError = validateImportItems(items);
    if (itemsError) {
      return badRequest(res, 'INVALID_ITEMS', itemsError);
    }

    const now = new Date();
    const rows = (items as Array<{ body: string; sourceRef: string; issueRef?: string; evidenceExcerpt?: string }>).map(
      (item) => ({
        body: item.body.trim(),
        source: 'cto_craft' as const,
        sourceRef: item.sourceRef,
        status: 'draft' as const,
        scheduledFor: null,
        position: 0,
        approvedAt: null,
        approvedBy: null,
        publishedAt: null,
        publishedUrl: null,
        publishError: null,
        createdAt: now,
        updatedAt: now,
        removedAt: null
      })
    );

    const result = await prisma.contentSchedulerItem.createMany({
      data: rows,
      skipDuplicates: true
    });

    // createMany({ skipDuplicates: true }) returns only the count of rows
    // actually inserted. Duplicates within the batch (or against
    // pre-existing rows with the same (source, sourceRef)) are silently
    // skipped. We re-read the affected sourceRefs to expose IDs and the
    // canonical sourceRef list — note this list may include pre-existing
    // rows, so we cannot derive skippedDuplicateCount from
    // rows.length - persisted.length.
    const refs = rows.map((r) => r.sourceRef);
    const persisted = await prisma.contentSchedulerItem.findMany({
      where: { source: 'cto_craft', sourceRef: { in: refs } },
      select: { id: true, sourceRef: true }
    });
    const createdCount = result.count;
    const skippedDuplicateCount = rows.length - createdCount;
    const createdIds = persisted.map((p) => p.id);
    const createdSourceRefs = persisted.map((p) => p.sourceRef);

    res.status(201).json({
      data: {
        createdCount,
        skippedDuplicateCount,
        createdIds,
        sourceRefs: createdSourceRefs
      }
    });
  } catch (err) {
    next(err);
  }
});
