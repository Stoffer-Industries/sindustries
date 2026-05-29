import { expect, test } from '@playwright/test';

const RESERVED_ASSIGNEES = ['Tom', 'Quinn', 'Rowan', 'Lox'];

test('AC2: assignee dropdown shows reserved options', async ({ page }) => {
  const tasks = [
    {
      id: 'task-1',
      title: 'Test Task',
      status: 'ready',
      statusChangedAt: new Date().toISOString(),
      priority: 'medium',
      assignee: null,
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
      await route.fulfill({ json: { data: tasks } });
      return;
    }
  });

  await page.goto('/');
  
  // Click on the task to open the editor
  await page.getByRole('button', { name: 'Test Task' }).click();
  
  // Find the assignee dropdown
  const assigneeSelect = page.locator('select[aria-label="Detail assignee"]');
  await expect(assigneeSelect).toBeVisible();
  
  // Check all options are present (4 reserved + 1 Unassigned = 5)
  const options = assigneeSelect.locator('option');
  await expect(options).toHaveCount(5);
  
  // Verify options contain expected values by getting all text
  const allOptionsText = await options.allTextContents();
  expect(allOptionsText).toContain('Unassigned');
  expect(allOptionsText).toContain('Tom');
  expect(allOptionsText).toContain('Quinn');
  expect(allOptionsText).toContain('Rowan');
  expect(allOptionsText).toContain('Lox');
});

test('AC3: can select assignee from dropdown', async ({ page }) => {
  const tasks = [
    {
      id: 'task-1',
      title: 'Test Task 2',
      status: 'ready',
      statusChangedAt: new Date().toISOString(),
      priority: 'medium',
      assignee: null,
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
      await route.fulfill({ json: { data: tasks } });
      return;
    }
  });

  await page.goto('/');
  
  // Click on the task to open the editor
  await page.getByRole('button', { name: 'Test Task 2' }).click();
  
  // Find the assignee dropdown
  const assigneeSelect = page.locator('select[aria-label="Detail assignee"]');
  
  // Select "Quinn"
  await assigneeSelect.selectOption('Quinn');
  
  // Verify selection
  await expect(assigneeSelect).toHaveValue('Quinn');
});
