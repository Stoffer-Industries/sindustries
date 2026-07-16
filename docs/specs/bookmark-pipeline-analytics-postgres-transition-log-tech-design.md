---
status: shipped
task_id: b179c0e3-c6b0-4c9d-97dc-982d3b841783
product_spec: brain/tasks/specs/bookmark-analytics-postgres.md
shipped_pr: 216
shipped_date: 2026-07-12
---

# Bookmark pipeline analytics — Postgres transition log — tech design

## Links

- Product spec: `brain/tasks/specs/bookmark-analytics-postgres.md` *(may be archived to `brain/tasks/specs/archived/` once the task ships per the spec-folder lifecycle)*
- Idea: `brain/ideas/bookmark-analytics-postgres.md` (key decisions: `analytics` schema, JSONB metadata, direct psycopg2, graceful degradation, append-only)
- Task: `b179c0e3-c6b0-4c9d-97dc-982d3b841783`
- Existing transition logger: `agents/workflows/bookmarks/scripts/common.py` (`log_transition()` at lines 252–300)
- Transitions JSONL file: `brain/state/bookmark-transitions.jsonl` (declared as `TRANSITIONS_PATH` in `common.py:26`)
- Tasks API Prisma migrations directory (precedent for migration location): `services/tasks-api/prisma/migrations/<timestamp>_<name>/migration.sql`
- Database connection: `DATABASE_URL` env var (already used by `services/tasks-api/prisma/schema.prisma`)

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-b179c0e3-bookmark-analytics-postgres`
- Worktree: `/Users/quinnstoffer/workspaces/rowan/sindustries-task-b179c0e3-bookmark-analytics-postgres`
- No secondary repos. The change touches `agents/workflows/bookmarks/scripts/` (Python) and a new SQL migration; the bookmark workflow runs entirely in this repo's `agents/` tree and reads from `brain/state/` (which lives in the workspace, not the repo, but is accessed via `OPENCLAW_WORKSPACE` env var). No cross-repo coordination.

## Product intent (from approved product spec + idea)

- Outcome: every bookmark state transition (e.g. `summarized → spec_created → approval_pending → tasked`) writes a row to a Postgres analytics table so Pulse can query pipeline history without touching local JSON state files. The existing JSONL remains the source of operational truth; the DB write is a best-effort mirror.
- Why now: Pulse is becoming the dashboard for pipeline analytics. Local JSONL is fine for a CLI but is not queryable from a web app. Postgres is already running in the stack (Tasks API uses it), so no new infra.
- Approved by Tom (per task description, 2026-07-07).
- Non-goals (per idea doc):
  - Replacing the JSONL as the source of truth (it stays primary; DB is a queryable mirror).
  - Backfilling historical transitions from the existing JSONL (the table starts empty; Pulse can backfill later if needed).
  - A REST endpoint for reads (Pulse will query Postgres directly; no API change in this task).
  - Real-time streaming or CDC (simple synchronous insert per transition is enough).
  - Connection pooling beyond what psycopg2 does by default.

## Acceptance criteria recap

- **AC1 — `analytics.bookmark_transitions` table exists in dev Postgres.** Created by an idempotent migration; the table has columns for `id`, `occurred_at`, `bookmark_key`, `bookmark_url`, `bookmark_slug`, `from_status`, `to_status`, `topic`, `approval_status`, `actor`, `source`, and a JSONB `payload`.
- **AC2 — `analytics.task_transitions` table exists (reserved, empty).** Same idempotent migration creates a parallel table with the same shape but `bookmark_*` columns nullable and a required `task_id` column. Empty after migration; populating it is a future task.
- **AC3 — `log_transition()` appends a row when `DATABASE_URL` is set.** The Python helper detects `DATABASE_URL`, opens a short-lived connection, and inserts one row per call. Failure to insert is logged as a warning and does not raise.
- **AC4 — Graceful degradation when `DATABASE_URL` is unset or DB unreachable.** If the env var is missing, the helper no-ops silently. If a connection or insert fails, the helper logs a warning and returns; the existing JSONL append still succeeds.
- **AC5 — Migration is idempotent.** Uses `CREATE TABLE IF NOT EXISTS …` for both tables; running the migration twice produces the same schema with no error.
- **AC6 — Existing JSONL behaviour unchanged.** The JSONL append path is preserved exactly; the DB insert is added on top and never short-circuits the JSONL write.
- **AC7 — Manual lobster run produces visible rows.** With `DATABASE_URL` pointing at dev Postgres, a manual `agents/workflows/bookmarks/run.py` invocation that triggers a state transition results in a new row in `analytics.bookmark_transitions` (verifiable via `psql` or Tasks API's Prisma Studio).

## `.openclaw` boundary

- The transitions JSONL file (`brain/state/bookmark-transitions.jsonl`) lives in the workspace (`OPENCLAW_WORKSPACE`), which is in `.openclaw` or the workspace root. This PR does **not** move or rewrite that file.
- The Postgres connection string (`DATABASE_URL`) is expected to be available in the same environment the lobster scripts run in (the dev Postgres in Docker, same one Tasks API uses). No new credentials or hosts are introduced. If the prod environment doesn't have `DATABASE_URL` exposed to the lobster runner, the helper degrades to JSONL-only — the design assumes prod runs the same env-var pattern as dev.
- No `~/.openclaw/` writes by this PR.

## Implementation plan

### File / module scope

#### SQL migration — `services/tasks-api/prisma/migrations/`

The migration lives in the Tasks API Prisma migrations directory because that's where the database is owned and where `prisma migrate deploy` is wired in the `Makefile` (`migrate-db` target). The migration creates two tables in a dedicated `analytics` schema; the schema is not declared in the Prisma schema (the analytics tables are read directly via SQL from Pulse, not via Prisma models).

- **`services/tasks-api/prisma/migrations/20260708120000_add_analytics_transitions/migration.sql`** *(new)*:
  ```sql
  -- Analytics schema for pipeline transition history.
  -- Populated by agents/workflows/bookmarks/scripts/common.py::log_transition()
  -- and (future) the feature-task workflow. Read directly by Pulse.

  CREATE SCHEMA IF NOT EXISTS analytics;

  CREATE TABLE IF NOT EXISTS analytics.bookmark_transitions (
    id               BIGSERIAL PRIMARY KEY,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bookmark_key     TEXT,
    bookmark_url     TEXT,
    bookmark_slug    TEXT,
    from_status      TEXT,
    to_status        TEXT,
    topic            TEXT,
    approval_status  TEXT,
    actor            TEXT,
    source           TEXT NOT NULL DEFAULT 'bookmark-workflow',
    payload          JSONB NOT NULL DEFAULT '{}'::JSONB
  );

  CREATE INDEX IF NOT EXISTS bookmark_transitions_occurred_at_idx
    ON analytics.bookmark_transitions (occurred_at DESC);
  CREATE INDEX IF NOT EXISTS bookmark_transitions_bookmark_key_idx
    ON analytics.bookmark_transitions (bookmark_key);
  CREATE INDEX IF NOT EXISTS bookmark_transitions_to_status_idx
    ON analytics.bookmark_transitions (to_status);

  CREATE TABLE IF NOT EXISTS analytics.task_transitions (
    id               BIGSERIAL PRIMARY KEY,
    occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    task_id          UUID,
    bookmark_key     TEXT,
    from_status      TEXT,
    to_status        TEXT,
    actor            TEXT,
    source           TEXT NOT NULL DEFAULT 'feature-task-workflow',
    payload          JSONB NOT NULL DEFAULT '{}'::JSONB
  );

  CREATE INDEX IF NOT EXISTS task_transitions_occurred_at_idx
    ON analytics.task_transitions (occurred_at DESC);
  CREATE INDEX IF NOT EXISTS task_transitions_task_id_idx
    ON analytics.task_transitions (task_id);
  ```
  All DDL is idempotent (`IF NOT EXISTS`); running the migration twice is safe. The `analytics` schema is decoupled from any Prisma model — Pulse will query it via direct `psql` or a future Tasks API analytics endpoint, not via the Prisma client.
- The Prisma schema itself does **not** get new models for these tables (they live outside the Tasks API's domain and Pulse queries them directly; adding Prisma models would couple unrelated subsystems).

#### Bookmark workflow helper — `agents/workflows/bookmarks/scripts/`

- **`agents/workflows/bookmarks/scripts/analytics_db.py`** *(new)* — Thin Postgres helper module. Single public function: `insert_transition(event: dict, *, table: str = 'bookmark_transitions') -> bool`. Returns `True` on insert, `False` on any failure (logged as a warning, never raises). Uses `psycopg2` (already a transitive dependency of `prisma`/`@prisma/client`; if not directly importable, the module falls back to the `pg8000` driver which Tasks API uses for its REST tests). Defaults to `psycopg2` because it's faster and what Prisma itself uses.
  - Behaviour:
    1. Read `os.environ['DATABASE_URL']`. If unset → return `False` silently.
    2. Open a new connection (`psycopg2.connect(DATABASE_URL, connect_timeout=2)`).
    3. Insert one row into the named table; commit; close.
    4. On any exception (connection refused, auth failed, timeout, unique violation if ever added): `log_debug(f'[analytics-db] insert failed: {e}')` → return `False`.
  - Connection lifetime: <100ms per insert; no pooling for v1. The task spec says "best-effort" and a per-insert connection is fine at the current transition volume (tens per day, occasionally hundreds when a lobster batch runs).
  - No schema or table creation in the helper — that lives in the migration only.
- **`agents/workflows/bookmarks/scripts/common.py`** *(modified)* — Update `log_transition()` to attempt the DB insert after the JSONL append:
  ```python
  def log_transition(key, from_status, to_status, reason, *, transitions_path=None):
      path = transitions_path or TRANSITIONS_PATH
      # ... existing JSONL write logic, unchanged ...
      # (after fd is closed successfully)
      event = {
          "key": str(key),
          "from": from_status,
          "to": to_status,
          "at": now_iso(),
          "actor": actor,
          "reason": str(reason or "").strip(),
      }
      try:
          from .analytics_db import insert_transition
          insert_transition({
              "bookmark_key": event["key"],
              "from_status": event["from"],
              "to_status": event["to"],
              "topic": _topic_for_key(event["key"]),  # optional; reads from review state if available
              "actor": event["actor"],
              "source": "bookmark-workflow",
              "payload": {"reason": event["reason"], "at": event["at"]},
          })
      except Exception as e:
          log_debug(f"[bookmark-analytics] insert skipped: {e}")
  ```
  - The JSONL write is unchanged (still appends first, in its own `os.write` block). The DB insert happens after; any failure is debug-logged.
  - The `_topic_for_key()` helper is optional and degrades to `None` if the review state isn't loaded; Pulse can backfill the topic from its own joins if needed.
- **`agents/workflows/bookmarks/scripts/analytics_db.py`** *(new tests)* — `agents/workflows/bookmarks/scripts/test_analytics_db.py`:
  - Returns `False` when `DATABASE_URL` is unset (set the env var to empty string for the test).
  - Returns `False` when `DATABASE_URL` points at an unreachable host (use a deliberately bad port like `5433`).
  - Returns `True` on successful insert (use a SQLite-in-Postgres test fixture if available; otherwise a real Postgres roundtrip against the test DB).
  - Logs a warning when the insert fails (capture `log_debug` output).
- **`agents/workflows/bookmarks/scripts/test_common.py`** *(modified if it exists)* — Add a test that asserts `log_transition()` continues to write the JSONL even when `analytics_db.insert_transition()` raises (mock the DB helper to raise).

#### Documentation — `docs/` and inline

- **`docs/systems/bookmark-workflow.md`** *(modified if it exists, otherwise `docs/systems/agent-pipeline-state.md` or similar is the home)* — add a paragraph explaining the analytics mirror, the migration location, and the graceful-degradation contract. If neither file exists, create `docs/systems/bookmark-workflow.md` as the durable home for the bookmark pipeline (which is broader than this task).
- **`agents/workflows/bookmarks/README.md`** *(modified if it exists)* — one paragraph under "Transition logging" pointing at the DB mirror.

### Data model summary

Two new Postgres tables in a new `analytics` schema:

- `analytics.bookmark_transitions` — populated by `log_transition()` whenever `DATABASE_URL` is set. Columns match the JSONL event shape, plus a JSONB `payload` for forward compatibility.
- `analytics.task_transitions` — same shape, mirrored for the future feature-task workflow. Created now, populated later.

No Prisma models for these tables — they're outside the Tasks API domain and will be queried directly by Pulse (or a future Tasks API analytics endpoint).

### Cross-context coordination

None. The helper runs server-side in the same Python process as the existing bookmark workflow scripts; no HTTP, no IPC, no `postMessage`.

### Workflow / cron / skill changes

- No cron changes. The existing bookmark lobster runs exercise the new code path automatically (every transition → JSONL + DB row).
- No skill changes. The `bookmark-curate`, `bookmark-state-analyzer`, and other bookmark-related skills continue to work on JSONL; a future Pulse task can switch them to read Postgres directly.

### Design system usage

None. This is a backend / Python change.

## Test plan

- **Unit — `agents/workflows/bookmarks/scripts/test_analytics_db.py`:**
  - `insert_transition({...})` returns `False` when `DATABASE_URL` is empty.
  - `insert_transition({...})` returns `False` when the connection times out (bad host).
  - `insert_transition({...})` returns `True` on a successful insert against the dev Postgres.
  - `log_transition()` continues to write the JSONL even when `insert_transition()` raises (mock-based test).
- **Integration — `services/tasks-api/prisma/migrations/`:**
  - Run `make migrate-db` (which calls `prisma migrate deploy`): migration applies cleanly.
  - Run `make migrate-db` again: no-op, no error (idempotency).
  - After migration: `\d analytics.bookmark_transitions` in psql shows the expected columns and indexes.
  - After migration: `\d analytics.task_transitions` in psql shows the expected columns and indexes.
- **Manual lobster run (AC7):**
  1. `export DATABASE_URL=postgres://tasks:tasks@localhost:5432/sindustries` (or whatever the dev URL is — check `services/tasks-api/.env.example` or `infra/docker-compose.yml`).
  2. `python3 agents/workflows/bookmarks/run.py` (or invoke the curator/summarizer step that triggers a transition).
  3. `psql $DATABASE_URL -c 'SELECT count(*) FROM analytics.bookmark_transitions;'` shows >= 1 row.
  4. Inspect a row: `SELECT bookmark_key, from_status, to_status, occurred_at FROM analytics.bookmark_transitions ORDER BY occurred_at DESC LIMIT 1;` matches the JSONL event.
- **JSONL preservation (AC6):**
  - Before and after the migration: the JSONL file continues to receive every transition. Diff the JSONL file content before/after a lobster run to confirm nothing was lost.
- **Degradation:**
  - Unset `DATABASE_URL` → JSONL still gets rows; DB has no new rows.
  - Point `DATABASE_URL` at an unreachable host → JSONL still gets rows; a warning is logged; no exception propagates.

## Open questions / risks

- **Q1 — `analytics` schema vs `public` schema.** The idea doc settled on a dedicated `analytics` schema; the design follows that. If a future Pulse task wants to co-locate these tables in `public`, that's a rename, not a redesign. No action needed.
- **Q2 — Connection pooling.** The current volume (tens of transitions per day) doesn't justify a pool. If Pulse polling or a future real-time pipeline raises volume 100×, swap `psycopg2.connect()` for `psycopg2.pool.ThreadedConnectionPool` — one function-local change, no API impact. Documented as a parking-lot item.
- **Q3 — Backfill from JSONL.** The idea doc left this open. The design does **not** backfill — the table starts empty on day 1 of the migration. Pulse analytics will show "since 2026-07-08" gaps; if Tom wants history, a one-shot backfill script is a separate task (~1 hour: parse JSONL, batch-insert, dedupe on `(bookmark_key, occurred_at, to_status)`).
- **Q4 — Topic capture.** Capturing `topic` per transition requires a lookup against `bookmark-review-state.json`. The helper tries this via `_topic_for_key()` and silently sets `NULL` on failure. If lookup becomes a hotspot, the helper can be extended to take an explicit `topic` argument from the call site. No change needed in v1.
- **Q5 — Schema migrations from outside Prisma.** The analytics tables are created by a Prisma migration (so `make migrate-db` covers them), but they're not declared in `schema.prisma`. This means `prisma migrate dev` will see them as unmanaged and might warn. Mitigation: the migration is named with a timestamp and tracked in `_prisma_migrations`; `prisma db pull` will not see them as drift because the migration is in the directory. If Prisma complains at dev time, a one-line comment in `schema.prisma` explains "analytics.* tables are managed by raw SQL migrations only."
- **Q6 — JSONB payload shape.** The `payload` column is `JSONB` (not strongly typed). This is intentional per the idea doc ("state shape is still evolving, so avoid premature normalization; add computed columns later as it stabilizes"). If Pulse needs typed queries on the payload, a future migration adds `GENERATED ALWAYS AS (payload->>'field') STORED` columns.
- **Q7 — Race with the JSONL append.** `log_transition()` is single-threaded per Python process (each lobster step runs in its own process). No concurrent writes from the same process; the existing file-lock-or-append semantics are unchanged. No new race introduced.
- **Q8 — DB permissions.** The `DATABASE_URL` user must have `INSERT` privilege on the `analytics` schema. The Tasks API DB user (`tasks`) does. If a future env uses a read-only `tasks` user for the lobster, we add a `tasks_writer` role or grant `INSERT` to the existing role. Out of scope for v1.
- **Q9 — Pulse query path.** This PR does not add a query endpoint. Pulse will query Postgres directly (via a future Tasks API analytics endpoint or via a dedicated Pulse-side connection). The two tables are designed to be query-friendly (indexes on `occurred_at`, `bookmark_key`, `to_status`). No Pulse work is required for the schema to exist.

## Out of scope

- Backfilling historical transitions from `brain/state/bookmark-transitions.jsonl`.
- A REST query endpoint for Pulse (direct SQL is fine for v1; an endpoint is a future task).
- Populating `analytics.task_transitions` (the table is created now; the feature-task workflow writes to it in a future task).
- Connection pooling.
- Strongly-typed `payload` columns.
- A graceful-degradation dashboard / metric (the helper logs warnings; aggregating them is a future task).
- Real-time streaming or CDC (synchronous insert is enough at current volume).

## Companion doc updates

- `docs/systems/bookmark-workflow.md` *(create if missing, otherwise modify)* — durable system doc for the bookmark pipeline; this task adds the analytics-mirror section.
- `agents/workflows/bookmarks/README.md` *(create or modify)* — paragraph on the analytics mirror under "Transition logging".
- `services/tasks-api/README.md` *(modify if it covers migration conventions)* — note that the `analytics` schema is owned by raw SQL migrations, not Prisma models.
- `[no-system-spec-change]` is recorded at PR time; if cross-cutting analytics for the bookmark pipeline emerge as a long-lived system, a `docs/systems/bookmark-analytics.md` would be the home. For v1, the analytics mirror is a single feature under the existing bookmark-workflow system.

## Later todos (parking lot)

- Backfill from `brain/state/bookmark-transitions.jsonl` (~1-hour one-shot script).
- Connection pooling if volume rises 100×.
- Tasks API analytics read endpoint (`GET /api/v1/analytics/transitions?since=...&topic=...`).
- Strongly-typed `payload` columns via generated columns.
- Feature-task workflow writes to `analytics.task_transitions` (parallel feature).
- A small observability dashboard that aggregates the warning logs from `analytics_db.insert_transition()` failures.