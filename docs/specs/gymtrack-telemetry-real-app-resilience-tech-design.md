---
status: draft
task_id: 8c3aa401-fed8-4f51-a93c-6ab69eea6419
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# GymTrack telemetry resilience — real-application proof — Tech Design

## Product spec link

- **Task:** `8c3aa401-fed8-4f51-a93c-6ab69eea6419` (💻 Prove AC3 real-application telemetry resilience (failed sign-in, sign-up, routed navigation with the relay aborted))
- **Task type:** `code` — no separate `brain/` product spec; the AC text in the task description is the product contract.
- **Parent task:** `e89db27f-6d78-418e-91c1-0759f8779d06` (💻 Add GymTrack browser error telemetry to Grafana). This task carries the *application-flow half* of the parent's AC3.
- **Parent tech design:** `docs/specs/gymtrack-browser-error-telemetry-tech-design.md` — its AC3 verification matrix promises "**E2E (Playwright).** Disable network in the browser context for the relay URL, drive a sign-in flow, assert the failure renders inline as before." That promise was not kept by either merged delivery PR (#836, #967); this task closes it.
- **Durable system doc:** `docs/systems/observability.md` § "Browser-side error telemetry" — the authoritative telemetry contract.

## Task and repository

- **Task ID:** `8c3aa401-fed8-4f51-a93c-6ab69eea6419`
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-8c3aa401-gymtrack-telemetry-real-app-e2e`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-8c3aa401-gymtrack-telemetry-real-app-e2e`
- **Base:** `origin/main` @ `f898a1ce`
- **PR:** (pending — no separate tech-design PR; Quinn reads this design from the branch blob URL. The implementation PR opens as **DRAFT** once Quinn approves this design.)

## Product intent summary

The parent's AC3 is a **resilience** contract: *export failure is non-blocking and does not break sign-in, sign-up, navigation, or page rendering*. That is a claim about the **running application**, not about a telemetry module in isolation. Quinn's review of PR #970 found the delivered Playwright evidence proves the module and a static harness — the harness calls `reportAuthError` directly and navigates by changing a hash — but never proves the real app's sign-in, sign-up, and routed-navigation paths survive a dead relay.

The user-visible promise behind AC3 is narrow and important: **a user whose telemetry relay is unreachable must still be able to sign in, sign up, and navigate the app.** If telemetry can break the auth flow, the observability layer has become an availability dependency — strictly worse than the outage it was added to diagnose.

This task delivers that proof against the real application, with no credentials and no live identity provider.

## Problem statement

Two facts drive the design, both verified in this repo at `origin/main` @ `f898a1ce`.

### 1. The delivered evidence is a harness, not the application

`apps/gymtrack/test/e2e/telemetry-resilience.spec.ts` contains two groups:

- **The harness group** (3 tests) drives `apps/gymtrack/test/e2e/fixtures/telemetry-harness.html` — a dev-server-only page that imports `src/lib/browserTelemetry.js` directly and calls `reportAuthError` / throws / changes a hash. It is hermetic by construction: *no auth provider, no live backend, no credentials*. It proves the telemetry module's never-throws/dedupe/volume behaviour in a browser. It does **not** prove the application's auth or navigation flows.
- **The live-app group** (1 test) drives the real `/login` route against a live Clerk deployment — but it is gated on `CLERK_TEST_URL` + `CLERK_TEST_EMAIL` + `CLERK_TEST_PASSWORD`, and **none of those exist in this workspace or in the protected secret store**. The task description records that provisioning them is an operator-only action. The test therefore never runs here, and there is no sign-up case and no routed-navigation case at all.

The gap is exactly the three cases this task names: failed sign-in, failed sign-up, and a real routed navigation — each with the relay aborted.

### 2. The default (Supabase) auth path cannot mount

The only credential-free path to a real running app is the default `VITE_AUTH_PROVIDER=supabase` provider, and it currently throws at mount. Verified mechanism:

- `apps/gymtrack/src/lib/supabase.js:87` passes the `accessToken` option to `createClient()` **unconditionally** — the callback returns `null` when the active provider is Supabase, but the *option's presence* is what matters.
- `@supabase/supabase-js` 2.118.0, `node_modules/@supabase/supabase-js/dist/index.mjs:665-671`:

  ```js
  if (!settings.accessToken) {
    this.auth = this._initSupabaseAuthClient(...);
  } else {
    this.accessToken = settings.accessToken;
    this.auth = new Proxy({}, { get: (_, prop) => {
      throw new Error(`@supabase/supabase-js: Supabase Client is configured with the accessToken option, accessing supabase.auth.${String(prop)} is not possible`);
    } });
  }
  ```

- `apps/gymtrack/src/lib/supabaseAuth.jsx:79` calls `supabase.auth.getSession()` in a mount effect → the proxy property access throws → the default provider path cannot mount.

This is a pre-existing defect tracked separately as task **`ca999d95`** ("Fix the GymTrack Supabase auth path throwing at mount"), status `ready`, tech design already approved by Quinn (2026-11-11). It is **not** in scope for this task, and this task **depends on it**.

## Design decision

> **Drive the real GymTrack application on the Supabase provider path, with the identity provider's HTTP boundary stubbed by Playwright route interception, and the telemetry relay aborted.**

The browser loads the real SPA (`src/main.jsx` → `src/App.jsx` → `src/lib/auth.jsx` dispatcher → `src/lib/supabaseAuth.jsx` → real `src/components/LoginScreen.jsx` / `src/components/SignUpPage.jsx`). The real `signIn` / `signUp` methods call the real `supabase.auth.signInWithPassword` / `supabase.auth.signUp`. The real failure path runs: `supabaseAuth.jsx:103` fires `reportAuthError(error, supabaseSafeContext(error, 'signin'))`, and `LoginScreen.jsx:149` renders `data-testid="login-error"`.

Only the **identity provider's HTTP endpoint** is stubbed — the standard Playwright technique for any third-party API. No component is replaced, no telemetry function is called directly by the test, and no credential is required.

### Options considered

| Option | Verdict |
|---|---|
| **A. Real app on the Supabase path, provider HTTP stubbed (chosen)** | Real components, real auth code path, real error handling, real inline rendering. No credentials, no live provider, deterministic, CI-safe. |
| **B. Real app on the Clerk path** | Blocked: `CLERK_TEST_URL` / `CLERK_TEST_EMAIL` / `CLERK_TEST_PASSWORD` do not exist; provisioning is operator-only. Would make the proof non-reproducible in CI. Retained as an **optional additional** case if the operator ever provisions the credentials, but it cannot be the proof. |
| **C. Keep the static harness, extend it** | Cannot satisfy AC1–AC4: the harness has no auth provider, no real sign-in form, and no real router. This is the gap Quinn flagged. |
| **D. Unit/component tests with a mocked provider** | Proves `LoginScreen` renders an error given an error — already covered by `LoginScreen.test.jsx` / `SignUpPage.test.jsx`. Does not prove the browser-level resilience claim (an unhandled rejection or a synchronous throw in the send path could still break the flow in a real browser). Insufficient as the *only* layer; retained as a fast lower-level regression alongside option A. |

### Why not stub the telemetry module itself

Stubbing `reportAuthError` would remove the thing under test. The relay is instead aborted at the network layer (`route.abort('failed')`), which is the real failure mode: the relay is unreachable, the `fetch` rejects, and the telemetry module's own catch path runs. That is exactly the condition AC3 names ("with the telemetry relay aborted").

## Blocking dependency

**This task depends on `ca999d95`.** Until the `accessToken` option is passed only on the Clerk branch, `supabase.auth` is a throwing proxy and the Supabase provider cannot mount — so no real-app case can run.

- The dependency is recorded on the task via the Tasks API `dependsOn` edge (`8c3aa401` → `ca999d95`).
- `ca999d95` is `ready` with an approved tech design and is waiting on Lobster to promote it to `doing` (capacity: Rowan has 3 active tasks in `doing`, limit 2).
- **Implementation sequencing:** land `ca999d95` first, then implement this task against the fixed `supabase.js`. The e2e work here is written *against the fixed* provider path and does not itself modify `src/lib/supabase.js` — one file, one task, one PR. If `ca999d95` is not yet merged when implementation starts, the spike in Step 1 below is what proves whether the path mounts; if it does not, that is the dependency speaking, not a test defect.

## Implementation plan

### Step 1 — Feasibility spike (before writing any test)

The one genuine unknown is whether `auth-js` 2.118.0 accepts a **stubbed** `200` session response well enough to establish a signed-in session without a live server. The failure cases (AC1, AC2) have no such risk; only the authenticated routed-navigation case (AC3) does.

Spike procedure (throwaway, not committed):

1. Boot the dev server on the Supabase provider path with the placeholder Supabase env already used by `playwright.config.ts` (`VITE_SUPABASE_URL=https://telemetry-e2e.invalid`).
2. Intercept `POST **/auth/v1/token?grant_type=password` and return `200` with a GoTrue session body; intercept `GET **/auth/v1/user` and return `200` with the user body.
3. Assert whether `supabase.auth.getSession()` resolves with that session, whether `onAuthStateChange` fires `SIGNED_IN`, and whether `AuthGate` renders its child.
4. Record the outcome in this design's verification table (Step 5) before writing the real tests.

**Decision rule:**

- **If the stubbed session works** → AC3 is verified with an *authenticated* routed navigation into an `AuthGate`-protected route (e.g. `/workouts`), which is the strongest form of the AC.
- **If it does not** → AC3 is verified with an *unauthenticated* real routed navigation: the app's own `<Link>` from `/login` to `/signup` (both real routes, real `react-router` pushState, real page render — explicitly not a hash change). The AC's wording ("a real routed navigation and page render … in the application") is satisfied by this; the spike result is recorded as the reason the authenticated variant was not used.

Either outcome delivers AC3. The spike exists so the *strongest* available form is used and the weaker one is a documented, evidence-backed fallback rather than a silent gap.

### Step 2 — Stub catalogue

All stubs are registered per-test via `page.route(...)`. The placeholder host `telemetry-e2e.invalid` is guaranteed non-resolvable, so an unstubbed request can never reach a real service — but the fail-closed guard in Step 3 makes that explicit.

| # | Request | Response | Used by |
|---|---|---|---|
| S1 | `POST **/auth/v1/token?grant_type=password` | `400` `{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}` | AC1 |
| S2 | `POST **/auth/v1/signup` | `400` `{"code":422,"error_code":"user_already_exists","msg":"User already registered"}` | AC2 |
| S3 | `POST **/auth/v1/token?grant_type=password` | `200` GoTrue session body (see below) | AC3 (if the spike succeeds) |
| S4 | `GET **/auth/v1/user` | `200` user body | AC3 (if the spike shows auth-js calls it) |
| S5 | `**/api/telemetry` | `route.abort('failed')` | AC1, AC2, AC3 — **the relay is dead in every case** |

**Why the S1/S2 bodies are shaped this way.** `auth-js` constructs the error in `node_modules/@supabase/auth-js/dist/module/lib/fetch.js:78`:

```js
throw new AuthApiError(_getErrorMessage(data), error.status || 500, errorCode);
```

with `errorCode = data.error_code` and the message taken from `data.msg`. So the S1 body yields `error.status === 400`, `error.code === 'invalid_credentials'`, `error.message === 'Invalid login credentials'`.

`supabaseSafeContext()` (`src/lib/supabaseAuth.jsx:16-23`) maps these to the telemetry context as `provider: 'supabase'`, `operation: 'signin' | 'signup'`, `errorCode: error.code`, `status: String(error.status)` — **no message, no email, no password**. That mapping is the redaction contract AC2 of the parent task, and asserting `errorCode === 'invalid_credentials'` / `status === '400'` on the captured event is what proves the safe context reached the relay from a real failure.

For S3, the session body is the standard GoTrue shape:

```json
{ "access_token": "<jwt-shaped string>", "token_type": "bearer", "expires_in": 3600,
  "expires_at": <epoch seconds>, "refresh_token": "<opaque string>",
  "user": { "id": "<uuid>", "aud": "authenticated", "role": "authenticated",
            "email": "<test address>", "email_confirmed_at": "<iso>",
            "app_metadata": {}, "user_metadata": {}, "created_at": "<iso>" } }
```

The email is a synthetic test address; it is never sent to the relay (the redaction contract strips it) and never leaves the machine.

### Step 3 — Fail-closed network guard

The whole point of the guard is that a test can never silently reach a real identity provider or a real relay:

- Register a catch-all route for the Supabase placeholder host that **aborts** any request not explicitly stubbed by S1–S4, and record it. An unmatched request therefore fails the test rather than escaping to the network.
- Abort every `**/api/telemetry` request (S5) and record it. Assert the abort actually happened — a test that silently never triggered telemetry is not a proof.
- Add a global "no unexpected network" assertion: track every request URL the page issued and fail the test if any host other than the dev server (`localhost:5179`) was contacted.

### Step 4 — Test cases

New file `apps/gymtrack/test/e2e/telemetry-real-app.spec.ts` (kept separate from the harness file so the harness suite and the real-app suite can be gated and reasoned about independently). The existing harness spec and its tests stay as they are — they are valid module-level evidence.

- **AC1 — failed sign-in, relay aborted.** Stub S1 + S5. Navigate to the real `/login` route, fill `login-email` / `login-password` with a synthetic address and a deliberately wrong password, submit. Assert (a) `login-error` becomes visible with the provider's message, (b) the form remains usable (the submit button is re-enabled and the email field retains its value — "does not break the auth flow"), (c) the relay request was attempted and aborted, and (d) the captured event (captured *before* the abort, from the intercepted request) carries `source: 'auth'`, `provider: 'supabase'`, `operation: 'signin'`, `errorCode: 'invalid_credentials'`, `status: '400'`, a non-empty `release` that is not `'dev'`, and **no email, password, or message**.

  The telemetry payload is read from the intercepted request's POST body, so the assertion proves the *browser sent* the safe event even though the network layer then killed it — which is precisely the resilience claim.

- **AC2 — failed sign-up, relay aborted.** Stub S2 + S5. Navigate to the real `/signup` route, fill `signup-email` / `signup-password`, submit. Assert (a) `signup-error` becomes visible, (b) the form is re-enabled and the password field is cleared as it is today, (c) the relay was attempted and aborted, and (d) the captured event carries `operation: 'signup'`, `provider: 'supabase'`, `errorCode: 'user_already_exists'`, `status: '422'`, and the same redaction guarantees.

- **AC3 — real routed navigation, relay aborted.** Stub S5 (and S3/S4 if the spike succeeded). With the relay dead, perform a real routed navigation through the app's own router — via `page.click()` on the app's visible `<Link>`/nav control, **not** `page.goto()` and not a hash change — and assert the destination route renders its real page content and that the page is still interactive afterwards. With the spike's authenticated session this navigates into an `AuthGate`-protected route; without it, `/login` → `/signup`. Assert no unhandled page error occurred and that the relay was aborted.

- **AC4 — evidence.** The verification matrix in § "Test plan" below is the record required by the AC ("the evidence is recorded in the PR body or the tech design's verification table"). The implementation PR body will carry the same matrix plus the recorded evidence (test names, run output, the exact assertions that passed). The AC4 claim itself — "a real application path, not a harness that calls `reportAuthError` directly" — is evidenced by the fact that these tests import **no** telemetry module and call **no** telemetry function; the only thing they touch is the real app's routes and the network boundary.

### Step 5 — Test plan and AC verification matrix

| AC | Requirement | Verification | Layer |
|---|---|---|---|
| **AC1** | A failed sign-in against the running GymTrack app, with the telemetry relay aborted, renders the inline error as before and does not break the auth flow. | `telemetry-real-app.spec.ts` § "AC1 — failed sign-in, relay aborted": real `/login` route, stub S1 (400 `invalid_credentials`) + S5 (relay aborted). Asserts `login-error` visible with the provider message; submit button re-enabled and email retained; relay attempted and aborted; captured event `source='auth'`, `provider='supabase'`, `operation='signin'`, `errorCode='invalid_credentials'`, `status='400'`, `release` set and not `'dev'`; no email/password/message in the payload. | **E2E (Playwright)** — the real application. |
| **AC2** | A failed sign-up against the running GymTrack app, with the telemetry relay aborted, renders the inline error as before. | `telemetry-real-app.spec.ts` § "AC2 — failed sign-up, relay aborted": real `/signup` route, stub S2 (400 `user_already_exists`) + S5. Asserts `signup-error` visible; form re-enabled and password cleared; relay attempted and aborted; captured event `operation='signup'`, `provider='supabase'`, `errorCode='user_already_exists'`, `status='422'`, same redaction guarantees. | **E2E (Playwright)** — the real application. |
| **AC3** | A real routed navigation and page render, with the telemetry relay aborted, completes normally in the application (not via a hash change in a static harness). | `telemetry-real-app.spec.ts` § "AC3 — real routed navigation, relay aborted": S5 + (S3/S4 if the spike succeeded). Navigation performed by clicking the app's own link, asserting the destination route's real content renders and the page stays interactive; no unhandled page error; relay aborted. | **E2E (Playwright)** — the real application. |
| **AC4** | The three cases run against a real application path, not a harness that calls `reportAuthError` directly, and the evidence is recorded in the PR body or the tech design's verification table. | The three tests above import no telemetry module and call no telemetry function — they drive the app's routes and the network boundary only. Evidence recorded in this matrix, the Step 1 spike outcome, and the implementation PR body (test names + run output + the assertions that passed). | **E2E (Playwright)** + recorded evidence. |

Supporting (already-delivered) layers, unchanged and still valid:

| Property | Existing coverage |
|---|---|
| Never-throws, dedupe counter, volume cap | `apps/gymtrack/src/lib/browserTelemetry.test.js` (unit) |
| `release` resolution (explicit tag → Vercel commit → deployment id → never `dev` in production) | `apps/gymtrack/src/lib/browserTelemetry.test.js` § "release identifier" (unit) + `apps/gymtrack/test/e2e/telemetry-resilience.spec.ts` (harness, browser) |
| Telemetry module behaviour in a real browser (uncaught exception, auth failure, blocked relay) | `apps/gymtrack/test/e2e/telemetry-resilience.spec.ts` (harness group) — retained |

### Running the suite

- The real-app suite is gated by `GT_TELEMETRY_E2E=1`, matching the existing telemetry suite convention, so it does not run in an ordinary `npm test`.
- **No credentials are required.** The suite must pass with an empty environment apart from `GT_TELEMETRY_E2E=1`.
- `playwright.config.ts` already boots the dev server with the placeholder Supabase env (`VITE_SUPABASE_URL=https://telemetry-e2e.invalid`, `VITE_SUPABASE_ANON_KEY=telemetry-e2e-placeholder-key`) and `VITE_TELEMETRY_ENABLED=1` with a synthetic `VERCEL_GIT_COMMIT_SHA`. The only config change needed is making sure `VITE_AUTH_PROVIDER=supabase` is explicit rather than implicit (see "Implementation plan → files in scope"), so the provider under test is stated rather than inferred from a default.
- `apps/gymtrack/package.json` gains a script for the real-app suite, e.g. `e2e:telemetry-real-app`, so it can be run and CI-invoked independently of the harness suite.

### Files in scope

| File | Change |
|---|---|
| `apps/gymtrack/test/e2e/telemetry-real-app.spec.ts` | **New.** The three real-application cases. |
| `apps/gymtrack/test/e2e/telemetry-env.ts` | **Modified.** Shared constants for the stub endpoints, the synthetic session/user bodies, and the synthetic test identity. Keeps the spec and any config in one place so they cannot drift. |
| `apps/gymtrack/playwright.config.ts` | **Modified.** Make `VITE_AUTH_PROVIDER=supabase` explicit in the telemetry dev-server command; nothing else changes. |
| `apps/gymtrack/package.json` | **Modified.** Add the `e2e:telemetry-real-app` script. |
| `apps/gymtrack/SPEC.md` | **Modified.** The § "Browser telemetry — release identifier and coverage mapping" table gains rows for the three real-application cases and replaces the row pointing at the credential-gated Clerk case with a note that the credential-free Supabase-path suite is the proof (the Clerk case remains as an optional additional case if the operator provisions credentials). |
| `apps/gymtrack/src/**` | **No production change.** This task adds verification, not behaviour. If the spike or a test uncovers a real defect in the app's error handling, that defect is filed as its own task (as `ca999d95` was) rather than fixed inside this PR — keeping this PR to test-only scope and keeping the parent task's redaction/boundary contract untouched. |

## Ownership boundary check

- **Natural source of truth:** the browser→relay telemetry contract is owned by `apps/gymtrack/src/lib/browserTelemetry.js` and documented in `docs/systems/observability.md` § "Browser-side error telemetry". This task **adds no new contract** — it verifies an existing one against the running app. The correct boundary is *no new boundary*: the tests observe the existing contract from outside.
- **Direct consumers:** none change. The relay (`apps/gymtrack/api/telemetry.js`) and the hosted Grafana tenant are untouched.
- **Why the tests do not become a second source of truth:** the stub bodies reproduce GoTrue's documented error envelope so the SDK produces a real `AuthApiError`. The contract under test is the app's handling of that error and the telemetry context derived from it — not the GoTrue wire format, which is an external dependency's contract and is re-derived per test rather than vendored into the repo.
- **Extraction/migration plan:** not applicable — no temporary placement is introduced.

## Data model and API contract changes

None. No schema change, no endpoint added, no event shape changed, no new dependency.

## Workflow, cron, and skill changes

None.

## `.openclaw` boundary

None. This design requires **no** change outside the repository — which is the point of choosing the Supabase path over the Clerk path. No OpenClaw configuration, workspace file, or secret is involved, and no credential is needed. The only operator-only item that *would* have been needed (Clerk e2e credentials) is deliberately avoided rather than escalated.

## Open questions

1. **Does a stubbed `200` session establish a usable session in auth-js 2.118.0?** Resolved by the Step 1 spike; the fallback (unauthenticated routed navigation) is defined in advance so AC3 is never blocked on it.
2. **Should the credential-gated Clerk case be kept?** Proposal: keep it, but demote it from "the proof" to "an optional additional case when the operator provisions Clerk e2e credentials", and update `SPEC.md` accordingly. This is a coverage-table wording change, not a behaviour change. Needs Quinn's confirmation at approval time.
3. **Should the harness suite stay?** Proposal: yes — it is fast, credential-free module-level evidence and it is already referenced by `SPEC.md`. The parent task's AC4 needs the *application* proof, not the harness removed. The two suites have different scopes and both are useful.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The stubbed session is not accepted by auth-js (AC3 must use the weaker form) | Low | Spike first; fallback defined in advance; either outcome satisfies AC3. |
| The Supabase path still cannot mount because `ca999d95` has not landed | **High — blocks all three cases** | Recorded as a task dependency on `ca999d95`; implementation sequencing states the order; the spike makes the state obvious immediately. |
| A stub is missing and the request escapes to the network | Medium | Fail-closed catch-all route for the placeholder host + "no unexpected host" assertion. The placeholder host is non-resolvable, so escape fails rather than leaks. |
| The relay-abort assertion passes vacuously (telemetry never fired at all) | Medium | Assert the intercepted request was observed, and assert the captured event's fields — a missing event fails the test. |
| The e2e suite becomes flaky | Medium | Deterministic stubs (no timing, no retries against a real provider); `fullyParallel: false` already set; the existing suite's polling helpers reused. |
| The suite drifts from the app's real error rendering | Low | Assert on the app's own `data-testid`s (`login-error`, `signup-error`) and the app's own button-state behaviour, so a UI change surfaces as a test failure rather than a silent pass. |
| The real-app suite duplicates the harness suite | Low | Different scopes, documented in `SPEC.md`'s coverage table; the harness remains module-level evidence. |

## Definition of Done

- The three real-application cases pass with **no credentials** and `GT_TELEMETRY_E2E=1`.
- The suite fails if the relay is *not* aborted, if a stub is missing, or if any unexpected host is contacted.
- The Step 1 spike outcome is recorded in the verification table above.
- `apps/gymtrack/SPEC.md`'s coverage table reflects the real-application cases.
- The implementation PR body carries the same verification matrix plus the recorded evidence.
- `ca999d95` is merged (this task's dependency) before the implementation PR is opened for review.
