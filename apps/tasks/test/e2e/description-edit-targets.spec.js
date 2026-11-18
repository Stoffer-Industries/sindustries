import { expect, test } from '@playwright/test';

const DESCRIPTION = [
  'Plain description paragraph.',
  '',
  '- [ ] first AC',
  '- [x] second AC',
  '',
  'See [the spec](https://example.com/spec).',
].join('\n');

test('description hit targets: AC row toggles, modifier-click opens the link, plain text still edits', async ({ page, context }) => {
  const task = {
    id: 'task-hit-targets',
    title: 'Hit target task',
    description: DESCRIPTION,
    status: 'ready',
    statusChangedAt: new Date().toISOString(),
    priority: 'medium',
    archivedAt: null,
    blocked: false,
    tags: [],
    taskType: 'code',
    approvals: [],
    comments: []
  };
  const patches = [];

  // Serve the external spec locally so the new tab opens without real network.
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>spec</body></html>' })
  );

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const idMatch = url.pathname.match(/\/tasks\/([^/]+)$/);

    if (method === 'GET' && /\/auth\/session$/.test(url.pathname)) {
      await route.fulfill({ status: 401, json: { error: { message: 'Unauthenticated' } } });
      return;
    }
    if (method === 'GET' && /\/task-types\/[^/]+\/required-approvals$/.test(url.pathname)) {
      await route.fulfill({
        json: { data: { taskType: 'code', requiredApprovals: ['qa_agent'], version: 1, source: 'builtin-default' } }
      });
      return;
    }
    if (method === 'GET' && /\/tasks$/.test(url.pathname)) {
      await route.fulfill({ json: { data: [task] } });
      return;
    }
    if (method === 'GET' && idMatch) {
      await route.fulfill({ json: { data: task } });
      return;
    }
    if (method === 'PATCH' && idMatch) {
      const body = request.postDataJSON();
      patches.push(body);
      Object.assign(task, body);
      await route.fulfill({ json: { data: task } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Hit target task' }).first().click();

  const preview = page.locator('.description-preview');
  await expect(preview).toBeVisible();

  // AC1: clicking the acceptance-criteria row toggles the criterion and never
  // enters inline text edit mode.
  await preview.locator('li').first().click();
  await expect.poll(() => patches.at(-1)?.description).toContain('- [x] first AC');
  await expect(page.getByLabel('Detail description')).toHaveCount(0);

  // AC2: modifier-clicking a URL must not enter inline text edit mode, and the
  // classifier must not cancel the browser default — that cancellation is what
  // would suppress the browser's own "open in a new tab" behaviour.
  //
  // The new tab itself is deliberately NOT asserted here: headless Chromium
  // does not implement modifier-click new-tab navigation (verified with a
  // standalone probe — no `popup` event fires), so asserting it would make
  // this spec fail in CI for a browser limitation rather than a defect. What
  // is asserted is the cause: the click was not default-prevented, so a real
  // browser performs its native navigation.
  await page.evaluate(() => {
    window.__linkClick = null;
    // React delegates its listeners to the root container, and this listener
    // is added afterwards, so it observes the state AFTER the classifier ran.
    document.getElementById('root').addEventListener('click', (event) => {
      window.__linkClick = { defaultPrevented: event.defaultPrevented };
    });
  });

  await preview.locator('a[href]').click({ modifiers: ['ControlOrMeta'] });

  await expect.poll(() => page.evaluate(() => window.__linkClick)).toEqual({ defaultPrevented: false });
  await expect(page.getByLabel('Detail description')).toHaveCount(0);
  // The current page must not have navigated away either.
  await expect(page).toHaveURL(/127\.0\.0\.1:4173/);

  // AC3: plain description text still enters inline text edit mode.
  await preview.locator('p').first().click();
  await expect(page.getByLabel('Detail description')).toBeVisible();
});
