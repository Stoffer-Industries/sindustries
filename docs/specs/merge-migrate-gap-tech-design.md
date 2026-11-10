---
status: draft
task_id: 20195ce7-6510-4b94-811d-8aefc66fda3f
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Close the Merge→Migrate Gap Tech Design

## Links

- Task: `20195ce7-6510-4b94-811d-8aefc66fda3f` ("Close the merge→migrate gap so schema drift cannot 500 the shared Tasks API again")
- Task API detail: `http://localhost:4001/api/v1/tasks/20195ce7-6510-4b94-811d-8aefc66fda3f`
- Incident: 2026-10-23 ~01:12 NZDT, documented on the task and in `brain/ops/retro-notes/2026-10-23.md` (`code-syncs-to-main-without-schema-sync-to-prodlike`)
- Prior diagnosis: Lox comments on the task (2026-10-24, 2026-10-25) — root cause located, design commissioned by Quinn rather than waived (2026-10-26)

## Scope

- Repositories: `Stoffer-Industries/sindustries` (AC1, AC2) and `Stoffer-Industries/workspace` (AC3 — Edge lives there, not in `sindustries`)
- Branch (this doc): `task-20195ce7-merge-migrate-gap-tech-design`
- Worktree: `/Volumes/WD1/worktrees/rowan/task-20195ce7-merge-migrate-gap-tech-design`
- Primary code surfaces:
  - `services/tasks-api/package.json` (`predev`/`prestart` scripts) — AC1
  - `services/tasks-api/src/server.ts` — AC2 startup preflight
  - `services/tasks-api/src/lib/schemaPreflight.ts` (new) — AC2 implementation
  - `services/tasks-api/test/` — new preflight unit test(s)
  - `services/openclaw-edge/server.mjs` (workspace repo) — AC3 push-time drift check + self-heal
  - `scripts/dev/migrate-db.sh` (sindustries repo) — reused, not duplicated, by the AC3 step
  - `brain/state/quinn-ops-state.json` incident note — AC4, already shipped by Lox 2026-10-25; no further action here

**`.openclaw` boundary note:** AC3's code lives in `services/openclaw-edge/server.mjs`, which is in the `Stoffer-Industries/workspace` repo, not `sindustries`. It ships as a separate PR against `workspace` and is **not** gated by the `sindustries` code-task Lobster workflow that owns this task. AC1/AC2 ship as a normal `sindustries` PR.

## Incident Recap (why this is durable, not one-off)

`codebases/sindustries` is fast-forwarded to `origin/main` by Edge's webhook (`services/openclaw-edge/server.mjs:166` `refreshMainCheckout()`) within seconds of every push to `main`. That updates the Prisma schema and (on the next file-watch-triggered restart) the generated client, but nothing in that path — or in the Tilt-managed local dev/prodlike service, or in CI — ever runs `prisma migrate deploy` against the long-lived local Postgres instances that back `dev` (port 6432) and `prodlike` (port 7432, the one all agents read via `TASKS_API_BASE_URL=http://localhost:4001/api/v1`). When a merged migration adds a column the generated client selects, every read 500s with Prisma `P2022` until someone notices and runs `scripts/dev/migrate-db.sh` by hand.

Three independent facts made this invisible longer than it should have been:
1. CI (`.github/workflows/ci.yml`) always provisions a **fresh** ephemeral DB and runs `prisma:migrate` against it before testing, so CI can never observe "migration merged but not applied to a persistent target" — there is no persistent target in CI.
2. Fly's staging deploy (`infra/cloud/fly/tasks-api.fly.toml`) already has `release_command = 'npm run prisma:migrate --workspace services/tasks-api'` wired into `[deploy]`, so the hosted staging app is not exposed to this gap. The gap is specific to the **local** Tilt-managed `dev`/`prodlike` stacks on Tom's Mac, which is what every agent actually reads from day to day.
3. Tilt's `tasks-api` `local_resource` (`infra/tilt/Tiltfile`) already lists `services/tasks-api/prisma` under `deps`, so it *does* restart `npm run dev` whenever a migration file changes on disk (via Edge's fast-forward touching the checkout). But `predev` only runs `prisma generate` — it regenerates the client against the new schema and restarts, without ever applying the migration to the DB. That restart is what made the incident land instantly and totally once the merge happened, rather than waiting for a cold start.

## Design Decisions (resolving Lox's five open questions)

1. **Where the migrate step lives — two layers, not one:**
   - **Layer A (fast self-heal, push time):** `services/openclaw-edge/server.mjs`, in the same push handler that already calls `refreshMainCheckout()`. This runs seconds after a merge, before any agent would notice.
   - **Layer B (fail-closed backstop, every service start):** `services/tasks-api/predev`/`prestart` (AC1) plus a startup preflight in `server.ts` (AC2). This is what protects dev (Rowan's own iteration DB, out of Edge's remit) and covers the case where Layer A is disabled, fails, or the service is started by hand.
   - Rejected: a third, separate periodic drift-guard script (option c from Lox's list). It would duplicate Layer A's detection with a polling delay and no extra safety the push-time hook doesn't already give for the one DB that matters most (prodlike). Not worth the added moving part.
2. **Which databases:** Layer A (Edge, AC3) targets **prodlike only** — it's the shared DB "every agent reads," and dev is explicitly Rowan's own remit per Lox's 2026-10-24 note. Layer B (AC1 predev, AC2 preflight) is generic per-service and protects **both** dev and prodlike identically, since it runs inside whichever Tilt mode is currently up.
3. **Failure policy:** Edge's `refreshMainCheckout()` **never blocks the fast-forward** — that would break Edge's core invariant that the canonical checkout always tracks `origin/main`, and a merge already landed on GitHub regardless of what the local Mac does. Instead: Edge best-effort runs the migrate step after a successful ff-merge and **alerts via `wakeMainSession()`** (the same channel already used for agent-definition sync failures) if it fails, without retrying in a loop. The authoritative guarantee against serving broken reads is Layer B's AC2 preflight, which refuses to `listen()` at all if the DB doesn't match the generated client — regardless of whether Layer A succeeded.
4. **Ordering:** `refreshMainCheckout()` → run `scripts/dev/migrate-db.sh` (`MODE=prodlike`) → `removeMergedWorktrees()`. The migration lands before Edge logs the refresh as complete. Tilt's own file-watch restart of `tasks-api` (triggered by the same checkout update) is independently gated by `predev`'s `prisma migrate deploy` (AC1), so even if Layer A is slow or fails, the respawned process will not start serving until the DB is correct, or it will fail to start at all (visible in Tilt as a crashed resource) rather than silently serving 500s.
5. **Credentials/DB reachability:** Reuse `scripts/dev/migrate-db.sh` rather than reimplementing backup+migrate+auto-recover logic in Edge. That script already knows how to reach the local Postgres (`postgresql://postgres:postgres@localhost:<port>/<db>`), takes a pre-migrate `pg_dump` backup, and has an auto-recovery path for the one known partial-apply drift case. Edge shells out to it with `MODE=prodlike` in the environment, exactly as a human operator would, so there is exactly one source of truth for "how we apply migrations" rather than two.

## Implementation Plan

### AC1 — `predev`/`prestart` run `prisma migrate deploy`

`services/tasks-api/package.json`:

```json
"predev": "prisma migrate deploy && prisma generate",
"prestart": "prisma migrate deploy && prisma generate",
```

This covers the Tilt-managed `dev` and `prodlike` local stacks (both run `npm run dev` via `infra/tilt/Tiltfile`'s `tasks-api` `local_resource`, which already restarts on `services/tasks-api/prisma` changes) and the `npm start` path used by Fly (where `release_command` already runs `prisma:migrate` separately — this makes `prestart` consistent with that, and harmless to run twice since `migrate deploy` is idempotent against an already-current DB).

If `prisma migrate deploy` fails (e.g. DB unreachable, a genuinely broken migration), `predev`/`prestart` fails and `npm run dev`/`npm start` never starts the server — the previous process has already been killed by Tilt before the new one is spawned, so the service goes **down** rather than serving 500s. This is an accepted, explicit tradeoff (see Risks).

### AC2 — Startup preflight on `TaskApproval` columns

New `services/tasks-api/src/lib/schemaPreflight.ts`:

- Import `Prisma` from the generated client (`../../generated/prisma/index.js`) and read `Prisma.dmmf.datamodel.models.find(m => m.name === 'TaskApproval').fields`, filtering to `kind === 'scalar'` fields, mapping each to its `dbName ?? name` — this is the exact column set the generated client will select, re-derived from `schema.prisma` automatically on every generate, so the check never drifts from the model it's protecting.
- Query `information_schema.columns` for `table_schema = 'tasks_api' AND table_name = 'TaskApproval'` via the existing `prisma` client (`prisma.$queryRaw`), producing the actual column set in the connected DB.
- Diff expected vs. actual. For each missing column, `grep` `prisma/migrations/*/migration.sql` for a `CREATE`/`ADD COLUMN` statement naming that column (case-insensitive) and report the owning migration directory name if found.
- Export a single `assertTaskApprovalSchema(): Promise<void>` that throws a descriptive `Error` (naming every missing column and its migration, if identified) when any column is missing; resolves otherwise.

`services/tasks-api/src/server.ts`: call `await assertTaskApprovalSchema()` immediately before `app.listen(...)`. On rejection, log the error and `process.exit(1)` instead of starting the listener — turning a silent total-outage-via-500 into a loud, correctly-attributed startup failure, which is AC2's explicit goal.

Scope is intentionally limited to `TaskApproval` per the AC text (it's the model that caused the incident); the same helper function generalizes to any model name if a future incident needs it, with no structural change.

### AC3 — Edge push-time drift self-heal

`services/openclaw-edge/server.mjs` (workspace repo): add a `migratePronodlikeDb()` step (naming TBD in review) called from the existing push-handler `action()` right after `await refreshMainCheckout();` succeeds and before `await removeMergedWorktrees();`:

```js
async function migrateProdlikeDb() {
  const script = path.join(REPO_ROOT, "scripts/dev/migrate-db.sh");
  try {
    await execFileAsync("bash", [script], {
      env: { ...process.env, MODE: "prodlike" },
      maxBuffer: 4 * 1024 * 1024,
    });
    log("prodlike DB migration check complete (no drift, or drift resolved)");
  } catch (error) {
    log(`ERROR: prodlike DB migration failed: ${error?.message || error}`);
    await wakeMainSession(
      `Tasks API prodlike DB migration failed after a main push. ` +
        `The merged schema may be ahead of the applied DB again. ` +
        `Check: bash scripts/dev/migrate-db.sh (MODE=prodlike) in codebases/sindustries. ` +
        `Error: ${error?.message || error}`
    );
  }
}
```

Called unconditionally after every successful `refreshMainCheckout()` (not gated on `relevant.length`, since a schema-affecting migration need not touch `agents/definitions/` or `agents/lib/`). `scripts/dev/migrate-db.sh` already no-ops safely (just runs `prisma migrate deploy`, which is a no-op when nothing is pending) when there's no new migration, so this is cheap on every push, not just schema-changing ones.

This directly satisfies AC3's "caught at push time" wording: GitHub Actions CI cannot observe this class of drift at all (its DB is always freshly created — see Incident Recap), so the only mechanism that runs "at push time" with access to the real persistent DB is Edge's push handler.

### AC4 — already shipped

Lox's 2026-10-25 comment and the referenced commits to `brain/state/quinn-ops-state.json` and the new `infra/runbooks/tasks-api-502-egress-proxy-vs-schema-drift.md` runbook (workspace repo) satisfy AC4. No further action in this design or its implementation PR.

## Data Model / API Contract Changes

None. No `schema.prisma` changes. AC2 reads the existing `TaskApproval` model's DMMF reflectively; it does not add fields.

## Workflow / Cron / Skill Changes

None beyond the Edge push-handler change (AC3), which is infrastructure code, not an agent workflow/skill.

## Ownership Boundary Check

- **AC1/AC2 (package.json lifecycle scripts, startup preflight):** API-owned resource — `services/tasks-api` already owns its own Prisma schema, migrations, and startup sequence. This is the natural, durable home; no shim under consideration.
- **AC3 (push-time self-heal):** Workflow/infra boundary — Edge already owns "what happens to the canonical checkout on a push to main." Adding "and make sure the DB it serves from is current" is a direct extension of that existing responsibility, not a new boundary. The alternative (a new standalone periodic guard, rejected above under Design Decisions #1) would have been a second, weaker source of truth for the same concern.
- No interim shim is proposed anywhere in this design — AC1/AC2 ship the durable fix directly (a one-line `package.json` change plus a small preflight module is not meaningfully cheaper to prototype first), and AC3 reuses the existing durable `migrate-db.sh` rather than introducing a parallel one.

## Test Plan

| AC | Verification | Layer |
|----|---------------|-------|
| AC1 | Unit/integration: with `prisma/migrations/` containing a migration not yet applied to a fresh test DB, running `npm run dev`'s `predev` step (or a direct `npm run prisma:migrate` invocation in a test harness) applies it before the server would otherwise start; assert exit code 0 and `_prisma_migrations` row present after. Existing `services/tasks-api/test/prisma-validate.test.ts` already proves the schema itself is valid against a throwaway DB — new coverage proves the *lifecycle script* applies migrations, not just that the schema validates. | integration (vitest, `services/tasks-api/test/`) |
| AC2 | Unit test for `assertTaskApprovalSchema()`: (a) against a fully-migrated test DB, resolves; (b) against a test DB missing one `TaskApproval` column (drop it after migrating, or migrate only up to N-1), rejects with an error naming that column. Mock/stub `information_schema.columns` query is unnecessary — use the real Postgres test DB already wired for `services/tasks-api/test/db-integration.test.ts`. | integration (vitest) |
| AC3 | No automated E2E possible — this is a local Mac-only, Edge-process-level integration with a real webhook delivery and a real local Postgres, which is exactly the class of infra change the existing `infra/guards/*` scripts never get CI coverage for either. Fallback: manual verification during rollout — trigger a push containing a trivial new migration against a prodlike snapshot, confirm Edge's log shows the migrate step running and `_prisma_migrations` picks up the new row, then confirm a deliberately-broken migration produces the `wakeMainSession` alert instead of a silent hang. Record the manual run in the task's evidence comment. | manual, recorded as task evidence |
| AC4 | Already shipped; no new verification needed (Lox's comment + merged runbook/incident-note commits are the evidence). | n/a |

## Open Questions and Risks

1. **Brief tasks-api downtime on a predev failure (AC1):** if `prisma migrate deploy` fails for any reason (bad migration, DB unreachable), Tilt's respawned `tasks-api` process won't start, so the service is fully down until fixed — rather than serving stale-but-working reads. This is intentional (same fail-closed philosophy as AC2) but is a behavior change worth flagging to Quinn: previously a bad migration left the *old* process running (serving a stale-but-correct schema) until someone noticed; now it goes down immediately. Recommend accepting this, since "down and loud" is strictly more debuggable than "500ing silently," but it's Quinn's call as the design approver.
2. **Edge auto-applying migrations against prodlike unattended (AC3)** is the biggest blast-radius item in this design — it turns "someone runs `migrate-db.sh` by hand after noticing drift" into "every push to `main` can mutate the shared prodlike DB automatically." Mitigations already in the reused script (pre-migrate `pg_dump` backup, Prisma's per-migration transactional apply, existing auto-recovery for the one known partial-apply case) carry over unchanged, and `migrate deploy` is the same command a human would run. Flagging explicitly for Quinn's review rather than treating it as self-evidently safe.
3. **`information_schema.columns` check is `TaskApproval`-only (AC2),** matching the AC text and the actual incident. If a future incident hits a different model, the same helper trivially generalizes, but it does not currently guard the whole schema — intentional scope limit, not an oversight.
4. **Dev DB is not covered by Layer A.** If Rowan's own dev Postgres drifts, only Layer B (AC1/AC2) protects it — consistent with Lox's 2026-10-24 note that dev is Rowan's remit, but worth stating plainly so it isn't assumed to be covered by the Edge change.
