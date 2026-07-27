# GymTrack

A single-user workout tracker for Tom. iOS-Safari-friendly; logs workouts to Supabase with email+password auth.

## Stack

- Vite + React 18 + React Router
- Supabase (Auth + Postgres)
- Vitest + React Testing Library (unit + component)
- Playwright (e2e on iPhone 13 emulation)

## Development

```bash
# From the repo root, or with workspaces enabled:
npm install
npm --workspace gymtrack run dev
# → http://localhost:5179
```

You'll need `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env` for the app to boot. See `.env.example`.

## Test

```bash
npm --workspace gymtrack test        # unit + component (Vitest)
npm --workspace gymtrack run test:e2e # Playwright (requires dev server + Supabase)
```

## Build

```bash
npm --workspace gymtrack run build
npm --workspace gymtrack run preview  # serves the built bundle
```

## Deploy

The `vercel.json` at the repo root of this app configures Vercel:

- Build command: `npm run build`
- Output: `dist/`
- SPA rewrite: `/(.*)` → `/index.html`

Environment variables are set in the Vercel project (NOT in the repo):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Supabase

See `supabase/README.md` for the migration apply + RLS smoke-test steps.

## Agent API

Agents (external tools, LLM assistants) can plan and read workouts on a user's behalf via bearer-token-authenticated serverless endpoints under `/api/agent/`. Full contract, request/response shapes, and known gaps are documented in `SPEC.md` ("Agent API" section) — read that before integrating.

Quick reference:

```bash
curl -X POST https://<deployment>/api/agent/planned-workouts \
  -H "Authorization: Bearer gym_sk_example..." \
  -H "Content-Type: application/json" \
  -d '{
    "scheduledFor": "2026-08-01",
    "title": "Upper Body Strength",
    "exercises": [
      { "name": "Bench Press", "sets": [{ "reps": 8, "weight": 80, "unit": "kg" }] }
    ]
  }'

curl https://<deployment>/api/agent/history?limit=10 \
  -H "Authorization: Bearer gym_sk_example..."

curl https://<deployment>/api/agent/exercises/Bench%20Press/progression?limit=20 \
  -H "Authorization: Bearer gym_sk_example..."
```

**There is no self-service key-generation UI yet** — a user cannot currently obtain a bearer token without direct Supabase access. See `SPEC.md` Known gaps and follow-up tasks tracking an MCP server + OAuth/social-login flow for this.

Server-only env var required for these endpoints (do not expose to the browser bundle): `SUPABASE_SERVICE_ROLE_KEY`.

## Files of interest

- `src/main.jsx` — entry; wires `<AuthProvider>` + `<BrowserRouter>`.
- `src/App.jsx` — top-level routes.
- `src/lib/supabase.js` — singleton Supabase client; fails fast if env vars are missing.
- `src/lib/auth.jsx` — `useAuth()` hook (session, signIn, signOut, …).
- `src/lib/workouts.js` — `createWorkout`, `addSets`, `listWorkouts`, `listSetsForWorkouts`, `deleteWorkout`.
- `src/lib/plans.js` — `fetchPlannedWorkoutForDate`, `fetchPlannedWorkoutById`, `markPlannedWorkoutCompleted` — browser-side plan-mode helpers.
- `src/components/WorkoutLogger.jsx` — log-workout screen (freeform + plan mode).
- `src/components/HistoryList.jsx` — last-30-days history view.
- `src/components/LoginScreen.jsx` — sign-in screen.
- `server/agentAuth.js` — shared agent bearer-token auth + Supabase admin client (server-only, outside `api/` so it is never itself a public route).
- `api/agent/planned-workouts.js`, `api/agent/history.js`, `api/agent/exercises/[exerciseName]/progression.js` — agent API route handlers.
- `supabase/migrations/20260708120000_init_workouts.sql` — schema + RLS.
- `supabase/migrations/20260723170000_agent_powered_workouts.sql` — agent API keys + planned workouts schema + RLS.