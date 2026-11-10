---
status: draft
task_id: 6e9410d5-7c02-41ae-846d-b655c1947d46
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# GymTrack Sign-Up — Email Verification Code Step — Tech Design

## Product spec link

- **Task:** `6e9410d5-7c02-41ae-846d-b655c1947d46` (💻 GymTrack sign-up: email verification code has no input field)
- **Task title:** 💻 GymTrack sign-up: email verification code has no input field
- **Task type:** `code` — dispatched through `agents/workflows/feature-task/code-task.lobster.yaml`. No product spec is required; the design intent is captured in the task description and its AC1–AC4 text.
- **Product spec:** n/a
- **Sibling task:** `7e7826c5` (💻 GymTrack: Google sign-in/sign-up button does nothing on click) — a **separate** defect on the OAuth path with its own root cause. This design does not cover it, and its fix must not be folded into this PR.

## Task and repository

- **Task ID:** `6e9410d5-7c02-41ae-846d-b655c1947d46`
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-6e9410d5-signup-email-verification-code`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-6e9410d5-signup-email-verification-code`
- **PR:** pending — the tech design is committed on the implementation branch; the implementation PR opens as **DRAFT** only after Quinn approves this design, and converts to ready-for-review once AC1–AC4 evidence is wired and `[implementer-prs]` is posted.

## Product intent summary

A new visitor can open `https://gymtrack.sindustries.co.nz/signup`, expand **Use email + password**, and submit an email + password. The identity provider accepts the credentials, creates the account, and emails a one-time verification code. The browser then shows a code field that never appears — the account is created but unusable, and the user has no way to finish signing up.

GymTrack is a multi-tenant workout tracker: any visitor can create their own account. Today the email + password sign-up path is a dead end, so the only working route to a GymTrack account is the Google OAuth button (itself the subject of the sibling task `7e7826c5`).

## Root cause

The bug is in `apps/gymtrack/src/components/SignUpPage.jsx`, in `handleSubmit`:

```jsx
const { error: signUpError } = await signUp(email, password);
setSubmitting(false);
if (signUpError) { setError(signUpError.message); return; }
navigate(from, { replace: true });
```

The return value of `signUp` is destructured for `error` only. The `data` half of the envelope — the half that says *"the account was created but the address is not verified yet"* — is discarded. The page therefore navigates to `from` (`/workout`) as if a session existed.

No session exists. `AuthGate` (`apps/gymtrack/src/components/AuthGate.jsx`) sees `session === null` and immediately redirects to `/login` with the intended destination in `location.state`. The user is bounced off the sign-up page and lands on the login form for an account they just created. The verification code that was emailed has no input field anywhere in the product.

This is true under **both** identity providers, for different reasons:

| Provider | `signUp` behaviour when the address must be verified | What `SignUpPage` does today |
|---|---|---|
| **Clerk** (production — `VITE_AUTH_PROVIDER=clerk`) | `clerkAuth.jsx` `signUp` reaches `clerkSignUp.status !== 'complete'` (Clerk's `missing_requirements`), sends the verification code via `clerkSignUp.verifications.sendEmailCode()`, and returns `{ data: { pendingVerification: true }, error: null }` | discards `data` → navigates to `/workout` → bounced to `/login` |
| **Supabase** (rollback path — `VITE_AUTH_PROVIDER=supabase`) | `supabase.auth.signUp()` returns `data.session === null` with `data.user` set, because the project requires email confirmation | discards `data` → navigates to `/workout` → bounced to `/login` |

The Clerk provider is the one that matters in production: `apps/gymtrack/SPEC.md` records that browser identity is issued by Clerk and that `https://gymtrack.sindustries.co.nz` is the canonical production origin.

### Why this was not caught by the existing tests

`apps/gymtrack/test/e2e/signup.spec.ts` signs up with email + password and asserts the user lands on `/workout`. Its own header comment states the requirement: **"a live Supabase project … with email auto-confirm enabled"**. Auto-confirm means `data.session` is non-null, the code is never sent, and the verification path is never exercised. The e2e was green because it tested the one branch that already worked. The verification-required branch had no test at any layer.

`apps/gymtrack/src/components/SignUpPage.test.jsx` covers only the error branch ("Account already exists."). No test asserts what the page does when `signUp` succeeds.

## Service boundary and data ownership

### Natural source of truth: the provider-agnostic browser auth contract

The feature's state is *"is this account awaiting a verification code, and does this code complete it?"*. That question has exactly one owner per identity backend — the provider that holds the pending verification state:

- Clerk holds it on the `signUp` resource (`clerkSignUp.verifications`), server-side, keyed by the sign-up attempt.
- Supabase holds it in the `email` + `token` pair that `supabase.auth.verifyOtp({ email, token, type: 'signup' })` consumes.

The page cannot answer that question, and it must not try. The natural source of truth is therefore the **shared, provider-agnostic auth contract** that `useAuth()` already publishes — the same contract that already carries `signIn`, `verifySignInCode`, `signOut`, and `startOAuthRedirect` across both providers.

This is not a new boundary. It is the existing boundary, extended by the one method the sign-up flow is missing.

### Options considered

1. **Page-local Supabase call (`supabase.auth.verifyOtp` directly in `SignUpPage.jsx`).** This is the literal suggestion in the task text and is the smallest possible diff (~10 lines). **Rejected.** It is wrong in production: the production provider is Clerk, so a Supabase-only page call would leave the live bug completely unfixed while looking "done". It would also require the page to branch on provider or on Supabase's response shape, putting provider semantics in the UI, and it would create a second source of truth for "is verification pending" alongside whatever the provider returns. It buys nothing that the contract change does not, and it would need a second implementation later — the exact avoidable-migration-work pattern to avoid.
2. **Extend `verifySignInCode` with a mode parameter** (e.g. `verifySignInCode(code, 'signup_email_code')`). **Rejected.** In Clerk the sign-in code lives on the `signIn` resource and the sign-up code lives on the `signUp` resource — they are different resources with different SDK methods (`signIn.emailCode.verifyCode()` vs `signUp.verifications.verifyEmailCode()`). In Supabase they are different OTP types (`email` vs `signup`). Folding sign-up into the sign-in method would make one method dispatch across two unrelated provider resources and two different code types, and would put a provider-shaped switch in the shared contract. A separate `verifySignUpCode` is clearer and matches how the SDKs actually model it.
3. **Extend the provider-agnostic contract with `signUp` returning a normalized outcome + a new `verifySignUpCode(code)` method.** **Chosen.** Both providers implement it; the page stays provider-agnostic; the UI mirrors the existing `LoginScreen` verification step; no provider semantics leak into the view.

### Why the durable solution is not more expensive than the shim

The contract change is two small provider methods plus one page state machine. The page-local Supabase shim is one page method — but it is not a complete implementation, because it does not work under the production provider and needs the same contract work later anyway. The two options are within one commit of each other in size, so the durable boundary is chosen now.

### Ownership summary

| Concern | Owner | Change |
|---|---|---|
| Pending verification state | Identity provider (Clerk `signUp` resource / Supabase email+token) | none — already owned |
| "Verification required" signal + code verification | `apps/gymtrack/src/lib/{clerkAuth,supabaseAuth}.jsx` via the `useAuth()` contract | **extended** |
| Verification code UI + inline errors | `apps/gymtrack/src/components/SignUpPage.jsx` | **extended** |
| Protected-route redirect | `AuthGate` + React Router | unchanged |
| Workouts, profiles, RLS, MCP OAuth | `services/gymtrack-mcp`, Supabase Postgres | unchanged — no data model change, no migration |
| `.openclaw` | — | **no changes required** |

### Data model / API contract changes

None. No table, no column, no migration, no server route, no new service. The only contract change is the in-browser `useAuth()` interface.

## `.openclaw` boundary notes

No work outside this repository. Nothing to route to Quinn at `attentionOwners[0]`. No new env var, no Vercel configuration change, no Clerk dashboard configuration change (the verification code is already sent by the existing `signUp` path — this design only adds the UI to enter it).

## Implementation plan

### 1. Provider-agnostic auth contract (`apps/gymtrack/src/lib/authContext.jsx` + `auth.jsx`)

Document the two additions in the contract docstrings:

```js
// signUp(email, password) -> { data, error }
//   data: { needsVerification: boolean, verificationMode?: 'signup_email_code' }
//
// verifySignUpCode(code) -> { data, error }
//   data: { session: string | null }
```

`verificationMode` is `'signup_email_code'` for both providers. It is included so the contract shape matches the existing sign-in contract (`data.verificationMode`) and so a future provider with a different verification mechanism (e.g. a captcha challenge, or an email link) can be added without changing the method signature.

### 2. Clerk provider (`apps/gymtrack/src/lib/clerkAuth.jsx`)

- **`signUp`** — unchanged control flow. The one behavioural change is the return value on the not-yet-verified path: replace `{ data: { pendingVerification: true }, error: null }` with `{ data: { needsVerification: true, verificationMode: 'signup_email_code' }, error: null }`. The existing `clerkSignUpPrepareEmailAddressVerification()` helper already sends the one-time code via `clerkSignUp.verifications.sendEmailCode()` — that call is the reason the user receives a code today, and it must stay exactly where it is. The immediate-session path keeps returning `{ data: { user: clerkSignUp.createdUserId }, error: null }`; it gains `needsVerification: false` so callers can branch on one field.
- **`verifySignUpCode(code)`** (new) — call `clerkSignUp.verifications.verifyEmailCode({ code })`. On success, if `clerkSignUp.status === 'complete'`, call `clerkSignUp.finalize()` and return `{ data: { session: clerkSignUp.createdSessionId }, error: null }`. On failure, return `{ data: null, error: new Error(clerkErrorMessage(error, 'Verification failed.')) }` and call `reportClerkError(error, 'verify_signup_code')` so the failure reaches the hosted Grafana browser-error surface with the same redaction contract used by every other Clerk call in this file (safe code + status only; the raw `longMessage` is never sent to telemetry).
- **No new Clerk dependency or dashboard change.** `signUp.verifications.sendEmailCode()` / `signUp.verifications.verifyEmailCode()` are the same resource methods already in use.

### 3. Supabase provider (`apps/gymtrack/src/lib/supabaseAuth.jsx`)

The Supabase provider is the one-env-var rollback path. It must implement the same contract, or the rollback breaks.

- **`signUp`** — after `supabase.auth.signUp({ email, password })`, detect the confirmation-required case: `data.user != null && data.session == null`. Return `{ data: { needsVerification: true, verificationMode: 'signup_email_code' }, error: null }` in that case; `{ data: { needsVerification: false } }` when a session was returned directly (auto-confirm projects).
- **`verifySignUpCode(code)`** (new) — call `supabase.auth.verifyOtp({ email, token: code, type: 'signup' })`. Supabase's `verifyOtp` needs the email alongside the token, so the provider stores the pending signup email in provider state when `signUp` reports confirmation-required, and `verifySignUpCode` consumes that stored email. **The page never passes the email** — that keeps the UI contract identical across providers and stops the view from becoming a second source of truth for the pending sign-up.
  - On success, supabase-js sets the session and fires `onAuthStateChange`, so the provider's `session` state updates and `AuthGate`/`SignUpPage` observe it. The page's explicit `navigate(from)` after `verifySignUpCode` resolves is the primary path; the `onAuthStateChange` path is the fallback. Both converge on `/workout`.
  - On failure, return `{ data: null, error: new Error(error.message) }` and call `reportAuthError(error, supabaseSafeContext(error, 'verify_signup_code'))`.

### 4. Sign-up page (`apps/gymtrack/src/components/SignUpPage.jsx`)

Add two pieces of state: `verificationMode` (null until the provider says a code is required) and `verificationCode`.

- **`handleSubmit`** — capture the whole envelope:

  ```jsx
  const { data, error: signUpError } = await signUp(email, password);
  setSubmitting(false);
  if (signUpError) { setError(signUpError.message); return; }
  if (data?.needsVerification) {
    setVerificationMode(data.verificationMode ?? 'signup_email_code');
    return;
  }
  navigate(from, { replace: true });
  ```

- **Verification step UI** — rendered as a separate block *below* the sign-up form, mirroring the `LoginScreen.jsx` verification markup: a `<p>` explaining that a code was emailed, a labelled `Verification code` input with `inputMode="numeric"` and `autoComplete="one-time-code"`, the inline error region, and a submit button.

  | Element | testid | Notes |
  |---|---|---|
  | Verification form | `signup-verification-form` | `className="signup-form"` |
  | Code input | `signup-verification-code` | mirrors `login-verification-code` |
  | Inline error | `signup-verification-error` | `className="status show error" role="alert"` — same visual pattern as `login-error` (AC3) |
  | Verify submit | `signup-verify-submit` | disabled while submitting |

  The existing form-level error keeps its own `signup-error` testid so the two regions are unambiguous in tests.

- **Preserving entered values (AC3)** — the email and password inputs stay mounted with their values while the verification step is showing. The **Create account** button is disabled and relabelled **Verification pending** so the user cannot re-submit a sign-up against an account that already exists; the code input stays enabled so a mistyped code can be corrected and retried. Nothing clears `email`, `password`, or `verificationCode` on a failed verification.

- **Success** — `navigate(from, { replace: true })`, exactly as the existing sign-up redirect does. `from` defaults to `/workout` and preserves a protected-route destination carried in `location.state.from` (AC2).

### 5. Documentation (same PR)

- **`apps/gymtrack/SPEC.md`** — the app's behavioural spec. Add the verification step to the sign-up flow, to the `/signup` screen row, and to the e2e-coverage table (pointing at the Vitest coverage, since that is the layer that exercises it).
- **`docs/systems/gymtrack.md`** — the durable system doc. Document the `needsVerification` / `verifySignUpCode` contract, the provider matrix (Clerk `signUp.verifications` vs Supabase `verifyOtp`), and add a runbook entry for the failure mode: *sign-up leaves the user at `/workout` and is bounced to `/login` — means the provider reported `needsVerification` and the page did not render the code field.*

### Milestones

Each is independently reviewable and lands as separate commits on one branch; the ACs are interdependent, so they ship as one PR.

1. **M1 — Contract + Clerk.** `clerkAuth.jsx` returns `needsVerification`; new `verifySignUpCode`; `clerkAuth.test.jsx` coverage for both.
2. **M2 — Page.** `SignUpPage.jsx` verification UI + inline error + value preservation; `SignUpPage.test.jsx` coverage for AC1–AC3.
3. **M3 — Supabase parity.** `supabaseAuth.jsx` `needsVerification` + `verifySignUpCode`; new `supabaseAuth.test.jsx`.
4. **M4 — Docs.** `apps/gymtrack/SPEC.md` + `docs/systems/gymtrack.md`.

### Files touched

| File | Change |
|---|---|
| `apps/gymtrack/src/components/SignUpPage.jsx` | verification step UI, `handleSubmit` branches on `data.needsVerification` |
| `apps/gymtrack/src/lib/clerkAuth.jsx` | `signUp` returns `needsVerification`; new `verifySignUpCode` |
| `apps/gymtrack/src/lib/supabaseAuth.jsx` | `signUp` returns `needsVerification`; new `verifySignUpCode` |
| `apps/gymtrack/src/lib/authContext.jsx` | contract documentation for the two additions |
| `apps/gymtrack/src/components/SignUpPage.test.jsx` | AC1–AC3 coverage |
| `apps/gymtrack/src/lib/clerkAuth.test.jsx` | Clerk contract coverage |
| `apps/gymtrack/src/lib/supabaseAuth.test.jsx` | **new** — Supabase contract coverage |
| `apps/gymtrack/SPEC.md` | app behavioural spec |
| `docs/systems/gymtrack.md` | durable system doc + runbook entry |

No new dependencies. No CSS changes — the verification block reuses the existing `signup-form`, `status show error`, and `btn-primary` classes, which is what makes it visually identical to the `LoginScreen` verification step (AC3).

## Test plan

### Acceptance-criterion verification matrix

This matrix lives in this design only. It must **not** be copied into the PR body — the lobster treats AC checkboxes in a merged PR body as "covered by implementation", and a docs-only commit listing them would create a false coverage signal.

| AC | Verification layer | Test |
|---|---|---|
| **AC1** — verification-code input renders when the account requires verification | component (Vitest) | `SignUpPage.test.jsx` → *"renders the verification-code input when sign-up requires email verification"*: `signUp` resolves `{ data: { needsVerification: true, verificationMode: 'signup_email_code' }, error: null }`; assert `signup-verification-code` is visible, `signup-submit` is disabled and relabelled *Verification pending*, and `signup-email` still holds the entered address |
| **AC2** — correct code completes sign-up and routes to `/workout` | component (Vitest) | `SignUpPage.test.jsx` → *"routes to /workout after the code is verified"*: `verifySignUpCode` resolves `{ data: { session: 'sess_test' }, error: null }`; assert the router location becomes `/workout` (rendered inside `MemoryRouter` with a location spy) |
| **AC3** — wrong/expired code shows an inline error and preserves the entered email/password | component (Vitest) | `SignUpPage.test.jsx` → *"shows an inline error and preserves the entered email and password when the code is wrong"*: `verifySignUpCode` resolves `{ data: null, error: new Error('That code is not valid.') }`; assert `signup-verification-error` shows the message with `role="alert"`, `signup-email` still holds the address, the code input is still enabled, and the Create-account button is still disabled |
| **AC4** — a test exercises submit → code field appears → submit code → land on `/workout` | component (Vitest) | The three cases above compose into the full flow; add one explicit end-to-end-within-the-component test that performs all three transitions in sequence in a single `it()` so the AC is satisfied by one readable test, not only by the sum of three |

### Provider-level coverage (Vitest)

- `clerkAuth.test.jsx` — extend the existing harness:
  - `signUp` with `mocks.signUp.status = 'missing_requirements'` returns `needsVerification: true` and `verificationMode: 'signup_email_code'`, and calls `mocks.signUp.verifications.sendEmailCode()` exactly once.
  - `verifySignUpCode('123456')` calls `mocks.signUp.verifications.verifyEmailCode({ code: '123456' })`, then `mocks.signUp.finalize()`, and returns the created session id.
  - A failed `verifyEmailCode` returns an error envelope and does **not** call `finalize()`.
- `supabaseAuth.test.jsx` (**new file**) — mock `apps/gymtrack/src/lib/supabase.js` and assert:
  - `signUp` with `{ user: { id: 'u1' }, session: null }` returns `needsVerification: true`.
  - `signUp` with `{ user: { id: 'u1' }, session: { access_token: 't' } }` returns `needsVerification: false`.
  - `verifySignUpCode('123456')` calls `supabase.auth.verifyOtp({ email: <the email given to signUp>, token: '123456', type: 'signup' })`.
  - A failed `verifyOtp` returns the error envelope.

### E2E coverage — why Playwright is not the primary layer here

**AC4 explicitly permits** *"Playwright e2e or Vitest with a mocked Supabase client"*. The Vitest layer is primary, for a concrete reason rather than convenience:

- The Clerk path needs a **fresh, never-used email address per run** plus inbox access to read the one-time code. `apps/gymtrack/test/e2e/signin-clerk.spec.ts` already requires dedicated `CLERK_TEST_EMAIL` / `CLERK_TEST_PASSWORD` credentials; there is no disposable-inbox fixture in this repo, and the verification code is single-use, so it cannot be replayed across runs.
- The Supabase path needs a test project with **email confirmation enabled** (the opposite of the auto-confirm setup `signup.spec.ts` requires today), plus the same inbox access.
- Neither provider exposes the pending OTP to the test harness. The Supabase admin API can mint a confirmation link, but that bypasses the user-visible code-entry flow this task is about, so it would not test AC1–AC3 at all.

The gap this leaves is real and is recorded here deliberately: **the end-to-end email delivery + code entry + landing on `/workout` is not covered by a live e2e.** The fallback layer is the component-level Vitest flow (the full state machine, with the provider mocked) plus the provider-level Vitest (the real provider methods, with the SDK mocked). Those two layers together cover every branch the page can take.

**Follow-up (not in this task):** add a disposable-inbox fixture (a Clerk test user backed by a mail-catcher service) so `signup-verification.spec.ts` can drive the live path. That is a separate task because it needs infrastructure Quinn owns, not because the coverage is optional.

## Open questions and risks

| # | Item | Impact | Recommendation |
|---|---|---|---|
| 1 | **Should the Supabase rollback path get full parity?** The production provider is Clerk; the Supabase path is one env-var flip away. | If Supabase parity is skipped, the contract is only half-implemented and the rollback breaks on the same bug. | **Implement both** (M3). The work is small and a half-implemented contract is the kind of debt that surfaces during an incident. |
| 2 | **Resend-code button.** AC3 covers an expired code by showing an inline error, but an expired code is unrecoverable without a resend. | A user whose code expires is stuck. | **Out of scope for this task.** Record as a follow-up. The error message should say the code may have expired rather than only that it is wrong. |
| 3 | **Clerk `signUp` resource lifetime.** `clerkSignUp.verifications.verifyEmailCode` only works while the `useSignUp()` resource is in the pending state. | If the resource is reset, verification fails with a Clerk error surfaced inline. | The verification step renders in the same mounted component and never remounts the provider, so the resource stays alive. The failure mode degrades to the inline error, which is the AC3 behaviour. |
| 4 | **Duplicate code sends.** `clerkSignUpPrepareEmailAddressVerification` already sends the code at sign-up time. | Sending again on the verification step would invalidate the first code and confuse the user. | The verification step **never** sends; it only verifies. One send, at sign-up. |
| 5 | **Error message quality.** Clerk errors carry `longMessage`; the generic fallback would be "Verification failed." | A vague error is a support burden. | Use the existing `clerkErrorMessage()` helper (which prefers `longMessage`) — same as every other Clerk call in the file. |
| 6 | **Telemetry redaction.** The new error paths must not leak user-facing messages into the hosted Grafana surface. | A leak would put user-visible content into an external log. | Reuse `reportClerkError` / `reportAuthError` with the existing safe-context shape (provider, operation, error code, status). No raw message. |
| 7 | **The `from` destination.** `navigate(from, { replace: true })` preserves a protected-route destination. | If `from` is malformed, the user lands somewhere unexpected. | Reuse the existing `fromState` handling in `SignUpPage` unchanged — same expression the sign-in and sign-up success paths already use. |

### Explicitly out of scope

- The Google OAuth "button does nothing" defect (task `7e7826c5`) — separate root cause, separate task, separate PR.
- Any change to the Clerk dashboard configuration, Vercel env vars, or Supabase project settings.
- Resend-code / change-email flows, MFA, and the sign-in verification flow (`LoginScreen` is untouched).
- Removing the Supabase rollback path. It is still the documented one-env-var rollback for task `bb09eaed` and must keep working.
