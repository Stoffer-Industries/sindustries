import { prisma } from '../../lib/prisma.ts';
import { badRequest } from '../../lib/http.ts';
import { workflowHandoffRolesForOwner } from '../../config/workflowHandoffs.ts';

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
  const roleIds = workflowHandoffRolesForOwner(owner);
  return roleIds.length > 0 ? [{ workflowHandoffRoleId: { in: roleIds } }] : [];
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
