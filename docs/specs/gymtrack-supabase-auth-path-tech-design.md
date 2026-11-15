---
status: draft
task_id: ca999d95-2e2f-4d42-9de7-667e0565e98c
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# GymTrack Supabase auth path — the `accessToken` option replaces `supabase.auth` with a throwing proxy — Tech Design

## Product spec link

- **Task:** `ca999d95-2e2f-4d42-9de7-667e0565e98c` — 💻 Fix the GymTrack Supabase auth path throwing at mount (accessToken option replaces supabase.auth with a throwing proxy)
- **Product spec:** n/a — this is a `code` task with no separate `brain/` product-spec document. The design intent is the task description and the AC text, which are quoted verbatim in the verification matrix below.
- **Related:** task `8c3aa401-fed8-4f51-a93c-6ab69eea6419` (AC3 real-application telemetry resilience) is blocked on this task being fixed — its "runnable Supabase path" alternative depends on the Supabase provider mounting successfully. This design also records the Clerk-path finding that task needs (see Risk R1).

## Task and repository

- **Task ID:** `ca999d95-2e2f-4d42-9de7-667e0565e98c`
- **Task title:** 💻 Fix the GymTrack Supabase auth path throwing at mount (accessToken option replaces supabase.auth with a throwing proxy)
- **Task type:** `code` — dispatched through `agents/workflows/feature-task/code-task.lobster.yaml`. The tech-design gate is satisfied by this document plus Quinn's structured `tech_design` approval.
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-ca999d95-supabase-auth-path`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-ca999d95-supabase-auth-path`
- **PR:** (pending — opened as **DRAFT** once Quinn approves this design; converted to ready-for-review when the AC evidence is wired and `[implementer-prs]` is posted)

## Product intent summary

GymTrack has two identity implementations behind one provider-agnostic `useAuth()` surface: Supabase Auth (the default, `VITE_AUTH_PROVIDER` unset or `supabase`) and Clerk (`VITE_AUTH_PROVIDER=clerk`, which is what production runs today). Both share a single `supabase-js` client, because the client is also the PostgREST transport for every read and write — the bearer token on those requests is the identity token either way.

The two providers need opposite things from that client. Supabase Auth needs supabase-js's **own** auth client, because the Supabase session token is what PostgREST expects. Clerk needs the client to send a **Clerk** JWT instead, which supabase-js supports through its `accessToken` callback.

Those two requirements are mutually exclusive inside supabase-js. When the `accessToken` option is present, the constructor does not build a real auth client at all — it installs a proxy that throws on every property access. The current code passes the `accessToken` option **unconditionally**, so the Supabase provider is handed a client whose `auth` surface explodes on contact.

The practical consequence: the default provider path cannot mount. That is not a cosmetic defect — it means the documented one-env-var rollback path (`VITE_AUTH_PROVIDER=supabase`) is not actually a rollback path, local and dev verification of the Supabase path is impossible, and the real-application telemetry criteria tracked on task `8c3aa401` cannot be exercised.

## Verified failure mechanism

Every claim below was checked against the repository and the installed dependency, not inferred.

**1. The SDK replaces `auth` with a throwing proxy when `accessToken` is set.**
`node_modules/@supabase/supabase-js` is at **2.118.0** (`apps/gymtrack/package.json` declares `^2.45.0`). Its constructor (`dist/index.mjs`):

```js
if (!settings.accessToken) {
    this.auth = this._initSupabaseAuthClient(settings.auth, this.headers, settings.global.fetch);
} else {
    this.accessToken = settings.accessToken;
    this.auth = new Proxy({}, { get: (_, prop) => {
        throw new Error(`@supabase/supabase-js: Supabase Client is configured with the accessToken option, accessing supabase.auth.${String(prop)} is not possible`);
    } });
}
```

The proxy's `get` trap throws on **any** property access — `getSession`, `getUser`, `onAuthStateChange`, `signInWithPassword`, everything.

**2. The behaviour difference is reproduced empirically**, using the repository's own `node_modules` (script run from the canonical checkout, then deleted):

```
accessToken SET   : getSession() THREW -> @supabase/supabase-js: Supabase Client is configured with the accessToken option, accessing supabase...
accessToken ABSENT: getSession() resolved -> session=null
```

**3. The app passes the option unconditionally.**
`apps/gymtrack/src/lib/supabase.js:87-105` builds the client with `auth: { persistSession, autoRefreshToken, detectSessionInUrl, storage }` — those four are already provider-conditional — **and** an `accessToken` callback that is always present. The callback correctly returns `null` when no Clerk getter is registered, but returning `null` is irrelevant: the *presence* of the option is what selects the proxy branch.

**4. The mount effect calls straight into it.**
`apps/gymtrack/src/lib/supabaseAuth.jsx:79` — `supabase.auth.getSession()` — and `:85` — `supabase.auth.onAuthStateChange(...)` — both inside the provider's mount effect. The property access throws before the promise is even created, so the throw is synchronous inside the effect and the provider never reaches `setLoading(false)`: the app hangs on the auth gate rather than surfacing an error.

## Service boundary and data ownership

**Natural source of truth: the app-local client-construction contract.**

`getActiveProvider()` in `apps/gymtrack/src/lib/clerkConfig.js` is already the single source of truth for which identity implementation is active — it validates the env value, defaults to `supabase`, and is read at module load by `main.jsx`, `auth.jsx`, `authFlow.js`, `App.jsx` and `supabase.js` alike. The fix **derives** the supabase-js client options from that existing source of truth. It introduces no new flag, no new env var, no second module-level source of truth, and no cross-app contract.

This is deliberately *not* an API-owned contract, *not* database-backed domain data, and *not* a shared package: `apps/gymtrack/src/lib/supabase.js` is consumed only by GymTrack (the eight importers are all under `apps/gymtrack/src/`). GymTrack is the only consumer of this client, so the fix belongs in the app.

**Why this is the durable shape and not an interim shim.** The two candidate shapes are (a) don't pass `accessToken` when the provider does not use it, or (b) pass an `accessToken` callback that is "inert" on the Supabase path. The SDK does not offer (b) — any truthy `accessToken` selects the proxy branch — so (b) would require reaching around the SDK or re-implementing its auth client. Shape (a) is both the smaller change and the final shape: the client is constructed exactly as the active provider requires. There is no follow-up migration implied by it.

**A second, stronger reason (a) is correct rather than merely convenient:** under (a), a Clerk token can never leak into the Supabase path, because the Supabase path has no `accessToken` callback to read the registered getter. Under (b), a Clerk session token registered by a stray `ClerkAuthProvider` mount would be sent as the bearer token to Supabase on the Supabase path. The fix removes a credential-mixing hazard, not just a crash.

## Implementation plan

### File / module scope

```
apps/gymtrack/
  src/lib/
    supabase.js                  # EDIT — build the options object; add `accessToken` only on the clerk path
    supabaseClientOptions.test.js # NEW — provider → client-options contract, both branches
    supabaseAuthMount.test.jsx    # NEW — real supabase-js; the Supabase provider mounts and getSession() resolves
  SPEC.md                        # EDIT — record that the Supabase provider path mounts and owns its own session
docs/specs/
  gymtrack-supabase-auth-path-tech-design.md   # this document
```

No other file changes. No dependency change. No schema change. No endpoint change. No env var change.

### Detailed behaviour — `apps/gymtrack/src/lib/supabase.js`

The current shape evaluates `getActiveProvider()` three times inline and appends `accessToken` unconditionally. The new shape resolves the provider once, keeps the existing `auth` options exactly as they are, and adds the `accessToken` option only for the Clerk path:

```js
const activeProvider = getActiveProvider();
const isSupabaseProvider = activeProvider === 'supabase';

const clientOptions = {
  auth: {
    persistSession: isSupabaseProvider,
    autoRefreshToken: isSupabaseProvider,
    detectSessionInUrl: isSupabaseProvider,
    storage: window.localStorage
  }
};

if (!isSupabaseProvider) {
  // Clerk path: supabase-js sends the Clerk session JWT as the bearer token.
  clientOptions.accessToken = async () => {
    if (!liveAccessTokenGetter) return null;
    try {
      const token = await liveAccessTokenGetter();
      return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  };
}

export const supabase = createClient(url, anonKey, clientOptions);
```

Points that matter:

- **The `accessToken` callback body is unchanged**, byte for byte. Only *whether it is supplied* changes. The Clerk path therefore keeps the identical token-resolution behaviour: the live getter, the `null` fallback for "no session / anon request", and the swallow-on-throw behaviour that lets RLS reject a torn-down session.
- **`setSupabaseAccessTokenGetter` stays exported and keeps its current contract.** On the Supabase path the registered getter is simply never read, because no `accessToken` callback exists. `SupabaseAuthProvider` already registers `null` on mount and unmount, and that call stays harmless.
- **The SSR / server-context guard stays above the `createClient` call.** `apps/gymtrack/src/lib/supabase.js:14-19` throws when `typeof window === 'undefined'`; the NOTE at `:80-86` calls out that reordering the guard above `createClient` breaks SSR/build-time evaluation. This change does not move that guard.
- **`getActiveProvider()` is now called once instead of three times.** It throws for an invalid `VITE_AUTH_PROVIDER` value, and it used to throw from inside the options object literal — i.e. after `createClient`'s arguments were partly evaluated. Hoisting the call above the options object keeps the same fail-fast behaviour (an invalid provider still throws at module load, before a client is constructed) and makes the branch explicit.

### What explicitly does *not* change

- `apps/gymtrack/src/lib/supabaseAuth.jsx` — no edit. The mount effect starts working because the client it calls into now has a real auth surface.
- `apps/gymtrack/src/lib/clerkAuth.jsx` — no edit. The Clerk bridge (`getAccessToken` → `setSupabaseAccessTokenGetter` → the `accessToken` callback) is untouched.
- `apps/gymtrack/src/lib/authFlow.js` — no edit. Its `supabase.auth.*` call sites are already provider-guarded with an early return under Clerk.
- The provider-agnostic `useAuth()` contract — no edit.

## Data model and API contract changes

**None.** No Prisma schema, no migration, no REST/GraphQL surface, no public type, no serialisation format. The app's public contract (`useAuth()` returning `{ session, user, loading, signIn, signUp, signOut, startOAuthRedirect, getAccessToken }`) is unchanged; the fix changes which SDK object backs it on the Supabase path.

## `.openclaw` boundary notes

- **No `.openclaw` writes.** Rowan cannot write to `~/.openclaw/` and this design does not need to.
- **No env var flip is required.** `VITE_AUTH_PROVIDER` stays wherever it is. The Supabase path becomes *usable*; nothing has to change in Vercel for this PR to land.
- **No secrets are involved or added.** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are public-by-design values that already exist and are unchanged. The Clerk publishable key is unchanged. Nothing in this change is a credential.
- **Rollback-path note for Quinn:** because the `supabase` value of `VITE_AUTH_PROVIDER` is documented as the one-env-var rollback path, this PR is what makes that claim true. No deploy action is needed to benefit from it, but the value of the rollback path rises once it lands.

## Test plan — AC verification matrix

| AC | Verification layer | Where |
|---|---|---|
| AC1 — Supabase provider path mounts without throwing when `VITE_AUTH_PROVIDER=supabase` and the `accessToken` option is absent or inert | unit + component | `supabaseClientOptions.test.js` (options contract) + `supabaseAuthMount.test.jsx` (real SDK, real mount) |
| AC2 — Clerk provider path unchanged: the `accessToken` bridge still supplies the Clerk session token, and RLS still sees `auth.uid()` from the Clerk subject | unit | `supabaseClientOptions.test.js` |
| AC3 — a regression test covers both provider branches | unit | `supabaseClientOptions.test.js` + `supabaseAuthMount.test.jsx` |
| AC4 — `apps/gymtrack/SPEC.md` updated if the observable auth behaviour changes | doc | `apps/gymtrack/SPEC.md` § Identity provider switch / § Auth |

### AC1 — Supabase provider mounts and `getSession()` resolves

Two layers, deliberately, because each catches a different regression:

**Layer 1 — options contract** (`apps/gymtrack/src/lib/supabaseClientOptions.test.js`). `@supabase/supabase-js` is mocked so `createClient` is a spy that captures its options argument. With `VITE_AUTH_PROVIDER` unset (the default):

- the captured options have **no `accessToken` property** — this is the assertion that would fail if someone re-added the option unconditionally;
- `auth.persistSession`, `auth.autoRefreshToken` and `auth.detectSessionInUrl` are all `true` (the existing Supabase-path behaviour is preserved);
- `auth.storage` is `window.localStorage`.

**Layer 2 — real SDK, real mount** (`apps/gymtrack/src/lib/supabaseAuthMount.test.jsx`). This file does **not** mock `@supabase/supabase-js`; it uses the real 2.118.0 client against stubbed dummy `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. With `VITE_AUTH_PROVIDER=supabase`:

- `await supabase.auth.getSession()` **resolves** with `{ session: null }` and does not throw. This is the exact call the mount effect makes, against the exact SDK that throws today;
- `supabase.auth.onAuthStateChange` is a function (not a throwing accessor);
- rendering `<SupabaseAuthProvider>` reaches `loading === false` through the context — i.e. the mount effect completed, which is the observable form of "the provider path mounts".

Layer 2 is the load-bearing one: it exercises the real SDK's proxy branch rather than a test double's idea of it. A regression that re-adds the `accessToken` option fails Layer 2 with the SDK's own "accessing supabase.auth.getSession is not possible" error.

### AC2 — the Clerk path is unchanged

- With `VITE_AUTH_PROVIDER=clerk`, the captured options **do** carry an `accessToken` **function** (the option is present exactly as today);
- invoking that captured callback with no getter registered returns `null` (anon request — unchanged);
- registering a getter via `setSupabaseAccessTokenGetter(() => 'clerk-jwt')` and then invoking the captured callback returns `'clerk-jwt'` — **the bridge still supplies the Clerk session token**;
- a getter that throws returns `null` rather than propagating (unchanged swallow-on-throw);
- `auth.persistSession` / `autoRefreshToken` / `detectSessionInUrl` remain `false` on the Clerk path.

**On the RLS half of AC2:** the fix does not touch the bearer token on the Clerk path, so the token Supabase Third-Party Auth verifies, and the `auth.uid()` → Clerk-subject resolution that the RLS policies depend on, are unaffected. That property is enforced by `supabase/migrations/20261013000000_clerk_phase_4_link_existing_user…` and the Phase 4 policies — not by this file. The regression risk this PR could have introduced is *the token reaching the wire differently*, and the tests above pin that the token resolution logic is byte-identical. The RLS integration itself is covered by `apps/gymtrack/src/lib/clerkRlsMigration.test.js` and by `infra/cloud/scripts/run-clerk-rls-test.sh` (live Clerk + Supabase boundary test, operator-run) — neither needs to change for this PR, and neither is re-run by it.

### AC3 — both branches are covered by the regression suite

Both files above are provider-parameterised, and each asserts the *opposite* expectation for the other provider. A regression that flips the branch fails one file; a regression that drops the `accessToken` option entirely fails the other.

### AC4 — `apps/gymtrack/SPEC.md`

The observable auth behaviour **does** change: the Supabase provider now mounts and manages its own session, so the documented "one-env-var rollback path" becomes real. `apps/gymtrack/SPEC.md` is updated in two places — § "Identity provider switch" (the `supabase` bullet) and § "Auth" — to state that the Supabase provider mounts, owns its session via `supabase.auth`, and that the two providers' `supabase.auth` surfaces differ by design. The E2E coverage table in `SPEC.md` gains a row for the new mount regression spec.

### E2E coverage — and why it is not the primary layer here

A Playwright spec is **not** the primary verification for this change, and the reason is recorded here rather than left implicit:

- The failure is in the SDK client construction, not in a user-visible flow. The app-level symptom is "the auth gate never resolves", which the component test in `supabaseAuthMount.test.jsx` reproduces exactly and deterministically, without a browser, a network, or a Supabase project.
- A Playwright spec for the Supabase provider needs a live Supabase project (the existing `apps/gymtrack/test/e2e/signup.spec.ts` documents this requirement). Driving the real app at mount does **not** need a working Supabase — the mount effect calls `getSession()`, which resolves locally from storage when there is no session — so a mount-level e2e is possible, but it would assert the same thing the component test asserts, more slowly and with more moving parts.
- **Decision:** the component + real-SDK layer is the primary verification. If the e2e suite is run with a live Supabase project available, the existing `signup.spec.ts` sign-up and sign-in cases become meaningful regression coverage for the Supabase path for free, and no new Playwright spec is added by this PR. The one user-visible flow that this change makes newly reachable — "the Supabase provider path works end to end" — is covered by those existing specs rather than by a new file.

### Mutation checks to run against the implementation

Each of these must make a test fail:

| Mutation | Test that must fail |
|---|---|
| Re-add `accessToken` unconditionally to the options object | `supabaseAuthMount.test.jsx` (SDK proxy error) |
| Add `accessToken` as a no-op function on the Supabase path | `supabaseAuthMount.test.jsx` (same) |
| Drop the `accessToken` option on the Clerk path | `supabaseClientOptions.test.js` (AC2 assertion) |
| Return `undefined` instead of `null` from the `accessToken` callback | `supabaseClientOptions.test.js` (null-fallback assertion) |

## Out of scope

- **The Clerk path's `supabase.auth` surface.** AC2 requires the Clerk path to be unchanged, and this PR honours that. The unguarded Clerk-path call sites are a separate defect — see Risk R1, which carries a recommended follow-up.
- **Removing the Supabase provider.** The `migrate-gymtrack-identity-supabase-auth-to-clerk` design's Phase 5 removes the Supabase path entirely. This task makes it work in the meantime; it does not start that removal.
- **Provisioning Clerk e2e credentials.** That is the operator-only action that task `8c3aa401` is waiting on. This task does not need it.

## Open questions and risks

**R1 — The Clerk path has the same `supabase.auth` hazard at three unguarded call sites, and this PR does not fix them (by design, per AC2).**

`apps/gymtrack/src/lib/authFlow.js:102` and `:140` guard their `supabase.auth.*` calls with an early return under Clerk. Three other call sites do **not**:

| Call site | Call | Reachable under Clerk? |
|---|---|---|
| `apps/gymtrack/src/lib/workouts-auth.js:17` | `supabase.auth.getUser()` | Yes — `createWorkout` → `requireAuthenticatedUser()` |
| `apps/gymtrack/src/lib/connectedAgents.js:38` | `supabase.auth.getSession()` | Yes — `revokeConnectedAgent` |
| `apps/gymtrack/src/lib/supabaseAuth.jsx:79,85` | `getSession()` / `onAuthStateChange()` | No — the Supabase provider is not mounted under Clerk |

`requireAuthenticatedUser()` is reached from `createWorkout` (`apps/gymtrack/src/lib/workouts.js:29`), which `WorkoutLogger.jsx:125` calls on Save, and `WorkoutLogger` is rendered by `AuthGate` on `/workout` for **any** provider with a session. On the Clerk path, `supabase.auth` is the throwing proxy, so `requireAuthenticatedUser()` **throws** rather than returning its `{ user: null, error }` envelope. `WorkoutLogger.handleSave` wraps the call in `try/catch` (`WorkoutLogger.jsx:123`), so the failure degrades to an inline error banner rather than a crash — but the workout is not saved.

**Why this is not fixed here:** AC2 explicitly requires the Clerk path to be unchanged, and the durable fix is a different one — `requireAuthenticatedUser()` should resolve the user from the provider-agnostic auth context rather than from `supabase.auth`, instead of adding a third provider guard. That is a separate change with its own blast radius.

**What is verified, and what is not.** Verified: the SDK's proxy throws on any `supabase.auth` property access (reproduced empirically against the installed 2.118.0); the production bundle inlines `VITE_AUTH_PROVIDER:\`clerk\`` (`https://gymtrack.sindustries.co.nz/assets/index-DkcSpXWb.js`); the Clerk path reaches `createWorkout` through `AuthGate` → `WorkoutLogger`; `workouts-auth.js` carries no provider guard. **Not verified here:** whether this manifests as a user-visible production failure in practice. That needs either the hosted Grafana telemetry, a production sign-in-and-save walkthrough, or Tom's confirmation that workout saving works on the live Clerk deployment. It is raised here because the code path is real and the consequence is a silently failing write, and it is **not** escalated to Tom as a confirmed outage because that has not been established.

**Recommendation:** raise a follow-up task against the Clerk path — "workout save and agent-consent revoke call `supabase.auth` on the Clerk path" — with the durable fix being identity resolution from the auth context. Proposed as a separate task rather than folded into this PR, because this PR's ACs are about the Supabase path and folding in a Clerk-path refactor would break AC2.

**R2 — The user-visible benefit of this PR is the rollback path, not production.** Production runs Clerk, so nothing changes for production users of GymTrack. What changes: the `supabase` rollback value becomes genuinely usable; local/dev verification of the Supabase path becomes possible; and task `8c3aa401` gains a runnable path for its application-flow evidence. Reviewers should size the PR accordingly — it is a correctness fix with a narrow blast radius, not a user-facing feature.

**R3 — `detectSessionInUrl` and the Clerk path.** On the Clerk path `detectSessionInUrl` is already `false`, and this change does not touch it. The Clerk provider handles its own redirect and callback parsing via `<ClerkProvider>` (SPEC.md § Auth). No change.

**R4 — HMR and module-load timing.** `getActiveProvider()` is read at module load, so the provider is fixed for the lifetime of the bundle — that is pre-existing and documented in `clerkConfig.js` and `auth.jsx`. `setSupabaseAccessTokenGetter` remains module-scoped for the same reason the existing design gives: the supabase-js singleton is created once at module load and the Clerk session closure must outlive the component tree. This PR does not alter either lifetime.

**R5 — Test dependency on the real SDK.** Layer 2 of the AC1 test deliberately does not mock `@supabase/supabase-js`, so it is coupled to the installed SDK's behaviour. That is the point — the regression being prevented is an SDK-behaviour regression — but it does mean an SDK major bump could require revisiting the test. The pinned dependency range (`^2.45.0`) and the lockfile keep the installed version at 2.118.0. If the SDK ever changes the `accessToken` contract, the SDK itself becomes the source of truth and this design's premise must be re-checked.
