import { prisma } from '../../lib/prisma.ts';
import { badRequest } from '../../lib/http.ts';

// Tag/dependency helpers extracted from tasks.ts. These touch the DB and
// signal errors via the response object so the caller short-circuits.

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
