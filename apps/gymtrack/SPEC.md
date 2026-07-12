# GymTrack — Behavioural spec

Task: `18256740` (Shape GymTrack MVP from saved prototype).
Tech design: `docs/specs/gymtrack-mvp-tech-design.md`.
Product spec: `brain/tasks/specs/gymtrack-mvp-2026-07-07.md`.

## Overview

GymTrack is a single-user workout tracker for Tom. It is a standalone SPA deployed at a stable URL, accessible from iOS Safari without an app install. Workouts are persisted in Supabase, scoped to Tom's user account via RLS. The MVP replaces the localStorage-based prototype (`apps/gymtrack/` on `feat/gymtrack-prototype`) with a real auth + real database.

## Users

- **Tom** — sole user in v1. Email + password sign-in. RLS is configured to scope all data to `auth.uid() = user_id` so even if a second user is provisioned in error, they cannot read Tom's data.

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

## E2E coverage

| Flow                | Spec file                              |
|---------------------|----------------------------------------|
| Sign in → land on `/workout` | `test/e2e/log-workout.spec.ts`  |
| Add 2 sets → save → see in history | `test/e2e/log-workout.spec.ts` |

Playwright runs against the Vite dev server on port 5179 with `iPhone 13` device emulation.

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