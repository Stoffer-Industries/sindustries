import { expect, test } from '@playwright/test';

test('approval checkboxes approve, revoke, reconcile, and roll back failures', async ({ page }) => {
  const task = {
    id: 'approval-task', title: 'Approval target', description: '', status: 'ready',
    statusChangedAt: new Date().toISOString(), priority: 'medium', archivedAt: null,
    blocked: false, tags: [], taskType: 'feature', approvals: [], comments: []
  };
  let failNextApproval = false;
  let signedIn = false;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && /\/auth\/session$/.test(url.pathname)) {
      await route.fulfill(signedIn
        ? { json: { data: { actor: 'Tom', approvalTypes: ['spec', 'qa'] } } }
        : { status: 401, json: { error: { message: 'Unauthenticated' } } });
      return;
    }
    if (method === 'POST' && /\/auth\/session$/.test(url.pathname)) {
      expect(request.postDataJSON()).toEqual({ username: 'tom', password: 'test-password' });
      signedIn = true;
      await route.fulfill({ json: { data: { actor: 'Tom', approvalTypes: ['spec', 'qa'] } } });
      return;
    }
    if (method === 'DELETE' && /\/auth\/session$/.test(url.pathname)) {
      signedIn = false;
      await route.fulfill({ json: { data: null } });
      return;
    }
    if (method === 'GET' && /\/task-types\/feature\/required-approvals$/.test(url.pathname)) {
      await route.fulfill({ json: { data: { taskType: 'feature', requiredApprovals: ['spec'], version: 1, source: 'builtin-default' } } });
      return;
    }
    if (method === 'GET' && /\/tasks$/.test(url.pathname)) {
      await route.fulfill({ json: { data: [task] } });
      return;
    }
    if (method === 'GET' && /\/tasks\/approval-task$/.test(url.pathname)) {
      await route.fulfill({ json: { data: task } });
      return;
    }
    if (method === 'POST' && /\/tasks\/approval-task\/approvals$/.test(url.pathname)) {
      expect(request.postDataJSON()).toEqual({ type: 'spec' });
      if (failNextApproval) {
        failNextApproval = false;
        await route.fulfill({ status: 403, json: { error: { message: 'Approval denied' } } });
        return;
      }
      const approval = {
        id: 'approval-1', type: 'spec', owner: 'Tom', state: 'approved',
        approvedAt: new Date().toISOString(), revokedAt: null, note: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      task.approvals = [approval];
      task.comments.push({ id: 'audit-1', author: 'Tom', text: 'Approval spec approved by Tom.', createdAt: new Date().toISOString() });
      await route.fulfill({ json: { data: approval } });
      return;
    }
    if (method === 'DELETE' && /\/tasks\/approval-task\/approvals\/spec$/.test(url.pathname)) {
      task.approvals = [{ ...task.approvals[0], state: 'revoked', revokedAt: new Date().toISOString() }];
      await route.fulfill({ json: { data: task.approvals[0] } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Approval target' }).first().click();
  const checkbox = page.getByRole('checkbox', { name: 'Spec approval' });

  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeEnabled();
  // Initial click while unauthenticated — opens the login modal and rolls back
  // the optimistic check. Use .click() instead of .check() because the rollback
  // intentionally leaves the box unchecked between the click and the re-attempt
  // triggered by the login flow; the strict .check() helper would time out
  // waiting for the box to settle as checked during that interim state.
  await checkbox.click();
  await page.getByLabel('Username').fill('tom');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as Tom')).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(page.getByText('Approval spec approved by Tom.')).toBeVisible();

  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();

  failNextApproval = true;
  // Same swap for the forced-403 rollback path: .click() lets the optimistic
  // state advance briefly and then roll back to unchecked when the server
  // denies; the strict .check() helper would not tolerate that interim state.
  await checkbox.click();
  await expect(page.getByRole('alert')).toContainText('Approval denied');
  await expect(checkbox).not.toBeChecked();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Sign in to change approvals')).toBeVisible();
});
