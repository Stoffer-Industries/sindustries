import { prisma } from '../../lib/prisma.ts';
import { badRequest } from '../../lib/http.ts';
import {
  gateOwnerFor,
  loadRequiredApprovalsConfig,
  requiredApprovalsFor
} from '../../config/requiredApprovals.ts';

// Tag/dependency helpers extracted from tasks.ts. These touch the DB and
// signal errors via the response object so the caller short-circuits.

/**
 * Resolve the workflow-gate context for a task: the ordered list of
 * approval types required for the task's `taskType`, plus the configured
 * owner per approval type. Pass both to `mapTask` via `MapTaskOptions` so
 * the response can expose a derived `workflowGates` field without
 * duplicating the policy in the UI (per task 66054ab4 WS1).
 *
 * Reads the global `RequiredApprovalsConfig` snapshot each call; the loader
 * is a cheap file read with memoization in tests, and policy drift is a
 * startup-time concern. When `taskType` is null/empty the resolved lists
 * are empty — no required approvals, no configured owners — which mirrors
 * `requiredApprovalsFor`'s semantics.
 */
export function resolveGateContext(taskType: string | null | undefined): {
  requiredApprovalTypes: string[];
  gateOwnersByType: Record<string, string>;
} {
  const config = loadRequiredApprovalsConfig();
  const requiredApprovalTypes = requiredApprovalsFor(config, taskType);
  const gateOwnersByType: Record<string, string> = {};
  for (const type of requiredApprovalTypes) {
    const owner = gateOwnerFor(config, type);
    if (owner) gateOwnersByType[type] = owner;
  }
  return { requiredApprovalTypes, gateOwnersByType };
}

/**
 * Build a Prisma `where` fragment for `?workflowGateOwner=OWNER` discovery
 * filtering. A task matches when its `taskType` requires at least one
 * approval type owned by OWNER (per the loaded config), AND no approved
 * row exists for any of those types — i.e. at least one of OWNER's gates
 * is still outstanding.
 *
 * Returned shape: an `AND: [...]` array suitable for merging into an
 * existing `where` clause. Returns an empty array when OWNER does not own
 * any approval type (no required gates, no discovery surface).
 *
 * Free-form owners that don't match `validAssignees` are still queried —
 * the discovery queue should not silently drop unknown names. Server-side
 * `console.warn` is acceptable noise; see the tech design.
 */
export function buildWorkflowGateOwnerWhere(owner: string): Array<Record<string, unknown>> {
  const config = loadRequiredApprovalsConfig();
  const ownedTypes = Object.entries(config.owners)
    .filter(([, candidate]) => candidate === owner)
    .map(([type]) => type);

  if (ownedTypes.length === 0) return [];

  const taskTypesForOwned = new Set<string>();
  for (const [taskType, required] of Object.entries(config.mappings)) {
    if (required.some((type) => ownedTypes.includes(type))) {
      taskTypesForOwned.add(taskType);
    }
  }

  if (taskTypesForOwned.size === 0) return [];

  const taskTypeFilter = {
    taskType: { in: [...taskTypesForOwned] }
  };

  // Outstanding = no approved row for any of OWNER's types. A single task
  // matches if AT LEAST ONE of OWNER's gates is outstanding; we encode that
  // with an OR over the per-type "no approved row" clauses.
  const anyOutstanding = {
    OR: ownedTypes.map((type) => ({
      NOT: {
        approvals: { some: { type, state: 'approved' } }
      }
    }))
  };

  return [taskTypeFilter, anyOutstanding];
}

export async function connectTags(tagNames) {
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

export async function validateDependsOnIds(res, taskId, dependsOnIds) {
  if (dependsOnIds.includes(taskId)) {
    badRequest(res, 'SELF_DEPENDENCY_NOT_ALLOWED', 'Task cannot depend on itself');
    return false;
  }

  if (dependsOnIds.length === 0) return true;

  const dependencyTasks = await prisma.task.findMany({
    where: { id: { in: dependsOnIds } },
    select: { id: true, archivedAt: true }
  });
  const foundIds = new Set(dependencyTasks.map((task) => task.id));
  const missingId = dependsOnIds.find((id) => !foundIds.has(id));
  if (missingId) {
    badRequest(res, 'DEPENDENCY_TASK_NOT_FOUND', `Dependency task not found: ${missingId}`);
    return false;
  }

  const archivedTask = dependencyTasks.find((task) => task.archivedAt);
  if (archivedTask) {
    badRequest(res, 'ARCHIVED_DEPENDENCY_NOT_ALLOWED', `Dependency task is archived: ${archivedTask.id}`);
    return false;
  }

  const directCycle = await prisma.taskDependency.findFirst({
    where: {
      taskId: { in: dependsOnIds },
      dependsOnId: taskId
    },
    select: { taskId: true }
  });
  if (directCycle) {
    badRequest(res, 'CIRCULAR_DEPENDENCY_NOT_ALLOWED', 'Direct circular dependencies are not allowed');
    return false;
  }

  return true;
}
