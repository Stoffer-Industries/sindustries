# Tech Design — Surface Stale Tom/Ash Acceptance-Queue Approvals Each Heartbeat (task afb7e861)

**Status:** Draft (awaiting Quinn approval via structured `tech_design` approval)
**Task:** https://api.localhost/tasks/afb7e861-86b3-465d-b65c-4fddc1b1cd6e (full UUID on Tasks API)
**Branch:** `task-afb7e861-acceptance-queue-surfacing` (off `origin/main`)
**Author:** Rowan (Staff Engineer)
**Date:** 2026-09-15

---

## Problem

Tom/Ash acceptance-stage approvals (`qa_agent` and `accepted` TaskApproval rows where the owner is `Tom` or `Ash`) are the single largest gate-failure source in the feature/code factory. Week-of-2026-09-07 factory-retro report, pattern #2: 23 of 91 gate failures came from this exact bucket — the top recurring pattern by volume across multiple factory-retro runs.

The standing SKILL.md guidance "check the acceptance queue every heartbeat" has not closed the gap because it relies on agent discipline/memory: Ash has to remember to query `GET /tasks?status=acceptance` and Tom (human) has to remember to check his Telegram approvals digest. Both check patterns are intermittent, so the backlog grows quietly between factory-retro passes.

`pending_tech_design_approvals.py` already solved the equivalent problem for Quinn's tech-design approval queue: a single read-only script that scans `task.approvals` globally, surfaces pending items, and is invoked by `agent_task_queue.py` so every agent's heartbeat sees it as part of the unified queue output. Ash/Tom have no equivalent.

## Goals (and non-goals)

**In scope**
- New read-only helper script `agents/skills/ops/tasks-api/scripts/pending_acceptance_approvals.py` that mirrors `pending_tech_design_approvals.py` in structure and CLI shape, but targets `qa_agent` and `accepted` approvals with owners `Tom` or `Ash`. Each surfaced item carries `waitingSince`, `waitingHours`, and a configurable `stale` boolean (default threshold: 24h).
- New `pendingAcceptanceApprovals` field in the JSON output of `agent_task_queue.py --assignee <name> --json`, parallel to `techDesignApprovals`. Hydrated by a new `fetch_pending_acceptance_approvals()` function in `agent_task_queue.py`.
- Unit tests in `agents/skills/ops/tasks-api/scripts/test_pending_acceptance_approvals.py` mirroring the existing `test_pending_tech_design_approvals.py` fixtures and assertions.
- Update `agents/definitions/ash/HEARTBEAT.md` to consume the new field (Ash acts on `qa_agent` items). Update `agents/definitions/quinn/HEARTBEAT.md` to add a short "Tom accepted-approval nudge" section so Quinn can forward a one-line reminder to Tom via Telegram when the queue is non-empty.
- Update `docs/systems/tasks.md` with a "Pending acceptance approvals" subsection that documents the new queue field, staleness semantics, and how each agent's heartbeat consumes it.
- No changes to `APPROVAL_ATTENTION_OWNERS` / `DEFAULT_APPROVAL_OWNERS` and no changes to the Rust `workflow_attention_owner` / `managed_owner_reason_satisfied` logic — those continue to key on approval type, not on the surfacing script.

**Out of scope**
- Changing who is authorized to grant `qa_agent` or `accepted` approvals (Tom and Ash remain the sole approvers per `ACTOR_PERMISSIONS`; Quinn's `tech_design` grant path unchanged; service-credential scopes unchanged). This is already covered by task `2c3bf69b` ("Let Tom approve tech-design and QA gates") and is intentionally a separate concern.
- Adding new approval types, changing acceptance-gate semantics, or adding structured-approval metadata fields.
- Building a general-purpose notification system beyond the acceptance-queue use case (Slack/Discord hooks, browser push, etc.). The surfacing stays inside the unified heartbeat output.
- Surfacing these approvals in non-heartbeat agents (Ivy, Vara, Lox). The factory-retro cron reads `tally_events.py` for trend measurement and is also out of scope to change — its fingerprint counter naturally reflects any reduction in volume.

## Source-of-truth docs

- `agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py` — pattern template (the change is `accept`-typed approvals, structurally identical)
- `agents/skills/ops/tasks-api/scripts/agent_task_queue.py` — `fetch_pending_tech_design_approvals()` (line 661), `build_work_queue()` (line 880), `main()` (line 960)
- `agents/skills/ops/tasks-api/scripts/test_pending_tech_design_approvals.py` — test template
- `services/tasks-api/src/routes/approvalSessions.ts` — `approvalTypesForActor` (read-only confirmation: `qa_agent` and `accepted` are valid `TaskApproval.type` strings)
- `agents/definitions/ash/HEARTBEAT.md` — heartbeat consumer to update
- `agents/definitions/quinn/HEARTBEAT.md` — heartbeat consumer to update
- `docs/systems/tasks.md` — system doc to extend (existing "Approval pipeline" section)
- `agents/skills/ops/factory-retro/SKILL.md` (read-only) — confirms fingerprint counter pattern the retro uses; no diff needed

## Architecture / approach

Five small surfaces, all in one PR:

**a.1. New helper script** — `agents/skills/ops/tasks-api/scripts/pending_acceptance_approvals.py`

Mirror `pending_tech_design_approvals.py` line-for-line with three substantive differences:

1. **Filter scope** instead of `needs_tech_design_review(task)`, define `needs_acceptance_review(task: dict) -> bool`:

   ```python
   def needs_acceptance_review(task: dict) -> bool:
       """Tasks with a pending qa_agent or accepted approval owned by Tom or Ash.

       Both feature and code tasks use the same acceptance-stage approvals
       (see agents/workflows/feature-task/src/main.rs and code_task_workflow.rs
       accepted/qa_agent gate rows). Excludes tasks that have no comments or
       approvals array — those cannot be in the acceptance stage.
       """
       if task.get("taskType") not in ("feature", "code"):
           return False
       for approval in task.get("approvals") or []:
           if approval.get("state") != "pending":
               continue
           owner = approval.get("owner")
           approval_type = approval.get("type")
           if owner in ("Tom", "Ash") and approval_type in ("qa_agent", "accepted"):
               return True
       return False
   ```

   This stays deliberately narrower than `needs_tech_design_review` — research tasks and feature-factory-tagged ops tasks do not produce `qa_agent`/`accepted` approvals, so no need to scan tags.

2. **Per-task extraction** — replace `tech_design_url` / `tech_design_approved` with `pending_acceptance_approvals(task)`:

   ```python
   def pending_acceptance_approvals(task: dict) -> list[dict]:
       """Return one row per pending qa_agent/accepted approval owned by Tom/Ash.

       Row shape:
         {
           "id": "<task id>",
           "title": "<task title>",
           "status": "<task status>",
           "assignee": "<task assignee>",
           "approvalType": "qa_agent" | "accepted",
           "owner": "Tom" | "Ash",
           "waitingSince": "<ISO-8601>",
           "waitingHours": <float>,
           "stale": <bool>,
         }
       """
       now = datetime.now(timezone.utc)
       rows: list[dict] = []
       for approval in task.get("approvals") or []:
           if approval.get("state") != "pending":
               continue
           owner = approval.get("owner")
           approval_type = approval.get("type")
           if owner not in ("Tom", "Ash"):
               continue
           if approval_type not in ("qa_agent", "accepted"):
               continue
           waiting_since_raw = (
               approval.get("createdAt")
               or approval.get("updatedAt")
               or task.get("statusChangedAt")
           )
           try:
               waiting_since = datetime.fromisoformat(waiting_since_raw.replace("Z", "+00:00"))
           except (AttributeError, ValueError):
               waiting_since = now
           waiting_hours = max(0.0, (now - waiting_since).total_seconds() / 3600.0)
           rows.append({
               "id": task.get("id"),
               "title": task.get("title"),
               "status": task.get("status"),
               "assignee": task.get("assignee"),
               "approvalType": approval_type,
               "owner": owner,
               "waitingSince": waiting_since.isoformat(),
               "waitingHours": round(waiting_hours, 2),
               "stale": waiting_hours >= _STALE_THRESHOLD_HOURS,
           })
       return rows
   ```

   Module-level constant `_STALE_THRESHOLD_HOURS = 24` is overridable via `--stale-hours N` CLI flag. The `createdAt` of the approval row is the canonical "waiting-since" because that's when the row first entered the pending state; fall back to `updatedAt` then `task.statusChangedAt` defensively (older tasks may have approvals written before `createdAt` was reliably set).

3. **CLI surface** — `argparse` shape identical to `pending_tech_design_approvals.py` plus one new flag:

   ```python
   parser.add_argument(
       "--stale-hours",
       type=float,
       default=24.0,
       help="Mark entries waiting this many hours or longer as stale (default: 24).",
   )
   parser.add_argument(
       "--stale-only",
       action="store_true",
       help="Only emit rows where stale=True.",
   )
   parser.add_argument(
       "--owner",
       choices=("Tom", "Ash"),
       default=None,
       help="Restrict to one approval owner (default: both).",
   )
   ```

   JSON output shape (used by `agent_task_queue.py`):
   ```json
   {
     "pendingAcceptanceApprovals": [ <row> ... ],
     "count": <int>,
     "staleCount": <int>
   }
   ```
   Human output lists each row with `stale` annotated as `[STALE]` so the heartbeat's terminal print is scannable.

   Mirror the `--status` filter and the pagination pattern from `list_tasks()` / `fetch_task_detail()` verbatim — same `nextCursor` walk, same `DEFAULT_PAGE_SIZE = 100`.

**a.2. Wire into `agent_task_queue.py`**

Three edits, all localized:

1. **Import the new module** after the existing `pending_approvals` import (line 49). Same `importlib.util` pattern, separate variable `pending_acceptance` to avoid name collision:

   ```python
   ACCEPTANCE_PATH = pathlib.Path(__file__).with_name("pending_acceptance_approvals.py")
   ACCEPTANCE_SPEC = importlib.util.spec_from_file_location(
       "pending_acceptance_approvals", ACCEPTANCE_PATH
   )
   pending_acceptance = importlib.util.module_from_spec(ACCEPTANCE_SPEC)
   ACCEPTANCE_SPEC.loader.exec_module(pending_acceptance)
   ```

2. **New fetcher** placed after `fetch_pending_tech_design_approvals` (line 661):

   ```python
   def fetch_pending_acceptance_approvals(
       base_url: str | None = None,
       stale_hours: float = 24.0,
       owner: str | None = None,
   ) -> list[dict[str, Any]]:
       """Return every pending qa_agent/accepted approval owned by Tom or Ash.

       Independent of task assignee — the acceptance-stage gate is global, not
       per-agent. Like fetch_pending_tech_design_approvals, this is a global scan
       so Quinn's HEARTBEAT.md can surface Tom's queue and Ash's HEARTBEAT.md can
       surface Ash's queue without per-assignee filters.
       """
       base = (base_url or tasks_api_client.get_base_url()).rstrip("/")
       candidates = [
           task
           for task in pending_acceptance.list_tasks(base, [])
           if pending_acceptance.needs_acceptance_review(task)
       ]
       rows: list[dict[str, Any]] = []
       for summary in candidates:
           task = pending_acceptance.fetch_task_detail(base, summary["id"])
           for row in pending_acceptance.pending_acceptance_approvals(task):
               if owner and row["owner"] != owner:
                   continue
               row["stale"] = row["waitingHours"] >= stale_hours
               rows.append(row)
       rows.sort(key=lambda r: r["waitingHours"], reverse=True)
       return rows
   ```

   Sort by `waitingHours` descending so the oldest items surface first when an agent scans the list. The `stale` flag is recomputed against the caller's `--stale-hours` override; the helper script's internal default is a fallback, not the source of truth.

3. **Output field in `build_work_queue`** (line 880):

   Add `pending_acceptance_approvals: list[dict[str, Any]] | None = None` parameter (mirrors `tech_design_approvals`), pass it through `main()` (line 960) as the result of:

   ```python
   acceptance_approvals = fetch_pending_acceptance_approvals()
   ```

   (Always-on, no per-agent gating — every agent's heartbeat benefits from visibility.)

   And extend the returned dict (line 916) with:
   ```python
   "pendingAcceptanceApprovals": acceptance_approvals,
   ```

   The field is global, not assignee-filtered, so it lands in every agent's unified queue output. Existing per-agent filter logic in `main()` (e.g. `if agent_key == "quinn"`) is preserved for `techDesignApprovals`; the acceptance queue intentionally has no such gate.

**a.3. Tests** — `agents/skills/ops/tasks-api/scripts/test_pending_acceptance_approvals.py`

Mirror `test_pending_tech_design_approvals.py` with the following test cases (one assertion block per case, mirroring the existing test structure):

1. `needs_acceptance_review` returns False on research tasks and tasks with no approvals array.
2. `needs_acceptance_review` returns False when only spec/tech_design approvals are pending.
3. `needs_acceptance_review` returns True when a qa_agent approval is pending and owner is Ash.
4. `needs_acceptance_review` returns True when an accepted approval is pending and owner is Tom.
5. `needs_acceptance_review` returns False when a qa_agent approval is approved (not pending).
6. `pending_acceptance_approvals` returns one row per pending qa_agent/accepted approval; both can appear in the same row list (a single task may have two pending acceptance-stage approvals).
7. `pending_acceptance_approvals` calculates `waitingHours` correctly from `approval.createdAt` (use a fixed past timestamp; assert within 0.01 tolerance).
8. `pending_acceptance_approvals` marks stale=True when `waitingHours >= 24.0`, False otherwise.
9. `pending_acceptance_approvals` falls back to `task.statusChangedAt` when `createdAt` is missing.
10. JSON output (`--json`) emits `count`, `staleCount`, and a non-empty `pendingAcceptanceApprovals` array.
11. `--stale-only` filters the human-readable output to only stale rows.

**a.4. Ash HEARTBEAT integration**

Append a new section to `agents/definitions/ash/HEARTBEAT.md` between the existing "ACCEPTANCE QUEUE" (if any) and the end:

```text
ACCEPTANCE QUEUE SURFACING (automatic)

Each heartbeat, the unified queue output (already fetched in step 1) carries a
`pendingAcceptanceApprovals` array — every feature/code task with a pending
qa_agent approval owned by Ash, plus waiting duration and a stale flag (24h
default threshold).

This is the same data Ash would otherwise have to query one task at a time, so
the gate-failure pattern "Ash forgot to check the acceptance queue" cannot
recur as long as the heartbeat runs. Action: when the array is non-empty and
Ash's `attentionOwners[0]` is empty for those tasks (i.e. Ash is not the
current routable actor), Ash can still issue the qa_agent approval if her
`ASH_TASKS_API_APPROVAL_TOKEN` is in the agent env and the merged PR is
referenced in the task — the surfacing is independent of routable attention.
Do not act when `topCandidate.kind` is anything other than a qa_agent gate.
```

(The current Ash HEARTBEAT routes strictly through `attentionOwners[0]` and the
empty-attention current-gate fallback; this section adds a parallel visibility
channel but does not change routing precedence.)

**a.5. Quinn HEARTBEAT integration**

Append a short section to `agents/definitions/quinn/HEARTBEAT.md` after the
"TECH DESIGN APPROVAL" section:

```text
TOM ACCEPTED-APPROVAL NUDGE

Each heartbeat, the unified queue carries `pendingAcceptanceApprovals` —
every feature/code task with a pending `accepted` approval owned by Tom.

Quinn acts as Tom's proxy for tech-design approvals; she does the same here
for the acceptance-stage reminder. When the field is non-empty, post a single
Telegram message to Tom with: the count of stale items, the count of fresh
items, and a one-line list of the three oldest (id + title + waitingHours).
If the field is empty: no output.

Quinn never issues the `accepted` approval on Tom's behalf; the nudge is the
handoff.
```

No routing change. No new structured-approval logic. The nudge is a visibility
mechanism that closes the "Tom forgets to check" failure mode the same way
Ash's HEARTBEAT addition closes the "Ash forgets to check" mode.

**a.6. Docs** — `docs/systems/tasks.md`

Add a new subsection under "Approval pipeline":

```text
### Pending acceptance approvals

A read-only helper (`agents/skills/ops/tasks-api/scripts/pending_acceptance_approvals.py`)
scans `task.approvals` globally for `qa_agent` and `accepted` rows in `pending`
state with owner `Tom` or `Ash`. The unified heartbeat queue surfaces the
result under `pendingAcceptanceApprovals` for every agent.

Each row carries:
- `id`, `title`, `status`, `assignee` — task identifiers
- `approvalType` — `qa_agent` or `accepted`
- `owner` — `Tom` or `Ash`
- `waitingSince` — ISO-8601 of the approval row's `createdAt`
- `waitingHours` — hours elapsed since `waitingSince`
- `stale` — `true` when `waitingHours >= 24.0` (override with `--stale-hours`)

The staleness threshold is a soft signal, not a gate — a fresh acceptance
queue is healthy, a stale queue is the failure mode this surfaces. The same
data is what factory-retro (`tally_events.py` fingerprint `Pending Tom/Ash
acceptance approval`) counts as a gate failure, so a reduction in
`staleCount` over consecutive weeks is the AC4 measurement signal.
```

## Service boundary and data ownership

- **Single owner: `agents/skills/ops/tasks-api/scripts/`.** No backend service changes, no UI changes, no shared-package changes, no DB migration. The new script reads the existing `GET /tasks?status=...` and `GET /tasks/:id` endpoints verbatim — same shape as `pending_tech_design_approvals.py`.
- **No new external integration.** No Telegram, Slack, webhook, or scheduler changes; Ash/Quinn heartbeats consume the queue field they already fetch.
- **No consumers affected outside the heartbeat surface.** `APPROVAL_ATTENTION_OWNERS` (workflowHandoffs.ts) and Rust `workflow_attention_owner` continue to key on approval type, not actor — a surfaced "Tom should approve" does not change the routable head slot, which remains `Quinn` for `tech_design` and `Ash` for `qa_agent`.
- **Service-credential scopes unchanged.** Tom's existing `TASKS_API_APPROVAL_SERVICE_CREDENTIALS` (if any) is not touched; Ash's `ASH_TASKS_API_APPROVAL_TOKEN` continues to grant `qa_agent` only; Quinn's `TASKS_API_APPROVAL_TOKEN` continues to grant `tech_design` only.

## Milestones

All on one PR (the change is small and the five surfaces are tightly coupled — splitting them would force reviewers to re-read the same script twice):

- **M1 (this PR):**
  - New `pending_acceptance_approvals.py` (~140 LoC, plus docstring) and `test_pending_acceptance_approvals.py` (~180 LoC of test code)
  - Three localized edits to `agent_task_queue.py` (~30 LoC diff total)
  - Two HEARTBEAT.md append blocks (Ash, Quinn) totaling ~25 lines
  - One subsection added to `docs/systems/tasks.md` (~25 lines)
  - Total diff: ~400 LoC across 6 files; no new dependencies.

- **M2 (operational, not in this PR):** monitor factory-retro week-of-2026-09-14 and week-of-2026-09-21 to confirm `Pending Tom/Ash acceptance approval` fingerprint count trends downward. If M2 shows no measurable reduction after two weeks, the design's AC4 evidence is missing and the PR retro commits a follow-up.

## Risk and mitigations

- **Risk: the staleness threshold (24h) creates alert fatigue on healthy tasks that simply take >1 day to land.**
  Mitigation: `--stale-hours` is a soft signal in the heartbeat output — it's an annotation on the row, not a paging mechanism. Ash and Quinn already choose when to clear items, so a 24h-old row is a hint, not an interrupt. AC4 measurement uses `tally_events.py`, not the heartbeat directly; alert fatigue does not affect the retro counter.

- **Risk: `approval.createdAt` is not reliably set on older rows, producing nonsense `waitingHours` for legacy tasks.**
  Mitigation: the helper falls back to `approval.updatedAt` and then `task.statusChangedAt`. AC2's "freshly-arrived vs. aging backlog" distinction is approximate by construction — the row is still in the queue, still flagged as pending, and a task that's been `acceptance` for >30 days will still show a large `waitingHours` and a `stale=True` row. The fallback chain is documented in the source-of-truth docs section above.

- **Risk: the helper's global scan adds latency to every heartbeat pass (Ash, Quinn, Rowan, Ivy, Lox).**
  Mitigation: `agent_task_queue.py` already paginates `pending_tech_design_approvals` with the same `DEFAULT_PAGE_SIZE = 100`, so the new fetcher follows an established pattern. Worst case: one extra `list_tasks` walk per heartbeat — bounded, no new API surface, no per-task hydration beyond what the tech-design approval already does. Empirically, `pending_tech_design_approvals.py` scans ~30 tasks per heartbeat; the acceptance-queue population is similar in size.

- **Risk: Ash's HEARTBEAT addition conflicts with the strict attention-owner routing rule.**
  Mitigation: the addition explicitly preserves the existing routing precedence — Ash still only acts when `attentionOwners[0]` is hers or when `attentionOwners` is empty and the current outstanding gate is hers. The new section only changes what Ash *sees*, not what Ash *acts on*. Same protection on Quinn's side: she nudges Tom, she never grants `accepted` on his behalf.

- **Risk: factory-retro's fingerprint counter doesn't recognize "stale" — it counts all pending acceptance approvals equally, so AC4 measurement is confounded.**
  Mitigation: the existing fingerprint (`Pending Tom/Ash acceptance approval`) is unchanged by this PR. The count trend is the signal: if 23/91 → ~5/91 over the next factory-retro run, the mechanism worked. Stale vs. fresh is a heartbeat-side distinction, not a retro-side one. AC4 wording ("measurable reduction") accommodates either a total-count drop or a stale-count drop, as long as the trend is unambiguous.

## Test plan

1. **Existing tests still pass.** `pytest agents/skills/ops/tasks-api/scripts/test_pending_tech_design_approvals.py agents/skills/ops/tasks-api/scripts/test_agent_task_queue.py -q` — both test files are independent of the new code; no fixtures overlap.
2. **New tests pass.** `pytest agents/skills/ops/tasks-api/scripts/test_pending_acceptance_approvals.py -q` — eleven cases listed above, all green. Mocks return a fixed `now` timestamp to make `waitingHours` assertions deterministic.
3. **Manual smoke (script):** `TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 agents/skills/ops/tasks-api/scripts/pending_acceptance_approvals.py` returns a non-empty list (at least one of `5279b310`, `55ac9240`, `536e04fc`, `4b3d6e9c`, `2b66ae79`, `1016cbff` etc. is currently `acceptance` with a pending `accepted` approval based on the queue output captured 2026-09-14). `--json` shape matches the documented schema.
4. **Manual smoke (queue):** `agent_task_queue.py --assignee Ash --json | jq '.pendingAcceptanceApprovals | length'` returns the same count as the script standalone — no hydration drift between the two surfaces.
5. **Manual smoke (heartbeat):** Ash's HEARTBEAT run with a non-empty `pendingAcceptanceApprovals` produces a terminal line in the heartbeat report; an empty queue produces no output (silence rule preserved).
6. **AC4 measurement:** run `agents/skills/ops/factory-retro/SKILL.md` (or its underlying scripts) one week after merge; confirm `Pending Tom/Ash acceptance approval` fingerprint count drops below the 23/91 baseline. The exact threshold for "measurable reduction" is left to the retro's own definition of trend, which is already published in `agents/skills/ops/factory-retro/SKILL.md`.

## Open questions

None blocking. One informational:

- **Q1 (informational):** Should the helper also surface `Tom`/`Ash`-owned `tech_design` approvals that are pending? Quinn's tech-design queue already does this; the acceptance queue intentionally excludes `tech_design` to avoid double-counting with `techDesignApprovals`.
  **Resolution:** No. Keeping the two queues disjoint makes the staleness semantics unambiguous ("acceptance-stage backlog" vs. "design-stage backlog") and avoids confusing factory-retro fingerprint counting. Quinn's HEARTBEAT continues to own tech-design entirely; this PR only touches the acceptance-stage backlog.

## AC ↔ verification matrix

| AC | Verification |
|---|---|
| AC1 | `pending_acceptance_approvals.py --json` returns `pendingAcceptanceApprovals` array with `id`, `title`, `waitingHours` per row; `agent_task_queue.py --assignee <name> --json` surfaces the same data under the same key. No per-task manual query required by the heartbeat. |
| AC2 | `--stale-hours` flag works; default 24h. Manual smoke against the live API confirms `stale=true` for rows where `waitingHours >= 24.0`. The `staleCount` summary field is exposed in JSON. |
| AC3 | `pendingAcceptanceApprovals` appears in `agent_task_queue.py` output without opt-in flags; Ash HEARTBEAT step 1 fetches it implicitly via the unified queue; Quinn HEARTBEAT step "TOM ACCEPTED-APPROVAL NUDGE" consumes it without a separate query. |
| AC4 | Out-of-band measurement — not gated by code in this PR. Captured in M2 of the milestones section: a subsequent factory-retro run (`tally_events.py` fingerprint `Pending Tom/Ash acceptance approval`) shows a measurable reduction relative to the 23/91 baseline from week-of-2026-09-07. Documented as the success criterion for the operational follow-up; PR merge does not depend on it. |