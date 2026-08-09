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

/**
 * Options for `mapTask` that drive the derived `workflowGates` response
 * field. Both fields are optional; when omitted the response simply omits
 * the `workflowGates` field rather than carrying a placeholder, because
 * legacy callers (e.g. the WS1a foundation PR's mapper tests) don't need
 * it and we want to keep the mapper unit-testable in isolation.
 *
 * `requiredApprovalTypes` is the ordered list of approval types required
 * for this task's `taskType` (from the resolved `RequiredApprovalsConfig`).
 * `gateOwnersByType` maps each approval type to its configured owner so
 * the gate can be surfaced even when no `TaskApproval` row has been
 * created yet — the natural source of truth, instead of hard-coding
 * `spec → Tom` / `tech_design → Quinn` / `qa → Tom` in the UI.
 */
export interface MapTaskOptions {
  requiredApprovalTypes?: string[];
  gateOwnersByType?: Record<string, string>;
}

/**
 * Derive the per-task `workflowGates` view from the task's approval rows
 * and the required-approvals policy. A gate is `outstanding` when no
 * approved row exists for that type (either no row, or a `revoked` row);
 * an approved row satisfies the gate and removes it from the outstanding
 * handoff surface. Order matches `requiredApprovalTypes` so the UI can
 * render a stable, policy-defined gate ordering.
 *
 * Free-form approval rows whose `type` is not in the required list are
 * preserved on `approvals` but excluded from `workflowGates` — they're
 * legacy or experimental rows, not active gates.
 */
export function deriveWorkflowGates(
  task,
  requiredApprovalTypes: string[] = [],
  gateOwnersByType: Record<string, string> = {}
) {
  if (!requiredApprovalTypes || requiredApprovalTypes.length === 0) return [];
  const approvalByType = new Map<string, { state: string; owner: string | null }>();
  for (const row of task.approvals ?? []) {
    approvalByType.set(row.type, { state: row.state, owner: row.owner ?? null });
  }
  return requiredApprovalTypes.map((type) => {
    const row = approvalByType.get(type);
    if (row && row.state === 'approved') {
      return { type, owner: row.owner ?? gateOwnersByType[type] ?? null, state: 'approved' as const };
    }
    // No row, or a row in a non-approved state (e.g. revoked). The owner
    // surfaces as the configured owner when no row carries one; we never
    // invent an owner we don't have a policy source for.
    const owner = row?.owner ?? gateOwnersByType[type] ?? null;
    return { type, owner, state: 'outstanding' as const };
  });
}

export function mapTask(task, options: MapTaskOptions = {}) {
  const requiredApprovalTypes = options.requiredApprovalTypes ?? [];
  const gateOwnersByType = options.gateOwnersByType ?? {};

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

  const workflowGates = deriveWorkflowGates(task, requiredApprovalTypes, gateOwnersByType);

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
    workflowGates,
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
