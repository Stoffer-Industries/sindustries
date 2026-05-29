import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, notFound } from '../lib/http.ts';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10000;

const validStatuses = new Set(['open', 'ready', 'doing', 'acceptance', 'done']);
const validPriorities = new Set(['low', 'medium', 'high', 'urgent']);
const validAssignees = new Set(['Tom', 'Quinn', 'Rowan', 'Lox']);
const validSorts = new Set(['priority', 'createdAt', 'updatedAt', 'dueAt', 'statusChangedAt']);

const priorityOrder = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3
};

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function parseLimit(value) {
  const n = Number.parseInt(value ?? `${DEFAULT_LIMIT}`, 10);
  if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeCursor(createdAt, id) {
  return Buffer.from(`${createdAt.toISOString()}::${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [createdAtRaw, id] = decoded.split('::');
    const createdAt = new Date(createdAtRaw);

    if (!id || Number.isNaN(createdAt.valueOf())) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
  }
}

function mapComment(comment) {
  return {
    id: comment.id,
    author: comment.author,
    text: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt
  };
}

function mapTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    statusChangedAt: task.statusChangedAt,
    priority: task.priority,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    assignee: task.assignee,
    archivedAt: task.archivedAt,
    blocked: task.blocked ?? false,
    ready: task.ready ?? false,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    taskType: task.taskType ?? null,
    tags: task.tags?.map((taskTag) => taskTag.tag?.name).filter(Boolean) ?? [],
    comments: task.comments?.map(mapComment) ?? []
  };
}

function mapTaskComment(comment) {
  return mapComment(comment);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return null;
  const normalized = tags
    .map((tag) => normalizeString(tag))
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());

  return [...new Set(normalized)];
}

async function connectTags(tagNames) {
  if (!tagNames?.length) return [];

  return Promise.all(
    tagNames.map((name) =>
      prisma.tag.upsert({
        where: { name },
        create: { name },
        update: {}
      })
    )
  );
}

export const tasksRouter = Router();

tasksRouter.get('/tasks', async (req, res, next) => {
  try {
    const {
      status,
      priority,
      assignee,
      tag,
      q,
      dueBefore,
      dueAfter,
      blocked,
      ready,
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
      ...(blocked !== undefined ? { blocked: blocked === 'true' } : {}),
      ...(ready !== undefined ? { ready: ready === 'true' } : {})
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
        }
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
    const { id } = req.params;

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
        }
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
    const title = normalizeString(req.body?.title);
    const description = normalizeString(req.body?.description) || null;
    const status = req.body?.status ?? 'open';
    const priority = req.body?.priority ?? 'medium';
    const assignee = normalizeString(req.body?.assignee) || null;
    const dueAt = req.body?.dueAt ? parseDate(req.body.dueAt) : null;
    const tags = normalizeTags(req.body?.tags);
    const blocked = req.body?.blocked ?? false;
    const ready = req.body?.ready ?? false;
    const taskType = req.body?.taskType || null;

    // Validation
    if (!title) return badRequest(res, 'TITLE_REQUIRED', 'title is required');
    if (taskType && !['content', 'code', 'research'].includes(taskType)) {
      return badRequest(res, 'INVALID_TASK_TYPE', 'taskType must be content, code, or research');
    }
    if (!validStatuses.has(status)) return badRequest(res, 'INVALID_STATUS_VALUE', 'Invalid status value');
    if (!validPriorities.has(priority)) return badRequest(res, 'INVALID_PRIORITY_VALUE', 'Invalid priority value');
    if (req.body?.dueAt && !dueAt) return badRequest(res, 'INVALID_DUE_AT', 'Invalid dueAt value');
    if (req.body?.tags && !tags) return badRequest(res, 'INVALID_TAGS', 'tags must be an array of strings');
    if (assignee && !validAssignees.has(assignee)) {
      return badRequest(res, 'INVALID_ASSIGNEE', 'Assignee must be one of: Tom, Quinn, Rowan, Lox');
    }

    const tagRecords = await connectTags(tags);
    const now = new Date();

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
        ready,
        taskType,
        tags: {
          create: tagRecords.map((tag) => ({ tag: { connect: { id: tag.id } } }))
        }
      },
      include: {
        tags: {
          include: {
            tag: true
          }
        }
      }
    });

    return res.status(201).json({ data: mapTask(created) });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.patch('/tasks/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.task.findFirst({ where: { id, archivedAt: null } });
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

    const updates = {};
    const title = normalizeString(req.body?.title);
    const description = req.body?.description === undefined ? undefined : normalizeString(req.body.description);
    const assignee = req.body?.assignee === undefined ? undefined : normalizeString(req.body.assignee);

    if (req.body?.title !== undefined) {
      if (!title) return badRequest(res, 'TITLE_EMPTY', 'title cannot be empty');
      updates.title = title;
    }

    if (description !== undefined) updates.description = description || null;
    if (assignee !== undefined) {
      if (assignee && !validAssignees.has(assignee)) {
        return badRequest(res, 'INVALID_ASSIGNEE', 'Assignee must be one of: Tom, Quinn, Rowan, Lox');
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

    if (req.body?.ready !== undefined) {
      updates.ready = Boolean(req.body.ready);
    }

    if (req.body?.taskType !== undefined) {
      const validTypes = ['content', 'code', 'research'];
      if (req.body.taskType && !validTypes.includes(req.body.taskType)) {
        return badRequest(res, 'INVALID_TASK_TYPE', 'taskType must be content, code, or research');
      }
      updates.taskType = req.body.taskType || null;
    }

    const updated = await prisma.task.update({
      where: { id },
      data: updates,
      include: {
        tags: {
          include: {
            tag: true
          }
        }
      }
    });

    if (req.body?.tags !== undefined) {
      const tags = normalizeTags(req.body.tags);
      if (!tags) return badRequest(res, 'INVALID_TAGS', 'tags must be an array of strings');
      const tagRecords = await connectTags(tags);
      await prisma.taskTag.deleteMany({ where: { taskId: id } });
      if (tagRecords.length > 0) {
        await prisma.taskTag.createMany({
          data: tagRecords.map((tag) => ({ taskId: id, tagId: tag.id })),
          skipDuplicates: true
        });
      }
    }

    const task = await prisma.task.findFirst({
      where: { id },
      include: { tags: { include: { tag: true } } }
    });

    return res.status(200).json({ data: mapTask(task ?? updated) });
  } catch (error) {
    return next(error);
  }
});

tasksRouter.post('/tasks/:id/comments', async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.task.findFirst({ where: { id, archivedAt: null } });
    if (!existing) return notFound(res, 'TASK_NOT_FOUND', 'Task not found');

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
    const { id } = req.params;

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
