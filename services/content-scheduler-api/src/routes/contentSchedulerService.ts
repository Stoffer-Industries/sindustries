// Content Scheduler — service-to-service routes.
//
// These routes are intentionally separated from `contentScheduler.ts`
// because they are NOT gated by `requireAuthenticatedUser`. They have
// their own shared-secret gates that the Fly headless worker and the
// CTO Craft LangGraph pipeline use to call the API without a Bearer
// token:
//
//   - POST /content-scheduler/items/:id/publish   (x-actor-secret)
//   - POST /content-scheduler/imports/cto-craft   (x-content-ingest-secret)
//
// `createApp` mounts this router BEFORE the auth gate so that requests
// to these two endpoints are handled by the matching route here and
// never reach the gate. The user-facing router (`contentScheduler.ts`)
// is mounted after the gate so every POST/PATCH/DELETE on
// `/content-scheduler/items*` requires a valid session cookie or
// service-credential Bearer.
//
// Tech design: docs/specs/content-scheduler-auth-tech-design.md (task bd755ad4)

import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';
import {
  guardPublish,
  getAucklandTodayParts,
  checkActorSecret
} from './contentSchedulerPublish.ts';
import { parseId } from './contentSchedulerValidation.ts';
import { validateImportItems } from './contentSchedulerValidation.ts';
import { decideAutoPostAction, getJobSchedulerAdapter } from './contentSchedulerJobs.ts';
import { publishContentSchedulerItem } from './contentSchedulerPublishService.ts';
import { publishThreadContentSchedulerItem, retryThreadPublish } from './contentSchedulerThreadPublish.ts';

export const contentSchedulerServiceRouter = Router();

// ---------------------------------------------------------------------------
// POST /content-scheduler/items/:id/publish — Fly headless worker → API.
//
// Auth: x-actor-secret header (when X_ACTOR_SECRET is configured). When
// unset (dev / local / CI), the gate is pass-through so unit tests and
// local development can publish without a shared secret.
// ---------------------------------------------------------------------------

contentSchedulerServiceRouter.post(
  '/content-scheduler/items/:id/publish',
  async (req, res, next) => {
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

      // Dispatch by kind: single-tweet items go through the existing
      // publish service; thread items (task 1016cbff) go through the
      // chain orchestrator so positions 1..n are posted as in_reply_to
      // replies with full compensation on partial failure.
      const existing = await prisma.contentSchedulerItem.findUnique({
        where: { id },
        select: { kind: true }
      });
      const isThread = (existing?.kind ?? 'scheduled') === 'thread';

      if (isThread) {
        const threadResult = await publishThreadContentSchedulerItem(id, 'manual');
        if (threadResult.ok === false) {
          if (threadResult.code === 'NOT_FOUND')
            return notFound(res, 'NOT_FOUND', threadResult.message);
          if (threadResult.code === 'NOT_THREAD')
            return badRequest(res, 'NOT_THREAD', threadResult.message);
          if (threadResult.code === 'MISSING_CREDENTIALS')
            return sendError(res, 503, 'MISSING_CREDENTIALS', threadResult.message);
          if (threadResult.code === 'PUBLISH_FAILED')
            return sendError(res, 502, 'PUBLISH_FAILED', threadResult.message);
          if (threadResult.code === 'CLEANUP_REQUIRED')
            return sendError(res, 409, 'CLEANUP_REQUIRED', threadResult.message);
          return sendError(res, 409, threadResult.code, threadResult.message);
        }
        const { date } = getAucklandTodayParts();
        const threadItem = await prisma.contentSchedulerItem.findUnique({ where: { id } });
        return res.json({ data: threadItem, today: date });
      }

      const result = await publishContentSchedulerItem(id, 'manual');

      if (result.ok === false) {
        if (result.code === 'NOT_FOUND') return notFound(res, 'NOT_FOUND', result.message);
        if (result.code === 'MISSING_CREDENTIALS')
          return sendError(res, 503, 'MISSING_CREDENTIALS', result.message);
        if (result.code === 'PUBLISH_FAILED')
          return sendError(res, 502, 'PUBLISH_FAILED', result.message);
        return sendError(res, 409, result.code, result.message);
      }

      // On successful manual publish, cancel any in-flight auto-post job
      // and bump the schedule version so a stale delayed job exits cleanly.
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
  }
);

// ---------------------------------------------------------------------------
// POST /content-scheduler/items/:id/retry-publish — cleanup_required retry.
//
// Auth: same x-actor-secret gate as /publish (the Fly headless worker
// is the legitimate caller for both, and a misconfigured browser-side
// retry should still respect the gate).
//
// Scope: thread items only. A single-tweet item that failed to publish
// stays in `approved` with a `publishError` row; re-clicking the
// standard /publish endpoint is the correct retry path. The thread
// orchestrator's `cleanup_required` terminal state is the only state
// that genuinely blocks re-publish, so this endpoint is gated on
// that and on `kind === 'thread'`.
//
// Flow:
//   1. Re-attempt deletion of any tweets the original compensation
//      couldn't delete (transient X 5xx, etc.).
//   2. If cleanup completes: transition the failed attempt to
//      `rolled_back`, item to `approved`, then run the standard
//      publish orchestrator end-to-end. The response shape mirrors
//      /publish so the UI can reuse its success handler.
//   3. If cleanup still fails: return 409 CLEANUP_STILL_REQUIRED with
//      the undeleted tweet URLs so Tom can decide whether to retry
//      again or manually delete via the X web UI.
// ---------------------------------------------------------------------------

contentSchedulerServiceRouter.post(
  '/content-scheduler/items/:id/retry-publish',
  async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return badRequest(res, 'INVALID_ID', 'Invalid id');

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

      // Dispatch by kind. Non-thread items can't reach cleanup_required
      // — the single-tweet publish path leaves status=approved on
      // failure — so we refuse cleanly instead of routing them through
      // the thread-only retry handler.
      const existing = await prisma.contentSchedulerItem.findUnique({
        where: { id },
        select: { kind: true }
      });
      const isThread = (existing?.kind ?? 'scheduled') === 'thread';

      if (!isThread) {
        return badRequest(
          res,
          'NOT_THREAD',
          'retry-publish only applies to thread items; non-thread items retry via POST /items/:id/publish'
        );
      }

      const threadResult = await retryThreadPublish(id);
      if (threadResult.ok === false) {
        if (threadResult.code === 'NOT_FOUND')
          return notFound(res, 'NOT_FOUND', threadResult.message);
        if (threadResult.code === 'NOT_THREAD')
          return badRequest(res, 'NOT_THREAD', threadResult.message);
        if (threadResult.code === 'NOT_CLEANUP_REQUIRED')
          return sendError(res, 409, 'NOT_CLEANUP_REQUIRED', threadResult.message);
        if (threadResult.code === 'MISSING_CREDENTIALS')
          return sendError(res, 503, 'MISSING_CREDENTIALS', threadResult.message);
        if (threadResult.code === 'CLEANUP_STILL_REQUIRED') {
          return res.status(409).json({
            error: {
              code: 'CLEANUP_STILL_REQUIRED',
              message: threadResult.message,
              undeletedTweets: threadResult.undeletedTweets
            }
          });
        }
        if (threadResult.code === 'CLEANUP_REQUIRED')
          return sendError(res, 409, 'CLEANUP_REQUIRED', threadResult.message);
        if (threadResult.code === 'PUBLISH_FAILED')
          return sendError(res, 502, 'PUBLISH_FAILED', threadResult.message);
        return sendError(res, 409, threadResult.code, threadResult.message);
      }

      const { date } = getAucklandTodayParts();
      const threadItem = await prisma.contentSchedulerItem.findUnique({ where: { id } });
      return res.json({ data: threadItem, today: date });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /content-scheduler/imports/cto-craft — CTO Craft LangGraph → API.
//
// Auth: x-content-ingest-secret header (when CONTENT_SCHEDULER_INGEST_SECRET
// is configured). When unset (dev / local / CI), the gate is pass-through.
//
// See `contentSchedulerJobs.decideAutoPostAction` import (above) — kept to
// mirror the original file's import block; this route does not enqueue
// auto-post jobs, only imports drafts. The import is harmless if unused.
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
  const equal = timingSafeEqual(expectedBuf, providedBuf);
  if (!equal) {
    return { ok: false, configured: true, reason: 'MISMATCH' };
  }
  return { ok: true, configured: true };
}

contentSchedulerServiceRouter.post(
  '/content-scheduler/imports/cto-craft',
  async (req, res, next) => {
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
      const rows = (items as Array<{
        body: string;
        sourceRef: string;
        issueRef?: string;
        evidenceExcerpt?: string;
      }>).map((item) => ({
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
      }));

      const result = await prisma.contentSchedulerItem.createMany({
        data: rows,
        skipDuplicates: true
      });

      // createMany({ skipDuplicates: true }) returns only the count of
      // rows actually inserted. Duplicates within the batch (or against
      // pre-existing rows with the same (source, sourceRef)) are silently
      // skipped. We re-read the affected sourceRefs to expose IDs and
      // the canonical sourceRef list — note this list may include
      // pre-existing rows, so we cannot derive skippedDuplicateCount
      // from rows.length - persisted.length.
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
  }
);
