import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    Clerk: {
      loaded: boolean;
      client: {
        signIn: {
          create(params: { strategy: 'ticket'; ticket: string }): Promise<{ createdSessionId: string }>;
        };
      };
      setActive(params: { session: string }): Promise<void>;
    };
  }
}

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

const CLERK_TEST_URL = process.env.CLERK_TEST_URL;
const CLERK_GATE = Boolean(CLERK_TEST_URL);
const CLERK_TEST_EMAIL = process.env.CLERK_TEST_EMAIL;
const CLERK_TEST_PASSWORD = process.env.CLERK_TEST_PASSWORD;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

if (CLERK_GATE && (!CLERK_TEST_EMAIL || !CLERK_TEST_PASSWORD || !CLERK_SECRET_KEY)) {
  throw new Error(
    'CLERK_TEST_EMAIL, CLERK_TEST_PASSWORD, and CLERK_SECRET_KEY are required when CLERK_TEST_URL is set'
  );
}

async function createSignInTicket() {
  const headers = { Authorization: `Bearer ${CLERK_SECRET_KEY}` };
  const usersResponse = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(CLERK_TEST_EMAIL!)}&limit=1`,
    { headers }
  );
  expect(usersResponse.ok).toBe(true);
  const usersPayload = await usersResponse.json();
  const users = Array.isArray(usersPayload) ? usersPayload : usersPayload.data;
  expect(users).toHaveLength(1);

  const tokenResponse = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: users[0].id, expires_in_seconds: 300 })
  });
  expect(tokenResponse.ok).toBe(true);
  const token = await tokenResponse.json();
  return token.token as string;
}

async function signInWithTicket(page: Page) {
  const ticket = await createSignInTicket();
  await page.goto('/login');
  await page.waitForFunction(() => window.Clerk?.loaded);
  await page.evaluate(async (signInTicket) => {
    const attempt = await window.Clerk.client.signIn.create({
      strategy: 'ticket',
      ticket: signInTicket
    });
    await window.Clerk.setActive({ session: attempt.createdSessionId });
  }, ticket);
  await page.goto('/workout');
}

test.describe('GymTrack — Clerk email + password sign-in (Slice B)', () => {
  test.skip(!CLERK_GATE, 'CLERK_TEST_URL not set — Clerk sign-in path skipped');

  test('AC1: valid password sign-in completes or presents the client-trust email code step', async ({ page }) => {
    await page.goto('/login');

    // The Slice A dispatcher mounts ClerkAuthProvider when VITE_AUTH_PROVIDER=clerk.
    // The LoginScreen renders the same data-testid surface as the Supabase path.
    await page.getByTestId('login-email').fill(CLERK_TEST_EMAIL!);
    await page.getByTestId('login-password').fill(CLERK_TEST_PASSWORD!);
    await page.getByTestId('login-submit').click();

    await expect
      .poll(async () => {
        if (/\/workout$/.test(page.url())) return 'complete';
        if (await page.getByTestId('login-verification-code').isVisible().catch(() => false)) {
          return 'client-trust';
        }
        return 'pending';
      }, { timeout: 15_000 })
      .toMatch(/complete|client-trust/);
    if (/\/login$/.test(page.url())) {
      await expect(page.getByText('We emailed you a verification code')).toBeVisible();
      await expect(page.getByTestId('login-verify-submit')).toBeEnabled();
      await expect(page.getByTestId('login-error')).not.toBeVisible();
    }
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

    const error = page.getByTestId('login-error');
    await expect(error).toBeVisible();
    await expect(error).not.toContainText('Additional sign-in steps required');
    await expect(error).not.toContainText('status=undefined');
    await expect(page.getByTestId('login-submit')).toBeEnabled();

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
    await expect(page.locator('#clerk-captcha')).toHaveCount(1);
  });

  test('AC1: email sign-up mounts CAPTCHA and settles instead of hanging', async ({ page }) => {
    await page.goto('/signup');
    await page.getByTestId('signup-show-email').click();

    await expect(page.locator('#clerk-captcha')).toHaveCount(1);
    await page.getByTestId('signup-email').fill(CLERK_TEST_EMAIL!);
    await page.getByTestId('signup-password').fill(CLERK_TEST_PASSWORD!);
    await page.getByTestId('signup-submit').click();

    // The dedicated Clerk test account already exists, so this exercises
    // CAPTCHA + request settlement without creating another production user.
    await expect(page.getByTestId('signup-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('signup-submit')).toBeEnabled();
    await expect(page.getByTestId('signup-submit')).toHaveText('Create account');
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('AC1: Google sign-in starts Clerk SSO without a client-side method error', async ({ page }) => {
    await page.goto('/login');

    await page.getByTestId('login-google').click();

    await expect(page.getByTestId('login-error')).not.toBeVisible();
    await page.waitForURL(
      (url) => url.origin !== new URL(CLERK_TEST_URL!).origin,
      { timeout: 15_000 }
    );
    expect(page.url()).not.toContain('authenticateWithRedirect');
  });
});

/**
 * End-to-end coverage for the Slice C verified-email linking flow
 * (task `bb09eaed`, Phase 4, AC3).
 *
 * After a successful Clerk sign-in, `apps/gymtrack/src/lib/clerkAuth.jsx`
 * fires a one-shot useEffect that calls
 * `supabase.rpc('link_clerk_user_to_profile', { p_clerk_user_id, p_email,
 * p_email_verified, p_signup_source })`. The RPC is `SECURITY DEFINER` and
 * idempotent: already-linked → return; legacy match by verified email →
 * set `clerk_user_id`; no match → fresh insert. The user never sees the
 * link — sign-in lands on `/workout` either way.
 *
 * This e2e asserts the *wiring* (browser → supabase-js → RPC URL +
 * params), not the RPC contract itself. The RPC contract is covered by
 * the Vitest unit test in `apps/gymtrack/src/lib/clerkPhase4Linking.test.js`,
 * which checks the migration SQL + `clerkAuth.jsx` against the source.
 * The e2e is the end-to-end reachability proof that the described flow
 * fires from a real Clerk session, which neither a unit test nor a
 * service integration test can give us.
 *
 * The RPC is intercepted with `page.route()` and fulfilled with a
 * canned "fresh insert" response so the test is reproducible without
 * a live Supabase test DB. The interception asserts the params the
 * browser actually sent (the part the unit test cannot).
 */
type SliceCLinkCall = {
  body: {
    p_clerk_user_id?: string;
    p_email?: string;
    p_email_verified?: boolean;
    p_signup_source?: string;
  };
};

test.describe('GymTrack — Clerk Slice C verified-email linking (Phase 4)', () => {
  test.skip(!CLERK_GATE, 'CLERK_TEST_URL not set — Slice C linking e2e skipped');

  test('AC1 Slice C: real Clerk sign-in invokes link_clerk_user_to_profile with the verified email + Clerk subject, then lands on /workout', async ({ page }) => {
    const rpcCalls: SliceCLinkCall[] = [];
    await page.route('**/rest/v1/rpc/link_clerk_user_to_profile', async (route) => {
      const request = route.request();
      let body: SliceCLinkCall['body'] = {};
      try {
        body = JSON.parse(request.postData() || '{}');
      } catch {
        // Body is not JSON — leave as empty object; assertion below will
        // surface the missing fields.
      }
      rpcCalls.push({ body });
      // Canned "fresh insert" response so the e2e is reproducible
      // without a live Supabase test DB. The shape mirrors the column
      // names of public.profiles that the function returns.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'profile-e2e-mock',
            clerk_user_id: body.p_clerk_user_id ?? null,
            email: body.p_email ?? null,
            signup_source: body.p_signup_source ?? null,
            linked_at: new Date().toISOString(),
            created_at: new Date().toISOString()
          }
        ])
      });
    });

    await signInWithTicket(page);

    // Slice C is silent for the user: the link RPC fires after the
    // sign-in lands on /workout. There is no loading state, no error
    // banner, and no extra UI step.
    await expect(page).toHaveURL(/\/workout$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'GymTrack' })).toBeVisible();

    // The Slice C useEffect must have invoked the link RPC at least
    // once. Asserting wiring + params here, not the RPC contract.
    expect(rpcCalls.length).toBeGreaterThan(0);
    const { body } = rpcCalls[0];
    // The Clerk subject is a `user_…` opaque id; not asserting a
    // specific value (it is environment-specific).
    expect(body.p_clerk_user_id).toMatch(/^user_/);
    // Email verification is a precondition for linking; the Clerk
    // test user must be configured with a verified email for this
    // e2e to exercise the happy path. A negative e2e for the
    // unverified-email rejection lives in
    // clerkPhase4Linking.test.js (Vitest unit, no live browser).
    expect(body.p_email_verified).toBe(true);
    // The function lowercases the email before lookup; the browser
    // sends the address as Clerk returns it, but the lookup is
    // case-insensitive per the migration assertion.
    expect(String(body.p_email).toLowerCase()).toBe(CLERK_TEST_EMAIL!.toLowerCase());
    // signup_source is the inferred provider; the four accepted
    // values are documented in clerkAuth.jsx.
    expect(['google', 'apple', 'email_password', 'clerk_first_login', 'clerk_import']).toContain(
      body.p_signup_source
    );
  });

  test('AC1 Slice C error tolerance: when the link RPC fails (e.g. unverified_email_cannot_link), sign-in still lands on /workout', async ({ page }) => {
    // Slice C must NOT block sign-in on link RPC errors. The useEffect
    // catches RPC failures and logs them; the next session change
    // retries (the function is idempotent, so the second call is a
    // cheap steady-state read).
    await page.route('**/rest/v1/rpc/link_clerk_user_to_profile', async (route) => {
      // Mirror the documented rejection shape so the test exercises
      // the real error path in clerkAuth.jsx, not just any 500.
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'P0001',
          message: 'unverified_email_cannot_link',
          details: null,
          hint: null
        })
      });
    });

    await signInWithTicket(page);

    // Sign-in must succeed even when the link RPC rejects the link.
    await expect(page).toHaveURL(/\/workout$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'GymTrack' })).toBeVisible();
  });
});
