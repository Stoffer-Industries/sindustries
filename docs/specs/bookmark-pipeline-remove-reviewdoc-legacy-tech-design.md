---
status: draft
task_id: b38f70bb-d956-4076-a3bd-215f07164a48
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Remove bookmark pipeline `reviewDoc` legacy paths — tech design

## Product spec and intent

- **Product spec:** n/a — this cleanup is defined directly by task `b38f70bb-d956-4076-a3bd-215f07164a48`.
- **Triggering fix:** PR #275 / commit `a5be990` added a temporary `reviewDoc || summaryDoc` recovery workaround.
- **Task:** `b38f70bb-d956-4076-a3bd-215f07164a48` — 💻 Remove reviewDoc legacy references from bookmark pipeline

The bookmark pipeline moved from the old review/classification artifact (`reviewDoc`) to the summary-and-curation model (`summaryDoc` plus `curation`). Mixed signals now create two routing paths and have already hidden new-pipeline items from priority recovery. This task makes `summaryDoc` the sole primary document signal, removes dead compatibility branches, documents any compatibility that truly remains, and safely clears stale `reviewDoc` fields from records that already have `summaryDoc`.

Current-state reconnaissance on 2026-08-15 found 17 records with both fields, 116 legacy `reviewDoc`-only records, 33 `summaryDoc`-only records, and 3 with neither. The implementation must therefore distinguish stale duplicate fields from genuinely legacy-only records rather than blindly deleting every old field.

## Delivery coordinates

- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-b38f70bb-tech-design`
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-b38f70bb-tech-design`
- **Design path:** `docs/specs/bookmark-pipeline-remove-reviewdoc-legacy-tech-design.md`
- **Implementation PR:** the implementation and this design will share this branch/PR.

## `.openclaw` boundary

All reusable code changes live in the repository. The one-time data cleanup targets workspace-owned `brain/state/bookmark-review-state.json`, which is outside the repository and must not be committed. No `.openclaw` configuration, extension, agent definition, or scheduler change is required.

The implementation PR will include a dry-run-by-default migration command. After merge, an operator runs it against the live brain state with an explicit apply flag, verifies the reported keys/counts, and preserves the generated backup. That operational execution is the only out-of-repo step.

## Ownership boundary check

- **Natural source of truth:** workflow-owned bookmark state and artifacts. `summaryDoc` is the durable summary artifact reference; `curation` owns relevance/routing decisions. `reviewDoc` is legacy migration residue, not a parallel source of truth.
- **Owning code:** `agents/workflows/bookmarks/scripts/` owns routing, approval packaging, and state migration helpers. `brain/state/bookmark-review-state.json` remains runtime data, not repository data.
- **Direct consumers:** bookmark lobster stages, Quinn's curation/spec dispatch helpers, approval packaging, and bookmark tests.
- **Why no shared package/API:** this is internal Python workflow state. No Tasks API, app, database, or cross-service contract should absorb it.
- **Incremental posture:** remove the primary-path ambiguity in one mergeable change and ship an idempotent cleanup utility. Do not attempt a broad bookmark-state redesign.
- **Legacy boundary:** records with both `summaryDoc` and `reviewDoc` are unambiguously migrated and lose only the stale field. `reviewDoc`-only records are not destructively rewritten by this task; any code that still reads them must be an isolated, explicitly commented backward-compatibility/reporting path that cannot outrank `summaryDoc` or reintroduce dual routing.

## Reference audit and intended disposition

Every Python reference under `agents/workflows/bookmarks/` will be classified during implementation:

| Area | Current use | Disposition |
|---|---|---|
| `lobster_list_curate_candidates.py` | Cleanup of missing review files and `reviewDoc || summaryDoc` active-document routing | Remove the old cleanup branch and PR #275 workaround; use `summaryDoc` only for new-pipeline routing and priority recovery. |
| `list_curate_candidates.py` | Treats `summary` or `reviewDoc` as proof of summarization; emits `reviewDoc` | Use `summaryDoc`/summary state as the primary proof and emit `summaryDoc`; retain no routing dependency on `reviewDoc`. |
| `list_spec_requests.py` | Includes `reviewDoc` in heartbeat request payload | Replace with `summaryDoc`; update consumers/tests together. |
| `lobster_generate_specs.py` | Passes `reviewDoc` into spec/task source metadata | Rename the internal contract to `summaryDoc`, update generated labels from “Review”/“Source Review” to “Summary”/“Source Summary” where applicable, and preserve parsing of already-written specs. |
| `lobster_request_spec_approval.py` and `request_topic_approval.py` | Carries `reviewDoc` through approval previews | Replace with `summaryDoc`; approval display uses the current summary artifact. |
| `rebuild_revised_approval.py` | Rehydrates revision payload with `reviewDoc` | Replace with `summaryDoc` so revisions use the same document contract as first-pass approval. |
| `debug/request_single_spec_approval.py` | Builds old-format debug payloads | Prefer `summaryDoc`. If old captured payload replay still requires `reviewDoc`, isolate it behind a named compatibility adapter and add an explicit removal-condition comment. |
| Tests/fixtures/docs | Assert or describe old payload fields | Remove dead-path assertions, add migration and summary-only regression coverage, and document any intentionally retained compatibility fixture. |

A final repository search is a merge gate: every remaining `reviewDoc` occurrence must be in the migration utility, a legacy fixture, or a compatibility adapter with an adjacent comment explaining why it remains and what permits removal.

## Implementation plan and file scope

1. **Centralize the primary document contract.**
   - Add a small helper in `agents/workflows/bookmarks/scripts/common.py` (for example `summary_doc_path(item)`) that returns only a normalized non-empty `summaryDoc` path.
   - Use this helper at routing boundaries instead of ad hoc `get("summaryDoc")` checks. It must not silently fall back to `reviewDoc`.
2. **Remove dual-path routing and payload fields.**
   - Apply the dispositions above across candidate listing, curation, spec request/generation, approval packaging, and revision rebuild scripts.
   - In `lobster_list_curate_candidates.py`, delete `_active_doc = reviewDoc || summaryDoc` and drive priority/spec recovery from the named summary helper. Preserve curation-score logic and existing terminal/task guards.
   - Remove old review-content classification as a new-pipeline routing signal where curation score is authoritative. If old on-disk specs need source metadata during resync, read existing spec content without making `reviewDoc` a routing prerequisite.
   - Keep input compatibility only where a replayed historical payload truly requires it. Compatibility code must translate once at the boundary and expose `summaryDoc` internally.
3. **Add `agents/workflows/bookmarks/scripts/migrate_reviewdoc_fields.py`.**
   - Accept `--state-path`, defaulting through `common.STATE_PATH`.
   - Dry-run by default and emit deterministic JSON/text with inspected, eligible, changed, and skipped counts plus affected bookmark keys.
   - An item is eligible only when both normalized `summaryDoc` and `reviewDoc` are non-empty. On `--apply`, remove `reviewDoc`; do not alter `summaryDoc`, `reviewStatus`, approvals, curation, task IDs, or transition history.
   - Validate that every eligible `summaryDoc` file exists before applying. Missing summary artifacts are reported and skipped rather than allowing a destructive cleanup.
   - Before applying, write a timestamped backup beside the state file. Write the updated JSON to a same-directory temporary file, fsync, and atomically replace the target. Never use an in-place partial write.
   - Make repeated application a no-op and return success with `changed: 0`.
4. **Update tests.**
   - Add migration tests for dry-run, apply, backup, atomic replacement, missing-summary skip, idempotence, and preservation of unrelated fields.
   - Update candidate/spec/approval fixtures to use `summaryDoc` and remove tests whose only purpose was the dead review path.
   - Add a regression fixture proving a `summaryDoc` item with spec/proposal work enters priority recovery without any `reviewDoc` field.
   - Add a compatibility test only for each intentionally retained adapter and assert `summaryDoc` wins when both fields are supplied.
5. **Update durable docs on implementation.**
   - Update `docs/systems/bookmark-workflow.md` state/artifact contracts and runbook with the one-time cleanup command and rollback from backup.
   - Update affected script docstrings/comments. Do not create a new system doc.
   - Mark this tech design shipped with PR/date in the implementation PR.
6. **Perform the operational migration after merge.**
   - Run dry-run against the live brain state, inspect eligible/skipped keys and backup destination, then run with `--apply`.
   - Re-run dry-run and verify zero eligible duplicate fields remain.
   - Run the read-only state analyzer and one normal bookmark pipeline pass to confirm no routing regression. Do not hand-edit state.

## Data model and API contract changes

### Bookmark state

The canonical artifact field becomes unambiguous:

- `summaryDoc: string` — primary summary artifact path used by the current pipeline.
- `curation: object` — current relevance/routing decision.
- `reviewDoc` — deprecated. Removed from records that also contain `summaryDoc`; not written by current scripts.

No state version bump is required because removing an optional deprecated field is backward-compatible for consumers that follow the canonical contract. The migration does not alter lifecycle fields.

### Internal pipeline payloads

Candidate, spec-request, approval-preview, and revision payloads replace `reviewDoc` with `summaryDoc`. These are internal process/stdin JSON contracts and all repository producers/consumers change atomically in one PR. Historical replay compatibility, if demonstrated by tests, is handled only at the outermost parser and normalized immediately.

No HTTP API, database schema, or external event contract changes.

## Workflow, cron, and skill changes

- **Bookmark workflow:** routing and package fields become summary-only. Lobster YAML step topology and approval semantics do not change.
- **Cron:** no scheduler changes. Existing cron invocations continue to call the same scripts/flags.
- **Skills:** no skill procedure change is required unless the state analyzer exposes artifact paths; if touched, it should display `summaryDoc` and label legacy-only records as migration debt rather than routing on them.
- **Operational migration:** explicit one-time command after merge; no automatic state mutation on import or cron startup.

## AC-by-AC verification matrix

| AC | Planned verification | Layer |
|---|---|---|
| AC1 — scripts use `summaryDoc` as primary; remaining `reviewDoc` references are explicitly documented compatibility | Repository `rg` audit plus tests showing all current payloads/routing use `summaryDoc`. Review each remaining hit for an adjacent compatibility/removal comment. | Static audit + unit |
| AC2 — records with both fields have stale `reviewDoc` cleared safely | Migration fixture and live dry-run/apply verification: eligible records lose only `reviewDoc`; missing-summary records are skipped; backup exists; second run changes zero records. | File integration + manual operation |
| AC3 — priority recovery no longer uses the PR #275 `reviewDoc || summaryDoc` workaround | Regression test creates a summary-only item with valid spec/proposal work and asserts priority ordering. Static assertion/search confirms the dual expression is gone. | Unit/integration |
| AC4 — all existing bookmark workflow tests pass and dead-path tests are removed | Record baseline test collection on current `main`, run the complete `agents/workflows/bookmarks` pytest suites after changes, and inspect removed/rewritten tests so the count change is explained rather than masking failures. | Regression |

No browser E2E applies because the change is an internal workflow/state migration. File integration tests and one post-migration pipeline smoke run are the proportionate end-to-end coverage.

## Open questions and risks

1. **Legacy-only records:** many live records still have `reviewDoc` without `summaryDoc`. This task does not delete those fields because that would erase their only artifact pointer. They may remain terminal history or be backfilled by normal summarization; any active compatibility reader must be isolated and documented.
2. **Generated markdown wording:** existing spec files may contain `**Review:**` or `**Source Review:**`. The task targets workflow code/state, not a destructive rewrite of historical docs. Parsers must continue reading existing files while new output uses summary terminology.
3. **Approval replay:** staged or persisted historical approval payloads might contain `reviewDoc`. Before removing the final parser fallback, inspect actual resume/replay contracts. If compatibility is needed, keep it only at the parser boundary with a removal condition.
4. **State-write safety:** `common.save_state()` currently writes directly. The migration must use backup plus atomic replacement so interruption cannot corrupt the live brain state.
5. **Unexpected re-entry:** removing review-only routing signals could make legacy records look unsummarized to a broad candidate scan. Candidate eligibility must continue respecting terminal statuses, task links, existing curation, and batch limits; add fixtures for declined/tasked legacy records.
6. **Scope:** do not remove historical markdown files, rewrite old transition logs, or redesign lifecycle statuses in this task.
