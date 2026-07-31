# GymTrack

A multi-tenant workout tracker SPA. iOS-Safari-friendly; logs workouts to Supabase with per-user RLS isolation. As of task `72d7cc3b`, anyone can self-sign-up at `/signup` via email + password, Google, or Apple (Apple gated on Supabase project configuration) — no manual provisioning required.

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

The sign-up path's RLS coverage is asserted by `supabase/migrations/20260731190000_signup_rls_assertion.sql`, which raises an exception if any GymTrack public table is missing `enable row level security`. Apply that migration alongside the existing schema migrations.

## Sign up

Anyone visiting the deployed URL who is not already signed in is shown `/login` with a "Create an account" link below the email + password form. Clicking the link routes to `/signup`, which offers:

- **Google** and **Apple** OAuth CTAs as the primary path. Apple is filtered out of the button list at click time if the Supabase project has not enabled it — this is graceful degradation, not a 500.
- A collapsed "Use email + password instead" panel as a fallback.

Email auto-confirm must be enabled on the Supabase project for the flow to land a new account straight on `/workout`; otherwise the user sees a "check your email" state. The dev/staging projects already have auto-confirm enabled; production must enable it before this flow is exposed.

The OAuth flow uses `redirectTo: ${origin}/workout`; Supabase's `detectSessionInUrl: true` (configured in `src/lib/supabase.js`) handles the post-callback session detection automatically.

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
- `src/components/LoginScreen.jsx` — sign-in screen (email + password + "Create an account" link).
- `src/components/SignUpPage.jsx` — public sign-up screen (OAuth CTAs + collapsed email/password panel). (Task `72d7cc3b`.)
- `src/lib/authFlow.js` — `signInWithOAuthRedirect`, `providerDisabled` heuristic, `getPostOAuthSession`, `SUPPORTED_OAUTH_PROVIDERS`. (Task `72d7cc3b`.)
- `test/e2e/signup.spec.ts` — Playwright e2e for `/signup` (AC1, AC2-email+pw, AC4, AC5 of task `72d7cc3b`).
- `test/e2e/signup-google.spec.ts` — Playwright e2e for the OAuth redirect path; gated on `SUPABASE_TEST_URL`.
- `server/agentAuth.js` — shared agent bearer-token auth + Supabase admin client (server-only, outside `api/` so it is never itself a public route).
- `api/agent/planned-workouts.js`, `api/agent/history.js`, `api/agent/exercises/[exerciseName]/progression.js` — agent API route handlers.
- `supabase/migrations/20260708120000_init_workouts.sql` — schema + RLS.
- `supabase/migrations/20260723170000_agent_powered_workouts.sql` — agent API keys + planned workouts schema + RLS.
- `supabase/migrations/20260731190000_signup_rls_assertion.sql` — defensive assertion that RLS is enabled on every GymTrack public table + documented isolation smoke-test. (Task `72d7cc3b`.)