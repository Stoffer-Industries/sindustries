import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';
import { authorizeApprovalRevocation, authorizeApprovalType, requireApprovalPrincipal, type ApprovalType } from '../middleware/approvalAuth.ts';
import { parseTaskId } from './tasks/_validation.ts';
import { mapTaskApproval } from './tasks/_mapper.ts';
import { validApprovalTypes } from './tasks/_constants.ts';
import { loadRequiredApprovalsConfig, requiredApprovalsFor } from '../config/requiredApprovals.ts';
import { workflowHandoffForApproval } from '../config/workflowHandoffs.ts';
import { evaluateQaAttestation, QA_EVIDENCE_GATE_BLOCKED } from '../lib/qaEvidenceAttestation.ts';

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

  // AC3: approval writes no longer touch the `attentionOwners` stack. Gate
  // ownership lives in `workflowHandoffRoleId/Gate/Reason` only; the
  // ordered action/escalation stack is owned by the lobster's `api_patch`
  // path (which goes through the case-insensitive dedupe normalization in
  // routes/tasks/_validation.ts) and the new per-row endpoints in
  // routes/taskAttentionOwners.ts. The two planes never co-write.

  return Object.keys(update).length > 0 ? update : null;
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

    // AC1 of task ad8346ee: a `qa_agent` grant is refused unless it carries a
    // fresh attestation minted from the live mechanical AC-evidence check.
    // Scoped to `qa_agent` only (design decision D4) — `spec`, `tech_design`,
    // and `accepted` approvals are unaffected and carry no attestation.
    //
    // Enforced at this choke point deliberately: it is the single route through
    // which EVERY `qa_agent` approval is written, so the gate cannot be
    // bypassed by a future writer forgetting to call something first.
    let evidencePins: { verifiedPrHeadSha: string; verifiedAcSectionDigest: string } | null = null;
    if (type === 'qa_agent') {
      const verdict = evaluateQaAttestation(req.body);
      if (!verdict.ok) {
        // No approval row is written on this path — that absence is asserted
        // directly by the AC1 test, because "returned a 4xx" alone would not
        // catch a regression that logged the rejection but still persisted.
        return res.status(409).json({
          error: {
            code: QA_EVIDENCE_GATE_BLOCKED,
            message: verdict.message,
            details: { reason: verdict.reason, failures: verdict.failures }
          }
        });
      }
      evidencePins = {
        verifiedPrHeadSha: verdict.headSha,
        verifiedAcSectionDigest: verdict.acSectionDigest
      };
    }

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
        create: {
          taskId: id,
          type,
          owner: actor,
          note,
          state: 'approved',
          approvedAt: now,
          ...evidencePins
        },
        // A re-approval overwrites the pins with the freshly attested values.
        // This is what makes the attestation single-use in practice: a stale
        // grant cannot survive a later approval, it is replaced by evidence
        // that was checked at that moment. Spreading the optional fields
        // (rather than assigning `undefined`) keeps Prisma from stripping the
        // keys and treating them as "no change".
        update: {
          owner: actor,
          note,
          state: 'approved',
          approvedAt: now,
          revokedAt: null,
          ...(evidencePins ?? { verifiedPrHeadSha: null, verifiedAcSectionDigest: null })
        }
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
    // Revocation is authorised against the wider `revocationTypes` set so
    // the lobster can invalidate a stale `qa_agent` grant (AC3 of task
    // ad8346ee) while still being unable to grant one.
    if (!authorizeApprovalRevocation(req, res, type)) return;
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
