# GymTrack — Behavioural spec

Task: `18256740` (Shape GymTrack MVP from saved prototype), `f520c396` (Agent-Powered Workouts).
Tech design: `docs/specs/gymtrack-mvp-tech-design.md`, `docs/specs/gymtrack-agent-powered-workouts-tech-design.md`.
Product spec: `brain/tasks/specs/gymtrack-mvp-2026-07-07.md`, `brain/tasks/specs/in-progress/gymtrack-agent-powered-workouts.md`.

## Overview

GymTrack is a single-user workout tracker for Tom. It is a standalone SPA deployed at a stable URL, accessible from iOS Safari without an app install. Workouts are persisted in Supabase, scoped to Tom's user account via RLS. The MVP replaces the localStorage-based prototype (`apps/gymtrack/` on `feat/gymtrack-prototype`) with a real auth + real database.

As of task `f520c396`, an authenticated agent can also submit a **planned workout** on Tom's behalf via a server-side API. The app surfaces the plan (if one exists for the selected date) in place of freeform logging, lets Tom log actuals against each planned set, and stores both target and actual values side by side. Agents can also read back recent history and per-exercise progression to inform the next plan.

## Users

- **Tom** — sole user in v1. Email + password sign-in. RLS is configured to scope all data to `auth.uid() = user_id` so even if a second user is provisioned in error, they cannot read Tom's data.
- **Agents** — authenticate to the agent-facing API via a bearer token (see [Agent API](#agent-api) below). An agent acts as the `user_id` its token was issued for; it cannot see or write other users' data. **As of this writing there is no self-service key-generation UI in the app** — every issued token today has been created by direct Supabase service-role insert, not through a flow a real external agent/user could complete unassisted. See Non-goals / Known gaps.

## Flows

### Sign in (AC5)

1. Open the URL → unauthenticated users land on `/login`.
2. Enter email + password → submit.
3. On success → redirect to `/workout` (or to the originally intended destination if redirected from a protected route).
4. On error → inline error banner; submit button re-enabled.

### Log a workout (AC1)

1. From `/workout`, the date defaults to today.
2. Pick an exercise from the catalogue (~29 entries) or choose "Other" and type a custom name.
3. Enter reps and weight; select kg/lb.
4. Tap "Add set" → the set appears under "In this workout", grouped by exercise.
5. Repeat for additional sets/exercises. Remove a set via its Remove button.
6. Tap "Save workout" (sticky at the bottom on mobile) → creates the workout + all sets in Supabase.
7. On success → success banner; pending list cleared.
8. On error → error banner; pending list retained so the user can retry.

### View history (AC2)

1. From `/history`, the last 30 days of workouts load.
2. Workouts are grouped by date (newest first). Each workout shows its set count and the per-set breakdown (exercise, set index, reps × weight unit).
3. Empty state: "No workouts in the last 30 days. Log one from the Log tab."

### Log a workout against a plan (AC2, agent-powered)

1. From `/workout`, if a planned workout exists for the selected date (`status` in `planned`/`started`), the screen renders **plan mode** instead of the freeform form.
2. Plan mode shows the plan's title and optional notes, then one table per exercise. Each row shows the target (reps × weight + unit) and editable actual-reps/actual-weight/unit inputs, pre-filled with the target values.
3. An "Add an extra (non-planned) set" form remains available below the plan for sets outside the plan.
4. Tap "Save workout" → creates a `workouts` row linked to the plan (`planned_workout_id`) and one `workout_sets` row per planned set (linked via `planned_set_id`) using the actual values entered, plus any extra freeform sets. The plan is marked `completed`.
5. On success → success banner; plan clears from the screen (a `completed` plan is not re-shown for that date).
6. If no plan exists for the selected date, the screen falls back to freeform logging (see "Log a workout" above). **The date shown is whatever is in the date picker — it defaults to today, not the plan's `scheduled_for` date.** If an agent creates a plan for a future date, Tom must change the date picker to that date to see it; the plan does not surface early.

### Sign out

- From `/workout`, tap "Sign out" → session cleared → redirect to `/login`.

## Screens

| Route       | Component         | Notes                                                       |
|-------------|-------------------|-------------------------------------------------------------|
| `/`         | redirect          | → `/workout` if signed in, else `/login`.                    |
| `/login`    | `LoginScreen`     | Email + password form.                                      |
| `/workout`  | `WorkoutLogger`   | Date picker + exercise picker + reps/weight + pending sets. |
| `/history`  | `HistoryList`     | Last-30-days grouped by date.                               |
| `*`         | redirect          | → `/` (which then redirects based on session).              |

All protected routes (`/workout`, `/history`) are wrapped in `<AuthGate>` which:

- Renders a loading placeholder while the initial session resolves.
- Redirects to `/login` (preserving the intended destination) if no session.

## Persistence

- `public.workouts` — one row per workout session. Columns: `id`, `user_id`, `performed_at`, `notes`, `created_at`, `updated_at`. RLS: `auth.uid() = user_id`.
- `public.workout_sets` — one row per set. Columns: `id`, `workout_id`, `exercise_name`, `set_index`, `reps`, `weight`, `unit`. RLS: parent `workouts.user_id = auth.uid()`.
- Indexes: `(user_id, performed_at desc)` on `workouts` for the 30-day query; `(workout_id, set_index)` on `workout_sets` for set ordering.
- Cascade: deleting a workout deletes its sets (`on delete cascade`).

## Auth

- Supabase Auth, email + password only (no magic link in v1).
- Session persisted in `localStorage` via Supabase's default storage adapter.
- `autoRefreshToken: true` keeps the session alive across reloads.
- `detectSessionInUrl: true` handles email-link confirmation redirects if Tom ever resets his password.

## Error handling

- All `workouts.js` functions return `{ data, error }`; they never throw to the caller.
- Component banners (`status.error`) render the error message inline; the user can retry.
- The app fails fast at startup if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing (clear error pointing to `.env.example`).

## Agent API

Server-side (Vercel serverless) endpoints under `apps/gymtrack/api/agent/`, implemented in `apps/gymtrack/server/agentAuth.js` + per-route handlers. These are separate from the browser app's Supabase anon-key access — they use the Supabase **service-role key** server-side and authenticate the caller via a bearer token, not a Supabase session.

### Auth

- Header: `Authorization: Bearer <token>`.
- Server hashes the token with SHA-256 and looks up a non-revoked row in `public.gymtrack_agent_api_keys` (`token_hash`, `revoked_at is null`).
- On success, the request acts as that row's `user_id`; `last_used_at` is updated best-effort.
- On failure (missing/malformed header, no matching row, revoked): `401 { "error": "invalid_api_key" }`.
- **Known gap:** there is no in-app flow for a user to generate their own key yet. Every key that exists today was inserted directly via the Supabase service-role key from outside the app (see Known gaps below).

### Endpoints

- `POST /api/agent/planned-workouts` — create a planned workout (title, optional notes, `scheduledFor` date, list of exercises each with target sets). Validates bounds (max 25 exercises, max 20 sets/exercise, max 200 sets total; positive reps; non-negative weight; unit `kg`/`lb`). Returns `201 { plannedWorkoutId, setCount }`. Implementation: `apps/gymtrack/api/agent/planned-workouts.js`.
- `GET /api/agent/history?limit=1..50` (default 10) — the caller's recent workouts with sets, including linked planned target (if any) per set. Implementation: `apps/gymtrack/api/agent/history.js`.
- `GET /api/agent/exercises/:exerciseName/progression?limit=1..200` (default 20) — chronological set history for one exercise (case-insensitive exact match), with linked planned target per set. Implementation: `apps/gymtrack/api/agent/exercises/[exerciseName]/progression.js`.

All three return `400 invalid_request` on bad input, `401 invalid_api_key` on auth failure, `405 method_not_allowed` on wrong verb, `500 server_error` on unexpected failure.

### Discovery

**There is no machine-readable API discovery surface (no OpenAPI spec, no MCP server, no `/api/agent` index route).** An agent needs this SPEC.md section or direct source access to know the contract exists. This is a known gap — see Known gaps below.

## E2E coverage

| Flow                | Spec file                              |
|---------------------|----------------------------------------|
| Sign in → land on `/workout` | `test/e2e/log-workout.spec.ts`  |
| Add 2 sets → save → see in history | `test/e2e/log-workout.spec.ts` |

Playwright runs against the Vite dev server on port 5179 with `iPhone 13` device emulation.

**Agent API and plan-mode flows have unit/component coverage (`src/lib/plannedWorkoutsHandler.test.js`, `src/lib/historyHandler.test.js`, `src/lib/progressionHandler.test.js`, `src/lib/agentAuth.test.js`, `src/lib/plannedWorkouts.test.js`) but no Playwright e2e coverage yet.** Add e2e coverage for: agent creates a plan → plan renders in plan mode → actuals saved → history/progression reflect it.

## Out of scope (v1)

- HealthKit / Apple Health sync (deferred to follow-up; see spike `a1c8f88e`).
- Offline queue / sync.
- Magic-link auth.
- Push notifications.
- Rest timer.
- Exercise categories / favourites.
- Volume / PR analytics.
- Export / CSV / Apple Health import.

## Non-goals

- Multi-user: only Tom's account exists in production. RLS is the safety net.
- Cross-app coordination with Mission Control — GymTrack is a standalone deploy; a future "Open GymTrack" link from Mission Control is a separate task.