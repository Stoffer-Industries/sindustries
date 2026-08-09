import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';
import { authorizeApprovalType, requireApprovalPrincipal, type ApprovalType } from '../middleware/approvalAuth.ts';
import { parseTaskId } from './tasks/_validation.ts';
import { mapTaskApproval } from './tasks/_mapper.ts';
import { validApprovalTypes } from './tasks/_constants.ts';

export const taskApprovalsRouter = Router();

function normalizeApprovalType(value): ApprovalType | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return validApprovalTypes.has(trimmed) ? trimmed as ApprovalType : null;
}

function normalizeNote(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function immutableTask(res) {
  return sendError(res, 409, 'TASK_IMMUTABLE', 'Approvals cannot be changed on an archived or done task');
}

export function approvalAuditBody(type: ApprovalType, action: 'approved' | 'revoked', actor: string) {
  return `Approval ${type} ${action} by ${actor}.`;
}

taskApprovalsRouter.get('/tasks/:id/approvals', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const task = await prisma.task.findFirst({
      where: { id, archivedAt: null },
      select: { id: true, approvals: { orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }] } }
    });
    if (!task) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');
    return res.status(200).json({ data: task.approvals.map(mapTaskApproval) });
  } catch (error) { return next(error); }
});

taskApprovalsRouter.post('/tasks/:id/approvals', requireApprovalPrincipal, async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const type = normalizeApprovalType(req.body?.type);
    if (!type) return badRequest(res, 'INVALID_APPROVAL_TYPE', 'type must be one of: spec, tech_design, qa');
    if (!authorizeApprovalType(req, res, type)) return;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'owner')) {
      return badRequest(res, 'FORGEABLE_APPROVAL_OWNER', 'owner is server-derived and must not be supplied');
    }
    const note = normalizeNote(req.body?.note);
    if (note === undefined) return badRequest(res, 'INVALID_APPROVAL_NOTE', 'note must be a string when provided');
    const actor = req.approvalPrincipal!.actor;

    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id }, select: { id: true, status: true, archivedAt: true } });
      if (!task) return { kind: 'missing' } as const;
      if (task.archivedAt || task.status === 'done') return { kind: 'immutable' } as const;
      const existing = await tx.taskApproval.findUnique({ where: { taskId_type: { taskId: id, type } } });
      if (existing?.state === 'approved' && existing.owner === actor && existing.note === note) {
        return { kind: 'approval', approval: existing } as const;
      }
      const now = new Date();
      const approval = await tx.taskApproval.upsert({
        where: { taskId_type: { taskId: id, type } },
        create: { taskId: id, type, owner: actor, note, state: 'approved', approvedAt: now },
        update: { owner: actor, note, state: 'approved', approvedAt: now, revokedAt: null }
      });
      await tx.taskComment.create({ data: { taskId: id, author: actor, body: approvalAuditBody(type, 'approved', actor) } });
      return { kind: 'approval', approval } as const;
    });
    if (result.kind === 'missing') return notFound(res, 'TASK_NOT_FOUND', 'Task not found');
    if (result.kind === 'immutable') return immutableTask(res);
    return res.status(200).json({ data: mapTaskApproval(result.approval) });
  } catch (error) { return next(error); }
});

taskApprovalsRouter.delete('/tasks/:id/approvals/:type', requireApprovalPrincipal, async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const type = normalizeApprovalType(req.params.type);
    if (!type) return badRequest(res, 'INVALID_APPROVAL_TYPE', 'type must be one of: spec, tech_design, qa');
    if (!authorizeApprovalType(req, res, type)) return;
    const actor = req.approvalPrincipal!.actor;

    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({ where: { id }, select: { id: true, status: true, archivedAt: true } });
      if (!task) return { kind: 'missing' } as const;
      if (task.archivedAt || task.status === 'done') return { kind: 'immutable' } as const;
      const existing = await tx.taskApproval.findUnique({ where: { taskId_type: { taskId: id, type } } });
      if (!existing || existing.state === 'revoked') return { kind: 'approval', approval: existing ?? null } as const;
      const approval = await tx.taskApproval.update({
        where: { taskId_type: { taskId: id, type } },
        data: { state: 'revoked', revokedAt: new Date() }
      });
      await tx.taskComment.create({ data: { taskId: id, author: actor, body: approvalAuditBody(type, 'revoked', actor) } });
      return { kind: 'approval', approval } as const;
    });
    if (result.kind === 'missing') return notFound(res, 'TASK_NOT_FOUND', 'Task not found');
    if (result.kind === 'immutable') return immutableTask(res);
    return res.status(200).json({ data: result.approval ? mapTaskApproval(result.approval) : null });
  } catch (error) { return next(error); }
});
