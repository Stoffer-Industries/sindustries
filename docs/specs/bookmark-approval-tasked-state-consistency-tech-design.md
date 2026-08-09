---
status: draft
task_id: 0089f4f9-6af7-4bd6-afa3-730878acdd59
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Bookmark approval tasked-state consistency — tech design

## Product intent

- Source task: `0089f4f9-6af7-4bd6-afa3-730878acdd59` — “Bookmark approval: X-sourced bookmarks can get stuck without reaching tasked, silently skipping author-tweet”.
- Product spec: n/a; the task description and its live reproduction are the product contract.
- Goal: make successful bookmark task creation authoritative for `reviewStatus: tasked`, prevent later pipeline passes from regressing that terminal state, and persist an explicit author-tweet outcome for every newly tasked X bookmark.

## Delivery metadata

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-0089f4f9-bookmark-approval-state`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-0089f4f9-bookmark-approval-state`
- Primary workflow: `agents/workflows/bookmarks/`
- Runtime state requiring reconciliation: `.openclaw` workspace file `brain/state/bookmark-review-state.json`

## Root cause and causal chain

The transition log provides a concrete chain for bookmark `d8311c3e5fc50b94`:

1. `lobster_resolve_spec_request.py` correctly transitioned `approval_pending → tasked` at `2026-08-03T23:55:01Z` with `taskIds=1`. Task creation and the resume path therefore completed; the resolver was not skipped.
2. At `2026-08-04T01:15:50Z`, a later `lobster_request_spec_approval.py` pass consumed the same bookmark in its generic `reviewed` bucket and unconditionally rewrote `tasked → reviewed` during “finalize review cycle”.
3. Because `reviewed` is not terminal in `lobster_list_curations.route()`, the still-high curation score routed the item back to `implement`.
4. `lobster_generate_specs.py` then reused/queued the existing spec and rewrote `reviewed → spec_requested` at `03:14:48Z`; `validate_spec_output.py` later advanced it to `spec_created`.
5. `taskIds` remained populated throughout, but the author-tweet hook only runs inline during the original resolver transition. The later regression did not invoke or persist a tweet outcome, making the miss silent.

The invariant is currently distributed and inconsistently enforced: task creation is represented by `taskIds`, but downstream routing/finalization trusts mutable `reviewStatus`. The durable fix is to make non-empty `taskIds` authoritative for `tasked` at every workflow boundary that can mutate or route bookmark state.

## Ownership and service boundary

The natural source of truth is the **bookmark workflow state machine** in `agents/workflows/bookmarks`, backed by `brain/state/bookmark-review-state.json`. The Tasks API owns task resources, but it should not own bookmark lifecycle state. The task ID link is the cross-boundary fact: once a reusable task exists and is linked to a bookmark, the bookmark state machine must derive `tasked` from that fact.

This is not a UI-local fix. A dashboard-only repair would hide corrupted state and leave tweet behavior unreliable. A new database/API resource is disproportionate because the workflow already owns the JSON state and transition log. The small durable change is a shared invariant helper used by routing and mutation boundaries, rather than one-off guards in each script.

## `.openclaw` boundary

The repository change can add reconciliation code and tests, but AC4 requires a one-time write to the live workspace state outside the repo:

- Correct `brain/state/bookmark-review-state.json` for `d8311c3e5fc50b94` to `reviewStatus: tasked` while preserving its existing task ID and approval metadata.
- Append a normal transition-log entry through the shared state helper; do not hand-edit the JSON without audit history.
- Do **not** post a late author tweet. The source link is `x.com/i/web/status/...`, which does not identify an author handle, and “we just started” several days late would be misleading. Persist a deliberate `tweetLog` skip such as `{status: "skipped", error: "backfill_not_posted:late_and_author_unresolved", ...}` with a timestamp so the outcome is explicit.

This reconciliation is operational state, not committed repository content.

## Implementation plan

### 1. Centralize the tasked invariant

Add a small helper in `agents/workflows/bookmarks/scripts/common.py` (or a focused state-machine module if imports would cycle):

- `effective_review_status(item)`: returns `tasked` whenever `taskIds` is non-empty; otherwise returns the stored status.
- `reconcile_tasked_item(item, key, reason, transitions_path)`: repairs persisted status and records a transition only when needed.

Keep `declined` precedence explicit only for items without task IDs. A task-linked bookmark cannot be moved backward to `reviewed`, `spec_requested`, `spec_created`, or `approval_pending` by generic pipeline cleanup.

### 2. Guard routing and finalization boundaries

Modify:

- `lobster_list_curations.py`: route any item with non-empty `taskIds` to `reviewed` output while retaining effective terminal status `tasked`; never route it to `implement` from curation score.
- `lobster_request_spec_approval.py`: before generic finalization, reconcile task-linked items and refuse status downgrades. The `reviewed` output bucket is a routing result, not permission to persist literal `reviewStatus: reviewed` over a terminal state.
- `lobster_generate_specs.py`: retain the existing `pending_or_tasked` guard and harden the entry path so task-linked items are skipped/reconciled before any `spec_requested` or `spec_created` write.
- `validate_spec_output.py`: reject or no-op spec output for task-linked bookmarks instead of overwriting terminal state if stale heartbeat work completes late.

### 3. Make author-tweet outcomes non-silent

Refactor the resolver’s tweet trigger into an idempotent helper called after the tasked invariant is established:

- Trigger only for X-sourced bookmarks with a newly linked task ID.
- If posting succeeds, persist the existing `posted` result.
- If posting cannot run (missing credentials, malformed/authorless X link, already attempted, or explicit backfill policy), persist a `skipped` result with a stable reason.
- If posting errors, persist `error` as today.
- Persist before returning resolver output; include the outcome/skip reason in structured output and logs.
- Avoid duplicate tweets by treating an existing terminal `tweetLog` outcome as idempotent unless an explicit retry mode is introduced later.

The current policy that drops `missing_x_link` skips must change for task-linked X bookmarks: AC3 requires an explicit persisted reason.

### 4. Add an idempotent reconciliation command

Add a narrow CLI/script under `agents/workflows/bookmarks/scripts/` that:

- Accepts a bookmark key.
- Verifies non-empty `taskIds`.
- Reconciles status to `tasked` with transition logging.
- Optionally records a supplied backfill skip reason, but never posts externally by default.
- Is safe to rerun without duplicate transition entries or tweet attempts.

Use it for AC4 against the live workspace after the code is reviewed.

### 5. Documentation updates

Update `docs/systems/bookmark-workflow.md` to document:

- `taskIds` as the authoritative terminal-state invariant.
- The distinction between a routing bucket named `reviewed` and persisted lifecycle status.
- Tweet outcome persistence for posted, skipped, and error cases.
- Reconciliation runbook and duplicate-tweet safeguards.

## Data model and API contract

No Tasks API schema or endpoint change is required.

Bookmark state contract changes:

- `taskIds: string[]` non-empty implies `reviewStatus: "tasked"`.
- For X-sourced bookmarks linked to a newly created task, `tweetLog` must exist with `status: "posted" | "skipped" | "error"`.
- `tweetLog.error`/reason uses stable machine-readable prefixes, including a deliberate backfill reason.

Existing state remains backward compatible; reconciliation repairs drift lazily or via the targeted CLI.

## Workflow, cron, and skill changes

- Workflow scripts change as listed above; `bookmarks.lobster.yaml` stage order does not need to change.
- No cron schedule change.
- No skill change.
- No OpenClaw configuration change.

## Test plan

Add/extend Python tests under the bookmark workflow test roots that CI already discovers:

- Unit-test the invariant helper for task-linked and taskless statuses.
- Reproduce the exact sequence: approve/resume output with a created task → resolver sets `tasked` → request/finalize cycle runs → curation/generate-spec pass runs → state remains `tasked`.
- Assert stale spec-validation output cannot downgrade a task-linked item.
- Assert X task-linked outcomes persist `posted`, explicit `skipped`, and `error`; assert reruns do not post twice.
- Test the reconciliation CLI twice to prove idempotency and transition-log behavior.

### Acceptance-criterion verification matrix

| AC | Planned verification | Layer |
|---|---|---|
| AC1 | Fixture transition sequence and the production transition-log evidence demonstrate `tasked → reviewed → spec_requested → spec_created`; system doc records the causal chain. | File/integration + documentation |
| AC2 | Resume-approved fixture creates/links a task, then executes all later routing/finalization/spec stages and remains `tasked`. | Python workflow integration |
| AC3 | X bookmark tests cover posted, malformed/authorless-link skip, missing credentials, error, and duplicate rerun; every newly tasked case has persisted `tweetLog`. | Unit + workflow integration |
| AC4 | Run the idempotent reconciliation CLI against `d8311c3e5fc50b94`; inspect state + transition log; verify deliberate late-tweet skip is persisted and no external post occurs. | Operational/manual inspection |
| AC5 | Dedicated regression fixture begins approval-pending, consumes resumed created-task output, and proves later pipeline passes cannot regress status. | Python workflow integration |

E2E browser coverage is not appropriate: this defect is in headless workflow state transitions and no UI interaction causes it. Workflow-level integration tests exercise the actual scripts and persisted JSON contract.

## Risks and tradeoffs

- **Status precedence:** blindly deriving `tasked` from historical/invalid task IDs could mask a deleted task. Mitigation: task creation only persists IDs returned/reused by Tasks API; reconciliation is limited to non-empty links. A separate task-health reconciler can validate stale IDs if needed.
- **Duplicate tweets:** replay/reconciliation must never repost by default. Existing `tweetLog` is the idempotency record; the backfill CLI records a skip unless a future explicit external-post mode is approved.
- **Concurrent JSON writers:** shared load/mutate/save remains susceptible to last-writer-wins. This change narrows the failure by applying the invariant at every writer boundary; migrating bookmark state to a database is out of scope.
- **Legacy silent skips:** historical tasked X bookmarks may lack `tweetLog`. This task reconciles the named reproduction only; a broader audit/backfill should be a separate, explicitly approved operation because tweeting is external and irreversible.

## Open questions / decisions

1. **Late tweet for `d8311c3e5fc50b94`:** recommendation is no post; persist `backfill_not_posted:late_and_author_unresolved`. This avoids an irreversible, misleading external action and handles the authorless `/i/web/status/` URL safely.
2. **Shared helper location:** prefer `common.py` unless test/import dependencies reveal a cycle; otherwise use `bookmark_state_machine.py` beside it.
3. **Historical audit:** out of scope for this delivery. After shipping, optionally run a read-only report of X bookmarks where `taskIds` is non-empty and `tweetLog` is absent, then create a separately approved remediation task.
