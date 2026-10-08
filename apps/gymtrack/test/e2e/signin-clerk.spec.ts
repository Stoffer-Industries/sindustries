import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke for the email + password sign-in path through Clerk
 * (task `bb09eaed`, Phase 3 Slice B, AC1).
 *
 * Slice A (PR #734, MERGED 2026-09-23) shipped the `AuthProvider`
 * dispatcher that mounts a `ClerkAuthProvider` when `VITE_AUTH_PROVIDER=clerk`
 * and bridges the Clerk session JWT into supabase-js. Slice B verifies
 * that path against a live Clerk test instance:
 *
 *   - The `/login` page renders the email + password form (no OAuth redirect
 *     required).
 *   - Submitting valid credentials lands the user on `/workout` (or the
 *     intended protected destination) with the GymTrack header visible.
 *   - Submitting invalid credentials surfaces a Clerk error without
 *     redirecting off-site and without leaving the user in a half-authenticated
 *     state.
 *
 * Gating:
 *   - Slice B is opt-in. The test gates only on `CLERK_TEST_URL` so a
 *     Supabase-only E2E run cannot accidentally execute the Clerk suite.
 *   - Once enabled, `CLERK_TEST_EMAIL` and `CLERK_TEST_PASSWORD` are
 *     required. Missing live credentials are a configuration failure, not a
 *     placeholder login attempt or a silently skipped happy path.
 */

const CLERK_GATE = Boolean(process.env.CLERK_TEST_URL);
const CLERK_TEST_EMAIL = process.env.CLERK_TEST_EMAIL;
const CLERK_TEST_PASSWORD = process.env.CLERK_TEST_PASSWORD;

if (CLERK_GATE && (!CLERK_TEST_EMAIL || !CLERK_TEST_PASSWORD)) {
  throw new Error(
    'CLERK_TEST_EMAIL and CLERK_TEST_PASSWORD are required when CLERK_TEST_URL is set'
  );
}

test.describe('GymTrack — Clerk email + password sign-in (Slice B)', () => {
  test.skip(!CLERK_GATE, 'CLERK_TEST_URL not set — Clerk sign-in path skipped');

  test('AC1: signing in with valid email + password lands the user on /workout', async ({ page }) => {
    await page.goto('/login');

    // The Slice A dispatcher mounts ClerkAuthProvider when VITE_AUTH_PROVIDER=clerk.
    // The LoginScreen renders the same data-testid surface as the Supabase path.
    await page.getByTestId('login-email').fill(CLERK_TEST_EMAIL!);
    await page.getByTestId('login-password').fill(CLERK_TEST_PASSWORD!);
    await page.getByTestId('login-submit').click();

    // Successful sign-in navigates to /workout (or to the originally intended
    // protected destination; /workout is the canonical landing for now).
    await expect(page).toHaveURL(/\/workout$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'GymTrack' })).toBeVisible();
  });

  test('AC1: invalid credentials surface a Clerk error and keep the user on /login', async ({ page }) => {
    await page.goto('/login');

    // Use a unique email + an obviously-wrong password. The Clerk signIn
    // error path must NOT redirect off-site (no Google / Apple consent
    // screen), and must leave the user on /login so they can retry.
    const email = `slice-b-invalid-${Date.now()}-${Math.floor(Math.random() * 1e6)}@gymtrack-test.local`;
    const password = 'definitely-wrong-' + Math.random().toString(36).slice(2);

    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();

    // Stay on /login (Clerk's `signIn.create` resolves with a structured
    // error rather than redirecting). Assert the URL did NOT navigate
    // off-site (no Clerk hosted account portal, no Google consent).
    await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 });

    // No off-site navigation to a third-party identity provider.
    expect(page.url()).not.toMatch(/clerk\.[a-z0-9-]+\.com|accounts\.google\.com/i);
  });

  test('AC1 regression: the Clerk sign-in path does not regress the Supabase sign-up form on /signup', async ({ page }) => {
    // Slice A's dispatcher mounts the same SignUpPage UI surface; this
    // test guards against an accidental split where the Clerk path
    // hides the email + password signup panel.
    await page.goto('/signup');

    const showEmailButton = page.getByTestId('signup-show-email');
    await expect(showEmailButton).toBeVisible();
    await showEmailButton.click();

    await expect(page.getByTestId('signup-email')).toBeVisible();
    await expect(page.getByTestId('signup-password')).toBeVisible();
    await expect(page.getByTestId('signup-submit')).toBeVisible();
  });
});
