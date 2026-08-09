import { taskTypeTitlePrefixes } from './_constants.ts';

// Response mappers extracted from tasks.ts. These shape Prisma rows into the
// public API contract; no validation, no DB calls.

function mapComment(comment) {
  return {
    id: comment.id,
    author: comment.author,
    text: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt
  };
}

export function mapTaskApproval(approval) {
  return {
    id: approval.id,
    type: approval.type,
    owner: approval.owner,
    state: approval.state,
    approvedAt: approval.approvedAt,
    revokedAt: approval.revokedAt ?? null,
    note: approval.note ?? null,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt
  };
}

export function mapTaskAttentionOwner(attentionOwners) {
  return {
    id: attentionOwners.id,
    owner: attentionOwners.owner,
    addedBy: attentionOwners.addedBy ?? null,
    note: attentionOwners.note ?? null,
    createdAt: attentionOwners.createdAt
  };
}

export function mapTask(task) {
  const dependsOn = task.dependencies
    ?.map((dependency) => dependency.dependsOn)
    .filter(Boolean)
    .map((dependency) => ({
      id: dependency.id,
      title: dependency.title,
      status: dependency.status,
      completedAt: dependency.completedAt
    })) ?? [];

  const attentionOwnerRows = task.attentionOwners ?? [];
  // Stable insertion order is used for the attention layer of the avatar
  // stack. Attention ownership is deliberately not interpreted as blocked
  // state; `task.blocked` and `dependencyBlocked` retain their own semantics.
  const attentionOwners = attentionOwnerRows.map((row) => row.owner);

  return {
    id: task.id,
    title: formatTaskTitle(task.title, task.taskType),
    description: task.description,
    status: task.status,
    statusChangedAt: task.statusChangedAt,
    priority: task.priority,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    assignee: task.assignee,
    archivedAt: task.archivedAt,
    blocked: task.blocked ?? false,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    taskType: task.taskType ?? null,
    specChecksum: task.specChecksum ?? null,
    tags: task.tags?.map((taskTag) => taskTag.tag?.name).filter(Boolean) ?? [],
    comments: task.comments?.map(mapComment) ?? [],
    approvals: task.approvals?.map(mapTaskApproval) ?? [],
    attentionOwners,
    attentionOwnerDetails: attentionOwnerRows.map(mapTaskAttentionOwner),
    dependsOn,
    dependsOnIds: dependsOn.map((dependency) => dependency.id),
    dependencyBlocked: dependsOn.some((dependency) => dependency.status !== 'done')
  };
}

export function formatTaskTitle(title, taskType) {
  const prefix = taskTypeTitlePrefixes[taskType];
  if (!prefix || typeof title !== 'string') return title;

  const knownPrefixPattern = Object.values(taskTypeTitlePrefixes)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const titleWithoutKnownPrefix = title.replace(new RegExp(`^(?:${knownPrefixPattern})\\s+`), '');
  return `${prefix} ${titleWithoutKnownPrefix}`;
}

export function mapTaskComment(comment) {
  return mapComment(comment);
}
