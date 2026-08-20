import { taskTypeTitlePrefixes } from './_constants.ts';
import { workflowHandoffOwnerFor } from '../../config/workflowHandoffs.ts';
import { gateOwnerFor, requiredApprovalsFor, type RequiredApprovalsConfig } from '../../config/requiredApprovals.ts';

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
    position: attentionOwners.position,
    createdAt: attentionOwners.createdAt
  };
}

/**
 * Options for `mapTask` that drive the derived `workflowGates` response
 * field (added in PR #2 of task `f6a4d56a`, "Add Ash: automated
 * QA-verifier agent gate").
 *
 * Both fields are optional; when omitted the response omits the
 * `workflowGates` field rather than carrying a placeholder, because legacy
 * callers (e.g. the WS1a foundation PR's mapper tests) don't need it and
 * we want to keep the mapper unit-testable in isolation.
 *
 * `requiredApprovalTypes` is the ordered list of approval types required
 * for this task's `taskType` (from the resolved `RequiredApprovalsConfig`).
 * `gateOwnersByType` provides the configured owner per approval type so the
 * gate can be surfaced even when no `TaskApproval` row has been created
 * yet — the natural source of truth, instead of hard-coding
 * `spec → Tom` / `tech_design → Quinn` / `qa_agent → Ash` / `accepted →
 * Tom` in the UI. When the config is supplied, the mapper uses it to look
 * up owners via `gateOwnerFor`; otherwise it falls back to the per-type
 * `DEFAULT_APPROVAL_OWNERS`.
 *
 * Generalisation rationale (PR #2 f6a4d56a): the legacy single-source
 * shape derived `workflowGates` from the singular `task.workflowHandoffRoleId`
 * column — only one outstanding gate could be surfaced at a time. The mapper
 * now derives gates from the required approval types for the task's
 * `taskType`, but scopes them to the current workflow transition so the UI
 * shows only the owner whose approval is actionable at the task's current
 * status.
 *
 * The `task.workflowHandoffRoleId` / `workflowHandoffGate` /
 * `workflowHandoffReason` columns remain populated (they still drive the
 * lobster's per-iteration current-attention handoff via
 * `tasksRouter.patch('/tasks/:id')` and `taskApprovals.ts`), but they no
 * longer drive the `mapTask.workflowGates` response surface.
 */
export interface MapTaskOptions {
  requiredApprovalTypes?: readonly string[];
  gateOwnersByType?: Readonly<Record<string, string>>;
}

export function buildMapTaskOptions(
  config: RequiredApprovalsConfig,
  taskType: string | null | undefined
): MapTaskOptions {
  // Delegate the type→required list lookup to `requiredApprovalsFor` so the
  // policy resolution stays a single source of truth; we then materialise a
  // gateOwnersByType map here so `mapTask` stays a pure function of
  // (task, options) and never reaches back into the config loader. `gateOwnerFor`
  // already falls back to `DEFAULT_APPROVAL_OWNERS` when the config doesn't
  // override a type.
  const required = requiredApprovalsFor(config, taskType);
  const gateOwnersByType: Record<string, string> = {};
  for (const approvalType of required) {
    const owner = gateOwnerFor(config, approvalType);
    if (owner) gateOwnersByType[approvalType] = owner;
  }
  return { requiredApprovalTypes: required, gateOwnersByType };
}

const ACTIONABLE_STATUS_BY_APPROVAL_TYPE: Readonly<Record<string, string>> = {
  spec: 'open',
  tech_design: 'ready',
  qa_agent: 'doing',
  accepted: 'acceptance'
};

export function mapTask(task, options) {

  const dependsOn = task.dependencies
    ?.map((dependency) => dependency.dependsOn)
    .filter(Boolean)
    .map((dependency) => ({
      id: dependency.id,
      title: dependency.title,
      status: dependency.status,
      completedAt: dependency.completedAt
    })) ?? [];

  const attentionOwnerRows = [...(task.attentionOwners ?? [])].sort((a, b) =>
    (a.position ?? 0) - (b.position ?? 0)
  );
  // Position 0 is the top of the action/escalation stack. Repeated owners are
  // preserved because each row is a role slot, not a set membership record.
  const attentionOwners = attentionOwnerRows.map((row) => row.owner);

  const workflowHandoffOwner = workflowHandoffOwnerFor(task.workflowHandoffRoleId);
  // Derive `workflowGates` from required approval types, configured owners,
  // structured approval rows, and the task's current workflow stage. A gate
  // is actionable only on the transition it controls:
  // open → spec, ready → tech_design, doing → qa_agent,
  // acceptance → accepted. `done` has no actionable approval gate.
  //
  // This status scoping prevents future requirements (for example Tom's
  // `accepted` sign-off) from appearing in the avatar stack while a task is
  // still in `doing`, and prevents already-passed gates from reappearing when
  // their approval row is missing or revoked on an inconsistent task record.
  const requiredApprovalTypes = options?.requiredApprovalTypes ?? [];
  const gateOwnersByType = options?.gateOwnersByType ?? {};
  const approvedTypes = new Set(
    (task.approvals ?? [])
      .filter((a) => a?.state === 'approved' && !a.revokedAt)
      .map((a) => a.type)
  );
  const derivedGates = requiredApprovalTypes
    .filter((approvalType) => ACTIONABLE_STATUS_BY_APPROVAL_TYPE[approvalType] === task.status)
    .filter((approvalType) => !approvedTypes.has(approvalType))
    .map((approvalType) => ({
      roleId: `${approvalType}_gate`,
      owner: gateOwnersByType[approvalType] ?? null,
      gate: approvalType,
      reason: null,
      state: 'outstanding' as const
    }));
  // The legacy single-source shape is preserved only when `options` is
  // omitted AND `workflowHandoffRoleId` is populated — keeps the legacy
  // unit tests and any unported caller on the old surface. New callers
  // always pass `options`, so the new derivation wins; the legacy shape
  // is a transitional shape that disappears once all routes pass options.
  const legacyGates = task.workflowHandoffRoleId && workflowHandoffOwner && !options
    ? [{
        roleId: task.workflowHandoffRoleId,
        owner: workflowHandoffOwner,
        gate: task.workflowHandoffGate ?? null,
        reason: task.workflowHandoffReason ?? null,
        state: 'outstanding' as const
      }]
    : [];
  const workflowGates = options ? derivedGates : legacyGates;

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
    topAttentionOwner: attentionOwners[0] ?? null,
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
