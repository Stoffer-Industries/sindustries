import { prisma } from '../../lib/prisma.ts';
import { badRequest } from '../../lib/http.ts';
import { workflowHandoffRolesForOwner } from '../../config/workflowHandoffs.ts';
import { loadRequiredApprovalsConfig } from '../../config/requiredApprovals.ts';
import { buildMapTaskOptions, type MapTaskOptions } from './tasks/_mapper.ts';

// Tag/dependency helpers extracted from tasks.ts. These touch the DB and
// signal errors via the response object so the caller short-circuits.

/**
 * Resolve the `MapTaskOptions` for a single task: reads the global
 * `RequiredApprovalsConfig` snapshot, then delegates to
 * `buildMapTaskOptions` so the response can expose a derived
 * `workflowGates` field (added in PR #2 of task `f6a4d56a`).
 *
 * The config loader is memoised at module load (`loadRequiredApprovalsConfig`),
 * so calling this helper on every request is cheap. When `task.taskType`
 * is null/empty the resolved lists are empty — no required approvals, no
 * derived gates — which mirrors `requiredApprovalsFor`'s semantics.
 */
export function mapTaskOptionsFor(task): MapTaskOptions {
  const config = loadRequiredApprovalsConfig();
  return buildMapTaskOptions(config, task?.taskType ?? null);
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
