import { expect, test } from '@playwright/test';

const ASSIGNEE_OPTIONS = ['Quinn', 'Rowan', 'Lox', 'Tom'];

function mockTasks(tasks) {
  return async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);
    const idMatch = url.pathname.match(/\/tasks\/([^/]+)$/);

    if (method === 'GET' && isCollection) {
      let filtered = tasks.filter((t) => !t.archivedAt);

      const assignee = url.searchParams.get('assignee');
      if (assignee === 'unassigned') {
        filtered = filtered.filter((t) => !t.assignee);
      } else if (assignee) {
        filtered = filtered.filter(
          (t) => t.assignee?.toLowerCase() === assignee.toLowerCase()
        );
      }

      const status = url.searchParams.get('status');
      if (status) {
        const statuses = status.split(',').map((value) => value.trim()).filter(Boolean);
        filtered = filtered.filter((t) => statuses.includes(t.status));
      }

      const priority = url.searchParams.get('priority');
      if (priority) {
        filtered = filtered.filter((t) => t.priority === priority);
      }

      const q = url.searchParams.get('q');
      if (q) {
        const lower = q.toLowerCase();
        filtered = filtered.filter((t) => t.title.toLowerCase().includes(lower));
      }

      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      if (includeArchived) {
        filtered = tasks.filter((t) => {
          let match = true;
          if (assignee === 'unassigned') match = match && !t.assignee;
          else if (assignee) match = match && t.assignee?.toLowerCase() === assignee.toLowerCase();
          if (status) {
            const statuses = status.split(',').map((value) => value.trim()).filter(Boolean);
            match = match && statuses.includes(t.status);
          }
          return match;
        });
      }

      await route.fulfill({ json: { data: filtered } });
      return;
    }

    if (method === 'PATCH' && idMatch) {
      const id = idMatch[1];
      const body = request.postDataJSON();
      const task = tasks.find((t) => t.id === id);
      if (task) {
        Object.assign(task, body);
        if (body.status) task.statusChangedAt = new Date().toISOString();
      }
      await route.fulfill({ json: { data: task } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  };
}

const baseTasks = [
  {
    id: 'task-quinn',
    title: 'Quinn task',
    status: 'open',
    statusChangedAt: new Date().toISOString(),
    priority: 'high',
    assignee: 'Quinn',
    archivedAt: null,
    blocked: false,
    tags: []
  },
  {
    id: 'task-rowan',
    title: 'Rowan task',
    status: 'ready',
    statusChangedAt: new Date().toISOString(),
    priority: 'medium',
    assignee: 'Rowan',
    archivedAt: null,
    blocked: false,
    tags: []
  },
  {
    id: 'task-lox',
    title: 'Lox task',
    status: 'doing',
    statusChangedAt: new Date().toISOString(),
    priority: 'low',
    assignee: 'Lox',
    archivedAt: null,
    blocked: false,
    tags: []
  },
  {
    id: 'task-tom',
    title: 'Tom task',
    status: 'open',
    statusChangedAt: new Date().toISOString(),
    priority: 'urgent',
    assignee: 'Tom',
    archivedAt: null,
    blocked: false,
    tags: []
  },
  {
    id: 'task-unassigned',
    title: 'Unassigned task',
    status: 'open',
    statusChangedAt: new Date().toISOString(),
    priority: 'medium',
    assignee: null,
    archivedAt: null,
    blocked: false,
    tags: []
  }
];

// AC1: Filter dropdown is visible in the filter bar
test('AC1: assignee filter dropdown is visible', async ({ page }) => {
  await page.route('**/api/v1/tasks**', mockTasks(baseTasks));
  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();

  const filterRow = page.locator('.filter-row');
  await expect(filterRow).toBeVisible();

  const assigneeTrigger = page.getByLabel('Assignee filter');
  await expect(assigneeTrigger).toBeVisible();
});

// AC2: Options include all assignees plus "All" and "Unassigned"
test('AC2: dropdown options include all assignees', async ({ page }) => {
  await page.route('**/api/v1/tasks**', mockTasks(baseTasks));
  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();

  const assigneeTrigger = page.getByLabel('Assignee filter');
  await expect(assigneeTrigger).toBeVisible();
  await assigneeTrigger.click();

  await expect(page.getByRole('menuitemradio', { name: 'ALL' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'UNASSIGNED' })).toBeVisible();

  for (const assignee of ASSIGNEE_OPTIONS) {
    await expect(page.getByRole('menuitemradio', { name: assignee.toUpperCase() })).toBeVisible();
  }

  await page.keyboard.press('Escape');
});

// AC4: Real-time filtering when assignee is selected
test('AC4: filtering happens in real-time', async ({ page }) => {
  await page.route('**/api/v1/tasks**', mockTasks(baseTasks));
  await page.goto('/');
  // Board view shows all statuses by default, no auto-filter

  // All tasks are visible
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rowan task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lox task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tom task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unassigned task' })).toBeVisible();

  // Select "Quinn" assignee
  const assigneeTrigger = page.getByLabel('Assignee filter');
  await assigneeTrigger.click();
  await page.getByRole('menuitemradio', { name: 'QUINN' }).click();

  // Only Quinn's task visible
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rowan task' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Lox task' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Tom task' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Unassigned task' })).toBeHidden();

  // Switch to "Unassigned"
  await assigneeTrigger.click();
  await page.getByRole('menuitemradio', { name: 'UNASSIGNED' }).click();
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Unassigned task' })).toBeVisible();
});

// AC3: Assignee filter combinable with other filters
test('AC3: combinable with other filters', async ({ page }) => {
  const mixedTasks = [
    {
      id: 'task-q-open',
      title: 'Quinn open task',
      status: 'open',
      statusChangedAt: new Date().toISOString(),
      priority: 'high',
      assignee: 'Quinn',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-q-ready',
      title: 'Quinn ready task',
      status: 'ready',
      statusChangedAt: new Date().toISOString(),
      priority: 'high',
      assignee: 'Quinn',
      archivedAt: null,
      blocked: false,
      tags: []
    },
    {
      id: 'task-r-open',
      title: 'Rowan open task',
      status: 'open',
      statusChangedAt: new Date().toISOString(),
      priority: 'medium',
      assignee: 'Rowan',
      archivedAt: null,
      blocked: false,
      tags: []
    }
  ];

  await page.route('**/api/v1/tasks**', mockTasks(mixedTasks));
  await page.goto('/');
  // Use board view (all statuses visible by default)

  const assigneeTrigger = page.getByLabel('Assignee filter');
  const statusTrigger = page.getByLabel('Status filter');

  // Filter by assignee "Quinn" first
  await assigneeTrigger.click();
  await page.getByRole('menuitemradio', { name: 'QUINN' }).click();
  await expect(page.getByRole('button', { name: 'Quinn open task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quinn ready task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rowan open task' })).toBeHidden();

  // Then also filter by status "open" — should show only Quinn's open task
  await statusTrigger.click();
  // Leave only "Open" selected.
  await page.getByRole('menuitemcheckbox', { name: 'Ready' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Doing' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Acceptance' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Quinn open task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quinn ready task' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Rowan open task' })).toBeHidden();
});

// AC5: Selecting "All" resets the assignee filter
test('AC5: selecting "All" resets assignee filter', async ({ page }) => {
  await page.route('**/api/v1/tasks**', mockTasks(baseTasks));
  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();

  // Select all statuses so all tasks are visible
  await page.getByLabel('Status filter').click();
  await page.getByRole('menuitemcheckbox', { name: 'All' }).click();
  await page.keyboard.press('Escape');

  const assigneeTrigger = page.getByLabel('Assignee filter');

  // Filter by "Rowan"
  await assigneeTrigger.click();
  await page.getByRole('menuitemradio', { name: 'ROWAN' }).click();
  await expect(page.getByRole('button', { name: 'Rowan task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeHidden();

  // Reset to "All"
  await assigneeTrigger.click();
  await page.getByRole('menuitemradio', { name: 'ALL' }).click();
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rowan task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lox task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tom task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unassigned task' })).toBeVisible();
});

// AC6: Filter state persists across view switches (board/backlog)
test('AC6: filter state persists across view switches', async ({ page }) => {
  await page.route('**/api/v1/tasks**', mockTasks(baseTasks));
  await page.goto('/');

  // Start in board view, set assignee filter
  const assigneeTrigger = page.getByLabel('Assignee filter');
  await assigneeTrigger.click();
  await page.getByRole('menuitemradio', { name: 'LOX' }).click();
  await expect(page.getByRole('button', { name: 'Lox task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeHidden();

  // Switch to backlog view
  await page.getByRole('button', { name: 'Backlog' }).click();

  // Select all statuses so all tasks show
  await page.getByLabel('Status filter').click();
  await page.getByRole('menuitemcheckbox', { name: 'All' }).click();
  await page.keyboard.press('Escape');

  // Assignee filter should still be set to "Lox"
  await expect(assigneeTrigger).toContainText('ASSIGNEE: LOX');
  await expect(page.getByRole('button', { name: 'Lox task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Quinn task' })).toBeHidden();

  // Switch back to board view
  await page.getByRole('button', { name: 'Kanban' }).click();

  // Filter should still be "Lox"
  await expect(assigneeTrigger).toContainText('ASSIGNEE: LOX');
});
