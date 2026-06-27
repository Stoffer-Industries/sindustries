import { expect, test } from '@playwright/test';

test('task dependency UI: add, list, copy ID, and remove', async ({ page }) => {
  const now = new Date().toISOString();
  const tasks = [
    {
      id: 'task-a',
      title: 'Task A',
      description: 'Depends on another task',
      status: 'ready',
      statusChangedAt: now,
      priority: 'medium',
      archivedAt: null,
      blocked: false,
      tags: [],
      comments: [],
      dependsOnIds: []
    },
    {
      id: 'task-b',
      title: 'Task B',
      description: 'Upstream dependency',
      status: 'doing',
      statusChangedAt: now,
      priority: 'high',
      archivedAt: null,
      blocked: false,
      tags: [],
      comments: [],
      dependsOnIds: []
    }
  ];

  function withDependencies(task) {
    return {
      ...task,
      dependsOn: (task.dependsOnIds ?? [])
        .map((id) => tasks.find((candidate) => candidate.id === id))
        .filter(Boolean)
        .map((dependency) => ({
          id: dependency.id,
          title: dependency.title,
          status: dependency.status,
          completedAt: dependency.completedAt ?? null
        })),
      dependencyBlocked: (task.dependsOnIds ?? [])
        .some((id) => tasks.find((candidate) => candidate.id === id)?.status !== 'done')
    };
  }

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedTaskId = text;
        }
      }
    });
  });

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);
    const detailMatch = url.pathname.match(/\/tasks\/([^/]+)$/);

    if (method === 'GET' && isCollection) {
      await route.fulfill({ json: { data: tasks.map(withDependencies) } });
      return;
    }

    if (method === 'GET' && detailMatch) {
      const [, taskId] = detailMatch;
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task) {
        await route.fulfill({ status: 404, json: { error: { message: 'Task not found' } } });
        return;
      }
      await route.fulfill({ json: { data: withDependencies(task) } });
      return;
    }

    if (method === 'PATCH' && detailMatch) {
      const [, taskId] = detailMatch;
      const body = request.postDataJSON();
      const task = tasks.find((entry) => entry.id === taskId);
      Object.assign(task, body);
      await route.fulfill({ json: { data: withDependencies(task) } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();
  await page.getByRole('button', { name: 'Task A' }).click();

  const dependencies = page.getByRole('region', { name: 'Task dependencies' });
  await expect(dependencies.getByText('No dependencies')).toBeVisible();

  await page.getByLabel('Dependency task ID').fill('task-b');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(dependencies.getByText('Link to')).toBeVisible();
  await expect(dependencies.getByText('Task B')).toBeVisible();
  await expect(dependencies.getByText('Doing')).toBeVisible();

  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(dependencies.getByRole('button', { name: 'Task B Doing' })).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).last().click();
  await page.getByRole('button', { name: 'Copy task ID task-a' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedTaskId)).toBe('task-a');

  await page.getByRole('button', { name: 'Task A' }).click();
  await page.getByRole('button', { name: 'Remove dependency Task B' }).click();
  await expect(dependencies.getByRole('button', { name: 'Task B Doing' })).toHaveCount(0);
  await expect(dependencies.getByText('No dependencies')).toBeVisible();
});
