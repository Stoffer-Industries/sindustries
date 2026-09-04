import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';
import { authorizeApprovalType, requireApprovalPrincipal, type ApprovalType } from '../middleware/approvalAuth.ts';
import { parseTaskId } from './tasks/_validation.ts';
import { mapTaskApproval } from './tasks/_mapper.ts';
import { validApprovalTypes } from './tasks/_constants.ts';
import { loadRequiredApprovalsConfig, requiredApprovalsFor } from '../config/requiredApprovals.ts';
import { attentionOwnerForApproval, workflowHandoffForApproval } from '../config/workflowHandoffs.ts';

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

function approvalHandoffUpdate(task, type: ApprovalType, action: 'approved' | 'revoked') {
  const handoff = workflowHandoffForApproval(type);
  const currentAttentionOwners = (task.attentionOwners ?? []).map((row) => row.owner);
  const desiredAttentionOwners = attentionOwnersForApproval(currentAttentionOwners, type, action);

  const update: Record<string, unknown> = {};

  if (handoff) {
    if (action === 'approved') {
      if (task.workflowHandoffGate === type) {
        update.workflowHandoffRoleId = null;
        update.workflowHandoffGate = null;
        update.workflowHandoffReason = null;
      }
    } else {
      const required = requiredApprovalsFor(loadRequiredApprovalsConfig(), task.taskType);
      if (required.includes(type)) {
        update.workflowHandoffRoleId = handoff.roleId;
        update.workflowHandoffGate = type;
        update.workflowHandoffReason = handoff.reason;
      }
    }
  }

  if (desiredAttentionOwners) {
    // Full-replacement via Prisma nested write — same atomicity as the
    // PATCH endpoint's deleteMany + createMany, but in a single statement.
    // The PATCH endpoint (routes/tasks.ts lines 615-622) uses the explicit
    // two-call form; the nested-write form here is equivalent inside one
    // $transaction.
    update.attentionOwners = {
      deleteMany: {},
      createMany: {
        data: desiredAttentionOwners.map((owner, position) => ({ owner, position }))
      }
    };
  }

  return Object.keys(update).length > 0 ? update : null;
}

/**
 * Compute the desired `attentionOwners[]` array after a structured approval
 * write, mirroring the lobster's `reconciled_attention_owners` else-branch
 * for the head-slot-pop / head-slot-prepend path.
 *
 * Returns:
 *   - `null` when the approval type has no attention-owner mapping, when the
 *     current head is unrelated (e.g. the assignee is at position 0 and the
 *     just-recorded approval satisfies a different gate), or when no change
 *     is needed (idempotent). The caller treats `null` as "leave the array
 *     alone; let the lobster's next sweep handle the broader reconciliation."
 *   - The new array otherwise.
 *
 * Behaviour:
 *   - approved + head matches type's owner → remove the head (single pop).
 *     Tail slots (including duplicates) are preserved byte-for-byte.
 *   - revoked + head does NOT match type's owner → prepend the owner, even
 *     when the owner is already present lower in the stack. Only position 0
 *     routes actionably, and the gate-owner must be there while their gate
 *     is open (the lobster tolerates duplicates; matching it preserves the
 *     invariant it relies on).
 *   - revoked + head already matches → no-op (idempotent).
 *   - anything else (head doesn't match on approve, no owner for this type) → null.
 *
 * Case-insensitive comparison mirrors the lobster's `eq_ignore_ascii_case`
 * so a task created with `"tom"` at the head behaves identically to `"Tom"`.
 */
export function attentionOwnersForApproval(
  current: string[],
  type: ApprovalType,
  action: 'approved' | 'revoked'
): string[] | null {
  const owner = attentionOwnerForApproval(type);
  if (!owner) return null;
  // Reconciliation only applies when there is existing state to reconcile.
  // An empty `current` array means the lobster has not yet populated the
  // stack (e.g. a task that has only ever held a single approval write);
  // injecting an entry here would collide with the lobster's broader
  // initial-population sweep on the next stage call, and it also breaks
  // pre-existing tests whose fixtures intentionally model the unset case.
  if (current.length === 0) return null;
  const matchesOwner = (o: string) => o.trim().toLowerCase() === owner.toLowerCase();
  const head = current[0];
  if (action === 'approved') {
    return head !== undefined && matchesOwner(head) ? current.slice(1) : null;
  }
  // action === 'revoked'
  // Only the head slot routes actionably; the lobster (Rust) treats head as
  // the sole routing signal and tolerates duplicates lower in the stack.
  // If the owner is already at the head (above) this is an idempotent revoke
  // — no-op. Any other presence (e.g. owner in the tail from an earlier
  // reconciliation pass) must NOT suppress the prepend, because the gate-
  // owner must be at position 0 while their gate is open.
  if (head !== undefined && matchesOwner(head)) return null;
  return [owner, ...current];
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
    if (!type) return badRequest(res, 'INVALID_APPROVAL_TYPE', `type must be one of: ${Array.from(validApprovalTypes).sort().join(', ')}`);
    if (!authorizeApprovalType(req, res, type)) return;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'owner')) {
      return badRequest(res, 'FORGEABLE_APPROVAL_OWNER', 'owner is server-derived and must not be supplied');
    }
    const note = normalizeNote(req.body?.note);
    if (note === undefined) return badRequest(res, 'INVALID_APPROVAL_NOTE', 'note must be a string when provided');
    const actor = req.approvalPrincipal!.actor;

    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          archivedAt: true,
          taskType: true,
          workflowHandoffRoleId: true,
          workflowHandoffGate: true,
          workflowHandoffReason: true,
          attentionOwners: { orderBy: { position: 'asc' } }
        }
      });
      if (!task) return { kind: 'missing' } as const;
      if (task.archivedAt || task.status === 'done') return { kind: 'immutable' } as const;
      const existing = await tx.taskApproval.findUnique({ where: { taskId_type: { taskId: id, type } } });
      if (existing?.state === 'approved' && existing.owner === actor && existing.note === note) {
        const handoffUpdate = approvalHandoffUpdate(task, type, 'approved');
        if (handoffUpdate) await tx.task.update({ where: { id }, data: handoffUpdate });
        return { kind: 'approval', approval: existing } as const;
      }
      const now = new Date();
      const approval = await tx.taskApproval.upsert({
        where: { taskId_type: { taskId: id, type } },
        create: { taskId: id, type, owner: actor, note, state: 'approved', approvedAt: now },
        update: { owner: actor, note, state: 'approved', approvedAt: now, revokedAt: null }
      });
      const handoffUpdate = approvalHandoffUpdate(task, type, 'approved');
      if (handoffUpdate) await tx.task.update({ where: { id }, data: handoffUpdate });
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
    if (!type) return badRequest(res, 'INVALID_APPROVAL_TYPE', `type must be one of: ${Array.from(validApprovalTypes).sort().join(', ')}`);
    if (!authorizeApprovalType(req, res, type)) return;
    const actor = req.approvalPrincipal!.actor;

    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          archivedAt: true,
          taskType: true,
          workflowHandoffRoleId: true,
          workflowHandoffGate: true,
          workflowHandoffReason: true,
          attentionOwners: { orderBy: { position: 'asc' } }
        }
      });
      if (!task) return { kind: 'missing' } as const;
      if (task.archivedAt || task.status === 'done') return { kind: 'immutable' } as const;
      const existing = await tx.taskApproval.findUnique({ where: { taskId_type: { taskId: id, type } } });
      if (!existing || existing.state === 'revoked') {
        if (existing?.state === 'revoked') {
          const handoffUpdate = approvalHandoffUpdate(task, type, 'revoked');
          if (handoffUpdate) await tx.task.update({ where: { id }, data: handoffUpdate });
        }
        return { kind: 'approval', approval: existing ?? null } as const;
      }
      const approval = await tx.taskApproval.update({
        where: { taskId_type: { taskId: id, type } },
        data: { state: 'revoked', revokedAt: new Date() }
      });
      const handoffUpdate = approvalHandoffUpdate(task, type, 'revoked');
      if (handoffUpdate) await tx.task.update({ where: { id }, data: handoffUpdate });
      await tx.taskComment.create({ data: { taskId: id, author: actor, body: approvalAuditBody(type, 'revoked', actor) } });
      return { kind: 'approval', approval } as const;
    });
    if (result.kind === 'missing') return notFound(res, 'TASK_NOT_FOUND', 'Task not found');
    if (result.kind === 'immutable') return immutableTask(res);
    return res.status(200).json({ data: result.approval ? mapTaskApproval(result.approval) : null });
  } catch (error) { return next(error); }
});
