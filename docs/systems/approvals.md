# Approvals

**Type:** System reference (data plane + workflow bridges)
**Last updated:** 2026-08-12
**Owner:** Rowan (engineering) · Tom (product approval gates) · Quinn (workflow orchestration)
**Repos:** `Stoffer-Industries/sindustries`
**Related task:** `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` (Remove legacy task-description approval marker)

---

## Purpose

This doc is the single source of truth for how Sindustries models approval state across the three approval-bearing surfaces:

1. **Task-level approvals** — structured `TaskApproval` rows on a task (the `spec`, `tech_design`, and `qa` gates that gate the task lifecycle).
2. **Brain-spec approvals** — markdown checkboxes inside the brain-spec FILE (a separate, file-level workflow the lobster reads to reconcile structured spec approvals).
3. **Bookmark-spec approvals** — markdown checkboxes inside bookmark-spec FILES (a separate, file-level workflow routed through the bookmark approval telemetry to Tom).

It exists so any engineer touching approval state in code can answer two questions from one place: "where is approval state stored?" and "what does each surface read or write to decide?" It also documents the legacy task-description approval marker that was removed by task `e2aba106` (WS1 + WS2), and the cutover plan, snapshot format, and rollback procedure that go with that removal.

Cross-cutting references:

- `docs/systems/tasks.md` — task data plane, `TaskApproval` table, required-approvals policy.
- `docs/systems/bookmark-workflow.md` — bookmark-driven spec intake (parallel pipeline that ends in a structured `spec` approval).
- `docs/systems/agent-orchestration.md` — wider agent map.

---

## Section index

1. [Architecture](#architecture)
2. [Data plane: structured `TaskApproval`](#data-plane-structured-taskapproval)
3. [Workflow bridges](#workflow-bridges)
4. [Legacy task-description approval marker (removed)](#legacy-task-description-approval-marker-removed)
5. [Cutover plan](#cutover-plan)
6. [Snapshot format](#snapshot-format)
7. [Rollback procedure](#rollback-procedure)
8. [Regression coverage](#regression-coverage)
9. [Operational guardrails](#operational-guardrails)
10. [Related specs, tasks, and PRs](#related-specs-tasks-and-prs)

---

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │              Sources of approval             │
                 │                                              │
                 │   Brain-spec FILE   Bookmark-spec FILE       │
                 │   checkbox          checkbox                 │
                 │   (e.g. brain/      (e.g. brain/bookmarks/    │
                 │    tasks/specs/      specs/*.md)             │
                 │    open/*.md)                                │
                 └────────────────┬───────────────┬─────────────┘
                                  │               │
                       read by    │               │  read by
                                  ▼               ▼
                  ┌─────────────────────┐ ┌─────────────────────┐
                  │ feature-task lobster│ │ bookmark lobster +  │
                  │ (brain-checkbox     │ │ review lobster      │
                  │  reconciler —       │ │ (bookmark approval  │
                  │  run.py sweep)      │ │  telemetry)         │
                  └──────────┬──────────┘ └──────────┬──────────┘
                             │                        │
                             │ POST /tasks/:id/       │ POST /tasks/:id/
                             │   approvals/spec       │   approvals/spec
                             ▼                        ▼
                  ┌────────────────────────────────────────────┐
                  │            Tasks API (Tasks DB)            │
                  │ TaskApproval rows: spec / tech_design / qa │
                  │ + audit comments `[brain_spec_approved...]`│
                  │ + `[tech-design-approved] true`            │
                  │ + `[qa-ac-verified] true`                  │
                  └────────────────────────────────────────────┘
```

Three things to keep in mind when reading this diagram:

1. The structured `TaskApproval` row is the **only** authoritative surface a task lifecycle depends on. The brain- and bookmark-spec markdown checkboxes are inputs that get **reconciled into** a `TaskApproval` row through the workflow lobes above. They are not consumed directly by the task lifecycle.
2. The brain- and bookmark-spec markdown checkboxes are themselves meaningful workflow signals. They live in version-controlled spec FILES so Tom can grant or revoke approval by editing one file, and the change is traceable in git history. They do not replace the structured row; they translate into one through a controlled write path.
3. The legacy task-description approval checkbox (a `- [x]` line whose label was `**Approved by Tom**` in the task description) is **not** part of the architecture diagram. It was removed by task `e2aba106` (WS1 froze the description-handling surface, WS2 removed the lobster's reads/writes). The brain- and bookmark-spec markdown systems above are the only surviving file-level approval surfaces.

---

## Data plane: structured `TaskApproval`

The Tasks API owns a `TaskApproval` join row keyed by `(taskId, type)`, where `type` is one of `spec`, `tech_design`, `qa`. Each row carries `owner`, `state` (`approved` or `revoked`), `approvedAt`, `revokedAt`, and a free-form `note`. The Tasks API policy in `.openclaw/tasks-api/required-approvals.yaml` declares which types are required per `taskType` and who owns each type. Clients never pass `owner`; the server derives it from the credential.

See [`docs/systems/tasks.md` § TaskApproval](../systems/tasks.md#taskapproval) and [`docs/systems/tasks.md` § Required approvals policy](../systems/tasks.md#required-approvals-policy) for the canonical description of the policy, write endpoints, and authentication contract. This doc only states the cross-cutting invariants:

- `state` transitions are append-only. A revoked row stays as a row; lifecycle code never deletes it.
- The API rejects writes from credentials that do not match the policy-declared owner.
- Lobster audit comments `[brain_spec_approved_by_tom]`, `[tech-design-approved] true`, and `[qa-ac-verified] true` are the ONLY comment shape that produces a `TaskApproval` row. Other comment text is informational and never satisfies a gate.

---

## Workflow bridges

### Feature-task lobster (brain-checkbox reconciler)

Before dispatching per-task workflows, `run.py` scans `brain/tasks/specs/open/*.md` for an exact `- [x]` checkbox line whose label is `**Approved by Tom**`. When found, the reconciler:

1. Verifies that the task description links to exactly one brain-spec FILE (`**Spec:** <path>`).
2. Confirms that the Tasks API policy requires the `spec` approval type for that `taskType`.
3. Calls `POST /tasks/:id/approvals/spec` with Tom's scoped `TASKS_API_APPROVAL_TOKEN` (loaded from `~/.openclaw/.env`).
4. Emits an audit comment describing the source spec file and the resolved gate.

The sweep is idempotent: an already-approved row produces no API write or second audit comment. Unchecked checkboxes, revoked API rows, missing or duplicate `**Spec:**` links, inaccessible files, code tasks, and spec FILES outside the `open/` task-spec directory never grant approval and are reported as diagnostics. A revoked API row is deliberately not re-approved from a stale checked checkbox because API state is authoritative. See `agents/workflows/feature-task/WORKFLOW.md` for the full bridge description.

### Bookmark approval telemetry

The bookmark approval pipeline runs after a bookmark-spec FILE has been curated and approved at the spec level. It is described end-to-end in `docs/systems/bookmark-workflow.md` § Pipeline Stages. The bookmark lobster reads the spec FILE's checkbox state for the lifecycle phase, transitions the bookmark item through `approval_pending` → `approved`, and writes through the `TaskApproval` endpoint. Telemetry drives the Telegram message that asks Tom to confirm.

### Drift / resync contract

The feature-task lobster separately handles AC drift. When the canonical AC text on a task no longer matches the brain-spec FILE, the lobster:

- Deletes the structured `TaskApproval` row via `DELETE /tasks/:id/approvals/spec`.
- Posts a checklist describing the drift episode.
- Binds subsequent re-approvals to the drift episode via `[spec-resynced]` records.

This is the ONLY legitimate path that revokes a `spec` approval. All other revocations are domain decisions separate from drift handling.

---

## Legacy task-description approval marker (removed)

Until 2026-08-10, the feature-task lobster read the legacy task-description approval marker as the source of truth for spec approval. The marker was a `- [x]` checkbox line whose label was `**Approved by Tom**`, written directly into the task description markdown. It had three roles:

1. Spec approval gate — the marker being checked satisfied the spec gate.
2. Drift handling — the lobster auto-unchecked the marker whenever the AC checksum drifted, so a stale approval did not carry forward.
3. Resync — the lobster rewrote the marker when ACs were re-synced, signalling that Tom's approval applied to the new AC text.

This marker is **gone** as of task `e2aba106` (WS1 + WS2 merged). The structured `TaskApproval` row drives all three roles now. The marker is no longer preserved, auto-unchecked, or rewritten by any code path. Tasks that previously contained a checked marker are silently ignored by the lobster (lifecycle code reads `TaskApproval`, not the description).

If you find a code path that still reads the marker from a task description, it is a bug. Open an issue against the legacy-marker lint:

```
node scripts/check-no-legacy-approval-marker.mjs
```

The lint catches new occurrences of the literal marker in source code; see [Operational guardrails](#operational-guardrails).

### Why it was removed

- **Duplicate state.** The marker and the structured row could disagree (e.g., the row is revoked but the marker is checked). The drift-handling responsibility was a workaround for this, not a fix.
- **Hidden audit trail.** The marker is a free-form markdown string; its history lives only in the audit comments the lobster posts. There is no schema for "Tom approved task T on date D for ACs C", only a chain of `[brain_spec_approved_by_tom]` and `[spec-resynced]` comments.
- **Cross-task coupling.** A stale checked marker could over-grant approval after AC edits if the lobster missed the drift. The structured row, keyed on `(taskId, type)`, is the only path.

### Why not the brain/bookmark spec checkboxes

The brain- and bookmark-spec FILE checkboxes are a separate signal. They live in version-controlled FILES and let Tom grant approval by editing a single, reviewable file (git blame shows exactly which AC was approved and when). The reconciler above translates a checkbox edit into a structured `TaskApproval` row. Removing the checkbox from a brain- or bookmark-spec FILE is intentional in some workflows (e.g., decline during bookmark curating); it is NOT a regression and is NOT covered by this cutover.

---

## Cutover plan

The cutover was a four-PR sequence shipped in order. Each PR was independently reviewable, reversible, and gated by the lobster's existing lint and test suite.

| Sequence | Task workstream | PR | Scope |
|---|---|---|---|
| WS0 | `tasks-api-native-approvals` (separate task) | various | Landed the structured `TaskApproval` table and endpoints; reconciled one-time via a migration bridge that mirrored task-description markers into `TaskApproval` rows. |
| WS1 | `e2aba106` WS1 (Tasks API description-handling freeze) | #420 | Removed `uncheckApprovalMarker` and friends from `_spec.ts`. PATCH `/tasks/:id` passes the description through verbatim; the marker is no longer auto-unchecked on drift. New `tasksSpecChecksum.test.ts` pins the simplified `descriptionHasSpecDrift`. |
| WS2 | `e2aba106` WS2 (Lobster-side cleanup) | #422 | Renamed `product_spec_approved_by_tom` → `brain_spec_approved_by_tom`. Removed the `ApprovalMarker` enum, `approval_marker_state`, and the AC-line marker filter. Five marker-based lobster tests rewritten to assert on the structured approval rows. 410 lines deleted, 232 lines added. |
| WS3 | `e2aba106` WS3 (Test sweep + lint + docs) | #TBD | This PR. Adds `scripts/check-no-legacy-approval-marker.mjs` (the regression guard), converts remaining lobster tests to assert on `TaskApproval`, lands this doc, adds an AC4 structural assertion that the bookmark workflow has no description-marker dependencies. |

The sequence is intentionally additive: WS0 ships the structured surface, WS1 removes the description-handling surface in the API, WS2 removes it in the lobster, and WS3 ships the guardrails that catch a regression in either layer.

---

## Snapshot format

The one-shot migration in WS0 wrote a JSON snapshot of every created `(taskId, type)` row. The snapshot lives at `~/.openclaw/tasks-api/snapshots/<iso-timestamp>.json`. The format is intentionally narrow so a future `--rollback` can read any snapshot without depending on Tasks API version state:

```json
{
  "formatVersion": 1,
  "createdAt": "2026-08-08T05:00:00.000Z",
  "tasksApiBaseUrl": "http://localhost:4001",
  "approvals": [
    {
      "taskId": "11111111-1111-1111-1111-111111111111",
      "type": "spec",
      "owner": "Tom",
      "approvedAt": "2026-08-08T05:00:00.000Z",
      "source": {
        "kind": "description",
        "markerChecked": true
      }
    }
  ]
}
```

- `formatVersion: 1` — bump this on any breaking schema change; the rollback script must refuse unknown versions.
- `createdAt` — when the migration wrote the snapshot.
- `tasksApiBaseUrl` — the API base URL the migration ran against (informational; rollback does not require URL match).
- `approvals[]` — every row the migration created. Each entry records `taskId`, `type`, `owner`, `approvedAt`, and a `source` block describing where the row came from (`description` for a migration, `comment` for a `[tech-design-approved]` or `[qa-ac-verified]` comment, etc.).
- Snapshot files are NOT auto-cleaned. They are intentionally durable so a later operator can audit or rollback without depending on a running process.

---

## Rollback procedure

The cutover is reversible in two layers:

### Layer A — revert the cutover PRs

Revert in reverse order to avoid any transient cross-task state:

```bash
# 1. Revert WS3 (lint + docs) — pure additive; revert first to unblock
#    code paths the lint forbids.
git revert -m 1 <ws3-merge-sha>

# 2. Revert WS2 (lobster-side cleanup). This re-introduces the
#    ApprovalMarker enum and the AC-line marker filter.
git revert -m 1 <ws2-merge-sha>

# 3. Revert WS1 (Tasks API freeze). This re-introduces the
#    uncheckApprovalMarker helper and the auto-uncheck behavior on
#    PATCH /tasks/:id.
git revert -m 1 <ws1-merge-sha>
```

After Layer A, the marker-in-description workflow is back to its pre-cutover behaviour, but the structured `TaskApproval` rows created by the WS0 migration remain. Tasks API lifecycle code reads structured rows first, so a reverted lobster will mostly ignore the structured rows.

### Layer B — drop the structured rows via snapshot rollback

Use the migration script's `--rollback` to drop every `TaskApproval` row created during WS0:

```bash
tsx services/tasks-api/scripts/migrate-legacy-approvals.ts \
  --rollback ~/.openclaw/tasks-api/snapshots/<iso-timestamp>.json
```

The script drops every `(taskId, type)` row present in the snapshot but **leaves audit comments untouched**, so:

- `[brain_spec_approved_by_tom]`, `[tech-design-approved] true`, and `[qa-ac-verified] true` comments remain for forensic value.
- The legacy task-description markers (where they still exist in the database) are untouched.

After Layer B, the system reverts to its pre-cutover behaviour, with the structured rows removed and the marker-in-description workflow re-enabled. The audit log is preserved.

### Layer B is destructive

`--rollback` deletes structured rows. Confirm the snapshot before running it; the script prints the planned deletions and requires interactive confirmation. If you want a dry-run, no rollback flag exists; instead, snapshot the current row set first (`SELECT id, "taskId", type, owner FROM "TaskApproval";`) so you can restore from a future point.

---

## Regression coverage

The following tests pin the cutover invariants. Add to or extend this list when changing the structure:

| Test | Path | Pins |
|---|---|---|
| `legacyApprovals.test.ts` | `services/tasks-api/test/legacyApprovals.test.ts` | The detector regex matches the marker literal for both checked and unchecked forms; the `tech_design` and `qa` comment patterns map to their respective approval rows. |
| `migrateLegacyApprovals.test.ts` | `services/tasks-api/test/migrateLegacyApprovals.test.ts` | Migration script: idempotent on `(taskId, type)`; skips unchecked; `[tech-design-approved]` and `[qa-ac-verified]` comments create the right rows. |
| `migrateLegacyApprovalsFetch.test.ts` | `services/tasks-api/test/migrateLegacyApprovalsFetch.test.ts` | Migration script handles the real Tasks API fetch surface. |
| `tasksSpecChecksum.test.ts` | `services/tasks-api/test/tasksSpecChecksum.test.ts` | API surface: description is passed through verbatim on PATCH; `descriptionHasSpecDrift` ignores the marker. |
| `read-endpoints.test.ts` (legacy marker section) | `services/tasks-api/test/read-endpoints.test.ts` | GET `/tasks/:id` exposes `TaskApproval` rows; descriptions with the marker in `read` output are unchanged post-WS2. |
| `bookmarkWorkflowStructuralAssertion.test.ts` | `services/tasks-api/test/bookmarkWorkflowStructuralAssertion.test.ts` (this PR) | AC4: bookmark workflow source files do not depend on `descriptionHasSpecDrift`, `uncheckApprovalMarker`, or other removed description-marker helpers. |
| `agents/workflows/bookmarks/tests/test_spec_lifecycle.py` | external | Bookmark approval lifecycle tests still read the spec FILE checkbox correctly. |
| `agents/workflows/feature-task/src/main.rs` tests at ~line 4035, 4463, 5610 | external | Lobster regressions: marker-in-description is ignored (WS2 invariant); brain-spec FILE checkbox is still reconciled (AC4 invariant). Each remains auditable at code review; see the lint script's `SKIP_PATH_PREFIXES` for why these fixtures do not trigger the lint. |

---

## Release note (2026-08-12)

Feature-task approval state is now exclusively structured. The legacy `- [x]` checkbox line whose label was `**Approved by Tom**` in the task description is no longer read or written by any code path. Tasks migrated via `services/tasks-api/scripts/migrate-legacy-approvals.ts --write`. Brain-spec and bookmark-spec file-level checkboxes remain unchanged and are governed by their own workflow bridges (see [Workflow bridges](#workflow-bridges)). The cutover was a four-PR sequence:

1. **WS0** — `tasks-api-native-approvals` (foundation): introduced structured `TaskApproval` rows and migration bridge.
2. **WS1** — PR #420 (e2aba106): froze the Tasks API description-handling surface; description is now passed through verbatim.
3. **WS2** — PR #422 (e2aba106): removed the lobster's task-description reads/writes; `product_spec_approved_by_tom` renamed to `brain_spec_approved_by_tom`.
4. **WS3** — PR #TBD (e2aba106, this PR): added the regression guard lint, the AC4 structural assertion, and the system docs at `docs/systems/approvals.md`.

Operators do not need to take action. Existing tasks are unaffected — their structured `TaskApproval` rows already drive the lifecycle. If you have a task whose description still contains the legacy marker (pre-cutover content), it is silently ignored; no marker rewrite is performed.

## Operational guardrails

### Lint — `scripts/check-no-legacy-approval-marker.mjs`

```bash
node scripts/check-no-legacy-approval-marker.mjs
```

Fails the build (exits 1) if any source file under `apps/`, `services/`, `packages/`, `agents/workflows/`, or `agents/lib/` contains the literal legacy marker. Detector and unit-test files are allow-listed; the Rust feature-task workflow source is path-prefix-skipped because the monolith ships many regression fixtures (each remains auditable at code review). A trailing inline comment with `allow-legacy-approval-marker: <reason>` suppresses a specific line. Wire the lint into CI alongside `pnpm lint:no-legacy-approval-marker`.

### Tests — `pnpm test:lint`

```bash
pnpm test:lint
```

Runs the unit tests for the lint script (and the absolute-paths lint). Use this as the local gate before opening a PR that touches check-* scripts.

### Workflow check — `pnpm test`

```bash
pnpm test
```

Tasks API unit tests. The legacy-marker-suppression invariants in [`legacyApprovals.test.ts`](../../services/tasks-api/test/legacyApprovals.test.ts) and the API surface invariants in [`tasksSpecChecksum.test.ts`](../../services/tasks-api/test/tasksSpecChecksum.test.ts) are the canonical regression set. Add a test here when extending the cutover.

---

## Related specs, tasks, and PRs

### Specs

- `docs/specs/tasks-api-native-approvals-tech-design.md` — Tasks API native approvals foundation (WS0)
- `docs/specs/remove-legacy-task-description-approval-marker-tech-design.md` — WS1 + WS2 + WS3 tech design for `e2aba106`
- `docs/systems/tasks.md` — task data plane + workflows
- `docs/systems/bookmark-workflow.md` — bookmark-driven spec intake

### Tasks / PRs

- Task `e2aba106-e1f6-4faf-ad81-3e5bec1b4574` — Remove legacy task-description approval marker
- PR #420 — WS1: Tasks API description-handling freeze
- PR #422 — WS2: Lobster-side cleanup
- PR #TBD — WS3: Test sweep + lint script + this doc (this PR)
- Task `tasks-api-native-approvals` (WS0, separate task) — initial structured `TaskApproval` table and migration bridge
