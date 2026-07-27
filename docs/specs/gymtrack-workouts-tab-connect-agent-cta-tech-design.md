---
status: draft
task_id: 2306125e-942d-42ea-9674-f6ba7941ef59
product_spec: brain/tasks/specs/in-progress/gymtrack-workouts-tab-connect-agent-2026-07-27.md
shipped_pr: null
shipped_date: null
---

# GymTrack Workouts Tab with "Connect to Your Agent" CTA

## Links

- Product spec: `brain/tasks/specs/in-progress/gymtrack-workouts-tab-connect-agent-2026-07-27.md`
- Tech design: `docs/specs/gymtrack-workouts-tab-connect-agent-cta-tech-design.md`
- Task: `2306125e-942d-42ea-9674-f6ba7941ef59`
- Tasks API record: `http://localhost:4001/api/v1/tasks/2306125e-942d-42ea-9674-f6ba7941ef59`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-2306125e-gymtrack-workouts-tab-connect-agent-cta`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must configure the Claude / ChatGPT OAuth clients in Supabase so the CTA's redirect URLs resolve (boundary lives outside this repo). The MCP server side is owned by sibling task `1474d515`.

## Scope

Today, planned workouts for future dates are invisible until the user manually opens the date picker. This task adds a dedicated Workouts tab listing the user's pending planned workouts at a glance, and a "Connect to your agent" CTA supporting Claude and ChatGPT when no agent is connected yet. The CTA must start a real OAuth flow — not a placeholder.

## Ownership boundary

- The tab is `apps/gymtrack/` UI state. It does **not** add a new database table — it reads from the existing `planned_workouts` (or equivalent) table.
- The "Connect to your agent" CTA routes into the OAuth flow shipped by sibling task `1474d515` (GymTrack MCP Server with OAuth Auth). This task ships the UI entry point only; if the OAuth task is not yet merged, the CTA's destination is a thin "Coming soon" stub with the same button shape so the UI is testable.
- Per-user agent connection state lives in a new table (introduced by `1474d515`); this task reads it via the supabase client and renders the CTA conditionally on absence.

## Implementation plan

File/module scope:

- `apps/gymtrack/src/nav/MainNav.tsx` (existing) — add a "Workouts" tab item between the current default tabs. Selected-state styling matches existing items.
- `apps/gymtrack/src/workouts/WorkoutsTab.tsx` (new) — top-level page. Fetches the current user's planned workouts (status `planned` or `started`), sorts by `scheduledFor` ascending, renders one card per workout with date, title, exercise/set summary. Highlights workouts for today or earlier with a distinct accent (e.g. "Today" / "Overdue" badge).
- `apps/gymtrack/src/workouts/WorkoutCard.tsx` (new) — single-workout card. Tap target routes to the existing log screen with the workout's date pre-selected (use the existing date picker query param convention).
- `apps/gymtrack/src/workouts/ConnectAgentCta.tsx` (new) — banner shown when no agent is connected. Two buttons: "Connect Claude" and "Connect ChatGPT", each starting the OAuth flow for the matching provider via `supabase.auth.signInWithOAuth` against the agent-specific client (configured by `1474d515`). Buttons are hidden individually if the provider is not yet configured (graceful degradation).
- `apps/gymtrack/src/workouts/agentConnection.ts` (new) — small helper to read the current agent connection state (e.g. `supabase.from('agent_connections').select('provider').eq('user_id', me).maybeSingle()`).
- `apps/gymtrack/src/router.tsx` (or current router config) — register `/workouts` → `WorkoutsTab`.
- `apps/gymtrack/SPEC.md` — add a new flow "Browse planned workouts" describing AC1–AC5.
- `apps/gymtrack/test/e2e/workouts-tab.spec.ts` (new) — Playwright E2E: sign in as a user with two planned workouts (one today, one next week) and one connected agent. Asserts ordering, today-badge, and absence of the CTA.
- `apps/gymtrack/test/e2e/connect-agent-cta.spec.ts` (new) — Playwright E2E: sign in as a user with no agent connection, asserts CTA is visible with both buttons, clicks Claude → lands on OAuth screen (mocked or smoke-flagged).
- `apps/gymtrack/test/unit/workoutsTab.test.tsx` (new) — Vitest unit test for the sorting/highlight logic, no supabase mocking required.

## Data model / API contract

- Reads: existing `planned_workouts` table; new `agent_connections` table introduced by sibling task `1474d515`.
- Writes: none in this task.
- API: no public REST contract change. The existing `/api/agent/planned-workouts` endpoint is unchanged; this task only adds a UI consumer of it.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — Workouts tab reachable from main nav; lists pending workouts (planned/started) with date, title, exercise summary | E2E `workouts-tab.spec.ts`: sign in, navigate to /workouts, assert cards present with the three fields for each planned workout. |
| AC2 — soonest-first ordering; today/past visually distinguished | Unit test on the sort+highlight helper; E2E asserts the "Today" / "Overdue" badge appears only on the today/past workout. |
| AC3 — when no agent connected, CTA with Claude + ChatGPT options visible | E2E `connect-agent-cta.spec.ts`: user with no agent connection lands on /workouts, asserts CTA with both buttons is present. |
| AC4 — selecting CTA starts the authorization flow — not a dead end | E2E: clicking Claude navigates to the OAuth provider URL (asserts the redirect started; full OAuth completion tested by `1474d515`). |
| AC5 — tapping a pending workout lands on log screen with date pre-selected | E2E: tap a workout card, assert URL contains the date param and the log screen renders for that date. |

User-visible ACs: all 5 are user-visible app flows. E2E coverage is planned for each via Playwright.

## Open questions and risks

- **Dependency on `1474d515`**: the CTA cannot function until the OAuth flow ships. Two options:
  1. Ship this UI first with the CTA pointing at a placeholder route; revisit once `1474d515` merges.
  2. Land both tasks together.
  Prefer option 1 — the UI is independently testable and the placeholder gives Quinn a UI to review without blocking on auth.
- **Today vs past badge**: spec says "today or past" is distinguished. We use a single "Today" badge for today and an "Overdue" badge for past dates. If Quinn prefers a single shared badge, one-line change.
- **Empty state**: when there are zero pending workouts, the page should still render with a friendly empty state plus the CTA (if applicable). Add this to AC1 verification.

## Linked tasks / spec

- `brain/tasks/specs/in-progress/gymtrack-workouts-tab-connect-agent-2026-07-27.md`
- Sibling task: `1474d515` — GymTrack MCP Server with OAuth Auth.