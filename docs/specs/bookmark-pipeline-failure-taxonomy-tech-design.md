---
status: draft
task_id: afd399f9-f247-4753-9f80-5802ab51d891
product_spec: brain/specs/infra/thin-supervisor-loop-for-bookmark-pipeline-audits-4609bf7649cc59d6.md
shipped_pr: null
shipped_date: null
---

# Bookmark pipeline failure taxonomy — tech design

## Product spec and intent

- **Product spec:** `brain/specs/infra/thin-supervisor-loop-for-bookmark-pipeline-audits-4609bf7649cc59d6.md`
- **Source review:** `brain/reviews/infra/best-openclaw-advice-i-can-give-4609bf7649cc59d6.md`
- **Task:** `afd399f9-f247-4753-9f80-5802ab51d891` — 💻 Add structured failure taxonomy for bookmark pipeline supervision

The product spec calls for a “thin read-only classifier” that turns bookmark state and available execution context into a concise local audit. It must distinguish stale state, invalid lifecycle combinations, approval-slot blockage, and incomplete handoffs; report grouped counts and remediation suggestions; and never mutate state, resolve approvals, create tasks, or rerun stages.

The task's `scripts/bookmarks/` path refers to the bookmark script area that now lives at `agents/workflows/bookmarks/scripts/` after the workflow layout was consolidated. The implementation will use the current canonical path rather than create a second top-level script tree.

## Delivery coordinates

- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-afd399f9-tech-design`
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-afd399f9-tech-design`
- **Design path:** `docs/specs/bookmark-pipeline-failure-taxonomy-tech-design.md`
- **Implementation PR:** the implementation and this design will share this branch/PR.

## `.openclaw` boundary

The classifier and renderer are repository-owned Python. They read the workspace-owned `brain/state/bookmark-review-state.json` and optional local run-result/trace summaries, but they do not modify those files. No `.openclaw` config, extension, heartbeat, or scheduler change is required. If a future follow-up wants OpenClaw notifications or automatic remediation, that must be separately designed and approval-gated; this task remains diagnostic only.

## Ownership boundary check

- **Natural source of truth:** workflow/cron/skill boundary. Bookmark lifecycle remains owned by `brain/state/bookmark-review-state.json`; the taxonomy is a reusable interpretation contract, not new domain state.
- **Owning code:** `agents/workflows/bookmarks/scripts/` owns bookmark workflow classification because its statuses, artifact fields, approval invariants, and stage names are domain-specific. The existing `agents/skills/bookmarks/state/` analyzer is a direct consumer and renderer.
- **Direct consumers:** the local supervisor CLI/state analyzer now; future bookmark pipeline steps may import the same identifiers and category metadata. No product app or Tasks API contract is involved.
- **Why not a shared generic observability package:** categories such as `approval_pending`, `spec_created`, topic approval slots, `summaryDoc`, and `specDocs` are bookmark-domain concepts. Generic trace capture remains outside this task.
- **Incremental posture:** introduce a pure taxonomy/classifier and enrich the existing read-only report. Do not add a new trace sink, daemon, service, or automated repair loop.
- **Durable boundary:** stable identifiers, centralized metadata, and JSON-safe findings avoid ad hoc strings now and give later steps one import path. An interim report-only string map would be almost as much work and would create migration debt, so the durable reusable module is designed now.

## Proposed taxonomy

Stable identifiers are lowercase snake_case values. Identifier values are append-only public report contracts; display labels and remediation text may evolve without renaming identifiers.

| Identifier | Trigger class | Default remediation |
|---|---|---|
| `stale_queued_state` | A non-terminal queued/in-flight state has exceeded the configured age threshold without progression. | Inspect the last transition and rerun the owning stage only after confirming no approval is pending. |
| `invalid_review_approval_combination` | Lifecycle fields contradict one another, such as `approvalStatus=approved` without terminal/task state, `approval_pending` without an approval ID/resume token, or task IDs on a non-`tasked` persisted status. | Reconcile malformed state through the existing state-machine/reconciliation helper; do not hand-edit silently. |
| `topic_approval_slot_blocked` | A ready item cannot progress because the applicable topic/global approval slot is already occupied. | Resolve or decline the existing pending approval, then rerun approval packaging. |
| `missing_artifact_transition` | State claims a summary/spec stage but its required `summaryDoc`/`specDocs` artifact is missing or the file path does not exist. | Restore/regenerate the artifact through the owning summarize/spec stage, then revalidate state linkage. |
| `pipeline_stage_failed` | Available run context names a stage with a non-zero exit, error status, or malformed output. | Fix the named stage failure and rerun that stage/pipeline; preserve the original diagnostic context. |
| `pipeline_progress_incomplete` | A handoff started but required downstream evidence is absent, for example `spec_created` without approval packaging or approval resolution without task materialization where tasks are expected. | Resume from the first incomplete stage rather than restarting or mutating later state directly. |

Each finding also carries `severity`, `bookmarkKey` (nullable for run-level failures), `stage` (nullable), a human-readable `message`, `evidence`, and the category's remediation hint.

## Implementation plan and file scope

1. **Add `agents/workflows/bookmarks/scripts/failure_taxonomy.py`.**
   - Define a string-valued `FailureCategory` enum for the identifiers above.
   - Define immutable category metadata (`label`, `default_severity`, `remediation_hint`) in one exhaustive mapping.
   - Define a JSON-safe finding constructor/typed structure and a `serialize_finding()` helper. Callers emit identifiers, never enum reprs or display labels as keys.
   - Fail tests if an enum member lacks metadata or duplicate identifier values are introduced.
2. **Add `agents/workflows/bookmarks/scripts/bookmark_pipeline_audit.py`.**
   - Load state through `common.load_state()` rather than directly parsing raw JSON as a second state-reader implementation.
   - Classify each normalized item with pure functions. Use `bookmark_state_machine.effective_review_status()` where routing state matters so existing task-link invariants are respected while still reporting persisted drift as evidence.
   - Check artifact existence relative to `WORKSPACE` without writing, repairing, or deleting anything.
   - Accept an optional `--run-result <json>` input for the latest local lobster/run summary. Classify explicit failed stages and incomplete envelopes when present; report state-only degraded mode when absent instead of inventing trace context.
   - Support `--json` and text output. JSON output is the machine contract; text is a concise operator summary.
   - Group findings by category with deterministic category ordering and counts before listing bookmark-specific details. Healthy bookmarks are omitted from `findings` and represented only by a healthy count.
   - Exit non-zero only for malformed inputs or classifier execution failure, not merely because findings exist; the audit is observability, not a pipeline gate in this slice.
3. **Update `agents/skills/bookmarks/state/scripts/run_bookmark_state_analyzer.py`.**
   - Reuse the shared classifier and include the grouped `failureSummary`/`findings` in JSON output.
   - Add the same grouped category counts and remediation hints to text output while preserving existing status/topic/approval counts for compatibility.
   - Add `summaryDoc` to compact item output and stop labeling every `spec_created`/`approval_pending` item “stale” without an age/invariant check.
4. **Add tests.**
   - `agents/workflows/bookmarks/tests/test_failure_taxonomy.py`: stable identifiers, complete metadata, serialization, and remediation hints.
   - `agents/workflows/bookmarks/tests/test_bookmark_pipeline_audit.py`: one fixture per category, repeated-category aggregation, healthy omission, deterministic JSON/text rendering, missing trace degraded mode, and read-only behavior.
   - Extend state-analyzer tests or add `agents/skills/bookmarks/state/tests/test_run_bookmark_state_analyzer.py` to prove it consumes the shared classifier rather than maintaining separate issue strings.
5. **Update documentation on implementation.**
   - Extend `docs/systems/bookmark-workflow.md` with the read-only audit contract, identifiers, inputs, and common remediation flow. Do not create a new overlapping system doc.
   - Mark this design shipped in the implementation PR.

## Data model and API contract changes

No database migration, Tasks API change, or bookmark state mutation is introduced.

The new local JSON report contract is:

```json
{
  "version": 1,
  "generatedAt": "2026-08-15T00:00:00Z",
  "statePath": ".../bookmark-review-state.json",
  "traceContext": "available",
  "summary": {
    "bookmarkCount": 42,
    "healthyCount": 36,
    "findingCount": 8,
    "byCategory": [
      {
        "category": "missing_artifact_transition",
        "count": 3,
        "severity": "error",
        "remediationHint": "Restore or regenerate the missing artifact through its owning stage, then revalidate state linkage."
      }
    ]
  },
  "findings": [
    {
      "category": "missing_artifact_transition",
      "severity": "error",
      "bookmarkKey": "abc123",
      "stage": "summarize",
      "message": "summaryDoc is missing for summarized item",
      "evidence": {"reviewStatus": "summarized", "summaryDoc": null},
      "remediationHint": "Restore or regenerate the missing artifact through its owning stage, then revalidate state linkage."
    }
  ]
}
```

`version: 1` makes future compatible extensions explicit. Existing state fields are read but not rewritten. Category IDs and top-level keys are stable; array ordering is deterministic for snapshots and operator diffs.

## Workflow, cron, and skill changes

- **Workflow:** no mutation step is added to `bookmarks.lobster.yaml` in this task. The audit can be called before/after a run without affecting approval or task creation.
- **Cron:** no schedule or cron config change. A later task may wire the command as a read-only health pass after the taxonomy proves stable.
- **Skill:** the existing bookmark state analyzer gains grouped findings by importing the shared module. Skill instructions may be updated only to document the new flags/output, not to automate fixes.
- **Approvals:** findings clearly separate observations from suggested actions. No remediation executes automatically.

## AC-by-AC verification matrix

| AC | Planned verification | Layer |
|---|---|---|
| Stable identifiers emit to JSON and render in summary | Assert exact enum string values, complete metadata, serialized finding schema, and matching text category labels/counts. | Unit |
| Covers stale queues, invalid review/approval combinations, topic-slot blocking, and failed/incomplete progression | Table-driven state/run fixtures trigger each required category and assert no category collision; healthy control fixtures produce no findings. | Unit |
| Every category includes a grounded remediation hint | Exhaustiveness test requires non-empty hints and snapshots hints that reference existing stages/actions such as summarize/spec rerun, pending approval resolution, or state reconciliation. | Unit |
| Report groups repeated issues and shows counts | Feed multiple bookmarks with the same and different failures; assert `findingCount`, per-category counts, deterministic order, and concise text grouping. | Integration |
| Reusable Python under the canonical bookmark scripts area | Import `failure_taxonomy` from both the audit CLI and state-analyzer test; assert neither defines duplicate identifier maps. Run the bookmark workflow Python test suites. | Import/regression |

No browser E2E applies: this is a local workflow/CLI contract with no user-facing app flow. The fallback layers are unit tests, CLI integration tests against temporary files, and a manual read-only smoke run against a copied state file.

## Open questions and risks

1. **Trace input availability:** the product spec references shared local O11y summaries, but no canonical bookmark trace-summary module is present on current `main`. This design accepts optional run-result context and reports state-only degraded mode. It must not create a competing trace sink.
2. **Staleness threshold:** use an explicit CLI/configured duration and document the default; do not infer staleness solely from status names. Approval-wait time may need a different threshold from summarize/spec handoffs.
3. **Approval slot semantics:** current runtime behavior can enforce a global pending-approval lock even though the product language says topic slot. The classifier should reuse the same lock/eligibility helper or normalized state rule as approval delivery, and evidence should say whether the blocker is topic or global. Duplicating policy constants would cause false diagnoses.
4. **False positives from legacy data:** missing fields on old records may be valid migration residue. Emit evidence and remediation, but do not mutate or escalate automatically.
5. **Identifier stability:** renaming a category breaks downstream grouping. Add categories for new distinctions rather than repurposing an existing ID.
6. **Scope discipline:** notification delivery, task creation, retries, state repair, and lobster gate behavior are explicitly out of scope.
