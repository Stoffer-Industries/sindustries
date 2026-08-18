---
status: draft
task_id: d8fbe750-12b8-4a92-bf02-8c14a0c7d864
product_spec: n/a (operational-discovery task; no product spec — closed upstream in 66054ab4)
shipped_pr: null
shipped_date: null
---

# Wire `attentionOwners` into agent docs and heartbeat discovery

## Product intent

Task `66054ab4` (workflow-gate ownership, attention owners, stacked avatars) shipped the `attentionOwners` mechanism on the Tasks API and the Tasks app — a way to flag a task for someone's attention *outside* the modelled `assignee` / `workflowGates` planes. The mechanism exists. The wiring into the agents that need to *use* it does not.

Concrete gap (live API scan 2026-08-18): zero of 365 tasks across all statuses have `attentionOwners` set. Rowan and Ivy have no documented way to page Quinn or Lox for something outside the existing structured tags (`[openclaw-needed]`, `[tech-design]`, etc.), and even if they set one manually via `tasks_api_client.py --attention-owners`, nothing would surface it in any heartbeat queue.

This task closes that gap end-to-end: docs (so Rowan / Ivy know they have an escape hatch), CLI docs (so the existing flag is discoverable), heartbeat discovery (so Quinn / Lox actually see themselves paged), and `HEARTBEAT.md` instructions for Quinn and Lox on what to do once they see their name attached.

## Boundary primer

### `attentionOwners` is a full-replacement array

The Tasks API treats `attentionOwners` as a set, not a delta. Calling `tasks_api_client.py patch --attention-owners <name>` replaces the full set with `[<name>]`. Any previously-attached names (e.g. `["Lox"]`) are dropped. The CLI helper `--clear-attention-owners` replaces with `[]`. There is no in-CLI way to read-modify-write the existing array; the call site must fetch-then-merge before patching.

The same caveat applies to Quinn / Lox when clearing: they must preserve any **other** owners already present (e.g. clearing their own name while leaving `Ivy` attached). The cleanest primitive is "fetch current `attentionOwners`, drop my name, PATCH the remainder" — implement it once in `tasks_api_client.py` and have HEARTBEAT instructions point at it.

### Existing structured tags vs. `attentionOwners`

`attentionOwners` is **the escape hatch**, not a replacement. The existing structured surfaces remain the primary mechanism:

- `[openclaw-needed]` — for work touching `~/.openclaw/` (Rowan cannot edit there)
- `[tech-design]` / `[tech-design-not-required]` — for the design gate
- `[implementer-prs]` — for handing off a PR for review
- `[openclaw-done]` — Quinn's confirmation that a `~/.openclaw/` edit landed
- `[code-task-progress-checklist]` / `[feature-task-progress-checklist]` — lobster-emitted to-do list (not a page signal)

Use `attentionOwners` only when **none** of the above fit the situation. Examples that warrant it:

- "Quinn — this needs a product-decision call that isn't an `[openclaw-needed]` and isn't a gate I can re-route" — e.g. a task that needs Quinn to *decide* whether to add a new app to the scope of a feature.
- "Lox — the runbook-hygiene follow-up is owed to your platform lane; nobody else has the context, and there's no gate to flip."

Do **not** use `attentionOwners` to mean `[openclaw-needed]`, `[tech-design]`, or `assignee`. The discriminator is whether the structured surface fits.

## Scope of this PR

- Rowan-owned code/docs (this repo) — lands in this PR:
  1. **`docs/specs/d8fbe750-wire-attention-owners-tech-design.md`** — this design doc itself, on the same implementation branch.
  2. **`agents/skills/ops/tasks-api/SKILL.md`** — extend the docs with the `--attention-owners` / `--clear-attention-owners` CLI flags and a worked example.
  3. **`agents/skills/ops/tasks-api/tasks_api_client.py`** — add a small "preserve-other-owners" convenience for clearing one's own name (`my_current_attention_owners` minus self), so callers don't have to hand-roll GET-modify-PATCH.
  4. **`agents/skills/ops/tasks-api/scripts/agent_task_queue.py`** — add a new optional `--attention-owner <Name>` flag that, when set, also surfaces any tasks where `<Name>` is currently in `attentionOwners` (across `open`, `ready`, `doing`, `acceptance`) as part of the unified queue, marked as a separate `kind: attentionPage` entry so it's distinguishable from assignee work.
  5. **`docs/systems/tasks.md`** — system-doc update adding the `attentionOwners` data contract and the "fetch → mutate → patch" round-trip recipe, as the durable home for the mechanism now that it's actually wired in.

- Quinn-owned `.openclaw` surfaces — out of scope here, queued as `[openclaw-needed]` requests:
  6. **`agents/definitions/rowan/WORKFLOW.md`** — add a short "When to use `attentionOwners`" section that compares against `[openclaw-needed]`, `[tech-design]`, and `assignee`.
  7. **`agents/definitions/ivy/WORKFLOW.md`** — same as #6, in Ivy's voice.
  8. **`agents/definitions/quinn/HEARTBEAT.md`** — short "If you see your name in an attention owner" section: read the task, act or comment, clear your own name (preserve others).
  9. **`agents/definitions/lox/HEARTBEAT.md`** — same as #8 for Lox.

I will post `[openclaw-needed]` for items 6–9 inside this implementation PR once the code is ready to merge, so Quinn lands them as the step immediately following the PR merge, not in parallel.

## Task, branch, and worktree

- **Task:** `d8fbe750-12b8-4a92-bf02-8c14a0c7d864`
- **Branch:** `task-d8fbe750-attention-owners-wire-in` (already created)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-d8fbe750-attention-owners-wire-in`
- **Repo:** `Stoffer-Industries/sindustries` (canonical checkout must stay clean; only this worktree owns the branch)

## Implementation plan

### A. CLI convenience for "clear only my own name"

In `tasks_api_client.py`, add a helper (not a CLI subcommand yet — used internally by HEARTBEAT instructions and future scripts):

```python
def remove_self_from_attention_owners(task_id: str, name: str) -> dict:
    """GET task → drop `name` from attentionOwners → PATCH the remainder.

    No-op if `name` is not currently attached. Returns the PATCH response.
    Does not use --clear-attention-owners so other names are preserved.
    """
```

Plus a matching `add_self_to_attention_owners(task_id, name)` to keep the symmetry obvious. (Both private to the module for now; HEARTBEAT instructions will reference them by qualified name.)

### B. `agent_task_queue.py` — surface attentionOwner-paged tasks

New CLI flag:

```
--attention-owner <Name>   Tasks where <Name> is a current attention owner
                           are added to the queue regardless of --assignee
                           (e.g. Quinn's own heartbeat without changing
                           her --assignee from Quinn to nothing).
```

Behaviour:

1. Existing assignee-fetched tasks remain the primary queue.
2. If `--attention-owner <Name>` is set, additionally fetch `tasks_api_client.list_tasks(attention_owner=<Name>, status=["open","ready","doing","acceptance"], limit=200)`.
3. Dedup against tasks already returned via `--assignee` (a task where the same person is both assignee AND attentionOwner surfaces once).
4. Insert new attention-owner-only tasks into the queue with:
   - `kind: "attentionPage"`
   - `taskStatus: <current>`
   - `actionable: true`
   - `classification: "ACTIONABLE"`
   - `reason: "paged to <Name> as attention owner"`

Triage priority for `topCandidate`: my **own** assignee work outranks anyone's attention-page, so the existing `--assignee` ordering is preserved (assignee queue entries appear first; attentionPage entries appended with a clear marker).

### C. `agents/skills/ops/tasks-api/SKILL.md` — CLI flags documentation

Insert a new subsection under "Common patterns" titled **`attentionOwners` — the escape-hatch paging mechanism`, with:

- One-paragraph "when to use it vs. when not to" guidance (boundary primer compressed).
- Worked example:

  ```bash
  # Rowan's flow when blocked on a product call nobody else can answer:
  python3 tasks_api_client.py patch \
    --id <task-uuid> \
    --attention-owners "Quinn"

  # Quinn's flow once she's decided / answered:
  python3 tasks_api_client.py patch \
    --id <task-uuid> \
    --clear-attention-owners    # ⚠ drops every owner; usually wrong

  # Safer: preserve any other owners already attached:
  python3 -c "from agents.skills.ops.tasks_api.tasks_api_client import remove_self_from_attention_owners; print(remove_self_from_attention_owners('<task-uuid>', 'Quinn'))"
  ```

- Pointer to the agent-draft communication rule (don't broadcast — set one or two names explicitly).

### D. `docs/systems/tasks.md` — durable data contract

Extend the existing system doc with:

- **`attentionOwners` field** under the "Task model" / "Data contracts" section: array of names (free-text, not FK), full-replacement set semantics, fetch-then-mutate round-trip recipe.
- **Operational flow subsection**: "Setting and clearing an attention owner" — caller must GET the task, mutate the array in the calling process, PATCH the full array back. The CLI flag accepts a single name (or a list) and replaces; preserve-others only via the helper functions.
- **Common failure modes**: PATCH with no GET race → silently dropping a co-owner, mitigated only via `remove_self_from_attention_owners`. Document this as the canonical safe-clear path.

### E. `[openclaw-needed]` requests for items 6–9

After the code is ready and PR opened (or at merge time — whichever Quinn prefers), post `[openclaw-needed]` with exact file paths and the proposed WORKFLOW.md / HEARTBEAT.md snippets for:

- `agents/definitions/rowan/WORKFLOW.md`
- `agents/definitions/ivy/WORKFLOW.md`
- `agents/definitions/quinn/HEARTBEAT.md`
- `agents/definitions/lox/HEARTBEAT.md`

Quinn lands them in `~/.openclaw/` directly and confirms with `[openclaw-done]`. The PR merge does not block on those landing — they're independent of the code path (the code path can be exercised without an explicit OPERATIONAL instruction in WORKFLOW.md / HEARTBEAT.md, just less discoverable).

## Service boundary / data ownership

- **Tasks API** (`services/tasks-api/`): owns the `attentionOwners` data field, the `?attentionOwner=<Name>` query parameter, and the PATCH semantics. Out of scope to change in this PR — the mechanism already shipped correctly via task `66054ab4`.
- **`tasks_api_client.py` + skill (`agents/skills/ops/tasks-api/`)**: the CLI / Python surface over the API. In scope to extend per items A and C.
- **`agent_task_queue.py`**: read-only adapter over the API for heartbeat discovery. In scope per item B.
- **System doc (`docs/systems/tasks.md`)**: durable spec for the Tasks API surface. In scope per item D.
- **Agent `WORKFLOW.md` / `HEARTBEAT.md`** (in `~/.openclaw/`): out of scope (`.openclaw` boundary). Quinn-lands via `[openclaw-needed]`.

No new API endpoint. No new database migration. No new shared package. The change is purely "extend the existing read-only adapter + documentation".

## Why not interim shim?

- The CLI / Python surface is already the durable boundary for ops scripts (`tasks_api_client.py`); no temporary placement needed.
- `agent_task_queue.py` is already the shared heartbeat-discovery adapter. The new `--attention-owner` flag belongs on the same script, not on a duplicate.
- A "Rowan-local list-of-paged-tasks in MEMORY.md" shim would re-introduce the duplicate-source-of-truth that `attentionOwners` was created to avoid. Rejected.

## Test plan

This change has no user-visible app behaviour (no UI). Test layers are unit / integration on the Python scripts and rendered-SKILL.md inspection.

### AC-by-AC verification matrix

| AC | Type | Verification |
|---|---|---|
| **AC1** — Rowan's and Ivy's operational docs explain `attentionOwner` vs. structured tags | manual | Quinn (or Tom) reads `agents/definitions/rowan/WORKFLOW.md` and `agents/definitions/ivy/WORKFLOW.md` post-merge and confirms the new section is present and the boundary is correct. Quinn-lands via `[openclaw-needed]`. |
| **AC2** — `agents/skills/ops/tasks-api/SKILL.md` documents the CLI flags with worked example | manual + rendered | After merge, render `agents/skills/ops/tasks-api/SKILL.md` and confirm the new "attentionOwners escape-hatch" subsection exists with the verbatim worked example block. Quinn confirms. |
| **AC3** — Quinn's heartbeat discovery surfaces `attentionOwner: Quinn` tasks | integration | From a temp branch in this worktree, run `python3 agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Quinn --attention-owner Quinn --json` against prodlike. Manually add `attentionOwners: ["Quinn"]` to a test task, re-run, confirm the task appears with `kind: "attentionPage"` and ACTIONABLE classification. Remove the test row and confirm surface returns to baseline. |
| **AC4** — Lox's heartbeat has the equivalent mechanism | integration | Same as AC3 with `--attention-owner Lox`. Same PASS criterion. |
| **AC5** — Quinn's and Lox's `HEARTBEAT.md` document the on-page action + safe-clear | manual | Quinn renders her own and Lox's HEARTBEAT.md post-merge and confirms the "you are an attention owner" section exists and the safe-clear snippet uses the new helpers (no hand-rolled GET → mutate → PATCH). Quinn-lands via `[openclaw-needed]`. |

### Unit / script tests (added to this PR)

- `agents/skills/ops/tasks-api/scripts/test_agent_task_queue.py` (new file, or extend if it exists) — add tests for:
  - `--attention-owner <Name>` flag accepted, surfaces matching tasks.
  - `--attention-owner <Name>` dedups against `--assignee` matches.
  - `attentionPage` entries carry `kind: "attentionPage"`, `actionable: true`, and the correct `reason`.
  - Top-candidate ordering: assignee work precedes attentionPage.

- `agents/skills/ops/tasks-api/test_tasks_api_client.py` (or extend existing) — add tests for the new `remove_self_from_attention_owners` and `add_self_to_attention_owners` helpers:
  - `remove_self_from_attention_owners` on a task with `["Quinn", "Lox"]` and `name="Quinn"` returns the task with `attentionOwners=["Lox"]`.
  - `remove_self_from_attention_owners` on a task with `["Lox"]` and `name="Quinn"` is a no-op (returns the task unchanged).
  - `add_self_to_attention_owners` on a task with `["Lox"]` and `name="Quinn"` returns `["Quinn", "Lox"]` (idempotent on re-add).

### E2E coverage

Not in scope. This change has no user-visible app behaviour change in the Tasks app (the UI was already shipped in task `66054ab4`). New behaviour is only at the agent-script and heartbeat-discovery layer, covered by script-level tests above.

## Risks

- **Race on PATCH.** Because `attentionOwners` is full-replacement, two concurrent patches can silently drop owners. The `remove_self_from_attention_owners` helper mitigates this for the "clear myself" path but not for arbitrary clear-and-set flows. Document the race in `docs/systems/tasks.md` and recommend callers re-GET after a 409 / pessimistic-conflict response (out of scope to implement now, but noted).
- **Free-text names.** `attentionOwners` is a free-text array, not an FK to the agent identity table. Typos create orphaned pages. Mitigation in this PR: the `--attention-owner` script flag is the only documentation explicit about which value to pass (e.g. always `"Quinn"`, never `"quinn"` / `"quinnstoffer"` / `"Quinn Stoffer"`). The Tasks UI uses these exact strings.
- **Quinn doesn't currently run `agent_task_queue.py`** — Quinn's heartbeat may use a different discovery path. Mitigation: I'll include in the `[openclaw-needed]` note the exact invocation Quinn should add to her `HEARTBEAT.md`, so the integration lands on the heartbeat, not on Quinn's ad-hoc process.
- **Pre-merge partial state.** The PR is mergeable without Quinn's `[openclaw-done]` for the `.openclaw/` edits. The heartbeat integration is live in code immediately, just less discoverable in agent prompts until Quinn lands the docs. This is the same posture as item E above.

## Open questions

1. **Should `--attention-owner` be additive (this design) or its own mode?** The current design keeps `--assignee` as primary and merges `--attention-owner` as a secondary source. An alternative is a separate `attention-owner-only` mode. Going with additive because it matches how Quinn/Lox will actually use it ("discover *everything* sitting on my plate: assignee work + pages"). Confirm before approval if Quinn prefers the alternative.
2. **Should `remove_self_from_attention_owners` be a CLI subcommand?** It would be ergonomically cleaner for Quinn/Lox to call `tasks_api_client.py clear-own-attention --id <uuid>` than the inline `python3 -c …` import path in the SKILL.md example. Mildly out of scope (touching the CLI surface vs. just Python helpers) — willing to add if Quinn prefers the CLI form.
3. **Should Ivy's WORKFLOW.md be edited by Ivy instead of Quinn?** Ivy's `WORKFLOW.md` is in `~/.openclaw/` — Ivy can't self-edit either (neither can Rowan). Quinn is the agent that lands `~/.openclaw/` edits. Documenting for clarity, but the path is Quinn → `[openclaw-needed]` regardless.

## Refs

- Task: `d8fbe750-12b8-4a92-bf02-8c14a0c7d864`
- Originating task: `66054ab4-24e2-4cc6-9847-0faa4e94f041` (Workflow-gate ownership, attention owners, and stacked task avatars)
- Tasks API data contract: `services/tasks-api/prisma/schema.prisma` (`AttentionOwner` rows), `services/tasks-api/src/routes/tasks.ts` (`?attentionOwner=` query, PATCH handler), `agents/skills/ops/tasks-api/tasks_api_client.py` (existing `--attention-owners` patch plumbing)
- Heartbeat discovery adapter: `agents/skills/ops/tasks-api/scripts/agent_task_queue.py`
- Tasks system doc: `docs/systems/tasks.md`
