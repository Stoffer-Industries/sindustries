---
status: draft
task_id: 18256740-5f72-488b-82db-71066502e0e6
product_spec: brain/tasks/specs/gymtrack-mvp-2026-07-07.md
shipped_pr: null
shipped_date: null
---

# Shape GymTrack MVP from saved prototype — tech design

## Links

- Product spec: `brain/tasks/specs/gymtrack-mvp-2026-07-07.md`
- Prototype preserved at: `feat/gymtrack-prototype` branch, commit `10beff5` ("chore: preserve gymtrack prototype")
- Prototype location: `apps/gymtrack/` (vanilla HTML/CSS/JS + `dist/index.html` + `server.js`, port 3000)
- Prototype README: `apps/gymtrack/README.md` (states "Vanilla HTML/CSS/JS — no framework needed" + localStorage + Vercel)
- HealthKit spike (parallel, deferred): task `a1c8f88e` (not in this PR's scope; result feeds a follow-up task)
- Existing monorepo web-app precedent: `apps/budget-mobile/` (newest web app in this repo — Vite + React + Supabase client pattern, deployed as a static SPA)
- Mission Control tab registry (host for future "GymTrack" tab): `apps/mission-control/src/pulseTabs.js`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-18256740-gymtrack-mvp`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-18256740-gymtrack-mvp`
- No secondary repos. The change is contained in `apps/gymtrack/` (rewrite + Supabase wiring). No cross-repo coordination.

## Product intent (from approved product spec)

- Outcome: ship a mobile-friendly GymTrack MVP Tom can use from iOS Safari to log workouts, persist them in Supabase, authenticate as a single user, and view the last 30 days of history at a stable URL — without installing anything.
- Why now: a prototype exists in the repo (`apps/gymtrack/` on `feat/gymtrack-prototype`) but it stores data in localStorage only (lost on browser reset, no cross-device sync). The MVP replaces localStorage with Supabase and adds real auth, so Tom's history survives and is reachable from any device.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals (per spec):
  - HealthKit / Apple Health sync (deferred to spike `a1c8f88e`; if it recommends native, a follow-up task adds HealthKit alongside Supabase).
  - Native iOS app (web-only in this iteration).
  - Social / sharing / multi-user.
  - Advanced analytics beyond "last 30 days of history".
  - The prototype's `server.js` (a `node http.createServer` static-file wrapper) — superseded by a static deployment.

## Acceptance criteria recap

- **AC1 — Log a workout from mobile.** From iOS Safari (or any modern mobile browser), Tom can record a workout: pick exercises, enter sets/reps/weight, save. UI is mobile-first (single-column layout, large tap targets, no horizontal scroll, native-feel input controls).
- **AC2 — Persistence in Supabase, last 30 days viewable.** Workouts are saved to Supabase. Tom can view a history list of his last 30 days of workouts (oldest first or newest first — designer's choice; default newest-first).
- **AC3 — Stable URL, no install.** Deployed as a static SPA to a stable URL. Vercel is the precedent (prototype's README says Vercel); the URL pattern is `gymtrack.stoffer.industries` or a sub-path on an existing domain — Quinn/Tom confirm at deploy time.
- **AC4 — Prototype is the starting point.** We start from `apps/gymtrack/` on `feat/gymtrack-prototype`. The prototype's `dist/index.html` (vanilla JS) becomes the v1 visual baseline; we wrap it in a Vite + React + Supabase structure to add auth + persistence + history view, keeping the existing workout UI's styling and interaction model.
- **AC5 — Single-user auth (Tom only).** Supabase Auth with email+password (no magic links in v1; magic-link UX is fiddly on iOS). RLS on the `workouts` table restricts reads/writes to the authenticated user; in practice Tom is the only user with an account, but RLS is the safety net.

## `.openclaw` boundary

- Supabase project URL and anon key live in `.env` (Vite env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). These are **build-time** variables, not secrets — Vite inlines them into the JS bundle. They are public-by-design (anon key is meant to be exposed; RLS is the gate). The repo's `.gitignore` already excludes `.env*`. **Do not commit env files.**
- The Supabase project itself (database, auth, storage) lives outside the repo (managed Supabase cloud). No DDL outside the repo runs in this PR — all DDL is via migration files committed to the repo and applied via `supabase db push` (or `npx supabase migration up` if Supabase CLI is set up).
- The Supabase service-role key (admin-level) **must not** be in the repo or the deployed bundle. The browser only ever sees the anon key; admin operations are out of scope.
- If the Supabase project doesn't exist yet, **post `[openclaw-needed]` during implementation** so Quinn can provision the project and wire credentials into the deploy pipeline.
- No `~/.openclaw/` writes by this PR.

## Implementation plan

### File / module scope

#### App structure — `apps/gymtrack/`

The prototype at `apps/gymtrack/` is a single HTML file + a tiny Node server. The MVP rewrites the app into a Vite + React + Supabase structure, **preserving the prototype's existing styling and workout-logging UX** (the prototype's `dist/index.html` becomes the visual reference; the rewrite re-implements in React components rather than rewriting the visual design).

- **`apps/gymtrack/package.json`** *(modified)* — replace with the Vite + React + Supabase toolchain. Scripts:
  - `dev`: `vite` (port from `vite.config.js`; `5179` to stay clear of the other Vite apps at 5173/5174/5175)
  - `build`: `vite build`
  - `preview`: `vite preview` (port 4179)
  - `test`: `vitest run`
  - `test:watch`: `vitest`
  - `test:e2e`: `playwright test`
- **`apps/gymtrack/vite.config.js`** *(new)* — Vite + React plugin. Port `5179` in dev, `4179` in preview. Aliases mirror `apps/budget-mobile/` so `@/` → `src/`.
- **`apps/gymtrack/index.html`** *(new)* — minimal HTML shell that mounts `<div id="root">` and pulls in `/src/main.jsx`. The prototype's full `dist/index.html` content moves into React components; only the `<head>` and root div remain in `index.html`.
- **`apps/gymtrack/src/main.jsx`** *(new)* — React entry. Wraps `<App/>` in `<BrowserRouter>` and `<SupabaseProvider>` (a thin context that exposes the Supabase client).
- **`apps/gymtrack/src/App.jsx`** *(new)* — top-level router. Routes:
  - `/login` — sign-in / sign-up form (single screen; "Sign up" is hidden behind a debug toggle in v1; Tom's account is provisioned by Quinn ahead of time).
  - `/` — redirects to `/workout` if signed-in, else `/login`.
  - `/workout` — log-workout screen (the prototype's existing UX, re-implemented).
  - `/history` — last-30-days history view.
- **`apps/gymtrack/src/lib/supabase.js`** *(new)* — singleton Supabase client:
  ```js
  import { createClient } from '@supabase/supabase-js';
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Surface a clear startup error if env vars are missing.
    throw new Error('GymTrack: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set');
  }
  export const supabase = createClient(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  ```
- **`apps/gymtrack/src/lib/auth.js`** *(new)* — `useAuth()` hook returning `{ session, user, signIn, signUp, signOut }`. Re-export from `SupabaseProvider`. Reads `supabase.auth.onAuthStateChange` and pushes updates into React state.
- **`apps/gymtrack/src/lib/workouts.js`** *(new)* — `listWorkouts({ since })`, `createWorkout({ performedAt, notes })`, `addSet({ workoutId, exerciseName, setIndex, reps, weight, unit })`, `deleteWorkout(id)`. All functions return `{ data, error }` from Supabase; components handle `error` to show a banner.
- **`apps/gymtrack/src/lib/exercises.js`** *(new)* — exercises catalogue (a small fixed list of common barbell/dumbbell exercises; Tom can also type a free-text name). Stored as a JSON file (`src/data/exercises.json`) — no DB table, no admin UI in v1.
- **`apps/gymtrack/src/components/AuthGate.jsx`** *(new)* — wraps protected routes; if no session, redirects to `/login`. Uses `useAuth()`.
- **`apps/gymtrack/src/components/WorkoutLogger.jsx`** *(new)* — the prototype's workout UI re-implemented in React. Mobile-first: single-column, large inputs, sticky "Save workout" button at the bottom. State held in component-local `useState`; on submit calls `createWorkout` + `addSet` per set.
- **`apps/gymtrack/src/components/HistoryList.jsx`** *(new)* — last-30-days history. Reads via `listWorkouts({ since: thirtyDaysAgoISO })` on mount; renders a vertical list grouped by date with collapsible details per workout (showing sets).
- **`apps/gymtrack/src/components/DatePicker.jsx`** *(new)* — wraps `<input type="date">` with iOS-friendly defaults (locale-aware, native picker on iOS Safari).
- **`apps/gymtrack/src/styles/index.css`** *(new)* — global styles. Tokens match the prototype (the `--bg`, `--card`, `--accent`, `--text`, etc. variables from `dist/index.html`). Mobile-first media queries; desktop is a fallback layout (centered column, max-width 600px, matching the prototype's `.container`).
- **`apps/gymtrack/src/components/LoginScreen.jsx`** *(new)* — email + password form. Submit calls `signIn()`. On success, `AuthGate` redirects to `/workout`. On error, shows the error message inline.
- **`apps/gymtrack/test/setup.js`** *(new)* — mirrors `apps/budget-mobile/test/setup.js` patterns: jsdom env, mock fetch for Supabase calls.
- **`apps/gymtrack/src/lib/workouts.test.js`** *(new)* — Vitest cases with `supabase-js` mocked:
  - `createWorkout` returns the row from Supabase.
  - `addSet` attaches a set to the parent workout.
  - `listWorkouts({ since })` filters correctly.
  - Errors propagate as `{ data: null, error }` and never throw.
- **`apps/gymtrack/src/components/WorkoutLogger.test.jsx`** *(new)* — Vitest + React Testing Library:
  - Renders the form on mount.
  - Adding a set appends to the in-memory list.
  - Submitting calls `createWorkout` + `addSet` per set, then clears the form.
- **`apps/gymtrack/src/components/HistoryList.test.jsx`** *(new)* — renders the date groups correctly given a fixture.
- **`apps/gymtrack/playwright.config.ts`** *(new)* — Playwright config: base URL `http://localhost:5179`, headless, single Chromium project (iOS Safari emulation handled by setting `userAgent` + viewport via `playwright.devices['iPhone 13']`).
- **`apps/gymtrack/test/e2e/log-workout.spec.ts`** *(new)* — Playwright iPhone-emulated e2e:
  1. Visit `/login`, sign in with test credentials.
  2. Land on `/workout`, add 2 sets of "Bench Press" at 80kg × 8 reps.
  3. Tap "Save workout".
  4. Visit `/history`, see the workout just saved.
  5. Screenshot for the PR.
- **`apps/gymtrack/SPEC.md`** *(new)* — durable behavioural spec per `docs/CONVENTIONS.md` §3:
  - Overview: what GymTrack is and who uses it (Tom, single user).
  - Flows: "Sign in", "Log a workout", "View history".
  - Screens: each route's UI and key interactions.
  - E2e coverage table: each flow → its Playwright spec file.
- **`apps/gymtrack/README.md`** *(modified)* — replace prototype's README. Sections: Development (Vite), Deploy (Vercel + env var names), Supabase setup (link to migrations), Test (unit + e2e), Stack.
- **`apps/gymtrack/.gitignore`** *(modified)* — `.env*`, `dist/`, `node_modules/`, `playwright-report/`, `test-results/`. (Prototype's `.gitignore` only had one line; rewrite to match the Vite + Playwright norms.)

#### Supabase migrations — `apps/gymtrack/supabase/migrations/`

The Supabase CLI convention is to keep SQL migrations co-located with the app (or in a dedicated `supabase/` directory at the repo root). Co-locating with `apps/gymtrack/` keeps the app self-contained.

- **`apps/gymtrack/supabase/migrations/20260708120000_init_workouts.sql`** *(new)* — initial schema:
  ```sql
  -- Workouts table. RLS restricts access to the authenticated user.
  create table if not exists public.workouts (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users(id) on delete cascade,
    performed_at timestamptz not null default now(),
    notes       text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
  );

  -- Sets within a workout. One row per set.
  create table if not exists public.workout_sets (
    id            uuid primary key default gen_random_uuid(),
    workout_id    uuid not null references public.workouts(id) on delete cascade,
    exercise_name text not null,
    set_index     int  not null,
    reps          int  not null check (reps > 0),
    weight        numeric not null check (weight >= 0),
    unit          text not null default 'kg' check (unit in ('kg', 'lb')),
    created_at    timestamptz not null default now()
  );

  -- Index for the last-30-days history view.
  create index if not exists workouts_user_performed_at_idx
    on public.workouts (user_id, performed_at desc);

  -- RLS: a user can only see/insert/update/delete their own workouts and sets.
  alter table public.workouts      enable row level security;
  alter table public.workout_sets  enable row level security;

  create policy workouts_user_isolation on public.workouts
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  create policy workout_sets_user_isolation on public.workout_sets
    for all
    using (
      exists (
        select 1 from public.workouts w
        where w.id = workout_sets.workout_id and w.user_id = auth.uid()
      )
    )
    with check (
      exists (
        select 1 from public.workouts w
        where w.id = workout_sets.workout_id and w.user_id = auth.uid()
      )
    );
  ```
  The `workout_sets` policy checks the parent workout's `user_id` (not a `user_id` column on the set itself) so sets are always scoped to their owner's workout.
- **`apps/gymtrack/supabase/README.md`** *(new)* — one-pager explaining the migration, how to apply (`supabase db push` or `psql -f`), and how to seed Tom's user (manual sign-up via Supabase Studio).

#### Deployment

- **`apps/gymtrack/vercel.json`** *(new)* — Vercel project config:
  - `buildCommand`: `npm run build`
  - `outputDirectory`: `dist`
  - `framework`: `vite`
  - `rewrites`: `[{ "source": "/(.*)", "destination": "/index.html" }]` (SPA fallback for client-side routing)
- **`apps/gymtrack/.env.example`** *(new)* — documents the two env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Real values live in Vercel's project settings (not in the repo).

### Data model summary

Two tables in Supabase's `public` schema:

| Table | Purpose | Key columns |
|---|---|---|
| `workouts` | one row per workout session | `id`, `user_id`, `performed_at`, `notes`, `created_at` |
| `workout_sets` | one row per set within a workout | `id`, `workout_id`, `exercise_name`, `set_index`, `reps`, `weight`, `unit` |

RLS enabled on both; user-scoped policies. No shared DB with the rest of the sindustries stack — GymTrack is a standalone Supabase project (or a separate Postgres database in the Supabase instance; same SQL applies).

### Cross-context coordination

None. GymTrack is a standalone SPA; it talks only to Supabase (HTTPS). No iframe, no `postMessage`, no cross-origin coordination with Mission Control or other apps. (A future "Open in GymTrack" link from Mission Control is a separate task.)

### Workflow / cron / skill changes

None. No cron, no agent skills touch this app in v1.

### Design system usage

None. GymTrack has its own minimal design tokens (matching the prototype's `--bg`, `--card`, `--accent`, etc.) — it does not use `@sindustries/ui/react`. Rationale: GymTrack is a standalone consumer app, not an internal tool; sharing design system primitives would couple GymTrack's deploy lifecycle to the design system release cadence. If the design system later ships primitives GymTrack can use (e.g. an iOS-friendly date picker), a follow-up task adopts them.

## Test plan

- **Unit — `apps/gymtrack/src/lib/workouts.test.js`:** each case listed above; Supabase client mocked via `vi.mock('@supabase/supabase-js', …)`.
- **Component — `WorkoutLogger.test.jsx` and `HistoryList.test.jsx`:** each case listed above; React Testing Library + jsdom.
- **Integration (manual):** with `VITE_SUPABASE_URL` pointing at a real Supabase project, run `npm run dev`, sign in, log a workout, refresh, confirm the workout persists. Run the SQL migrations against the project once and confirm tables + RLS via `select * from workouts;` (should be empty after sign-in as a new user).
- **E2e — Playwright (`test/e2e/log-workout.spec.ts`):** iPhone-emulated, signs in with a test user, logs a workout, sees it in history. Screenshot saved to `apps/gymtrack/playwright-report/` for the PR.
- **Build:** `npm --workspace gymtrack run build` (or equivalent). Bundle size sanity check (target < 200 KB gzipped; the prototype is already a single HTML so we're mainly adding React + Supabase client — roughly 100–150 KB).
- **Dev smoke (iOS Safari):**
  1. Deploy to a stable URL (e.g. `https://gymtrack.stoffer.industries` — Quinn/Tom confirms hostname).
  2. Open in iOS Safari → login form renders cleanly.
  3. Sign in → land on `/workout`.
  4. Add a workout with 3 sets → tap Save → see success toast.
  5. Navigate to `/history` → see the workout just saved.
  6. Close tab, reopen → still signed in (Supabase session persists via localStorage; auth state persists across reloads).
  7. Open on a second device → not signed in (RLS prevents data leak; sign in to see the data on the second device too).

## Open questions / risks

- **Q1 — Supabase project provisioning.** The MVP needs a Supabase project. If one doesn't exist, Quinn needs to provision it and wire env vars into Vercel. **Mitigation:** the design degrades to a clear startup error if env vars are missing (`throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set')`). No silent failure.
- **Q2 — Stable URL.** The prototype's README mentions Vercel but doesn't commit to a hostname. We propose `gymtrack.stoffer.industries` (matches the SIndustries brand domain); if a different hostname is preferred (e.g. `gym.stoffer.industries`, `gymtrack.sindustries.co.nz`), the change is a Vercel project setting, not a code change.
- **Q3 — Auth UX.** Email + password is simpler than magic-link on iOS. If Tom prefers magic-link (no password to remember), the change is one line (`signInWithOtp` instead of `signInWithPassword`). Documented here so the choice is intentional.
- **Q4 — HealthKit spike.** The parallel spike `a1c8f88e` may recommend adding HealthKit sync. The MVP does **not** block on this; HealthKit is a follow-up task that adds `healthkit-js`-style reads alongside the Supabase writes. The MVP data model (workouts + sets) is HealthKit-compatible.
- **Q5 — Exercise catalogue.** v1 ships a small fixed list (~20 common barbell/dumbbell exercises) + free-text. If Tom wants a curated catalogue with categories / favourites / supersets, that's a follow-up task. Out of scope here.
- **Q6 — Units.** v1 supports `kg` and `lb`. The schema's `unit` column is per-set (not per-user), so Tom can mix units in a single workout (some lifters do). Default is `kg` (NZ locale).
- **Q7 — Offline support.** v1 requires network. If Tom logs a workout offline, the save fails and shows an error. A future task adds an IndexedDB queue that flushes on reconnect. Documented as a parking-lot item.
- **Q8 — RLS bypass risk.** The anon key is public (in the bundle). RLS is the gate. If RLS policies are misconfigured in the migration, Tom's data leaks. **Mitigation:** the migration is reviewed against the `select * from workouts;` smoke test as "should return only my rows". A separate review step in the PR description walks through each policy.
- **Q9 — Prototype UX preservation.** The prototype has a specific look-and-feel (dark theme, accent yellow, large tap targets). The MVP preserves this. If Tom wants the look to evolve, a follow-up task adopts the design system or ships a redesign.
- **Q10 — Backup path.** Supabase data lives in Supabase's managed Postgres; nightly automated backups are a Supabase feature (plan-dependent). For a single-user MVP, this is acceptable. If Tom wants offsite backups, that's a follow-up.

## Out of scope

- HealthKit / Apple Health sync (spike `a1c8f88e`).
- Native iOS app (web-only).
- Social / sharing / multi-user.
- Advanced analytics (volume progression charts, PR detection, exercise frequency heatmap).
- Offline queue / sync.
- Curated exercise catalogue with categories / favourites.
- Webhooks / push notifications for workout reminders.
- Export to CSV / Apple Health / Strong / Hevy.
- Customisable rest timer (a future v2 feature; v1 is log-only).
- HealthKit-style workout type recognition (cardio vs strength).

## Companion doc updates

- `apps/gymtrack/SPEC.md` *(new)* — durable behavioural spec.
- `apps/gymtrack/README.md` *(modified)* — replaces prototype README.
- `apps/gymtrack/supabase/README.md` *(new)* — migration + seed guide.
- `[no-system-spec-change]` is recorded at PR time. GymTrack is a standalone consumer app; it doesn't interact with the sindustries infra (no Tasks API, no budget-api, no telemetry). No `docs/systems/` update.

## Later todos (parking lot)

- HealthKit / Apple Health sync (parallel spike `a1c8f88e`).
- Offline queue via IndexedDB.
- Curated exercise catalogue with categories + favourites.
- Volume progression charts and PR detection.
- Rest timer.
- Export to CSV / HealthKit / Hevy.
- Magic-link auth (alternative to password).
- A "GymTrack" tab in Mission Control (deep-link to the deployed URL).
- Push notifications for workout reminders.
- Custom accents / themes.