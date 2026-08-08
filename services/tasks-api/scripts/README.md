# Tasks API scripts

## migrate-legacy-approvals.ts

One-shot migration that reads legacy approval state (from task descriptions
and comment bodies) and writes equivalent `TaskApproval` rows through the
canonical `POST /api/v1/tasks/:id/approvals` endpoint.

### Modes

```
# Inspect what would be migrated; no DB writes.
tsx scripts/migrate-legacy-approvals.ts --dry-run

# Write through the canonical endpoint. Saves a snapshot to
# ~/.openclaw/tasks-api/snapshots/<timestamp>.json so a rollback is possible.
tsx scripts/migrate-legacy-approvals.ts --write

# Reverse a previous --write run.
tsx scripts/migrate-legacy-approvals.ts --rollback <snapshot-path>
```

### Sources of legacy approval state

| Signal | Mapped to |
|---|---|
| `- [x] **Approved by Tom**` in description | `spec` approval, owner = `Tom` |
| `- [ ] **Approved by Tom**` in description | Intentionally not migrated (unchecked) |
| `[tech-design-approved] true` in a comment | `tech_design` approval, owner = comment.author |
| `[qa-ac-verified] true` in a comment | `qa` approval, owner = comment.author |

### Safety

1. Run `--dry-run` first. The summary's `createdApprovals` count should
   roughly match the number of tasks that had at least one legacy approval
   signal. If the count looks wildly off, do not proceed.
2. `--write` is idempotent on `(taskId, type)`: existing rows are skipped
   and counted under `skippedExisting`.
3. Each `--write` run saves a snapshot to
   `~/.openclaw/tasks-api/snapshots/<timestamp>.json`. Hold on to this
   snapshot if you might want to reverse the migration.
4. `--rollback` drops every `(taskId, type)` from the snapshot. The
   legacy comments and description checkboxes are untouched, so the
   system reverts to the pre-migration behavior immediately.

### Required env

- `TASKS_API_BASE_URL` — default `http://localhost:4001`.
