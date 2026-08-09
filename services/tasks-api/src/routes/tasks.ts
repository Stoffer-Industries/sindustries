import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound, sendError } from '../lib/http.ts';

import {
  dependencyInclude,
  priorityOrder,
  validAssignees,
  validPriorities,
  validSorts,
  validStatuses,
  validTaskTypes
} from './tasks/_constants.ts';
import {
  normalizeDependsOnIds,
  normalizeString,
  normalizeTags,
  parseDate,
  parseLimit,
  parseTaskId
} from './tasks/_validation.ts';
import { decodeCursor, encodeCursor } from './tasks/_pagination.ts';
import { formatTaskTitle, mapTask, mapTaskComment } from './tasks/_mapper.ts';
import { descriptionHasSpecDrift, descriptionWithSpecDriftApprovalState } from './tasks/_spec.ts';
import { connectTags, validateDependsOnIds } from './tasks/_deps.ts';

export const tasksRouter = Router();

tasksRouter.get('/tasks', async (req, res, next) => {
  try {
    const {
      status,
      priority,
      assignee,
      taskType,
      tag,
      q,
      dueBefore,
      dueAfter,
      blocked,
      includeArchived,
      limit: rawLimit,
      cursor,
      sort = 'priority'
    } = req.query;

    // Support multi-select status filter (comma-separated)
    const statusValues = status ? status.toString().split(',').map(s => s.trim()) : [];
    if (statusValues.length > 0) {
      const invalidStatuses = statusValues.filter(s => !validStatuses.has(s));
      if (invalidStatuses.length > 0) {
        return badRequest(res, 'INVALID_STATUS_FILTER', 'Invalid status filter');
      }
    }

    if (priority && !validPriorities.has(priority)) {
      return badRequest(res, 'INVALID_PRIORITY_FILTER', 'Invalid priority filter');
    }

    if (taskType && !validTaskTypes.has(String(taskType))) {
      return badRequest(res, 'INVALID_TASK_TYPE_FILTER', 'Invalid taskType filter');
    }

    if (sort && !validSorts.has(sort)) {
      return badRequest(res, 'INVALID_SORT_VALUE', 'Invalid sort value');
    }

    const dueBeforeDate = parseDate(dueBefore);
    if (dueBefore && !dueBeforeDate) {
      return badRequest(res, 'INVALID_DUE_BEFORE', 'Invalid dueBefore value');
    }

    const dueAfterDate = parseDate(dueAfter);
    if (dueAfter && !dueAfterDate) {
      return badRequest(res, 'INVALID_DUE_AFTER', 'Invalid dueAfter value');
    }

    const decodedCursor = decodeCursor(cursor);
    if (cursor && !decodedCursor) {
      return badRequest(res, 'INVALID_CURSOR', 'Invalid cursor value');
    }

    const limit = parseLimit(rawLimit);

    // Build status filter
    let statusFilter = {};
    if (statusValues.length > 1) {
      statusFilter = { status: { in: statusValues } };
    } else if (statusValues.length === 1) {
      statusFilter = { status: statusValues[0] };
    }

    const where = {
      ...(includeArchived === 'true' ? {} : { archivedAt: null }),
      ...statusFilter,
      ...(priority ? { priority } : {}),
      ...(taskType ? { taskType: String(taskType) } : {}),
      ...(assignee
        ? assignee === 'unassigned'
          ? { OR: [{ assignee: null }, { assignee: '' }] }
          : { assignee: { equals: assignee, mode: 'insensitive' } }
        : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } }
            ]
          }
        : {}),
      ...(tag
        ? {
            tags: {
              some: {
                tag: {
                  name: { equals: tag, mode: 'insensitive' }
                }
              }
            }
          }
        : {}),
      ...(dueBeforeDate || dueAfterDate
        ? {
            dueAt: {
              ...(dueBeforeDate ? { lte: dueBeforeDate } : {}),
              ...(dueAfterDate ? { gte: dueAfterDate } : {})
            }
          }
        : {}),
      ...(blocked !== undefined ? { blocked: blocked === 'true' } : {})
    };

    const queryWhere = decodedCursor
      ? {
          AND: [
            where,
            {
              OR: [
                { createdAt: { lt: decodedCursor.createdAt } },
                {
                  createdAt: decodedCursor.createdAt,
                  id: { lt: decodedCursor.id }
                }
              ]
            }
          ]
        }
      : where;

    const tasks = await prisma.task.findMany({
      where: queryWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        tags: {
          include: {
            tag: true
          }
        },
        approvals: true,
        ...dependencyInclude
      },
      take: limit + 1
    });

    let sortedTasks = tasks;
    if (sort === 'priority') {
      sortedTasks = [...tasks].sort((a, b) => {
        const p = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (p !== 0) return p;
        if (a.createdAt > b.createdAt) return -1;
        if (a.createdAt < b.createdAt) return 1;
        return b.id.localeCompare(a.id);
      });
    } else if (sort === 'dueAt') {
      sortedTasks = [...tasks].sort((a, b) => {
        if (!a.dueAt && !b.dueAt) return b.createdAt - a.createdAt;
        if (!a.dueAt) return 1;
        if (!b.dueAt) return -1;
        if (a.dueAt > b.dueAt) return 1;
        if (a.dueAt < b.dueAt) return -1;
        return b.createdAt - a.createdAt;
      });
    } else {
      sortedTasks = [...tasks].sort((a, b) => {
        if (a[sort] > b[sort]) return -1;
        if (a[sort] < b[sort]) return 1;
        return b.createdAt - a.createdAt;
      });
    }

    const hasNextPage = sortedTasks.length > limit;
    const pageTasks = sortedTasks.slice(0, limit);
    const lastTask = pageTasks.at(-1);

    return res.status(200).json({
      data: pageTasks.map(mapTask),
      page: {
        limit,
        nextCursor: hasNextPage && lastTask ? encodeCursor(lastTask.createdAt, lastTask.id) : null,
        hasNextPage
      }
    });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.get('/tasks/:id', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    const task = await prisma.task.findFirst({
      where: { id, archivedAt: null },
      include: {
        tags: {
          include: {
            tag: true
          }
        },
        comments: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        },
        approvals: true,
        ...dependencyInclude
      }
    });

    if (!task) {
      return notFound(res, 'TASK_NOT_FOUND', 'Task not found');
    }

    return res.status(200).json({ data: mapTask(task) });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.post('/tasks', async (req, res, next) => {
  try {
    const rawTitle = normalizeString(req.body?.title);
    const description = normalizeString(req.body?.description) || null;
    const status = req.body?.status ?? 'open';
    const priority = req.body?.priority ?? 'medium';
    const assignee = normalizeString(req.body?.assignee) || null;
    const dueAt = req.body?.dueAt ? parseDate(req.body.dueAt) : null;
    const tags = normalizeTags(req.body?.tags);
    const blocked = req.body?.blocked ?? false;
    const taskType = req.body?.taskType || null;
    const specChecksum = normalizeString(req.body?.specChecksum) || null;

    // Validation
    if (!rawTitle) return badRequest(res, 'TITLE_REQUIRED', 'title is required');
    if (taskType && !validTaskTypes.has(taskType)) {
      return badRequest(res, 'INVALID_TASK_TYPE', 'taskType must be content, code, research, or feature');
    }
    if (specChecksum && !/^[a-f0-9]{64}$/.test(specChecksum)) {
      return badRequest(res, 'INVALID_SPEC_CHECKSUM', 'specChecksum must be a lowercase sha256 hex digest');
    }
    if (!validStatuses.has(status)) return badRequest(res, 'INVALID_STATUS_VALUE', 'Invalid status value');
    if (!validPriorities.has(priority)) return badRequest(res, 'INVALID_PRIORITY_VALUE', 'Invalid priority value');
    if (req.body?.dueAt && !dueAt) return badRequest(res, 'INVALID_DUE_AT', 'Invalid dueAt value');
    if (req.body?.tags && !tags) return badRequest(res, 'INVALID_TAGS', 'tags must be an array of strings');
    if (assignee && !validAssignees.has(assignee)) {
      return badRequest(res, 'INVALID_ASSIGNEE', 'Assignee must be one of: Tom, Quinn, Rowan, Lox, Ivy');
    }

    const tagRecords = await connectTags(tags);
    const now = new Date();
    const title = formatTaskTitle(rawTitle, taskType);

    const created = await prisma.task.create({
      data: {
        title,
        description,
        status,
        priority,
        assignee,
        dueAt,
        statusChangedAt: now,
        completedAt: status === 'done' ? now : null,
        blocked,
        taskType,
        specChecksum,
        tags: {
          create: tagRecords.map((tag) => ({ tag: { connect: { id: tag.id } } }))
        }
      },
      include: {
        tags: {
          include: {
            tag: true
          }
        },
        approvals: true,
        ...dependencyInclude
      }
    });

    return res.status(201).json({ data: mapTask(created) });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.patch('/tasks/:id', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const existing = await prisma.task.findFirst({ where: { id, archivedAt: null } });
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const updates = {};
    const hasDependencyUpdate = req.body?.dependsOnIds !== undefined;
    const dependsOnIds = hasDependencyUpdate ? normalizeDependsOnIds(req.body.dependsOnIds) : undefined;
    const title = normalizeString(req.body?.title);
    const description = req.body?.description === undefined ? undefined : normalizeString(req.body.description);
    const assignee = req.body?.assignee === undefined ? undefined : normalizeString(req.body.assignee);

    if (req.body?.title !== undefined) {
      if (!title) return badRequest(res, 'TITLE_EMPTY', 'title cannot be empty');
      updates.title = title;
    }

    if (hasDependencyUpdate && !dependsOnIds) {
      return badRequest(res, 'INVALID_DEPENDS_ON_IDS', 'dependsOnIds must be an array of UUID strings');
    }

    const nextDescription = description === undefined
      ? undefined
      : descriptionWithSpecDriftApprovalState(existing, description || null);
    const specApprovalRevocationRequired = description !== undefined
      && descriptionHasSpecDrift(existing, nextDescription);
    if (nextDescription !== undefined) updates.description = nextDescription;
    if (assignee !== undefined) {
      if (assignee && !validAssignees.has(assignee)) {
        return badRequest(res, 'INVALID_ASSIGNEE', 'Assignee must be one of: Tom, Quinn, Rowan, Lox, Ivy');
      }
      updates.assignee = assignee || null;
    }

    if (req.body?.priority !== undefined) {
      if (!validPriorities.has(req.body.priority)) {
        return badRequest(res, 'INVALID_PRIORITY_VALUE', 'Invalid priority value');
      }
      updates.priority = req.body.priority;
    }

    if (req.body?.status !== undefined) {
      if (!validStatuses.has(req.body.status)) {
        return badRequest(res, 'INVALID_STATUS_VALUE', 'Invalid status value');
      }
      updates.status = req.body.status;
      updates.statusChangedAt = new Date();
      updates.completedAt = req.body.status === 'done' ? new Date() : null;
    }

    if (req.body?.dueAt !== undefined) {
      if (req.body.dueAt === null) {
        updates.dueAt = null;
      } else {
        const dueAt = parseDate(req.body.dueAt);
        if (!dueAt) return badRequest(res, 'INVALID_DUE_AT', 'Invalid dueAt value');
        updates.dueAt = dueAt;
      }
    }

    if (req.body?.blocked !== undefined) {
      updates.blocked = Boolean(req.body.blocked);
    }

    if (req.body?.taskType !== undefined) {
      if (req.body.taskType && !validTaskTypes.has(req.body.taskType)) {
        return badRequest(res, 'INVALID_TASK_TYPE', 'taskType must be content, code, research, or feature');
      }
      updates.taskType = req.body.taskType || null;
    }

    if (hasDependencyUpdate) {
      const validDependencies = await validateDependsOnIds(res, id, dependsOnIds);
      if (!validDependencies) return;
    }

    if (req.body?.specChecksum !== undefined) {
      const specChecksum = normalizeString(req.body.specChecksum);
      if (specChecksum && !/^[a-f0-9]{64}$/.test(specChecksum)) {
        return badRequest(res, 'INVALID_SPEC_CHECKSUM', 'specChecksum must be a lowercase sha256 hex digest');
      }
      if (existing.specChecksum && specChecksum !== null && specChecksum !== existing.specChecksum) {
        return sendError(
          res,
          409,
          'SPEC_CHECKSUM_LOCKED',
          'specChecksum is locked after spec approval -- write a new spec to change scope'
        );
      }
      updates.specChecksum = specChecksum || null;
    }

    const hasTagUpdate = req.body?.tags !== undefined;
    let tagRecords = null;
    if (req.body?.tags !== undefined) {
      const tags = normalizeTags(req.body.tags);
      if (!tags) return badRequest(res, 'INVALID_TAGS', 'tags must be an array of strings');
      tagRecords = await connectTags(tags);
    }

    const task = await prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id },
        data: updates
      });

      if (specApprovalRevocationRequired) {
        const specApproval = await tx.taskApproval.findUnique({
          where: { taskId_type: { taskId: id, type: 'spec' } }
        });
        if (specApproval?.state === 'approved') {
          await tx.taskApproval.update({
            where: { taskId_type: { taskId: id, type: 'spec' } },
            data: { state: 'revoked', revokedAt: new Date() }
          });
          await tx.taskComment.create({
            data: {
              taskId: id,
              author: 'Tasks API',
              body: 'Approval spec revoked by Tasks API after acceptance criteria changed.'
            }
          });
        }
      }

      if (hasTagUpdate) {
        await tx.taskTag.deleteMany({ where: { taskId: id } });
        if (tagRecords.length > 0) {
          await tx.taskTag.createMany({
            data: tagRecords.map((tag) => ({ taskId: id, tagId: tag.id })),
            skipDuplicates: true
          });
        }
      }

      if (hasDependencyUpdate) {
        await tx.taskDependency.deleteMany({ where: { taskId: id } });
        if (dependsOnIds.length > 0) {
          await tx.taskDependency.createMany({
            data: dependsOnIds.map((dependsOnId) => ({ taskId: id, dependsOnId })),
            skipDuplicates: true
          });
        }
      }

      return tx.task.findFirst({
        where: { id },
        include: {
          tags: { include: { tag: true } },
          approvals: true,
          ...dependencyInclude
        }
      });
    });

    return res.status(200).json({ data: mapTask(task) });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.post('/tasks/:id/comments', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');
    const existing = await prisma.task.findFirst({ where: { id, archivedAt: null } });
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');
    // Comments are meta-discussion, not scope changes. The drift check
    // belongs on PATCH (where ACs can actually be modified), not on comment
    // creation. Checking here blocks all discussion on drifted tasks, which
    // is the opposite of what we want — the new ACs need to be discussed.

    const author = normalizeString(req.body?.author);
    const text = normalizeString(req.body?.text);

    if (!author) return badRequest(res, 'COMMENT_AUTHOR_REQUIRED', 'author is required');
    if (!text) return badRequest(res, 'COMMENT_TEXT_REQUIRED', 'text is required');

    const comment = await prisma.taskComment.create({
      data: {
        taskId: id,
        author,
        body: text
      }
    });

    return res.status(201).json({ data: mapTaskComment(comment) });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.delete('/tasks/:id', async (req, res, next) => {
  try {
    const id = parseTaskId(req.params.id);
    if (!id) return badRequest(res, 'INVALID_TASK_ID', 'Task id must be a 36-char UUID');

    const existing = await prisma.task.findFirst({ where: { id, archivedAt: null } });
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const archived = await prisma.task.update({
      where: { id },
      data: { archivedAt: new Date() }
    });

    return res.status(200).json({ data: { id: archived.id, archivedAt: archived.archivedAt } });
  } catch (error) {
    return next(error);
  }
});
