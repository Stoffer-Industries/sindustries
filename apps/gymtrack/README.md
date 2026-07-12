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

## Files of interest

- `src/main.jsx` — entry; wires `<AuthProvider>` + `<BrowserRouter>`.
- `src/App.jsx` — top-level routes.
- `src/lib/supabase.js` — singleton Supabase client; fails fast if env vars are missing.
- `src/lib/auth.jsx` — `useAuth()` hook (session, signIn, signOut, …).
- `src/lib/workouts.js` — `createWorkout`, `addSets`, `listWorkouts`, `listSetsForWorkouts`, `deleteWorkout`.
- `src/components/WorkoutLogger.jsx` — log-workout screen.
- `src/components/HistoryList.jsx` — last-30-days history view.
- `src/components/LoginScreen.jsx` — sign-in screen.
- `supabase/migrations/20260708120000_init_workouts.sql` — schema + RLS.