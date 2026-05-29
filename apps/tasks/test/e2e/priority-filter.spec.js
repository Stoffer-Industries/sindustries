import { expect, test } from '@playwright/test';

test('priority filter on Kanban board filters displayed tasks', async ({ page }) => {
  const now = new Date().toISOString();
  const tasks = [
    {
      id: 'task-urgent-1',
      title: 'Fix login crash',
      status: 'open',
      statusChangedAt: now,
      priority: 'urgent',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-high-1',
      title: 'Update dependencies',
      status: 'open',
      statusChangedAt: now,
      priority: 'high',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-medium-1',
      title: 'Write docs',
      status: 'doing',
      statusChangedAt: now,
      priority: 'medium',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-low-1',
      title: 'Nice to have feature',
      status: 'open',
      statusChangedAt: now,
      priority: 'low',
      archivedAt: null,
      blocked: false,
      tags: []
    }
  ];

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);
    const idMatch = url.pathname.match(/\/tasks\/([^/]+)$/);

    if (method === 'GET' && isCollection) {
      const priority = url.searchParams.get('priority');
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      let visible = includeArchived ? tasks : tasks.filter((task) => !task.archivedAt);
      if (priority) {
        visible = visible.filter((task) => task.priority === priority);
      }
      await route.fulfill({ json: { data: visible } });
      return;
    }

    if (method === 'PATCH' && idMatch) {
      const id = idMatch[1];
      const body = request.postDataJSON();
      const task = tasks.find((entry) => entry.id === id);
      if (task) {
        Object.assign(task, body);
        if (body.status) task.statusChangedAt = new Date().toISOString();
      }
      await route.fulfill({ json: { data: task } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');

  // Debug: wait for page to render and log content
  await page.waitForTimeout(2000);
  const debugHtml = await page.content();
  console.log('PAGE HTML (first 3000):', debugHtml.substring(0, 3000));

  // Default view is Kanban - verify all tasks are shown initially
  await expect(page.getByTestId('column-open')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix login crash' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update dependencies' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nice to have feature' })).toBeVisible();
  // Medium task is in 'doing' column
  await expect(page.getByRole('button', { name: 'Write docs' })).toBeVisible();

  // Select "urgent" priority filter
  await page.getByLabel('Priority filter').click();
  await page.getByRole('menuitemradio', { name: 'URGENT' }).click();

  // Only the urgent task should be visible
  await expect(page.getByRole('button', { name: 'Fix login crash' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update dependencies' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write docs' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nice to have feature' })).toHaveCount(0);

  // Switch to "high" priority filter
  await page.getByLabel('Priority filter').click();
  await page.getByRole('menuitemradio', { name: 'HIGH' }).click();

  // Only the high priority task should be visible
  await expect(page.getByRole('button', { name: 'Update dependencies' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix login crash' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write docs' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nice to have feature' })).toHaveCount(0);

  // Switch back to "All priorities"
  await page.getByLabel('Priority filter').click();
  await page.getByRole('menuitemradio', { name: 'ALL PRIORITIES' }).click();

  // All tasks should be visible again
  await expect(page.getByRole('button', { name: 'Fix login crash' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update dependencies' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write docs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nice to have feature' })).toBeVisible();
});

test('priority filter combines with status column visibility on Kanban board', async ({ page }) => {
  const now = new Date().toISOString();
  const tasks = [
    {
      id: 'task-1',
      title: 'Urgent todo task',
      status: 'open',
      statusChangedAt: now,
      priority: 'urgent',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-2',
      title: 'High doing task',
      status: 'doing',
      statusChangedAt: now,
      priority: 'high',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-3',
      title: 'Urgent doing task',
      status: 'doing',
      statusChangedAt: now,
      priority: 'urgent',
      archivedAt: null,
      blocked: false,
      tags: []
    }
  ];

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);

    if (method === 'GET' && isCollection) {
      const priority = url.searchParams.get('priority');
      let visible = tasks.filter((task) => !task.archivedAt);
      if (priority) {
        visible = visible.filter((task) => task.priority === priority);
      }
      await route.fulfill({ json: { data: visible } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');

  // Filter to urgent
  await page.getByLabel('Priority filter').click();
  await page.getByRole('menuitemradio', { name: 'URGENT' }).click();

  // Todo column should show urgent todo task
  await expect(page.getByRole('button', { name: 'Urgent todo task' })).toBeVisible();

  // Doing column should show urgent doing task
  await expect(page.getByRole('button', { name: 'Urgent doing task' })).toBeVisible();

  // High priority task should not be visible
  await expect(page.getByRole('button', { name: 'High doing task' })).toHaveCount(0);
});

test('priority filter works on backlog view', async ({ page }) => {
  const now = new Date().toISOString();
  const tasks = [
    {
      id: 'task-urgent',
      title: 'Critical bug',
      status: 'open',
      statusChangedAt: now,
      priority: 'urgent',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-low',
      title: 'Minor cleanup',
      status: 'open',
      statusChangedAt: now,
      priority: 'low',
      archivedAt: null,
      blocked: false,
      tags: []
    }
  ];

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);

    if (method === 'GET' && isCollection) {
      const priority = url.searchParams.get('priority');
      let visible = tasks.filter((task) => !task.archivedAt);
      if (priority) {
        visible = visible.filter((task) => task.priority === priority);
      }
      await route.fulfill({ json: { data: visible } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();

  // Both tasks visible initially
  await expect(page.getByRole('button', { name: 'Critical bug' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minor cleanup' })).toBeVisible();

  // Filter to urgent
  await page.getByLabel('Priority filter').click();
  await page.getByRole('menuitemradio', { name: 'URGENT' }).click();

  // Only urgent task visible
  await expect(page.getByRole('button', { name: 'Critical bug' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Minor cleanup' })).toHaveCount(0);
});
