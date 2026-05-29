import { expect, test } from '@playwright/test';

test('happy path: create task, move to doing, archive', async ({ page }) => {
  const title = `Created in e2e ${Date.now()}`;
  const now = new Date().toISOString();
  const tasks = [
    {
      id: 'task-1',
      title: 'Task 1',
      status: 'ready',
      statusChangedAt: now,
      priority: 'medium',
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
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      const visible = includeArchived ? tasks : tasks.filter((task) => !task.archivedAt);
      await route.fulfill({ json: { data: visible } });
      return;
    }

    if (method === 'POST' && isCollection) {
      const body = request.postDataJSON();
      const created = {
        id: `task-${Date.now()}`,
        title: body.title,
        description: body.description ?? null,
        status: 'ready',
        statusChangedAt: new Date().toISOString(),
        priority: body.priority ?? 'medium',
        assignee: body.assignee ?? null,
        dueAt: body.dueAt ?? null,
        blocked: body.blocked ?? false,
        tags: (body.tags ?? []).map((tag) => ({ name: tag })),
        archivedAt: null
      };
      tasks.push(created);
      await route.fulfill({ json: { data: created } });
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

    if (method === 'DELETE' && idMatch) {
      const id = idMatch[1];
      const task = tasks.find((entry) => entry.id === id);
      if (task) task.archivedAt = new Date().toISOString();
      await route.fulfill({ json: { data: task } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '+ New Task' }).click();
  await page.getByLabel('New task title').fill(title);
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('button', { name: title })).toBeVisible();

  await page.getByRole('button', { name: 'Kanban' }).click();

  const card = page.locator('[data-testid^="card-"]', { hasText: title });
  await expect(card).toBeVisible();

  const cardId = await card.getAttribute('data-testid');
  const doing = page.getByTestId('column-doing');
  await card.dragTo(doing);

  await expect(page.getByTestId(cardId)).toBeVisible();

  await page.getByRole('button', { name: title }).first().click();
  await page.getByRole('button', { name: 'Archive task' }).click();

  await expect(page.getByRole('button', { name: title })).toHaveCount(0);
});

test('archived filter stays right-aligned on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/tasks**', async (route) => {
    await route.fulfill({
      json: {
        data: [
          {
            id: 'task-1',
            title: 'Task 1',
            status: 'ready',
            statusChangedAt: new Date().toISOString(),
            priority: 'medium',
            archivedAt: null,
            blocked: false,
            tags: []
          }
        ]
      }
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();

  const filterPanel = page.locator('.filter-row');
  const archivedToggle = page.getByRole('button', { name: 'Show archived' });

  await expect(filterPanel).toBeVisible();
  await expect(archivedToggle).toBeVisible();

  const panelBox = await filterPanel.boundingBox();
  const toggleBox = await archivedToggle.boundingBox();

  expect(panelBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox.x + toggleBox.width).toBeGreaterThan(panelBox.x + panelBox.width - 24);
});

test('happy path: create and render a task comment', async ({ page }) => {
  const createdAt = new Date().toISOString();
  const tasks = [
    {
      id: 'task-with-comments',
      title: 'Comment target',
      description: 'Used for comment e2e coverage',
      status: 'ready',
      statusChangedAt: createdAt,
      priority: 'medium',
      archivedAt: null,
      blocked: false,
      tags: [],
      comments: []
    }
  ];

  await page.route('**/api/v1/tasks**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isCollection = /\/tasks$/.test(url.pathname);
    const detailMatch = url.pathname.match(/\/tasks\/([^/]+)$/);
    const commentMatch = url.pathname.match(/\/tasks\/([^/]+)\/comments$/);

    if (method === 'GET' && isCollection) {
      await route.fulfill({ json: { data: tasks.map(({ comments, ...task }) => task) } });
      return;
    }

    if (method === 'GET' && detailMatch && !commentMatch) {
      const [, taskId] = detailMatch;
      const task = tasks.find((entry) => entry.id === taskId);
      await route.fulfill({ json: { data: task } });
      return;
    }

    if (method === 'POST' && commentMatch) {
      const [, taskId] = commentMatch;
      const body = request.postDataJSON();
      const task = tasks.find((entry) => entry.id === taskId);
      const comment = {
        id: `comment-${Date.now()}`,
        author: body.author,
        text: body.text,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (task) task.comments = [...(task.comments ?? []), comment];
      await route.fulfill({ status: 201, json: { data: comment } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Backlog' }).click();
  await page.getByRole('button', { name: 'Comment target' }).click();

  await expect(page.getByRole('heading', { name: 'Comments' })).toBeVisible();
  await expect(page.getByText('No comments yet')).toBeVisible();

  const toggleButton = page.getByRole('button', { name: 'Comment', exact: true });
  await expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  await toggleButton.click();
  await expect(page.locator('button[aria-controls="task-comment-composer"]')).toHaveAttribute('aria-expanded', 'true');

  await page.getByLabel('Comment author').fill('Rowan');
  await page.getByLabel('Comment text').fill('E2E comment path works.');
  await page.getByRole('button', { name: 'Add comment' }).click();

  const commentsList = page.getByRole('list', { name: 'Task comments' });
  await expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
  await expect(commentsList.getByText('Rowan')).toBeVisible();
  await expect(commentsList.getByText('E2E comment path works.')).toBeVisible();
  await expect(commentsList.locator('.comment-meta time')).toBeVisible();
});
