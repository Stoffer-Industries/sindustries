---
status: draft
task_id: 7e7826c5-8c2f-4418-a439-7cfb23fe3f0e
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# GymTrack Google OAuth — Silent No-Op — Tech Design

## Product spec link

- **Task:** `7e7826c5-8c2f-4418-a439-7cfb23fe3f0e` (💻 GymTrack: Google sign-in/sign-up button does nothing on click)
- **Task title:** 💻 GymTrack: Google sign-in/sign-up button does nothing on click
- **Task type:** `code` — dispatched through `agents/workflows/feature-task/code-task.lobster.yaml`. No product spec is required; the design intent is captured in the task description and its AC1–AC4 text.
- **Product spec:** n/a
- **Sibling task:** `6e9410d5` (💻 GymTrack sign-up: email verification code has no input field) — a separate defect on the email + password path, its own branch, its own PR. This design does not cover it and its fix must not be folded into this PR.

## Task and repository

- **Task ID:** `7e7826c5-8c2f-4418-a439-7cfb23fe3f0e`
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-7e7826c5-google-oauth-silent-noop`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-7e7826c5-google-oauth-silent-noop`
- **PR:** pending — the tech design is committed on the implementation branch; the implementation PR opens as **DRAFT** only after Quinn approves this design.

## AC1 — root cause

**AC1 asks for a root cause before any fix, and specifically asks that a Supabase-project config gap be escalated to Quinn as `[openclaw-needed]` rather than papered over with a code change. Here is the root cause.**

### The task's framing is stale: production does not run the Supabase OAuth path

The task description says:

> Both pages share the same `handleOAuth` -> `useAuth().startOAuthRedirect('google', ...)` -> `supabase.auth.signInWithOAuth` call path.

That was true before the Clerk cutover. It is not true now. `docs/systems/gymtrack.md` § *Required env/config* records the production value:

```
- `VITE_AUTH_PROVIDER=clerk`
```

`apps/gymtrack/src/lib/auth.jsx` dispatches on that flag at module load, so in production `useAuth().startOAuthRedirect` is `ClerkAuthProvider.startOAuthRedirect`, which calls `clerkSignIn.sso({ strategy: 'oauth_google', redirectUrl, redirectCallbackUrl })`. `supabase.auth.signInWithOAuth` is never called in production.

**So the answer to AC1's first question — "is the Supabase project's Google OAuth provider unconfigured?" — is that the question does not apply to the live bug.** The Supabase path is the one-env-var rollback path. It is not the cause of the reported symptom, and it is not what the fix should target first.

### The production root cause: an unguarded `sessionStorage` write outside the error boundary

`apps/gymtrack/src/lib/clerkAuth.jsx`, `startOAuthRedirect`:

```js
const strategy = clerkStrategyForProvider(provider);
const redirectUrl = new URL(redirectPath, window.location.origin).toString();
const redirectCallbackUrl = new URL('/sso-callback', window.location.origin).toString();
rememberClerkSsoDestination(redirectPath);   // <-- OUTSIDE the try/catch below
try {
  const { error } = await clerkSignIn.sso({ strategy, redirectUrl, redirectCallbackUrl });
  ...
} catch (err) { ... }
```

`rememberClerkSsoDestination` is `apps/gymtrack/src/lib/clerkSsoDestination.js`:

```js
export function rememberClerkSsoDestination(destination) {
  window.sessionStorage.setItem(DESTINATION_KEY, safeInternalDestination(destination));
}
```

`window.sessionStorage.setItem` is called with **no `try`/`catch`**. On iOS Safari — GymTrack's primary client, per `apps/gymtrack/SPEC.md` ("accessible from iOS Safari without an app install") — touching `sessionStorage` throws a `SecurityError` when cookies are blocked (ITP) or the page is in certain private-browsing states. That throw happens **before** `startOAuthRedirect`'s own `try` block, so it escapes the provider's error handling entirely.

### The amplifier: the click handlers have no error boundary either

`apps/gymtrack/src/components/SignUpPage.jsx` and `apps/gymtrack/src/components/LoginScreen.jsx` both have:

```jsx
async function handleOAuth(provider) {
  setError(null);
  const { data, error: oauthError, providerDisabled } = await startOAuthRedirect(provider, from);
  ...
}
```

There is **no `try`/`catch`**, and the call site is a floating promise:

```jsx
onClick={() => handleOAuth('google')}
```

A rejection therefore becomes an **unhandled promise rejection**: no `setError`, no navigation, no re-render. The user's click produces literally nothing — no redirect, no error message, nothing.

This is what converts any thrown error into a silent no-op, and it is why the symptom is "nothing happens" rather than "an error appears".

### What the reported symptom rules out

The report is specific: *no redirect to Google, no error message, nothing happens.* Two candidate causes are therefore **ruled out**, because both produce a *visible* message:

| Candidate | Behaviour | Consistent with the report? |
|---|---|---|
| Clerk instance has no Google OAuth application configured, or the redirect URL is not allowlisted | Clerk returns an error → `clerkErrorMessage()` → `setError(oauthError.message)` → the page renders `signup-error` / `login-error` | **No** — that would be visible |
| Supabase Google provider not enabled (rollback path only) | `isProviderDisabledError()` matches → `providerDisabled: true` → the button is removed and "…is not available right now." is shown | **No** — that would be visible |

Both of those are *already handled correctly*. The failure modes that remain are exactly the ones that produce no output: a thrown error escaping an error boundary, and a redirect that is initiated but never happens.

### Second production mechanism: Clerk resolves, but there is no visible effect and no fallback

Under Clerk, `startOAuthRedirect` returns:

```js
return { data: { provider }, error: null, providerDisabled: false };
```

There is **no `data.url`**. The pages' shared final step is:

```jsx
if (data?.url) { window.location.assign(data.url); }
```

Under Clerk that line is intentionally inert — the Clerk SDK is expected to perform the navigation itself. The page therefore has **no fallback for the case where Clerk resolves without navigating** and no intermediate feedback for the (normal) case where Clerk *is* navigating. If the Clerk SDK resolves without navigating — a misconfigured allowlist that Clerk treats as a no-op, a blocked third-party cookie preventing the Frontend API call, or a browser that suppresses the navigation — the user again sees nothing at all.

So there are **two** production mechanisms that produce the reported symptom, and the fix must close both:

1. **A thrown error escaping the error boundary** (`sessionStorage` write, or anything else) → silent no-op.
2. **A redirect that is initiated but never completes** → silent no-op, with no intermediate feedback either.

### Conclusion for AC1

**This is a code bug, not a project-config gap.** AC1's escape hatch — "flag it as an `[openclaw-needed]` Quinn blocker instead of shipping a no-op code change" — therefore does **not** apply, and no `[openclaw-needed]` escalation is raised for the OAuth wiring itself. The code fix below makes every outcome visible, which is exactly what AC2 asks for.

One genuinely external item does remain, and it is recorded as a risk below rather than as the deliverable: **the Clerk instance's Google OAuth application and its allowlisted redirect URLs are Clerk-dashboard configuration that Quinn owns.** The code fix guarantees the user sees either a redirect or a clear error; it does not make Google sign-up *work* if the dashboard is not configured. If the dashboard turns out to be unconfigured, the user-visible outcome after this fix is a clear inline error instead of silence — which satisfies AC2 — and the dashboard wiring becomes a separate follow-up.

## Service boundary and data ownership

### Natural source of truth: the OAuth click contract, owned by the auth provider

The fact this feature needs is *"did the OAuth redirect actually start, and if not, what should the user see?"*. That fact has one owner per backend:

- **Clerk** owns the redirect: `clerkSignIn.sso()` initiates an out-of-band navigation and returns an error envelope if it cannot.
- **Supabase** owns the redirect URL: `supabase.auth.signInWithOAuth()` returns `{ data: { url } }` and the browser must be sent there.

The pages today learn about neither cleanly. They poke at `data?.url`, which only exists in the Supabase shape, and they have no error boundary, so a provider-side throw is invisible.

The natural source of truth is therefore the **provider-agnostic `useAuth()` contract** — the same boundary that already carries `signIn`, `signUp`, `signOut`, and `startOAuthRedirect` — extended so that a caller can always tell the difference between *"redirect started"*, *"provider refused"*, and *"provider threw"*.

### Options considered

1. **Duplicate a `try`/`catch` in both pages.** **Rejected.** It fixes the symptom but leaves AC3 ("applies identically on both `/login` and `/signup`") as a convention two people must remember rather than a property the code guarantees. The two `handleOAuth` implementations are already byte-for-byte near-duplicates; a third copy of the same logic is how they drift.
2. **Guard `sessionStorage` only.** **Necessary but not sufficient.** It closes mechanism (1) but leaves mechanism (2) — a redirect that never completes still shows nothing, and any *other* future throw in the chain is still silent.
3. **A shared `useOAuthRedirect()` hook that owns the whole click contract, plus a hardened `sessionStorage` helper.** **Chosen.** The hook is the single total error boundary for both pages, so AC3 is structural; the storage fix removes the specific throw site so the common case actually *works* rather than merely becoming visible.

### Why the durable solution is not more expensive than the shim

The shared hook is roughly the size of the two `try`/`catch` blocks it replaces, and it removes duplicated logic rather than adding to it. There is no interim shim here: the fix goes straight to the durable boundary.

### Ownership summary

| Concern | Owner | Change |
|---|---|---|
| OAuth redirect initiation | Identity provider (Clerk `signIn.sso()` / Supabase `signInWithOAuth`) | unchanged |
| "Did the redirect start?" signal | `apps/gymtrack/src/lib/{clerkAuth,supabaseAuth}.jsx` via the `useAuth()` contract | **extended** (`data.redirecting`) |
| Total error boundary for the click | **new** `apps/gymtrack/src/lib/useOAuthRedirect.js` | **new** |
| SSO destination persistence | `apps/gymtrack/src/lib/clerkSsoDestination.js` | **hardened** (never throws) |
| Button rendering, inline error, provider-disabled state | `SignUpPage.jsx`, `LoginScreen.jsx` | **extended** (consume the hook) |
| Clerk dashboard OAuth app + redirect allowlist | Clerk dashboard (Quinn owns) | **none in this PR** — recorded as a risk |
| `.openclaw` | — | **no changes required** |

### Data model / API contract changes

None. No table, no migration, no server route, no new service. The only contract change is the in-browser `useAuth()` interface.

## `.openclaw` boundary notes

No work outside this repository. Nothing to route to Quinn at `attentionOwners[0]`.

The one external dependency — the Clerk instance's Google OAuth application and its allowlisted redirect URLs (`https://gymtrack.sindustries.co.nz` and `https://gymtrack.sindustries.co.nz/sso-callback`) — is Clerk-dashboard configuration Quinn already owns as part of the `bb09eaed` cutover. This PR does not require a change to it. If it turns out to be unset, the correct follow-up is a separate `[openclaw-needed]` escalation, raised at that point with the concrete Clerk error message now visible to the user.

## Implementation plan

### 1. Harden the SSO destination helper (`apps/gymtrack/src/lib/clerkSsoDestination.js`)

Wrap every `sessionStorage` access in `try`/`catch` so the module can never throw:

- `rememberClerkSsoDestination(destination)` — `setItem` in a `try`; on failure, fall back to a module-level in-memory value so the current page can still read it back.
- `consumeClerkSsoDestination()` — `getItem` in a `try`; on failure, use the in-memory value; the existing `?? '/workout'` default still applies.
- `clearClerkSsoDestination()` — `removeItem` in a `try`; always clear the in-memory value too.

**Degradation is acceptable and documented:** when `sessionStorage` is unavailable the destination cannot survive the off-site round trip, so `/sso-callback` falls back to `/workout` (the helper's existing default) instead of the user's requested destination. Losing the destination is a far better outcome than a dead button.

### 2. Extend the provider contract with `data.redirecting`

Both providers publish a uniform "a redirect has been initiated" signal:

- **Clerk** — `startOAuthRedirect` returns `{ data: { provider, redirecting: true }, error: null, providerDisabled: false }` on success. The Clerk SDK owns the navigation, so the signal means "navigation initiated", not "here is a URL".
- **Supabase** — `startOAuthRedirect` returns `{ data: { url, redirecting: true }, error: null, providerDisabled: false }` on success. `data.url` is preserved because the page still needs it for `window.location.assign`.

The contract is documented in `apps/gymtrack/src/lib/authContext.jsx` alongside the existing method docs.

### 3. New shared hook (`apps/gymtrack/src/lib/useOAuthRedirect.js`)

`useOAuthRedirect()` wraps `useAuth().startOAuthRedirect` and returns a uniform, **never-rejecting** envelope:

```js
const { startOAuth, pending, error, providerDisabled, redirecting } = useOAuthRedirect();
```

- **Total error boundary.** Any throw from `startOAuthRedirect` — the `sessionStorage` `SecurityError`, a `new URL()` failure, a rejected promise, a future provider bug — is caught and converted into a user-facing error message. The hook never rejects.
- **`providerDisabled` is preserved.** The existing behaviour (drop the button, show "…is not available right now.") is unchanged.
- **`redirecting` drives intermediate feedback.** While a redirect is in flight the hook reports `redirecting: true`, so the page can show a "Redirecting to Google…" status instead of an inert button.
- **Bounded fallback.** If `redirecting` is still true after a short grace period (5 seconds) and the page has not navigated away, the hook surfaces an actionable error: *"Could not start Google sign-in. Try again, or use email + password instead."* The timer is cleared on unmount and when the provider reports a new result. This is what makes "never a silent no-op" true rather than aspirational.

### 4. Update both pages (`SignUpPage.jsx`, `LoginScreen.jsx`)

Both pages currently duplicate the same `handleOAuth` body. Both switch to the hook, which makes AC3 structural rather than conventional:

```jsx
async function handleOAuth(provider) {
  const result = await startOAuth(provider, from);
  if (result.providerDisabled) {
    setAvailableProviders((prev) => prev.filter((p) => p !== provider));
    setError(`Sign-up with ${provider} is not available right now. Try another option.`);
    return;
  }
  if (result.error) {
    setError(result.error.message);
    return;
  }
  if (result.data?.url) {
    window.location.assign(result.data.url);
  }
}
```

The `providerDisabled` and `error` branches are unchanged in behaviour and in copy. The additions are the "Redirecting to Google…" status while `redirecting` is true, and the hook's bounded fallback error.

The two pages keep their own copy ("Sign-up with…" vs "Sign-in with…") — that difference is intentional and stays.

### 5. Documentation (same PR)

- **`apps/gymtrack/SPEC.md`** — the OAuth behaviour of `/login` and `/signup`: what the user sees while the redirect is in flight, and what they see if it cannot start.
- **`docs/systems/gymtrack.md`** — a runbook entry for the failure mode, plus the Clerk dashboard requirement (Google OAuth application configured; `https://gymtrack.sindustries.co.nz` and `https://gymtrack.sindustries.co.nz/sso-callback` allowlisted as redirect URLs).

### Milestones

Independently reviewable commits on one branch. AC1–AC4 are interdependent, so they ship as one PR.

1. **M1 — Storage hardening.** `clerkSsoDestination.js` never throws; new `clerkSsoDestination.test.js`.
2. **M2 — Contract + hook.** `data.redirecting` on both providers; new `useOAuthRedirect.js` + `useOAuthRedirect.test.js`.
3. **M3 — Pages.** `SignUpPage.jsx` + `LoginScreen.jsx` consume the hook; page-level tests for every outcome.
4. **M4 — Docs.** `apps/gymtrack/SPEC.md` + `docs/systems/gymtrack.md`.

### Files touched

| File | Change |
|---|---|
| `apps/gymtrack/src/lib/clerkSsoDestination.js` | never-throw storage access + in-memory fallback |
| `apps/gymtrack/src/lib/clerkSsoDestination.test.js` | **new** — storage-unavailable coverage |
| `apps/gymtrack/src/lib/useOAuthRedirect.js` | **new** — shared total error boundary |
| `apps/gymtrack/src/lib/useOAuthRedirect.test.js` | **new** — hook contract coverage |
| `apps/gymtrack/src/lib/clerkAuth.jsx` | `startOAuthRedirect` returns `data.redirecting` |
| `apps/gymtrack/src/lib/supabaseAuth.jsx` | `startOAuthRedirect` returns `data.redirecting` |
| `apps/gymtrack/src/lib/authContext.jsx` | contract documentation |
| `apps/gymtrack/src/components/SignUpPage.jsx` | consume the hook; redirecting status; fallback error |
| `apps/gymtrack/src/components/LoginScreen.jsx` | consume the hook; redirecting status; fallback error |
| `apps/gymtrack/src/components/SignUpPage.test.jsx` | AC2–AC4 coverage |
| `apps/gymtrack/src/components/LoginScreen.test.jsx` | AC3 coverage (both pages) |
| `apps/gymtrack/SPEC.md` | app behavioural spec |
| `docs/systems/gymtrack.md` | durable system doc + runbook entry |

No new dependencies. No CSS changes — the redirecting status reuses the existing `status show` class and the error reuses `status show error`.

## Test plan

### Acceptance-criterion verification matrix

This matrix lives in this design only. It must **not** be copied into the PR body — the lobster treats AC checkboxes in a merged PR body as "covered by implementation", and a docs-only commit listing them would create a false coverage signal.

| AC | Verification layer | Test |
|---|---|---|
| **AC1** — root-cause the silent no-op | investigation (documented above) | Not a test — the root cause is established in this design: an unguarded `sessionStorage` write outside the provider's error boundary, amplified by click handlers with no error boundary, plus the absence of any fallback when Clerk resolves without navigating. The production path is Clerk, not Supabase. |
| **AC2** — clicking Google either redirects or shows a visible inline error, never a silent no-op | component (Vitest) | `SignUpPage.test.jsx` → *"shows a visible inline error when the OAuth redirect throws"* (the reported symptom: a throwing `startOAuthRedirect` must render `signup-error`, not nothing) and *"shows a visible inline error when the redirect does not start"* (the bounded fallback). `LoginScreen.test.jsx` → the same two cases. |
| **AC3** — the fix applies identically on `/login` and `/signup` | component (Vitest) + structure | Both pages consume the single `useOAuthRedirect()` hook, so the behaviour is shared by construction rather than by convention. `SignUpPage.test.jsx` and `LoginScreen.test.jsx` each assert the same outcome set (redirect / error / provider-disabled / fallback), so a regression in one page fails its own test and the shared-hook test covers the common logic once. |
| **AC4** — a Vitest test covering success → `window.location.assign`, a real error → inline error, `providerDisabled` → button removed + "not available" | component (Vitest) | `SignUpPage.test.jsx` → three cases: *"navigates to the provider URL when the redirect starts"* (asserts `window.location.assign` called with `data.url`), *"renders the inline error message when the provider returns an error"*, *"removes the Google button and shows the not-available message when the provider is disabled"*. Mirrored in `LoginScreen.test.jsx`. |

**Note on AC4's wording.** AC4 says to mock `supabase.auth.signInWithOAuth`. That is the rollback path. Since production runs Clerk, the suite must cover **both** providers: the Supabase path via `supabase.auth.signInWithOAuth` (asserting `window.location.assign` with `data.url`) and the Clerk path via `clerkSignIn.sso` (asserting the redirecting status, the error path, and the fallback). The Supabase-path assertions AC4 names are included verbatim; the Clerk-path assertions are added because they cover the live path.

### Provider-level coverage (Vitest)

- `clerkAuth.test.jsx` — extend the existing harness: `startOAuthRedirect('google')` with a successful `sso()` returns `data.redirecting: true`; with a Clerk error returns the error envelope; when `rememberClerkSsoDestination` throws (simulated by making `sessionStorage.setItem` throw), `startOAuthRedirect` must still return an envelope rather than rejecting.
- `supabaseAuth.test.jsx` (**new file**) — mock `apps/gymtrack/src/lib/supabase.js`: `signInWithOAuth` success returns `{ data: { url, redirecting: true } }`; the provider-disabled error path returns `providerDisabled: true`.
- `clerkSsoDestination.test.js` (**new file**) — `sessionStorage.setItem` throwing must not propagate; `consumeClerkSsoDestination()` falls back to `/workout`; the in-memory fallback preserves the destination within the page.

### Hook-level coverage (Vitest)

- `useOAuthRedirect.test.js` — the hook never rejects: a throwing `startOAuthRedirect` becomes an error envelope; `providerDisabled` passes through; `redirecting` flips to true and then to the bounded-fallback error after the grace period (fake timers).

### E2E coverage

`apps/gymtrack/test/e2e/signup-google.spec.ts` already exists and asserts that clicking **Continue with Google** starts the OAuth redirect. It is gated on `process.env.SUPABASE_TEST_URL` and is **skipped, not failed**, when that variable is absent — which is why the silent no-op was never caught by CI.

This PR does not change that gate. The e2e's value is that it asserts the *redirect starts*; the failure mode this task fixes is the case where the redirect does **not** start, which is only reproducible with a live Clerk instance and a real Google consent screen. The Vitest layer above covers every branch deterministically.

**Recorded gap:** there is no CI-observable test for "the Google button is wired to a working Clerk OAuth application". That requires the Clerk dashboard to be correctly configured and a live browser. If CI cannot cover it, the runbook entry in `docs/systems/gymtrack.md` names the manual check (click the button on a fresh iOS Safari session and confirm the Google consent screen appears).

## Open questions and risks

| # | Item | Impact | Recommendation |
|---|---|---|---|
| 1 | **Clerk dashboard OAuth configuration.** Is Google OAuth configured on the Clerk instance, with `https://gymtrack.sindustries.co.nz` and `https://gymtrack.sindustries.co.nz/sso-callback` allowlisted as redirect URLs? | If not, the fix turns silence into a clear error, but Google sign-up still does not work. | Confirm with Quinn as part of the review of this design. If unconfigured, raise a separate `[openclaw-needed]` escalation with the now-visible Clerk error message. **Not** the deliverable of this task — the deliverable is that the failure is visible. |
| 2 | **The task description assumes the Supabase path.** | Fixing only the Supabase path would leave production broken while the task appears closed. | Fix **both** providers, Clerk first. The task description's framing is corrected in this design. |
| 3 | **`sessionStorage` unavailable → destination lost.** The SSO destination cannot survive the round trip without storage. | The user returns to `/workout` instead of their requested protected route. | Acceptable degradation. `/workout` is the existing default in `consumeClerkSsoDestination()`. Documented in the system doc. |
| 4 | **The 5-second fallback timer is a heuristic.** A slow network could exceed it. | A user on a slow connection could see the fallback error while Clerk is still working. | 5 seconds is far beyond a normal Clerk SSO round trip start. The fallback error is worded as an actionable suggestion ("Try again, or use email + password instead"), not as a failure claim, and it does not block a navigation that arrives later. |
| 5 | **The fallback timer must not fire after a successful navigation.** | A stray error would appear on a page the user already left. | The timer is cleared on unmount and on any new provider result. `window.location.assign` tears down the page, so the timer dies with it. |
| 6 | **Duplicate `handleOAuth` logic in two pages today.** | The pages can drift, which is what AC3 is about. | Replaced by the shared hook. The remaining per-page difference is the copy ("Sign-up with…" vs "Sign-in with…"). |
| 7 | **Telemetry.** The new error paths must not leak user-facing messages to the hosted Grafana surface. | A leak would put user-visible content into an external log. | The hook catches errors and produces a generic user-facing message; no raw provider message is sent to telemetry. If a provider error is reported, use the existing `reportClerkError` / `reportAuthError` safe-context shape (provider, operation, error code, status). |

### Explicitly out of scope

- The email + password sign-up verification defect (task `6e9410d5`) — separate root cause, separate branch, separate PR.
- Wiring the Apple OAuth provider (still in `DISABLED_OAUTH_PROVIDERS` until Quinn has an Apple Developer account).
- Clerk dashboard configuration changes (risk #1 above).
- The Supabase → Clerk migration's remaining phases (`bb09eaed`).
