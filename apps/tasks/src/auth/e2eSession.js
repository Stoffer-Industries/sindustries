// Test-only authentication seam for the Playwright e2e harness.
//
// The e2e suite drives the real UI but stubs every `/api/v1/tasks` response
// with `page.route`, so no real session ever exists to establish. Before the
// Clerk boundary landed the board rendered immediately; with the boundary in
// place the app waits for a Clerk session that cannot arrive in CI, and every
// spec times out waiting for the first board control.
//
// The seam activates only when BOTH conditions hold:
//
//   1. `import.meta.env.DEV` is true — the bundle was served by the Vite dev
//      server. `vite build` sets DEV=false, so a deployed bundle can never
//      activate it.
//   2. `VITE_TASKS_E2E_AUTH_TOKEN` is set — the harness sets it in
//      `playwright.config.js` and nothing else does.
//
// Production auth is not weakened: the API does not accept this token, so a
// leaked value authenticates nothing. It only lets the UI render past the
// boundary so the mocked API traffic can be exercised.
import { setTokenGetter } from './token.js';

export function e2eSession(env = import.meta.env) {
  const token = env.VITE_TASKS_E2E_AUTH_TOKEN;
  if (!env.DEV || !token) return null;
  return { token };
}

/**
 * Install the token getter before the tree renders. React runs child effects
 * before parent effects, so a getter installed from an effect would still be
 * missing when the board issues its first API call.
 */
export function installE2eSession(session) {
  const getter = async () => session.token;
  setTokenGetter(getter);
  return getter;
}
