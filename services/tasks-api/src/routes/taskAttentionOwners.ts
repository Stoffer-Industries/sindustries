import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';
import {
  MAX_ATTENTION_OWNERS,
  MAX_ATTENTION_OWNER_LENGTH,
  parseTaskId
} from './tasks/_validation.ts';
import { mapTask } from './tasks/_mapper.ts';
import { mapTaskOptionsFor } from './tasks/_deps.ts';

/**
 * Per-row write endpoints for the attention-owner stack.
 *
 * The PATCH `/tasks/:id` endpoint already accepts a full-replacement
 * `attentionOwners` array; that contract is preserved. These per-row
 * endpoints cover the cases where the caller needs to:
 *   - add a single row with a required reason (closes AC2),
 *   - move, rename, or edit the note on an existing row,
 *   - delete a single row without disturbing the rest of the stack,
 *   - remove the caller's own current top slot ("resolve my blocker").
 *
 * Every write here goes through `requireAuth`; the lobster is unaffected
 * because it still writes the full stack via the PATCH `/tasks/:id`
 * endpoint and benefits from the case-insensitive dedupe there.
 */

export const taskAttentionOwnersRouter = Router();

const MAX_NOTE_LENGTH = 500;

function normalizeOwnerString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_ATTENTION_OWNER_LENGTH) return null;
  return trimmed;
}

function normalizeNoteString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTE_LENGTH) return null;
  return trimmed;
}

function normalizePosition(value) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  if (n > MAX_ATTENTION_OWNERS) return null;
  return n;
}

function sameOwner(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Resolve `req.user.actor` against the current top of the attention stack
 * (after the case-insensitive compare). Returns `true` when the actor is
 * the actionable owner. `Tom` and `Quinn` always pass because they are
 * the documented override path (matching the lobster's escalation policy).
 */
function isAuthorizedForRow(actor, currentTopOwner) {
  if (!actor || typeof actor !== 'string') return false;
  if (actor.trim().toLowerCase() === 'tom') return true;
  if (actor.trim().toLowerCase() === 'quinn') return true;
  if (!currentTopOwner) return false;
  return sameOwner(actor, currentTopOwner);
}

async function loadTask(id) {
  return prisma.task.findFirst({
    where: { id, archivedAt: null },
    include: {
      tags: { include: { tag: true } },
      approvals: true,
      attentionOwners: { orderBy: { position: 'asc' } },
      dependencies: { include: { dependsOn: true } }
    }
  });
}

async function loadTaskWithAttentionOwners(id) {
  return prisma.task.findFirst({
    where: { id, archivedAt: null },
    include: { attentionOwners: { orderBy: { position: 'asc' } } }
  });
}

/**
 * POST /tasks/:id/attention-owners
 * Body: `{ owner: string, note: string, position?: number }`
 * Auth: any authenticated actor (Tom/Quinn/Rowan/Lox/Ivy/...)
 * Effect: insert a single new row with the supplied reason. `note` is
 *   required (closes AC2). Default position is 0 (head insert); a
 *   non-zero position inserts at that index and shifts the tail down.
 * Audit: TaskComment `Attention owner "<owner>" added at position <n> by
 *   <actor>: <note>`.
 */
taskAttentionOwnersRouter.post('/tasks/:id/attention-owners', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    const authenticatedActor = req.user?.actor;
    if (!authenticatedActor) {
      return sendError(res, 401, 'AUTH_REQUIRED', 'A valid session or service credential is required');
    }

    const owner = normalizeOwnerString(req.body?.owner);
    if (!owner) return badRequest(res, 'INVALID_ATTENTION_OWNER', 'owner must be a non-empty string (max 64 chars)');

    const note = normalizeNoteString(req.body?.note);
    if (!note) return badRequest(res, 'INVALID_ATTENTION_OWNER_NOTE', 'note is required (max 500 chars, non-empty after trim)');

    const position = normalizePosition(req.body?.position);
    if (position === null && req.body?.position !== undefined && req.body?.position !== null) {
      return badRequest(res, 'INVALID_ATTENTION_OWNER_POSITION', 'position must be a non-negative integer');
    }
    const requestedPosition = position === null ? 0 : position;

    const existing = await loadTaskWithAttentionOwners(id);
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const created = await prisma.$transaction(async (tx) => {
      const currentRows = await tx.taskAttentionOwner.findMany({
        where: { taskId: id },
        orderBy: { position: 'asc' }
      });

      // Reject case-insensitive duplicates on insert. The PATCH /tasks/:id
      // path silently dedupes; the per-row path requires explicit intent,
      // so duplicates are a client error rather than a silent collapse.
      const duplicate = currentRows.find((row) => sameOwner(row.owner, owner));
      if (duplicate) {
        return { kind: 'duplicate', existingPosition: duplicate.position } as const;
      }

      const insertIndex = Math.min(requestedPosition, currentRows.length);
      const rowsToShift = currentRows.slice(insertIndex);

      // Renumber the tail that shifts down by one to make room at the
      // insert slot. We do it in a single transaction with the insert so
      // the @@unique([taskId, position]) constraint is never violated.
      for (let i = rowsToShift.length - 1; i >= 0; i--) {
        const row = rowsToShift[i];
        await tx.taskAttentionOwner.update({
          where: { id: row.id },
          data: { position: row.position + 1 }
        });
      }

      const newRow = await tx.taskAttentionOwner.create({
        data: {
          taskId: id,
          owner,
          addedBy: authenticatedActor,
          note,
          position: insertIndex
        }
      });

      await tx.taskComment.create({
        data: {
          taskId: id,
          author: authenticatedActor,
          body: `Attention owner "${owner}" added at position ${insertIndex} by ${authenticatedActor}: ${note}`
        }
      });

      return { kind: 'created', row: newRow } as const;
    });

    if (created.kind === 'duplicate') {
      return badRequest(
        res,
        'DUPLICATE_ATTENTION_OWNER',
        `Attention owner "${owner}" already exists at position ${created.existingPosition} (case-insensitive match)`
      );
    }

    const refreshed = await loadTask(id);
    return res.status(200).json({
      data: mapTask(refreshed, mapTaskOptionsFor(refreshed)),
      row: created.row
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * PATCH /tasks/:id/attention-owners/:rowId
 * Body: `{ owner?: string, note?: string, position?: number }`
 * Auth: top-of-stack actor (current actionable owner) OR Tom/Quinn.
 * Effect: rename / move / edit note on a single row. At least one mutable
 *   field is required. Reordering preserves the relative order of every
 *   other row. `position` move validation: equal to current position is
 *   a no-op (200). Move conflicts (case-insensitive duplicate at the
 *   target) return 409.
 * Audit: TaskComment `Attention owner "<old>" updated by <actor>: <changes>`.
 */
taskAttentionOwnersRouter.patch('/tasks/:id/attention-owners/:rowId', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const rowId = req.params.rowId;
    if (!rowId || typeof rowId !== 'string') {
      return badRequest(res, 'INVALID_ROW_ID', 'rowId must be a non-empty path segment');
    }

    const authenticatedActor = req.user?.actor;
    if (!authenticatedActor) {
      return sendError(res, 401, 'AUTH_REQUIRED', 'A valid session or service credential is required');
    }

    const newOwnerRaw = req.body?.owner;
    const newNoteRaw = req.body?.note;
    const newPositionRaw = req.body?.position;
    const hasOwner = newOwnerRaw !== undefined;
    const hasNote = newNoteRaw !== undefined;
    const hasPosition = newPositionRaw !== undefined;
    if (!hasOwner && !hasNote && !hasPosition) {
      return badRequest(res, 'NO_FIELDS', 'At least one of owner, note, or position must be supplied');
    }

    const newOwner = hasOwner ? normalizeOwnerString(newOwnerRaw) : null;
    if (hasOwner && newOwner === null) {
      return badRequest(res, 'INVALID_ATTENTION_OWNER', 'owner must be a non-empty string (max 64 chars)');
    }
    const newNote = hasNote ? normalizeNoteString(newNoteRaw) : null;
    if (hasNote && newNote === null) {
      return badRequest(res, 'INVALID_ATTENTION_OWNER_NOTE', 'note must be a non-empty string (max 500 chars) when supplied');
    }
    const newPosition = hasPosition ? normalizePosition(newPositionRaw) : null;
    if (hasPosition && newPosition === null) {
      return badRequest(res, 'INVALID_ATTENTION_OWNER_POSITION', 'position must be a non-negative integer');
    }

    const existing = await loadTaskWithAttentionOwners(id);
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const currentTop = existing.attentionOwners[0]?.owner;
    if (!isAuthorizedForRow(authenticatedActor, currentTop)) {
      return sendError(res, 403, 'NOT_TOP_OWNER', 'Only the current top-of-stack actor (or Tom/Quinn) may modify attention-owner rows');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const target = await tx.taskAttentionOwner.findUnique({ where: { id: rowId } });
      if (!target || target.taskId !== id) {
        return { kind: 'missing' } as const;
      }

      const allRows = await tx.taskAttentionOwner.findMany({
        where: { taskId: id },
        orderBy: { position: 'asc' }
      });

      // Case-insensitive duplicate detection across the rest of the stack
      // when renaming. The target row itself is excluded so renaming to
      // the same casing is fine.
      if (newOwner && !sameOwner(newOwner, target.owner)) {
        const conflict = allRows.find((row) => row.id !== target.id && sameOwner(row.owner, newOwner));
        if (conflict) {
          return { kind: 'duplicate', existingPosition: conflict.position } as const;
        }
      }

      // Move: re-number the slot at the new position out of the way,
      // then re-number the freed slot down. Single transaction so the
      // @@unique constraint never trips.
      const movingToDifferentPosition = newPosition !== null && newPosition !== target.position;
      if (movingToDifferentPosition) {
        const targetIndex = newPosition;
        const currentIndex = allRows.findIndex((row) => row.id === target.id);
        if (targetIndex !== currentIndex) {
          // Two-step swap: bump everything at/after the target slot up by
          // one (to free the slot), then move the target into place.
          for (const row of allRows) {
            if (row.id === target.id) continue;
            if (row.position >= targetIndex && row.position < currentIndex) {
              await tx.taskAttentionOwner.update({
                where: { id: row.id },
                data: { position: row.position + 1 }
              });
            } else if (row.position <= targetIndex && row.position > currentIndex) {
              await tx.taskAttentionOwner.update({
                where: { id: row.id },
                data: { position: row.position - 1 }
              });
            }
          }
        }
      }

      const data = {};
      if (newOwner !== null) data.owner = newOwner;
      if (newNote !== null) data.note = newNote;
      const patch = await tx.taskAttentionOwner.update({
        where: { id: rowId },
        data
      });

      // If position was meant to change, the row's own position needs the
      // final value (targetIndex, possibly after the swap dance).
      if (movingToDifferentPosition) {
        const finalIndex = newPosition;
        await tx.taskAttentionOwner.update({
          where: { id: rowId },
          data: { position: finalIndex }
        });
        patch.position = finalIndex;
      }

      const changes: string[] = [];
      if (newOwner !== null && newOwner !== target.owner) changes.push(`owner "${target.owner}" -> "${newOwner}"`);
      if (newNote !== null && newNote !== target.note) changes.push(`note updated`);
      if (movingToDifferentPosition) changes.push(`position ${target.position} -> ${newPosition}`);
      if (changes.length > 0) {
        await tx.taskComment.create({
          data: {
            taskId: id,
            author: authenticatedActor,
            body: `Attention owner "${target.owner}" updated by ${authenticatedActor}: ${changes.join('; ')}`
          }
        });
      }

      return { kind: 'updated', row: patch } as const;
    });

    if (updated.kind === 'missing') return notFound(res, 'ROW_NOT_FOUND', 'Attention-owner row not found on this task');
    if (updated.kind === 'duplicate') {
      return badRequest(
        res,
        'DUPLICATE_ATTENTION_OWNER',
        `Renaming would collide with "${updated.existingPosition}" — case-insensitive duplicate in the stack`
      );
    }

    const refreshed = await loadTask(id);
    return res.status(200).json({
      data: mapTask(refreshed, mapTaskOptionsFor(refreshed)),
      row: updated.row
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * DELETE /tasks/:id/attention-owners/:rowId
 * Auth: top-of-stack actor OR Tom/Quinn.
 * Effect: removes exactly the targeted row; renumbers positions
 *   contiguously. Records an audit comment.
 */
taskAttentionOwnersRouter.delete('/tasks/:id/attention-owners/:rowId', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const rowId = req.params.rowId;
    if (!rowId || typeof rowId !== 'string') {
      return badRequest(res, 'INVALID_ROW_ID', 'rowId must be a non-empty path segment');
    }

    const authenticatedActor = req.user?.actor;
    if (!authenticatedActor) {
      return sendError(res, 401, 'AUTH_REQUIRED', 'A valid session or service credential is required');
    }

    const existing = await loadTaskWithAttentionOwners(id);
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const currentTop = existing.attentionOwners[0]?.owner;
    if (!isAuthorizedForRow(authenticatedActor, currentTop)) {
      return sendError(res, 403, 'NOT_TOP_OWNER', 'Only the current top-of-stack actor (or Tom/Quinn) may remove attention-owner rows');
    }

    const removed = await prisma.$transaction(async (tx) => {
      const target = await tx.taskAttentionOwner.findUnique({ where: { id: rowId } });
      if (!target || target.taskId !== id) {
        return { kind: 'missing' } as const;
      }
      const reasonRaw = req.body?.reason;
      const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
      await tx.taskAttentionOwner.delete({ where: { id: rowId } });
      // Renumber positions contiguously so a UI re-render shows the
      // expected [0..n-1] ordering.
      const remaining = await tx.taskAttentionOwner.findMany({
        where: { taskId: id },
        orderBy: { position: 'asc' }
      });
      for (let i = 0; i < remaining.length; i++) {
        const row = remaining[i];
        if (row.position !== i) {
          await tx.taskAttentionOwner.update({ where: { id: row.id }, data: { position: i } });
        }
      }
      await tx.taskComment.create({
        data: {
          taskId: id,
          author: authenticatedActor,
          body: `Attention owner "${target.owner}" removed by ${authenticatedActor}${reason ? `: ${reason}` : ''}`
        }
      });
      return { kind: 'removed', row: target } as const;
    });

    if (removed.kind === 'missing') return notFound(res, 'ROW_NOT_FOUND', 'Attention-owner row not found on this task');

    const refreshed = await loadTask(id);
    return res.status(200).json({
      data: mapTask(refreshed, mapTaskOptionsFor(refreshed)),
      removed: removed.row
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /tasks/:id/attention-owners/self-resolve
 * Body: `{ note?: string }`
 * Auth: authenticated actor whose case-insensitive name equals
 *   `task.attentionOwners[0]` (the current actionable owner).
 * Effect: removes ONLY the current top row; later rows renumber up by
 *   one. Preserves `task.blocked`, `dependencyBlocked`, `assignee`,
 *   `approvals`, and `workflowHandoffRoleId/Gate/Reason`.
 * Returns 403 if attentionOwners is empty or the current top doesn't match.
 */
taskAttentionOwnersRouter.post('/tasks/:id/attention-owners/self-resolve', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    const authenticatedActor = req.user?.actor;
    if (!authenticatedActor) {
      return sendError(res, 401, 'AUTH_REQUIRED', 'A valid session or service credential is required');
    }

    const noteRaw = req.body?.note;
    const note = typeof noteRaw === 'string' ? noteRaw.trim() : '';

    const existing = await loadTaskWithAttentionOwners(id);
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const top = existing.attentionOwners[0];
    if (!top) {
      return sendError(res, 403, 'NO_ACTIVE_BLOCKER', 'attentionOwners is empty; nothing to resolve');
    }
    // The Tom/Quinn override path runs BEFORE the same-owner check so the
    // call path "actor=Tom, current top=Quinn" succeeds without hitting the
    // generic 403. The override is the documented escape hatch matching the
    // lobster's escalation policy; see the per-row write endpoints' authz
    // section in docs/specs/attention-owner-escalations-tech-design.md.
    if (!isAuthorizedForRow(authenticatedActor, top.owner)) {
      return sendError(
        res,
        403,
        'NOT_TOP_OWNER',
        `Current top is "${top.owner}"; authenticated actor "${authenticatedActor}" cannot resolve`
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.taskAttentionOwner.delete({ where: { id: top.id } });
      // Renumber so position 0 is the new top. Subsequent callers (UI
      // re-render, lobster sweep) read the same ordered invariant.
      const remaining = await tx.taskAttentionOwner.findMany({
        where: { taskId: id },
        orderBy: { position: 'asc' }
      });
      for (let i = 0; i < remaining.length; i++) {
        const row = remaining[i];
        if (row.position !== i) {
          await tx.taskAttentionOwner.update({ where: { id: row.id }, data: { position: i } });
        }
      }
      const nextTop = remaining[0]?.owner ?? null;
      await tx.taskComment.create({
        data: {
          taskId: id,
          author: authenticatedActor,
          body: `Attention blocker for ${authenticatedActor} resolved${note ? `: ${note}` : ''}. New top: ${nextTop ?? '(empty)'}`
        }
      });
      return { kind: 'resolved', nextTop } as const;
    });

    const refreshed = await loadTask(id);
    return res.status(200).json({
      data: mapTask(refreshed, mapTaskOptionsFor(refreshed)),
      resolved: top.owner,
      nextTopOwner: result.nextTop
    });
  } catch (error) {
    return next(error);
  }
});