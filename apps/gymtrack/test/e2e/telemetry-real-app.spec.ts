import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TELEMETRY_E2E_COMMIT_SHA } from './telemetry-env';

/**
 * Real-application telemetry resilience (task `8c3aa401`).
 *
 * The parent task `e89db27f` promises in AC3 that *export failure is
 * non-blocking and does not break sign-in, sign-up, navigation, or page
 * rendering*. Quinn's review of PR #970 found the delivered Playwright
 * evidence proved only the telemetry **module** and a static harness — a
 * page that calls `reportAuthError` directly and navigates by changing a
 * hash. It never drove the real application's auth or routing paths.
 *
 * These three cases close that gap against the **real running app**:
 *
 *   AC1 — a failed sign-in renders its inline error and leaves the auth
 *         flow usable, with the telemetry relay aborted.
 *   AC2 — a failed sign-up renders its inline error, with the relay aborted.
 *   AC3 — a real routed navigation and page render completes normally in
 *         the application with the relay aborted.
 *
 * WHAT MAKES THIS "REAL APPLICATION" AND NOT A HARNESS
 *
 *   The browser loads the real SPA: `src/main.jsx` → `src/App.jsx` →
 *   `src/lib/auth.jsx` → `src/lib/supabaseAuth.jsx` → the real
 *   `src/components/LoginScreen.jsx` / `SignUpPage.jsx`. The real
 *   `signIn` / `signUp` methods call the real `supabase.auth.*`. The real
 *   failure path runs: `supabaseAuth.jsx` fires `reportAuthError(...)` and
 *   `LoginScreen.jsx` renders `data-testid="login-error"`.
 *
 *   Only the **identity provider's HTTP boundary** is stubbed — the
 *   standard Playwright technique for any third-party API. No component is
 *   replaced and **this file imports no telemetry module and calls no
 *   telemetry function**; the only things it touches are the app's own
 *   routes and the network boundary. That is what AC4 asks to be able to
 *   claim.
 *
 *   The relay is aborted at the network layer (`route.abort('failed')`)
 *   rather than stubbed. That is the real failure mode AC3 names: the
 *   relay is unreachable, the `fetch` rejects, and the telemetry module's
 *   own catch path runs. The payload is read from the intercepted request
 *   body, so the assertions prove the browser *sent* the safe event even
 *   though the network then killed it.
 *
 * NO CREDENTIALS, NO LIVE IDENTITY PROVIDER
 *
 *   The provider's HTTP boundary is stubbed, so no real credential is used
 *   and no request reaches a real provider. `playwright.real-app.config.ts`
 *   pins `baseURL` to the local dev server and always starts it, so this
 *   suite cannot drift onto a deployed app even when `CLERK_TEST_URL` is
 *   set in the environment.
 */

const SUPABASE_HOST = 'telemetry-e2e.invalid';
const RELAY_GLOB = '**/api/telemetry';

/** Hosts this suite is allowed to contact: the local dev server and the stubbed provider. */
const ALLOWED_HOSTS = new Set(['localhost:5179', '127.0.0.1:5179', SUPABASE_HOST]);

type RelayEvent = {
  source: string;
  environment: string;
  release: string;
  route: string;
  operation: string;
  provider: string | null;
  errorCode: string | null;
  status: string | null;
  message: string | null;
  stack: string | null;
  timestamp: string;
};

type BoundaryState = {
  /** Every payload the browser sent to the relay, captured before the abort. */
  relayPayloads: RelayEvent[];
  /** How many relay requests were aborted (the relay was unreachable). */
  relayAborted: number;
  /** Requests that reached the provider host without a matching stub. */
  unstubbed: string[];
  /** Every host the browser contacted. */
  hosts: Set<string>;
  /** Uncaught exceptions in the page. */
  pageErrors: string[];
};

/* ------------------------------------------------------------------ *
 * Stub bodies
 * ------------------------------------------------------------------ */

/**
 * A JWT-shaped access token.
 *
 * `auth-js` reads the expiry from the token, so the payload carries a
 * real `exp`. It is unsigned and synthetic — nothing verifies it, and it
 * grants no access anywhere.
 */
function syntheticJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({
      sub: '11111111-2222-3333-4444-555555555555',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'telemetry-e2e@example.invalid',
      iat: now,
      exp: now + 3600,
      session_id: '66666666-7777-8888-9999-000000000000'
    }),
    'c2lnbmF0dXJl'
  ].join('.');
}

const TEST_USER = {
  id: '11111111-2222-3333-4444-555555555555',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'telemetry-e2e@example.invalid',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  phone: '',
  confirmed_at: '2026-01-01T00:00:00Z',
  last_sign_in_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z'
};

function sessionBody(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: syntheticJwt(),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'a-synthetic-refresh-token',
    user: TEST_USER
  };
}

/**
 * S1 — failed password grant.
 *
 * `auth-js` builds the error as
 * `new AuthApiError(data.msg, response.status, data.error_code)`, so the
 * HTTP status becomes `error.status` and `error_code` becomes
 * `error.code`. The body below therefore yields
 * `status === 400`, `code === 'invalid_credentials'` and the message
 * `Invalid login credentials`.
 */
const SIGNIN_FAILURE = {
  status: 400,
  body: {
    code: 400,
    error_code: 'invalid_credentials',
    msg: 'Invalid login credentials'
  }
};

/**
 * S2 — failed sign-up.
 *
 * GoTrue answers a duplicate registration with HTTP **422**, and
 * `auth-js` takes `error.status` from the HTTP status — so the stub has
 * to be 422 for the event to carry `status: '422'`. (The tech design's
 * stub table said 400 while its AC2 row asserted 422; the HTTP status is
 * the only thing that decides the field.)
 */
const SIGNUP_FAILURE = {
  status: 422,
  body: {
    code: 422,
    error_code: 'user_already_exists',
    msg: 'User already registered'
  }
};

/** S6 — a failing sign-out, used to exercise the relay from a real auth path. */
const SIGNOUT_FAILURE = {
  status: 400,
  body: { code: 400, msg: 'Session not found' }
};

/* ------------------------------------------------------------------ *
 * Network boundary
 * ------------------------------------------------------------------ */

/**
 * Install the whole network boundary.
 *
 * ROUTE ORDERING MATTERS: Playwright matches routes in **reverse
 * registration order**, so the most recently registered route has
 * priority. The catch-all must therefore be registered FIRST (lowest
 * priority) and the specific stubs LAST (highest priority). Registering
 * the catch-all last silently shadows every stub — which is exactly what
 * the first spike did, and why it saw the token request as "unstubbed".
 */
async function installBoundary(
  page: Page,
  options: { session?: 'success' } = {}
): Promise<BoundaryState> {
  const state: BoundaryState = {
    relayPayloads: [],
    relayAborted: 0,
    unstubbed: [],
    hosts: new Set<string>(),
    pageErrors: []
  };

  page.on('request', (request) => {
    try {
      state.hosts.add(new URL(request.url()).host);
    } catch {
      // A non-absolute URL cannot reach the network; nothing to record.
    }
  });

  page.on('pageerror', (error) => {
    state.pageErrors.push(error.message);
  });

  // --- priority 3 (lowest): catch-all for the provider host -------------
  // Anything to the provider that no stub claims is aborted and recorded.
  // An unstubbed request is a test defect, not a pass.
  await page.route(`**/*${SUPABASE_HOST}/**`, async (route) => {
    state.unstubbed.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort('failed');
  });

  // --- priority 2: the telemetry relay --------------------------------
  // The relay is dead in every case. The payload is captured BEFORE the
  // abort so the assertions can prove the browser sent the safe event.
  await page.route(RELAY_GLOB, async (route) => {
    const request = route.request();
    try {
      state.relayPayloads.push(request.postDataJSON() as RelayEvent);
    } catch {
      state.relayPayloads.push({ postData: request.postData() } as unknown as RelayEvent);
    }
    state.relayAborted += 1;
    await route.abort('failed');
  });

  // --- priority 1 (highest): the specific provider stubs ---------------
  if (options.session === 'success') {
    await page.route('**/auth/v1/token**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sessionBody())
      });
    });
    await page.route('**/auth/v1/user**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TEST_USER)
      });
    });
    await page.route('**/auth/v1/logout**', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify(SIGNOUT_FAILURE.body)
      });
    });
  } else {
    await page.route('**/auth/v1/token**', async (route) => {
      await route.fulfill({
        status: SIGNIN_FAILURE.status,
        contentType: 'application/json',
        body: JSON.stringify(SIGNIN_FAILURE.body)
      });
    });
    await page.route('**/auth/v1/signup**', async (route) => {
      await route.fulfill({
        status: SIGNUP_FAILURE.status,
        contentType: 'application/json',
        body: JSON.stringify(SIGNUP_FAILURE.body)
      });
    });
  }

  return state;
}

/**
 * Assert the fail-closed guard held: nothing outside the local dev
 * server and the stubbed provider was contacted.
 */
function expectNoEscapedNetwork(state: BoundaryState): void {
  for (const host of state.hosts) {
    expect(
      ALLOWED_HOSTS.has(host),
      `the browser contacted ${host}, which is neither the local dev server nor the stubbed provider`
    ).toBe(true);
  }
}

const SYNTHETIC_EMAIL = 'telemetry-e2e@example.invalid';
const WRONG_PASSWORD = 'definitely-not-the-password';

/* ------------------------------------------------------------------ *
 * AC1 — failed sign-in
 * ------------------------------------------------------------------ */

test('AC1: a failed sign-in renders inline and leaves the auth flow usable, with the relay aborted', async ({
  page
}) => {
  const state = await installBoundary(page);

  await page.goto('/login');
  await expect(page.getByTestId('login-form')).toBeVisible();

  await page.getByTestId('login-email').fill(SYNTHETIC_EMAIL);
  await page.getByTestId('login-password').fill(WRONG_PASSWORD);
  await page.getByTestId('login-submit').click();

  // The provider's message renders inline, exactly as it did before
  // telemetry existed — the user is not left on a blank page.
  const error = page.getByTestId('login-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Invalid login credentials');

  // The auth flow is not broken: the form is usable again and the user
  // has not lost what they typed.
  await expect(page.getByTestId('login-submit')).toBeEnabled();
  await expect(page.getByTestId('login-email')).toHaveValue(SYNTHETIC_EMAIL);

  // The relay was reached and killed. A test that never triggered
  // telemetry proves nothing about resilience.
  await expect.poll(() => state.relayAborted, { timeout: 10_000 }).toBeGreaterThan(0);

  const event = state.relayPayloads.find((e) => e.source === 'auth');
  expect(event, 'the browser sent no auth telemetry event to the relay').toBeTruthy();

  // The safe context reached the relay from a real failure.
  expect(event!.provider).toBe('supabase');
  expect(event!.operation).toBe('signin');
  expect(event!.errorCode).toBe('invalid_credentials');
  expect(event!.status).toBe('400');
  expect(event!.route).toBe('/login');

  // The build identifier: the dev server was started with a synthetic
  // VERCEL_GIT_COMMIT_SHA and no explicit VITE_RELEASE_TAG, so this is the
  // production resolution path — never the literal 'dev'.
  expect(event!.release).toBe(TELEMETRY_E2E_COMMIT_SHA);
  expect(event!.release).not.toBe('dev');

  // The redaction contract: the auth surface is context-only, so no
  // message, no stack, and certainly no address or password.
  expect(event!.message).toBeNull();
  expect(event!.stack).toBeNull();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(SYNTHETIC_EMAIL);
  expect(serialized).not.toContain(WRONG_PASSWORD);

  expect(state.pageErrors, 'the page raised an uncaught exception').toEqual([]);
  expectNoEscapedNetwork(state);
});

/* ------------------------------------------------------------------ *
 * AC2 — failed sign-up
 * ------------------------------------------------------------------ */

test('AC2: a failed sign-up renders inline, with the relay aborted', async ({ page }) => {
  const state = await installBoundary(page);

  await page.goto('/signup');
  // The email + password panel is collapsed behind an explicit control.
  await page.getByTestId('signup-show-email').click();
  await expect(page.getByTestId('signup-form')).toBeVisible();

  await page.getByTestId('signup-email').fill(SYNTHETIC_EMAIL);
  await page.getByTestId('signup-password').fill(WRONG_PASSWORD);
  await page.getByTestId('signup-submit').click();

  const error = page.getByTestId('signup-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('User already registered');

  // The form is usable again and the address the user typed survives.
  await expect(page.getByTestId('signup-submit')).toBeEnabled();
  await expect(page.getByTestId('signup-email')).toHaveValue(SYNTHETIC_EMAIL);

  await expect.poll(() => state.relayAborted, { timeout: 10_000 }).toBeGreaterThan(0);

  const event = state.relayPayloads.find((e) => e.source === 'auth');
  expect(event, 'the browser sent no auth telemetry event to the relay').toBeTruthy();
  expect(event!.provider).toBe('supabase');
  expect(event!.operation).toBe('signup');
  expect(event!.errorCode).toBe('user_already_exists');
  expect(event!.status).toBe('422');
  expect(event!.route).toBe('/signup');
  expect(event!.release).toBe(TELEMETRY_E2E_COMMIT_SHA);
  expect(event!.release).not.toBe('dev');

  expect(event!.message).toBeNull();
  expect(event!.stack).toBeNull();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(SYNTHETIC_EMAIL);
  expect(serialized).not.toContain(WRONG_PASSWORD);

  expect(state.pageErrors, 'the page raised an uncaught exception').toEqual([]);
  expectNoEscapedNetwork(state);
});

/* ------------------------------------------------------------------ *
 * AC3 — real routed navigation
 * ------------------------------------------------------------------ */

test('AC3: a real routed navigation and page render completes normally in the application, with the relay aborted', async ({
  page
}) => {
  // The Step-1 spike established that `auth-js` accepts a stubbed GoTrue
  // session, so the strongest form of AC3 is available: an AUTHENTICATED
  // routed navigation into an `AuthGate`-protected route, performed by
  // clicking the app's own `<Link>` — not `page.goto()`, not a hash
  // change, not the static harness.
  const state = await installBoundary(page, { session: 'success' });

  await page.goto('/login');
  await expect(page.getByTestId('login-form')).toBeVisible();

  await page.getByTestId('login-email').fill(SYNTHETIC_EMAIL);
  await page.getByTestId('login-password').fill(WRONG_PASSWORD);
  await page.getByTestId('login-submit').click();

  // The stubbed session is accepted and the app lands on the
  // `AuthGate`-protected `/workout` route, which renders real content.
  await expect(page).toHaveURL(/\/workout$/, { timeout: 15_000 });
  await expect(page.getByTestId('tab-workout')).toBeVisible();
  await expect(page.getByTestId('sign-out')).toBeVisible();

  // A REAL routed navigation: the app's own nav link, clicked. The
  // router pushes the route; the destination page renders its own
  // content.
  await page.getByTestId('tab-history').click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('tab-history')).toBeVisible();

  // The destination route rendered its real content — the page is not
  // blank and not torn down by the dead relay.
  await expect(
    page
      .locator('[data-testid="history-loading"], [data-testid="history-empty"], [data-testid="history-days"]')
      .first()
  ).toBeVisible();

  // Still interactive afterwards: a second real navigation also works.
  await page.getByTestId('tab-workouts').click();
  await expect(page).toHaveURL(/\/workouts$/);
  await expect(page.getByTestId('workouts-tab')).toBeVisible();

  // The relay really was dead throughout, and the app really did try to
  // use it: the sign-out path fires a telemetry event that the aborted
  // relay swallows. This is the fourth real auth path, and it proves the
  // relay-dead condition is not vacuous.
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  await expect.poll(() => state.relayAborted, { timeout: 10_000 }).toBeGreaterThan(0);

  const signoutEvent = state.relayPayloads.find((e) => e.operation === 'signout');
  expect(signoutEvent, 'the browser sent no sign-out telemetry event to the relay').toBeTruthy();
  expect(signoutEvent!.source).toBe('auth');
  expect(signoutEvent!.provider).toBe('supabase');

  // No uncaught exception anywhere in the run.
  expect(state.pageErrors, 'the page raised an uncaught exception').toEqual([]);

  expectNoEscapedNetwork(state);
});
