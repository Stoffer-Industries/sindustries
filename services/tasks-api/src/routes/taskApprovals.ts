import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound } from '../lib/http.ts';
import { parseTaskId } from './tasks/_validation.ts';
import { mapTaskApproval } from './tasks/_mapper.ts';
import { validApprovalTypes } from './tasks/_constants.ts';

// Dedicated approval routes. Approval writes flow through here rather than
// `PATCH /tasks/:id` so the partial-update semantics of that route (which
// handles status / priority / assignee / etc.) stay isolated from approval
// state. Approvals are also intentionally orthogonal to `Task.description`
// and `TaskComment` — they do not modify description text or post comments.
//
// See docs/specs/tasks-api-native-approvals-tech-design.md WS1.

export const taskApprovalsRouter = Router();

function normalizeApprovalType(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return validApprovalTypes.has(trimmed) ? trimmed : null;
}

function normalizeOwner(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNote(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined; // signal invalid
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// GET /tasks/:id/approvals — list all approval rows for a task.
taskApprovalsRouter.get('/tasks/:id/approvals', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    // Single round-trip: load the task with its approvals relation. The 404
    // path is preserved by checking the task presence; the listing path
    // returns the same shape (sorted, mapped) as the previous two-query
    // implementation. Functionally equivalent — see repo audit 2026-W32
    // "[Low] Backfill is chatty at scale".
    const task = await prisma.task.findFirst({
      where: { id, archivedAt: null },
      select: {
        id: true,
        approvals: {
          orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }]
        }
      }
    });
    if (!task) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    return res.status(200).json({ data: task.approvals.map(mapTaskApproval) });
  } catch (error) {
    return next(error);
  }
});

// POST /tasks/:id/approvals — approve or re-approve. Idempotent on
// (taskId, type): a second call for the same type updates owner, note,
// state=approved, and re-stamps approvedAt.
taskApprovalsRouter.post('/tasks/:id/approvals', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    const type = normalizeApprovalType(req.body?.type);
    if (!type) {
      return badRequest(res, 'INVALID_APPROVAL_TYPE', 'type must be one of: spec, tech_design, qa');
    }

    const owner = normalizeOwner(req.body?.owner);
    if (!owner) return badRequest(res, 'APPROVAL_OWNER_REQUIRED', 'owner is required');

    const note = normalizeNote(req.body?.note);
    if (note === undefined) {
      return badRequest(res, 'INVALID_APPROVAL_NOTE', 'note must be a string when provided');
    }

    const task = await prisma.task.findFirst({
      where: { id, archivedAt: null },
      select: { id: true }
    });
    if (!task) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const now = new Date();
    const approval = await prisma.taskApproval.upsert({
      where: { taskId_type: { taskId: id, type } },
      create: {
        taskId: id,
        type,
        owner,
        note,
        state: 'approved',
        approvedAt: now
      },
      update: {
        owner,
        note,
        state: 'approved',
        approvedAt: now,
        revokedAt: null
      }
    });

    return res.status(200).json({ data: mapTaskApproval(approval) });
  } catch (error) {
    return next(error);
  }
});

// DELETE /tasks/:id/approvals/:type — revoke. Idempotent: revoking an
// already-revoked row is a no-op, and revoking an absent row returns 200
// with no payload (nothing to revoke, no phantom row created).
taskApprovalsRouter.delete('/tasks/:id/approvals/:type', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    const type = normalizeApprovalType(req.params.type);
    if (!type) {
      return badRequest(res, 'INVALID_APPROVAL_TYPE', 'type must be one of: spec, tech_design, qa');
    }

    const task = await prisma.task.findFirst({
      where: { id, archivedAt: null },
      select: { id: true }
    });
    if (!task) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const existing = await prisma.taskApproval.findUnique({
      where: { taskId_type: { taskId: id, type } }
    });
    if (!existing) {
      return res.status(200).json({ data: null });
    }

    const now = new Date();
    const approval = await prisma.taskApproval.update({
      where: { taskId_type: { taskId: id, type } },
      data: {
        state: 'revoked',
        revokedAt: now
      }
    });

    return res.status(200).json({ data: mapTaskApproval(approval) });
  } catch (error) {
    return next(error);
  }
});
