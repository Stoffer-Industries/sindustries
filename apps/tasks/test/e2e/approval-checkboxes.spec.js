import { expect, test } from '@playwright/test';

// The Clerk boundary retired the password-backed session, so this spec no
// longer drives a sign-in form. The harness establishes the session up front:
// the app is mounted with the test-only session seam (see
// apps/tasks/src/auth/e2eSession.js) and the API session is stubbed as an
// already-signed-in actor, which is what the approval controls now require.
test('approval checkboxes approve, revoke, reconcile, and roll back failures', async ({ page }) => {
  const task = {
    id: 'approval-task', title: 'Approval target', description: '', status: 'ready',
    statusChangedAt: new Date().toISOString(), priority: 'medium', archivedAt: null,
    blocked: false, tags: [], taskType: 'feature', approvals: [], comments: []
  };
  let failNextApproval = false;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && /\/auth\/session$/.test(url.pathname)) {
      await route.fulfill({
        json: {
          data: {
            actor: 'Tom',
            displayName: 'Tom',
            approvalTypes: ['spec', 'tech_design', 'qa_agent', 'accepted']
          }
        }
      });
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
  await expect(page.getByText('Signed in as Tom')).toBeVisible();

  // The session already exists, so the first click approves straight away.
  // Use .click() instead of .check() because the optimistic state is rolled
  // back by a rejected request, and the strict .check() helper would time out
  // waiting for the box to settle as checked during that interim state.
  await checkbox.click();
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
});
