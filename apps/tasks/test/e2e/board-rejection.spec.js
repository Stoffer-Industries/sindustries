import { expect, test } from '@playwright/test';

import { dragCardToColumn } from './helpers/dragCardToColumn.js';

// The Tasks API rejects a `doing` → `acceptance` transition with 409 when the
// structured `qa_agent` approval is missing or still pending. The message is
// built in `services/tasks-api/src/routes/tasks/_statusTransitions.ts`; this
// is that exact string, because the board contract is that the API's own
// message — not a generic failure — reaches the user.
const QA_APPROVAL_REQUIRED_MESSAGE =
  'Cannot move a task from `doing` to `acceptance`: the structured `qa_agent` approval is `pending`. ' +
  'Ash must approve the `qa_agent` gate before this task reaches acceptance.';

test('a rejected transition surfaces the API error and leaves the card in its original column', async ({ page }) => {
  const task = {
    id: 'gated-task',
    title: 'Gated transition task',
    description: '',
    status: 'doing',
    statusChangedAt: new Date().toISOString(),
    priority: 'medium',
    archivedAt: null,
    blocked: false,
    tags: [],
    taskType: 'feature',
    approvals: [
      {
        id: 'qa-row-1',
        type: 'qa_agent',
        owner: 'Ash',
        state: 'pending',
        approvedAt: null,
        revokedAt: null,
        note: null
      }
    ],
    comments: []
  };

  const attempted = [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());

    if (method === 'GET' && /\/auth\/session$/.test(url.pathname)) {
      await route.fulfill({ status: 401, json: { error: { message: 'Unauthenticated' } } });
      return;
    }
    if (method === 'GET' && /\/task-types\/feature\/required-approvals$/.test(url.pathname)) {
      await route.fulfill({
        json: {
          data: {
            taskType: 'feature',
            requiredApprovals: ['spec', 'tech_design', 'qa_agent', 'accepted'],
            version: 1,
            source: 'builtin-default'
          }
        }
      });
      return;
    }
    if (method === 'GET' && /\/tasks$/.test(url.pathname)) {
      await route.fulfill({ json: { data: [task] } });
      return;
    }
    if (method === 'GET' && /\/tasks\/gated-task$/.test(url.pathname)) {
      await route.fulfill({ json: { data: task } });
      return;
    }
    if (method === 'PATCH' && /\/tasks\/gated-task$/.test(url.pathname)) {
      attempted.push(request.postDataJSON());
      await route.fulfill({
        status: 409,
        json: { error: { code: 'QA_APPROVAL_REQUIRED', message: QA_APPROVAL_REQUIRED_MESSAGE } }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Kanban' }).click();

  // The task starts in the `doing` column.
  await expect(page.getByTestId('column-doing').getByTestId('card-gated-task')).toBeVisible();
  await expect(page.getByTestId('column-acceptance').getByTestId('card-gated-task')).toHaveCount(0);

  // Drag it into `acceptance`. The board issues the real PATCH; the API
  // rejects the transition and leaves the task in `doing`.
  //
  // The drag is dispatched deterministically (explicit `dragstart`/`dragover`/
  // `drop` sharing one `DataTransfer`) rather than through the browser's own
  // drag controller, which can deliver the drop before the card's `dragstart`
  // handler has written the payload.
  await dragCardToColumn(page, 'card-gated-task', 'column-acceptance');

  // The PATCH is intercepted by the route handler above, so the attempt is
  // recorded asynchronously — poll for it instead of asserting on a list that
  // may not have been written yet.
  await expect.poll(() => [...attempted]).toEqual([{ status: 'acceptance' }]);

  // The board surfaces the API's own message, so the user learns which gate
  // blocked the move and who has to clear it.
  const toast = page.locator('.toast-error');
  await expect(toast).toContainText('qa_agent');
  await expect(toast).toContainText('Ash must approve');

  // The card did not move: it is still in its original column and is absent
  // from the rejected one.
  await expect(page.getByTestId('column-doing').getByTestId('card-gated-task')).toBeVisible();
  await expect(page.getByTestId('column-acceptance').getByTestId('card-gated-task')).toHaveCount(0);
});
