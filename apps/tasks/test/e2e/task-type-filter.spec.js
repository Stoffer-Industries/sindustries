import { expect, test } from '@playwright/test';

test('task type filter limits visible tasks', async ({ page }) => {
  const now = new Date().toISOString();
  const tasks = [
    {
      id: 'feature-task',
      title: 'Build feature workflow',
      status: 'open',
      statusChangedAt: now,
      priority: 'high',
      taskType: 'feature',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'content-task',
      title: 'Write content update',
      status: 'open',
      statusChangedAt: now,
      priority: 'medium',
      taskType: 'content',
      archivedAt: null,
      blocked: false,
      tags: []
    }
  ];

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);

    if (request.method() === 'GET' && isCollection) {
      const taskType = url.searchParams.get('taskType');
      const visible = taskType ? tasks.filter((task) => task.taskType === taskType) : tasks;
      await route.fulfill({ json: { data: visible } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();

  await expect(page.getByRole('button', { name: 'Build feature workflow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write content update' })).toBeVisible();

  await page.getByLabel('Task type filter').click();
  await page.getByRole('menuitemradio', { name: 'FEATURE' }).click();

  await expect(page.getByRole('button', { name: 'Build feature workflow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write content update' })).toHaveCount(0);
  await expect(page.getByLabel('Task type filter')).toHaveText('TYPE: FEATURE');

  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByRole('button', { name: 'Build feature workflow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write content update' })).toHaveCount(0);
});

test('task editor saves task type changes', async ({ page }) => {
  const now = new Date().toISOString();
  const task = {
    id: 'editable-task',
    title: 'Retype task',
    description: 'Change this from code to feature.',
    status: 'open',
    statusChangedAt: now,
    priority: 'medium',
    taskType: 'code',
    archivedAt: null,
    blocked: false,
    tags: [],
    comments: []
  };
  let patchedBody = null;

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);
    const idMatch = url.pathname.match(/\/tasks\/([^/]+)$/);

    if (method === 'GET' && isCollection) {
      await route.fulfill({ json: { data: [task] } });
      return;
    }

    if (method === 'GET' && idMatch) {
      await route.fulfill({ json: { data: task } });
      return;
    }

    if (method === 'PATCH' && idMatch?.[1] === task.id) {
      patchedBody = request.postDataJSON();
      Object.assign(task, patchedBody);
      await route.fulfill({ json: { data: task } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();
  await page.getByRole('button', { name: 'Retype task' }).click();

  await expect(page.getByLabel('Detail task type')).toHaveValue('code');
  await page.getByLabel('Detail task type').selectOption('feature');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect.poll(() => patchedBody?.taskType).toBe('feature');
});
