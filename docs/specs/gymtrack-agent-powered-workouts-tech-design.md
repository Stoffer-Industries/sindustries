---
status: draft
task_id: f520c396-9664-4210-b149-180371dc8a53
product_spec: brain/tasks/specs/in-progress/gymtrack-agent-powered-workouts.md
shipped_pr: null
shipped_date: null
---

# GymTrack Agent-Powered Workouts — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/gymtrack-agent-powered-workouts.md`
- Task: `f520c396-9664-4210-b149-180371dc8a53` (`GymTrack Agent-Powered Workouts`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/f520c396-9664-4210-b149-180371dc8a53`
- Prior GymTrack MVP design: `docs/specs/gymtrack-mvp-tech-design.md`
- Existing app: `apps/gymtrack/`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-f520c396-gymtrack-agent-powered-workouts`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-f520c396-gymtrack-agent-powered-workouts`
- No secondary repo changes expected.

## Product intent

The task describes the desired outcome as:

> An AI agent can create a planned workout for a GymTrack user before they go to the gym. The user opens the app, sees their workout ready, and logs actual performance set by set. Both planned targets and actual results are stored and visible side by side. Any user can sign up to GymTrack, generate an API key, and connect their own agent.

This builds on the shipped GymTrack MVP app: authenticated users can already log actual workout sets and view recent history. This feature adds an agent-facing write/read API, user-generated API keys, planned workout storage, and UI flows for logging actuals against plan targets.

## Source-read note

The product spec path is iCloud-backed under `brain/`; this agent hit macOS `Operation not permitted` when reading the file directly. The task description has been rebuilt from that spec and includes the accepted intent, ACs, checksum, and Rowan workstream, so this design is grounded on that task record plus current repo inspection.

## Service boundary and data ownership

- GymTrack owns its own app domain and data model under `apps/gymtrack/` and its Supabase schema.
- Supabase remains the source of truth for GymTrack workouts. The SIndustries Tasks API is not involved in workout data.
- The browser app may use the public Supabase anon key under RLS. Agent access must not expose the Supabase service-role key; any API-key validation that needs privileged lookup runs in server-side Vercel functions or equivalent serverless runtime under `apps/gymtrack/api/`.
- API keys are user-owned GymTrack credentials, not OpenClaw credentials. Keys authenticate agents to GymTrack only.
- Extraction plan: if GymTrack grows beyond a small SPA plus serverless API, move API-key auth and planning endpoints into a dedicated GymTrack service. Keep the request/response contracts below stable so agents do not depend on Supabase internals.

## `.openclaw` boundary

- No `.openclaw/` files should be edited in this repo PR.
- Deployment secrets are outside repo scope: `SUPABASE_SERVICE_ROLE_KEY` (server-only), `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` need to be present in the GymTrack deployment. If missing during implementation, post `[openclaw-needed]` with the exact env var names and target deployment.
- Real API keys generated for users are secrets. Do not commit examples containing real tokens; docs should use `gym_sk_example...` placeholders only.

## Acceptance criteria recap

- **AC1:** An authenticated agent can submit a planned workout containing one or more exercises, each with one or more target sets (reps and weight). The planned workout is stored and associated with a specific user.
- **AC2:** When a user logs actual performance against a planned workout, both the targets and the actuals are stored and linked. A user can see, for each set, the planned target alongside what they actually did.
- **AC3:** An authenticated agent can retrieve a user recent workout history (last N sessions) and the progression history for a specific exercise, so it can inform the next planned workout.

## Implementation plan

### Data model and migrations

Add a second GymTrack migration, e.g. `apps/gymtrack/supabase/migrations/20260723170000_agent_powered_workouts.sql`.

New tables:

- `public.gymtrack_agent_api_keys`
  - `id uuid primary key default gen_random_uuid()`
  - `user_id uuid not null references auth.users(id) on delete cascade`
  - `label text not null`
  - `token_hash text not null unique`
  - `token_prefix text not null`
  - `last_used_at timestamptz`
  - `revoked_at timestamptz`
  - `created_at timestamptz not null default now()`
- `public.planned_workouts`
  - `id uuid primary key default gen_random_uuid()`
  - `user_id uuid not null references auth.users(id) on delete cascade`
  - `agent_key_id uuid references public.gymtrack_agent_api_keys(id) on delete set null`
  - `scheduled_for date not null`
  - `title text not null`
  - `notes text`
  - `status text not null default 'planned' check (status in ('planned','started','completed','archived'))`
  - `created_at timestamptz not null default now()`
  - `updated_at timestamptz not null default now()`
- `public.planned_workout_sets`
  - `id uuid primary key default gen_random_uuid()`
  - `planned_workout_id uuid not null references public.planned_workouts(id) on delete cascade`
  - `exercise_name text not null`
  - `set_index int not null`
  - `target_reps int not null check (target_reps > 0)`
  - `target_weight numeric not null check (target_weight >= 0)`
  - `unit text not null default 'kg' check (unit in ('kg','lb'))`
  - `notes text`
  - `created_at timestamptz not null default now()`

Modify existing tables:

- `workouts.planned_workout_id uuid references public.planned_workouts(id) on delete set null`
- `workout_sets.planned_set_id uuid references public.planned_workout_sets(id) on delete set null`
- Optionally `workout_sets.actual_notes text` if the UI needs per-set notes; keep out if not needed for ACs.

Indexes:

- `planned_workouts_user_scheduled_idx on planned_workouts(user_id, scheduled_for desc)`
- `planned_workout_sets_plan_idx on planned_workout_sets(planned_workout_id, set_index)`
- `agent_api_keys_hash_idx on gymtrack_agent_api_keys(token_hash) where revoked_at is null`
- `workouts_user_plan_idx on workouts(user_id, planned_workout_id)`

RLS:

- Enable RLS on all new tables.
- Authenticated users can select/insert/update/delete only their own API-key metadata and planned workouts.
- For API key rows, expose `token_prefix`/metadata in the browser but never token plaintext; only the client-side generation screen sees the token once before hashing/inserting.
- Planned workout set policies scope through the parent planned workout's `user_id`.
- Serverless functions use the Supabase service-role key only after validating the bearer token hash; they must still explicitly write rows under the resolved `user_id`.

### Agent API contract

Add Vercel/serverless functions under `apps/gymtrack/api/agent/` so agents have a stable HTTPS contract independent of Supabase table shape.

Authentication:

- Header: `Authorization: Bearer gym_sk_<random>`
- Server hashes the token with SHA-256 and looks up a non-revoked row in `gymtrack_agent_api_keys`.
- On success, set `last_used_at = now()` asynchronously/best-effort and operate as that `user_id`.
- On failure, return `401 { "error": "invalid_api_key" }`.

Endpoints:

- `POST /api/agent/planned-workouts`
  - Request:
    ```json
    {
      "scheduledFor": "2026-07-24",
      "title": "Upper Body Strength",
      "notes": "Optional agent rationale",
      "exercises": [
        {
          "name": "Bench Press",
          "sets": [
            { "reps": 8, "weight": 80, "unit": "kg", "notes": "RPE 7" }
          ]
        }
      ]
    }
    ```
  - Validation: at least one exercise and one set; positive reps; non-negative weight; `unit` in `kg|lb`; max payload bounds to prevent accidental huge plans.
  - Response: `201 { "plannedWorkoutId": "...", "setCount": 1 }`.
- `GET /api/agent/history?limit=10`
  - Returns recent completed workouts with actual sets and linked planned target fields when available.
  - Bounds `limit` to a safe range, e.g. 1-50.
- `GET /api/agent/exercises/:exerciseName/progression?limit=20`
  - Returns chronological set history for that exercise: date, reps, weight, unit, optional planned reps/weight.
  - Normalize matching with exact case-insensitive name for v1; defer aliases/synonyms.

Implementation files:

- `apps/gymtrack/api/agent/_auth.js` — token hashing, Supabase admin client, key lookup, shared error helpers.
- `apps/gymtrack/api/agent/planned-workouts.js` — POST handler and insert transaction logic.
- `apps/gymtrack/api/agent/history.js` — recent workout query.
- `apps/gymtrack/api/agent/exercises/[exerciseName]/progression.js` or Vercel-compatible route equivalent — progression query.
- `apps/gymtrack/src/lib/agentKeys.js` — browser helpers to create/revoke/list keys.
- `apps/gymtrack/src/lib/plans.js` — browser helpers to list today's/open planned workouts and convert a plan into actual workout rows.

### Browser app changes

- Add an API key management screen reachable from the signed-in app, e.g. `/settings/agents`.
  - Generate a random token in the browser using `crypto.getRandomValues`.
  - Store only `sha256(token)` plus a short `token_prefix` in Supabase.
  - Show the full token once with copy affordance and a warning that it cannot be recovered.
  - List existing keys by label/prefix/created/last-used and allow revoke.
- Update the workout route to show the user's next planned workout first.
  - If a plan exists for today or the nearest future date, render each planned set with target reps/weight.
  - Add actual reps/weight inputs next to each planned target.
  - Saving creates a `workouts` row linked to `planned_workout_id` and `workout_sets` rows linked to each `planned_set_id`, then marks the plan `completed`.
  - Preserve the existing freeform logging path when there is no plan.
- Update history view to include planned-vs-actual details when linked plan data exists.
- Update `apps/gymtrack/SPEC.md` for the new user flows: generate agent API key, view planned workout, log actuals against targets, inspect planned-vs-actual history.
- Update `apps/gymtrack/README.md` with agent API examples and deployment env var requirements.

### Workflow, cron, and skill changes

- No SIndustries agent workflow or cron changes are required.
- No OpenClaw skill changes are required.
- Add documentation examples that an external agent can use, but do not register a live OpenClaw agent integration in this task.

## Test plan

### Unit and integration tests

- Add serverless handler tests for `_auth`, `planned-workouts`, `history`, and `progression` with Supabase client mocked.
- Add `agentKeys` tests for token format, SHA-256 hashing, one-time display state, and revoke behaviour.
- Add `plans` tests for mapping planned set rows to actual set rows.
- Extend existing `workouts` tests to cover `planned_workout_id` and `planned_set_id` linkage.

### Component tests

- API-key settings screen: create flow shows token once; key list shows prefixes only; revoke removes active key.
- Workout logger: planned workout renders target and actual columns; saving calls the linked-plan helper and clears/completes the plan.
- History list: planned target and actual result are visible side by side.

### E2E tests

Use Playwright against the GymTrack app with mocked/stubbed Supabase or a seeded local test project, whichever matches the existing GymTrack E2E setup during implementation.

- User signs in, generates an API key, copies the one-time token.
- Agent API creates a planned workout with at least one exercise and one target set.
- User opens `/workout`, sees the plan, enters actuals, saves.
- User opens `/history`, sees planned target and actual result side by side.
- Agent API fetches recent history and exercise progression and receives the new workout data.

### AC verification matrix

| AC | Verification layer | Planned evidence |
|---|---|---|
| AC1 | API integration + E2E | `POST /api/agent/planned-workouts` test creates a stored plan for the API-key owner; E2E creates a plan through the agent endpoint and verifies it appears in app state. |
| AC2 | Component + E2E | Planned workout logger test verifies target/actual fields and saved linkage; E2E verifies history displays planned target beside actual reps/weight. |
| AC3 | API integration | `GET /api/agent/history` and `GET /api/agent/exercises/:exerciseName/progression` tests verify owner-scoped recent sessions and exercise progression payloads, including linked planned targets when present. |

## Open questions and risks

- **Spec read boundary:** direct spec-file access was blocked; if Quinn sees nuance missing from the source spec, update this design before approval.
- **Serverless runtime:** current GymTrack is a static Vite app. Vercel functions are the lightest way to keep API-key validation server-side; if GymTrack is not deployed on Vercel, adjust to the actual host's function runtime before implementation.
- **API-key plaintext:** users will only see generated tokens once. That is safer, but support docs need to make recovery/revoke clear.
- **Transactions:** Supabase JS does not provide multi-statement transactions directly from serverless handlers unless using RPC. For plan creation, prefer a Postgres RPC (`create_planned_workout`) if partial inserts become likely; otherwise insert parent then child rows and clean up parent on child failure.
- **Exercise name normalization:** exact case-insensitive progression is enough for v1, but agents may send aliases. Defer alias tables unless acceptance testing shows this blocks usefulness.
