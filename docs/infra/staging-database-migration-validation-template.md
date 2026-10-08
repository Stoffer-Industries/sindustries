# Cloud staging database migration + restore — evidence template

> Task: `d37681e1-2666-425b-bf1d-5edd4f4be7ce` (Validate staging database migration and restore)
> Tech design: `docs/specs/staging-database-migration-restore-tech-design.md` (Quinn approved 2026-08-15)
> Runbook: `docs/runbooks/staging-database-migration-restore.md`
> Workflow: `.github/workflows/cloud-staging-db-drill.yml`

Copy this file to `docs/infra/staging-database-migration-validation-<YYYY-MM-DD>.md`
and fill in the bracketed placeholders. Do not commit raw DSNs, host
names, row data, IDs, titles, comments, emails, merchant text, or
token bytes. The drill script already redacts logs and envelopes; the
operator's job is to keep this document redacted too.

---

## Run header

- **Date (UTC):** `<YYYY-MM-DD>`
- **Workflow run id:** `<github-run-id>`
- **Drill run id (CLOUD_DB_RUN_ID):** `<run-id>`
- **Environment:** `staging`
- **Operator:** `<github-handle>`
- **Image commit:** `<full-sha>` (`<short-sha>`)
- **Interruption drill:** `<none | dump | restore>`
- **Recovery drill included:** `<yes | no>`

## Source / destination resource aliases

| Resource | Alias | Provider | Notes |
|---|---|---|---|
| Source tasks_api DB | `source-tasks` | `<provider>` | read-only, no DSN committed |
| Source budget_api DB | `source-budget` | `<provider>` | read-only, no DSN committed |
| Destination tasks_api DB | `dest-tasks` | `<provider>` | fresh, empty pre-restore |
| Destination budget_api DB | `dest-budget` | `<provider>` | fresh, empty pre-restore |
| Recovery tasks_api DB | `recovery-tasks` | `<provider>` | only when --recovery |
| Recovery budget_api DB | `recovery-budget` | `<provider>` | only when --recovery |

## Result envelopes (paste JSON or attach)

- **inventory:** `<inventory-<run-id>.json>`
- **dump:** `<dump-<run-id>.json>` (archive path + sha256)
- **restore:** `<restore-<run-id>.json>`
- **migrate:** `<migrate-<run-id>.json>`
- **reconcile (source → dest):** `<reconcile-<run-id>.json>`
- **drill (final):** `<drill-<run-id>.json>`
- **reconcile (dest → recovery):** `<reconcile-recovery-<run-id>.json>` (only when --recovery)

## AC-by-AC verdict

| AC | Verification | Verdict | Notes |
|---|---|---|---|
| AC1 — representative staging data transfers with reconciliation and no unexplained loss/duplication | `<reconcile-<run-id>.json>` shows every check `match=true`, every `digestMatch=true`. | `<PASS / FAIL>` | Any non-zero unexplained delta fails. |
| AC2 — required migrations complete and representative workflows continue | `<migrate-<run-id>.json>` shows zero `failed`, zero unaccounted `pending`. Black-box staging workflow from task `2850c5ac` is run against the destination. | `<PASS / FAIL>` | |
| AC3 — migrated backup restores into a usable service state | Recovery reconcile envelope is `verdict=PASS`; health + authenticated workflow checks pass. | `<PASS / FAIL>` | |
| AC4 — failure/interruption/retry is documented and verified safely | Interruption drill envelope (if any) shows `.partial` / quarantine semantics; CI migration-failure fixture test is green; runbook §3 covers the procedure. | `<PASS / FAIL>` | |

## Production blockers

A `PASS` verdict for AC1–AC4 requires this table to be empty.

| # | Blocker | Owner | Status |
|---|---|---|---|

## Accepted limitations

Limitations are recorded here so they cannot be confused with
blockers. Each limitation is acknowledged and tracked.

| # | Limitation | Why it's accepted | Tracking |
|---|---|---|---|

## Cleanup record

| Resource | Action | Time (UTC) | Operator |
|---|---|---|---|

## Refs

- `docs/specs/staging-database-migration-restore-tech-design.md`
- `scripts/cloud/database/{common,inventory,dump,restore,migrate,reconcile.mjs,drill}.sh`
- `services/tasks-api/ops/reconciliation.sql`
- `services/budget-api/ops/reconciliation.sql`
- `.github/workflows/cloud-staging-db-drill.yml`
- `docs/runbooks/staging-database-migration-restore.md`
- `brain/tasks/specs/open/staging-database-migration-restore.md`
- Task `d37681e1-2666-425b-bf1d-5edd4f4be7ce`
