---
status: draft
task_id: 72d7cc3b-eb7d-458f-809f-b9c627338e3a
product_spec: brain/tasks/specs/in-progress/gymtrack-signup-social-login-2026-07-27.md
shipped_pr: null
shipped_date: null
---

# GymTrack Public Sign-Up with Social Login

## Links

- Product spec: `brain/tasks/specs/in-progress/gymtrack-signup-social-login-2026-07-27.md`
- Tech design: `docs/specs/gymtrack-public-signup-social-login-tech-design.md`
- Task: `72d7cc3b-eb7d-458f-809f-b9c627338e3a`
- Tasks API record: `http://localhost:4001/api/v1/tasks/72d7cc3b-eb7d-458f-809f-b9c627338e3a`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-72d7cc3b-gymtrack-public-signup-social-login`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must enable Google and/or Apple OAuth providers in the Supabase project and provision credentials (boundary lives outside this repo).

## Scope

Today, GymTrack has exactly one account (Tom's), created manually in Supabase Studio. This task ships a public sign-up path on the home page that lets any visitor create their own account, with social login (Google / Apple) as the easiest option. Email + password sign-in must continue to work for Tom.

## Ownership boundary

- Sign-up lives in `apps/gymtrack/`. The user-facing flow is React (Vite) + Supabase Auth.
- Account isolation is enforced by Supabase RLS, which GymTrack already uses for the single-account case. This task adds the same RLS coverage to the new sign-up path so a brand-new account is isolated from the moment of creation.
- OAuth provider config is a Supabase project concern, owned by Quinn (`.openclaw` boundary). Code in this repo can wire the UI to `supabase.auth.signInWithOAuth({ provider: 'google' | 'apple' })` but cannot enable the providers themselves.

## Implementation plan

File/module scope:

- `apps/gymtrack/src/auth/SignUpPage.tsx` (new) — public sign-up page mounted at `/signup`. Renders two CTAs: "Continue with Google" and "Continue with Apple" (primary), and a collapsed "Use email + password" panel (secondary). On success, redirects to `/workouts` (empty state).
- `apps/gymtrack/src/auth/SignInPage.tsx` (existing) — add a "Create account" link to `/signup`. Do not break the existing email/password path.
- `apps/gymtrack/src/auth/supabaseClient.ts` (existing) — confirm the client uses the same `supabase-js` instance; no new config here.
- `apps/gymtrack/src/lib/authFlow.ts` (new) — shared helper for the OAuth redirect flow. Encapsulates `signInWithOAuth` + the post-callback session check.
- `apps/gymtrack/supabase/migrations/<timestamp>_rls_signup_path.sql` (new) — verify / add RLS policies for all tables that already protect the single-account case. Smoke test: insert a row as user A, assert user B's session cannot read it.
- `apps/gymtrack/test/e2e/signup.spec.ts` (new) — Playwright E2E: visits `/signup`, signs up with a fresh email + password, lands on `/workouts`, asserts the empty-state UI is visible.
- `apps/gymtrack/test/e2e/signup-google.spec.ts` (new) — Playwright E2E: clicks "Continue with Google", completes the OAuth flow against the Supabase test project, lands on `/workouts`. Marked as a smoke test that requires Supabase OAuth test credentials in CI.
- `apps/gymtrack/SPEC.md` — add a new flow: "Sign up" describing AC1–AC5.
- `apps/gymtrack/README.md` — short note on the sign-up route and the env vars required for OAuth.

## Data model / API contract

- No new tables. Supabase Auth handles `auth.users`; existing tables gain an `auth.uid()` owner column check via RLS (already in place for the single-account case).
- No public REST contract change.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — unauthenticated visitor sees a clear path to create a new account, distinct from sign-in | E2E `signup.spec.ts`: visits `/`, asserts a "Create account" CTA is visible alongside (not replacing) the existing sign-in. |
| AC2 — visitor can create an account via social login (Google and/or Apple) with no manual provisioning | E2E `signup-google.spec.ts`: completes Google OAuth flow against Supabase test project, lands authenticated, asserts a row exists in `auth.users` for the test email. |
| AC3 — newly created account is fully isolated from the moment of creation | Integration test: sign in as user A, create a workout; sign up as user B in a fresh context; assert B cannot read A's workouts via either the UI or the direct supabase query. |
| AC4 — existing email + password sign-in continues to work for Tom without migration | Existing E2E `signin.spec.ts` (or smoke) still passes; manual smoke in dev environment. |
| AC5 — after sign-up, new user lands somewhere sensible (e.g. empty Workouts state with next-step guidance) | E2E: after OAuth or email signup, lands on `/workouts`, asserts empty-state copy is present. |

User-visible ACs: all 5 are user-visible app flows. E2E coverage is planned for each: AC1, AC2, AC5 via Playwright; AC3 via a per-user isolation test; AC4 via the existing sign-in smoke.

## Open questions and risks

- **Apple provider**: Apple OAuth requires a configured Apple Developer account and a verified domain. If Quinn has not yet provisioned it, ship Google first and add Apple in a follow-up task. The UI must degrade gracefully if the provider is not enabled (hide the button, not show a 500).
- **Existing single-account RLS**: confirm during implementation that the same policies apply to new accounts. If the single-account path used a special admin role, that bypass must NOT carry over to public sign-ups.
- **Rate-limit on sign-up**: out of scope for this task, but sign-up endpoints should sit behind the rate-limit middleware from task `cc7a4e38` once that lands.

## Linked spec

- `brain/tasks/specs/in-progress/gymtrack-signup-social-login-2026-07-27.md`