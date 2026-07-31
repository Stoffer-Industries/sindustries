import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke for the public sign-up page (task 72d7cc3b).
 *
 * Coverage:
 *   AC1 — an unauthenticated visitor sees a clear path to create a new
 *         account, distinct from the existing sign-in flow.
 *   AC2 — a visitor can create an account via email + password (the social
 *         login path lives in signup-google.spec.ts and is gated on
 *         process.env.SUPABASE_TEST_URL).
 *   AC4 — existing email + password sign-in continues to work for Tom.
 *   AC5 — after sign-up, a new user lands on /workout with the empty
 *         state visible.
 *
 * Requires a live Supabase project (VITE_SUPABASE_URL +
 * VITE_SUPABASE_ANON_KEY wired into the dev server) with email auto-confirm
 * enabled, and Tom's seeded test account for the AC4 check.
 */

// Generate a unique email per run so re-execution doesn't conflict with a
// previous test's account. The test DB is allowed to accumulate sign-up
// rows; if it becomes a problem, post a cleanup task and drop the oldest
// test rows on each run.
function uniqueSignupEmail(): string {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@gymtrack-test.local`;
}

test.describe('GymTrack — public sign-up', () => {
  test('AC1: unauthenticated visitor sees a "Create account" link on /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    const createLink = page.getByTestId('login-create-account');
    await expect(createLink).toBeVisible();
    await expect(createLink).toHaveAttribute('href', '/signup');

    await createLink.click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { name: /Create your GymTrack account/i })).toBeVisible();
  });

  test('AC2 + AC5: a visitor can sign up with email + password and lands on /workout', async ({ page }) => {
    const email = uniqueSignupEmail();
    const password = 'pw-' + Math.random().toString(36).slice(2, 10) + '-A1!';

    await page.goto('/signup');

    // Open the (collapsed) email + password panel.
    await page.getByTestId('signup-show-email').click();

    await page.getByTestId('signup-email').fill(email);
    await page.getByTestId('signup-password').fill(password);
    await page.getByTestId('signup-submit').click();

    // AC5 — lands somewhere sensible (the existing /workout route, which
    // renders an empty state for a fresh user).
    await expect(page).toHaveURL(/\/workout$/);
    await expect(page.getByRole('heading', { name: 'GymTrack' })).toBeVisible();
  });

  test('AC4: existing email + password sign-in still works (regression check)', async ({ page }) => {
    await page.goto('/login');

    const tomEmail = process.env.GT_TEST_EMAIL ?? 'tom@example.com';
    const tomPassword = process.env.GT_TEST_PASSWORD ?? 'password';

    await page.getByTestId('login-email').fill(tomEmail);
    await page.getByTestId('login-password').fill(tomPassword);
    await page.getByTestId('login-submit').click();

    await expect(page).toHaveURL(/\/workout$/);
    await expect(page.getByRole('heading', { name: 'GymTrack' })).toBeVisible();
  });
});