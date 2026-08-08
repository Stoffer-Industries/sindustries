# Runbook — Approval migration (`migrate-legacy-approvals`)

**Owner:** Rowan (engineering)
**Trigger:** A new environment (dev, staging, prod-like) needs the legacy approval state in task descriptions/comments translated into the canonical `TaskApproval` rows that the feature-task lobster reads as a delivery gate.
**Related:** `services/tasks-api/scripts/migrate-legacy-approvals.ts`, `services/tasks-api/src/lib/legacyApprovals.ts`, `services/tasks-api/src/routes/taskApprovals.ts`, audit `docs/repo-audits/2026-W32.md` finding *"Migration safety contract exists in source comments but not a durable runbook"*.

## Why this exists

Before the approvals API existed, approval state lived in freeform prose on tasks:

- `**Approved by Tom**` (checked) in description → spec, owner=Tom
- `[tech-design-approved] true` in a comment → tech_design, owner=comment.author
- `[qa-ac-verified] true` in a comment → qa, owner=comment.author
- `- [ ] **Approved by Tom**` (unchecked) in description → **no** spec row (correctly absent)

`migrate-legacy-approvals.ts` reads that state and writes equivalent `TaskApproval` rows through the canonical `POST /api/v1/tasks/:id/approvals` endpoint. The script is idempotent on `(taskId, type)`: if a row already exists, the existing row is left untouched and counted under `skippedExisting`. The script is the only path that can introduce a `TaskApproval` row from a legacy source — there is no automatic backfill on API startup.

This runbook exists because the script's safety contract is documented only in its source header and its rollback is destructive: it deletes rows by snapshot without an integrity check against the target environment.

## Modes

The script takes exactly one mode flag per invocation:

| Flag | Effect | Writes? | Snapshot? |
|---|---|---|---|
| `--dry-run` | Print summary only. | No | No |
| `--write` | Run the full algorithm, POST each new approval, write a snapshot. | Yes | Yes (`~/.openclaw/tasks-api/snapshots/<ISO timestamp>.json`) |
| `--rollback <snapshot-path>` | `DELETE` every `(taskId, type)` listed in the snapshot. | Yes (destructive) | No |

Rejected usage: passing `--dry-run` and `--write` together, or `--rollback` without a path, exits with a non-zero status. `--help` prints the same summary as the source header.

Required env: `TASKS_API_BASE_URL` (default `http://localhost:4001`). The script does **not** validate that the base URL points at the intended environment — set the env explicitly (`TASKS_API_BASE_URL=https://tasks-api.staging.example.com npx tsx ...`) and verify the value before each invocation.

## Pre-flight

1. **Confirm target environment.** Run `echo "$TASKS_API_BASE_URL"` before every call. The script cannot tell the difference between dev and staging — the operator is the only safeguard.
2. **Confirm the API is reachable.** `curl -fsS "$TASKS_API_BASE_URL/api/v1/health"` (or whatever the environment's health endpoint is) should return 200. If the API is down, do not run `--write`; `--dry-run` will also fail because it needs to fetch tasks.
3. **Confirm you've reviewed the protections that already exist on the target API.** The script posts against `POST /api/v1/tasks/:id/approvals` and `DELETE /api/v1/tasks/:id/approvals/:type`. If the target API has the internal-secret middleware enabled (theme 1 of the W32 audit), the script will fail with a 401 — set the appropriate credential header or run against a loopback-only API. The script does not carry credentials itself.
4. **Notify the team.** Approval writes are durable and visible to the lobster workflow on the next sweep. A misdirected `--write` may bypass an approval gate. Pin a window in `#engineering` and pause lobster sweeps if available.
5. **Take a snapshot of the approval table before destructive operations.** For production-grade runs, dump the table first:
   ```sql
   pg_dump -t '"TaskApproval"' --data-only --no-owner > task-approval-pre-migration-$(date -u +%Y%m%dT%H%M%SZ).sql
   ```
   The backup is under the database's current schema, not a script snapshot. It is the safety net for `--rollback` failure.

## Procedure

### 1. Dry-run

```sh
TASKS_API_BASE_URL=https://tasks-api.staging.example.com \
  npx tsx --require @sindustries/otel-node/register \
  services/tasks-api/scripts/migrate-legacy-approvals.ts --dry-run
```

Expected output shape:

```json
{
  "totalTasks": 1234,
  "createdApprovals": 47,
  "skippedExisting": 312,
  "breakdownByType": [
    { "type": "spec", "created": 30, "skippedExisting": 200 },
    { "type": "tech_design", "created": 10, "skippedExisting": 80 },
    { "type": "qa", "created": 7, "skippedExisting": 32 }
  ],
  "snapshotPath": null,
  "dryRun": true,
  "rolledBack": 0
}
```

Checks before proceeding:

- `totalTasks` matches the expected order of magnitude (use `GET /api/v1/tasks?limit=1` to compare the page count).
- `createdApprovals` is non-zero and reasonable — a 0 count means either the migration was already run (rows already exist) or no legacy state was detected.
- `breakdownByType` is consistent with the source distribution. If a single type shows all of the creates while the others are zero, the detection logic is probably reading from the wrong field — stop and investigate.

### 2. Write

```sh
TASKS_API_BASE_URL=https://tasks-api.staging.example.com \
  npx tsx --require @sindustries/otel-node/register \
  services/tasks-api/scripts/migrate-legacy-approvals.ts --write
```

The script will:

1. Fetch every task (paginated, 200 per page).
2. For each task, detect legacy state from description and comments.
3. For each `(taskId, type)` that does not already have a row, POST it to the API.
4. Accumulate the rows it created in memory.
5. At the end, write a snapshot to `~/.openclaw/tasks-api/snapshots/<ISO timestamp>.json` containing the created rows.

**Important caveat — no resume support.** If the API returns a 5xx mid-run, the script exits with an error and the snapshot is **not written**. Re-running `--write` is safe: the `skippedExisting` path will skip rows that already landed, and only the missing tail will be attempted. But this is a manual operator judgment, not a checkpointed workflow. Monitor the API and the script's progress closely on a first run.

**Capture the snapshot path from stdout.** The script prints the JSON summary at the end, including `snapshotPath`. Copy that path into a safe place — the snapshot is the only artifact that supports `--rollback`, and the operator needs to point rollback at it later.

### 3. Verify

After `--write`:

1. **Confirm the row counts.** `breakdownByType` should match the dry-run's prediction (modulo rows that were freshly created between the dry-run and the write).
2. **Spot-check a few tasks.** Pick three tasks from the snapshot and `GET /api/v1/tasks/:id` for each. The `approvals` array should contain the rows you expect.
3. **Check the snapshot file.** It should be valid JSON and contain an array of `{ taskId, type }` entries. The schema is intentionally minimal today — see "Future hardening" below for what is missing.
4. **Re-run `--dry-run`.** A clean re-run shows `createdApprovals: 0` and `skippedExisting` equal to the previous `createdApprovals + skippedExisting`. This is the strongest end-to-end check that the script is done with this dataset.

## Rollback

Only the `--rollback` mode is approved for undoing a migration. **There is no UI or admin endpoint that does the same thing.**

```sh
TASKS_API_BASE_URL=https://tasks-api.staging.example.com \
  npx tsx --require @sindustries/otel-node/register \
  services/tasks-api/scripts/migrate-legacy-approvals.ts \
  --rollback ~/.openclaw/tasks-api/snapshots/2026-08-08T11-30-00.json
```

Behavior:

- Reads the snapshot file and DELETEs each `(taskId, type)` listed.
- Does **not** confirm the snapshot is from the same environment as the current `TASKS_API_BASE_URL`. Match the path yourself.
- Does **not** verify the rows still exist before issuing DELETE — re-running `--rollback` on the same snapshot is a no-op against the API but doubles the request count.
- Returns `rolledBack: <row count>` in the summary.

**Before invoking `--rollback`:**

1. Confirm the snapshot file's `savedAt` matches the run you are undoing. The file is named with the timestamp of the run that produced it.
2. Confirm the target environment via `TASKS_API_BASE_URL`.
3. Confirm the operator who triggered the original `--write` is aware, or pause the lobster sweep for the duration of the rollback.
4. Prefer the database-level `pg_dump` (taken in pre-flight) as the recovery path if `--rollback` itself misbehaves. The script cannot guarantee atomicity.

After rollback, re-run `--dry-run` and confirm `createdApprovals` is back to the pre-`--write` number. If it is **not**, the rollback gave up partway through and you need to investigate from the API logs, not just rerun the script.

## Known limitations

These are gaps in the current script that the audit's Task Plan already tracks. They are not a reason to delay a necessary migration, but the operator should know about them:

- **No snapshot schema version.** The snapshot format is the union of whatever the script wrote at the time. A future script version that changes the snapshot shape will not refuse to read an older snapshot.
- **No environment identity in the snapshot.** The snapshot is just a list of `(taskId, type)` rows. Rollback against a different `TASKS_API_BASE_URL` will silently delete rows in the wrong database. Match the environment manually.
- **No created-row IDs.** The snapshot records the keys that were written, not the database IDs the API returned. If the API ever returns a different row for the same key (e.g., a unique constraint violation generates a new row), the snapshot will not capture the new ID.
- **Per-row HTTP POSTs.** `--write` makes one POST per detected approval. A 1,000-row migration is 1,000 round trips. If the API is slow, the run can exceed HTTP timeouts.
- **No checkpoint.** Failure mid-run leaves the dataset partially migrated. Re-running `--write` is safe (idempotent on `(taskId, type)`) but is a manual operator step.
- **No confirmation guard on rollback.** The script will delete every row listed in the snapshot without asking.

## Future hardening (not in scope today)

The audit's Milestone 0 task 2 and Milestone 1 task 4 (in `docs/repo-audits/2026-W32.md`) track the durable fixes:

1. Add a `version` field to the snapshot file and have `--rollback` reject snapshots with a too-new or too-old version.
2. Add a `targetApiBaseUrl` and `environment` field to the snapshot and have `--rollback` require an explicit `--match-environment` flag.
3. Add the created row IDs (the API's response ID) to the snapshot so rollback can target the exact row even if duplicates exist.
4. Switch from one HTTP POST per row to a bounded batch endpoint (Milestone 2 task 6).
5. Add a checkpoint file so a failed `--write` can resume from the last successful batch.

Tracked as follow-up tasks; see the migration theme in the audit. Until those land, this runbook is the only durable reminder of the script's safety contract.
