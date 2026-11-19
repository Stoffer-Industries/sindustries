---
name: tasks-api
description: Manage Stoffer Industries tasks through the Tasks API from workspace automations. Use when creating, updating, listing, prioritizing, or archiving tasks, and when migrating task workflows away from local tasks.md/tasks.json state files toward API-first state.
---

# Tasks API Ops

Use API-first task operations for all automation flows.

> **Creating a new task?** Read `agents/skills/ops/tasks-create/SKILL.md` first — it covers task type selection, required field formats, and when not to create a task at all.

## Rules

1. Prefer Tasks API as source of truth.
2. Avoid writing/reading `tasks.md` for operational state.
3. Use guarded env targeting for write automations to prevent accidental writes to the wrong environment.
4. Keep operations idempotent where possible (source tags, stable IDs).

## Base URL

```bash
export TASKS_API_BASE_URL=http://localhost:4001/api/v1
```

## Script

```
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py
```

Run with `-h` or `<command> -h` for full usage:

```bash
python3 tasks_api_client.py -h
python3 tasks_api_client.py list -h
python3 tasks_api_client.py create -h
```

## Client path and required flags

The client is a **single file at the skill root** — not inside `scripts/`:

```
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/tasks_api_client.py
```

`scripts/` holds `agent_task_queue.py` and `pending_tech_design_approvals.py`, plus a **deprecated forwarding shim** at
`scripts/tasks_api_client.py`. That shim execs the maintained client with the same argv and exit code and prints a
deprecation notice on stderr, so a caller still composing the old path gets a working read instead of an opaque
`No such file or directory` (exit 2). It will be removed; use the skill-root path above.

`--id` is **required** by every single-task subcommand and must be the full task UUID:

| Subcommand | Required flags |
|---|---|
| `list` | none (optional filters: `--assignee`, `--status`, `--summary`, `--heartbeat`) |
| `create` | `--title` (plus optional `--description`, `--priority`, `--type`, `--tags`) |
| `get` | `--id <full-task-uuid>` |
| `patch` | `--id <full-task-uuid>` (plus the fields to change) |
| `approve` / `revoke-approval` | `--id <full-task-uuid>` + `--type {spec,tech_design,qa_agent,accepted}` |
| `archive` | `--id <full-task-uuid>` |

Omitting `--id` fails fast with an argparse error (`the following arguments are required: --id`) and performs no request. `python3 <client> <subcommand> -h` is the authoritative flag list.

The `tasks-api` directory name contains a hyphen, so `from agents.skills.ops.tasks_api import tasks_api_client` does not import — use `importlib.util.spec_from_file_location`, or shell out to the CLI.

Programmatic use: import `get_task`, `list_tasks`, and `get_base_url` from `tasks_api_client` for scripts that need to query tasks without the CLI.

The client automatically prefers the current agent's scoped credential
(`<AGENT>_TASKS_API_APPROVAL_TOKEN`) when the runtime exposes
`OPENCLAW_AGENT_ID`, `AGENT_ID`, or an agent-scoped `CODEX_HOME`. It falls back
to `TASKS_API_APPROVAL_TOKEN` for callers without an identifiable agent. For
explicit programmatic writes, pass `token=service_token_env("<AGENT>_TASKS_API_APPROVAL_TOKEN")`.

## Common patterns

Agent heartbeat queue (recommended):
```bash
python3 scripts/agent_task_queue.py --assignee Rowan
python3 scripts/agent_task_queue.py --assignee Rowan --json
```

This read-only adapter retrieves full active tasks and classifies them as
`ACTIONABLE`, `WAITING_EXTERNAL`, `DEPENDENCY_BLOCKED`, or `BLOCKED`. Lobster
remains the sole owner of capacity and state admission. When `attentionOwners` is populated, position 0 overrides comment-derived
classification: only that owner sees actionable task work. Legacy delivery and
checklist comments remain evidence. Without an attention stack, the exact
current outstanding workflow-gate owner is actionable; assignee/PR
classification remains the fallback when no current gate is outstanding.

The unified queue includes `authoredPrConflict` for an agent's open PR where
GitHub reports merge conflicts. This remains actionable even when CI is green
and review feedback is absent: rebase onto the base branch, preserve both
sides of content conflicts, push with `--force-with-lease`, and re-request the
original reviewer because the push dismisses the approval.

That force-push path is for **genuine content conflicts**. A branch that is
merely behind `main` (`mergeStateStatus: BEHIND`) is not a conflict: GitHub
refuses the merge with "the head branch is not up to date with the base
branch", and the fix is GitHub's update-branch operation, which refreshes the
branch without rewriting the reviewed commits — see the "When the merge is
refused because the branch is behind `main`" section of
`agents/skills/dev/pr-process/SKILL.md`.

### Status transition enforcement (task `fb5c4e40`)

Two status transitions are validated at the API boundary. `PATCH /tasks/:id`
rejects them with `409 Conflict` and a stable code, and leaves the task
entirely unchanged:

| Transition | Requires | Rejection code |
|---|---|---|
| `doing` → `acceptance` | a granted `qa_agent` approval, when the task type requires it | `QA_APPROVAL_REQUIRED` / `QA_APPROVAL_REVOKED` |
| `acceptance` → `done` | a granted `accepted` approval, when the task type requires it | `ACCEPTANCE_APPROVAL_REQUIRED` |

The required set is the config-driven one from `requiredApprovalsFor()`, so
`content` and `research` tasks are unaffected and the policy stays editable
without a deploy.

**A caller that hits a 409 must not work around it by moving the task some
other way.** The repair is to grant the approval properly (Ash for `qa_agent`,
Tom for `accepted`) or to move the task back to `doing` for redelivery. There
is no route that reaches `acceptance` without the QA gate — that is the point
of the guard.

### Identifying tasks that already skipped the gate (read-only)

`agents/skills/ops/tasks-api/scripts/identify_skipped_qa_tasks.py` finds tasks
that reached a gate without a granted `qa_agent` approval, and reports the
repair options per task. It writes nothing — no approval, no status, no
attention owner.

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 \
  python3 agents/skills/ops/tasks-api/scripts/identify_skipped_qa_tasks.py
python3 agents/skills/ops/tasks-api/scripts/identify_skipped_qa_tasks.py --json
```

It reports two classes, because they mean different things:

- `skipped_gate` — the `qa_agent` row was materialised and never granted.
  This is the defect's signature and needs a repair decision.
- `no_gate_row` — no `qa_agent` row was ever created, so the task predates
  the QA gate. Not damage from the transition defect. A task still in
  `acceptance` is itemised (it owes a decision); closed ones are only
  counted.

### Draft PRs are never merge candidates

The unified queue excludes **draft** PRs from `mergeCandidates`. GitHub refuses
to merge a draft, and the draft flag is the author's own signal that the work
is not ready to land, so a draft PR is never a merge candidate regardless of
its approval, CI or mergeability state.

A draft is not silently dropped. Drafts authored by the agent are reported in
the dedicated `authoredDraftPrs` collection, which carries the PR's draft
state, the reason it is not a merge candidate, and the next action:

```jsonc
{
  "id": "Stoffer-Industries/sindustries#979",
  "number": 979,
  "isDraft": true,
  "eligibleExceptDraft": true,   // every other merge precondition is met
  "reason": "authored PR is a draft; GitHub refuses to merge a draft PR",
  "nextAction": "convert the PR to ready-for-review once the implementation is complete, then merge after the blocking approval and green CI"
}
```

`eligibleExceptDraft` is `true` when the draft satisfies every other merge
precondition — blocking approval present, CI green, `mergeable`, no
outstanding changes requested — so the only thing standing between it and a
merge is the draft flag itself.

`authoredDraftPrs` is **visibility only**: its entries are emitted into the
`queue` list with `actionable: false`, so a draft can never become the
queue's `topCandidate`. A deliberate draft must not displace real work — task
`c2e3a106` tracked the defect where PR #979 was ranked as the top merge
candidate on every heartbeat despite being a draft that was explicitly meant
to stay a draft.

### Attention owners: ordered action and escalation stack

Use `agents/skills/ops/attention-owner-routing/SKILL.md` for the complete
decision and mutation procedure. This section records the shared data model;
the routing skill is the single procedure for adds, replacements, escalations,
repairs, and self-resolves.

`attentionOwners` is the primary blocker/handoff control plane. It is an ordered
list of role slots, not a set: position 0 is the next actionable owner and later
positions are only genuine, explicitly justified escalation targets. Repeated
names are meaningful when they represent distinct active role slots; do not
create passive watchlist entries. Quinn is the highest agent escalation; if
Quinn cannot resolve the blocker, Quinn moves Tom to position 0.
`attentionOwners=["Tom"]` is the terminal human action state: no fallback slot
is required and no escalation exists beyond Tom.

### Reason-bearing write contract

Every agent- or Lobster-driven add, replacement, repair, or escalation must
record a non-empty task-specific reason and the authenticated actor. A bracketed
comment is useful audit evidence, but it does not replace the reason on the
attention-owner row. Do not use the legacy `PATCH /tasks/:id` attention-owner
fields for automated handoffs: that full-stack compatibility path can recreate
rows with `addedBy=null` and `note=null`.

Use `POST /tasks/:id/attention-owners/reconcile` with the complete ordered
`attentionOwners` array and a concise `note` explaining who acts, why now, and
what the next action is. Use the single-owner POST endpoint when adding one
owner, and the self-resolve endpoint when the current actor is done. Preserve
genuine tail slots; remove stale or unjustified escalation slots rather than
carrying them forward. Quinn is an exceptional OpenClaw/runtime unblocker, not
a normal QA, acceptance, review, or delivery-workflow owner. Tom is added only
when a concrete action requires Tom now. The reason-bearing reconcile API
rejects attempts to put Tom on a `doing` task unless the authenticated actor is
Quinn (or Tom acting directly), the reason is non-empty, and Tom is the sole
terminal attention owner. It also rejects Quinn as a dormant non-zero slot. Legacy
`[quinn-escalation]` comments authorize nothing. This prevents a stale comment
or ordinary heartbeat from paging Tom while Lobster is still reporting an
unresolved delivery fingerprint.

**Client helper.** `agents/skills/ops/tasks-api/tasks_api_client.py` exposes
`reconcile_attention_owners(task_id, attention_owners, note, *, base_url=None, token=None)`
as the supported path. Use it instead of constructing the POST manually. The
`/tasks/:id/attention-owners/reconcile` route is POST-only; an `OPTIONS` or
`GET` probe returns 404 and that 404 is normal — do not treat it as a
deployment or credential regression. To verify reachability, call the helper
(or POST directly) with an authenticated credential.

Delivery (`assignee`) and gate eligibility/context (`workflowGates` and
structured approvals) remain independent. During ordinary delivery evidence
work a normal state is `assignee=Rowan`, `qa_agent` gate owner `Ash`, and
`attentionOwners=[]`; Rowan is already actionable through the assignee queue.
A Tom row is only valid at `acceptance`, or as a deliberate Quinn-to-Tom
terminal escalation. Do not hide Ash and do not deduplicate Rowan across those
roles.

An ordinary Lobster delivery checklist is not itself an escalation. When the
checklist asks the delivery assignee to correct PR/AC evidence, keep
`attentionOwners` empty and let the assignee queue surface the task as
actionable. Keep the downstream QA gate dormant until Lobster clears the
evidence. Add an explicit attention row only for a genuine blocker or a
cross-role handoff that needs ordered escalation.

### Completed delivery handoff

When an implementation delivery is complete, the delivery assignee must not
remain at `attentionOwners[0]` merely because the `assignee` field is still
theirs. After the implementation PRs are merged, the acceptance-criteria
evidence and required delivery marker are present, and no real delivery blocker
remains, the current agent must read back the stack and self-resolve or advance
only its own top attention slot through the reason-bearing endpoint. Preserve
the delivery assignee and every genuine later slot. The reason must name the
completed evidence and the next gate/actor. If QA is already approved, the next
actor is the acceptance gate rather than the delivery assignee.

If a later Lobster checklist claims that delivery evidence is missing, verify
the merged PR bodies and task evidence before acting. Address a real gap from
the assignee queue; if an older sweep left the assignee in the attention stack
solely for that checklist, clear the stale row. Do not leave the assignee in
the attention stack as a passive watch state.

```http
POST /tasks/<task-uuid>/attention-owners/reconcile
{"attentionOwners":["Ash"],"note":"QA verification is required for the delivered implementation."}
```

OpenClaw/runtime blockers route to Quinn by putting Quinn first. Legacy
`[openclaw-needed]`, checklist, and other bracketed comments are audit history;
they are not routing state. The heartbeat queue automatically fetches the invoking agent's attention-owned
and current gate-owned tasks. A populated attention stack is authoritative and
only position 0 acts. With an empty stack, the exact current outstanding gate
owner is the fallback actor. Lower escalation slots and stale/future gates remain
dormant.

Safe helpers perform a fetch → mutate → PATCH round trip. Because duplicate
slots are valid, callers must intentionally remove/advance the resolved slot,
not case-insensitively collapse the list.

Raw agent task view (grouped by status):
```bash
python3 tasks_api_client.py list --assignee Rowan --status ready --status doing --status acceptance --summary
```

Heartbeat view (all active + 10 open):
```bash
python3 tasks_api_client.py list --heartbeat
```

## Tech-design approval queue (heartbeat helper)

For Quinn's heartbeat tech-design approval pass:

```bash
python3 agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py
python3 agents/skills/ops/tasks-api/scripts/pending_tech_design_approvals.py --json
```

Reads the structured `tech_design` TaskApproval state used by the Lobster. Comments provide the design URL only and never count as approval.

Grant or revoke an approval with the caller's scoped service credential:

```bash
export TASKS_API_APPROVAL_TOKEN="$QUINN_TASKS_API_APPROVAL_TOKEN" # actor-specific; never share tokens
python3 tasks_api_client.py approve --id <full-task-uuid> --type tech_design
python3 tasks_api_client.py revoke-approval --id <full-task-uuid> --type tech_design
```

The client sends the token as `Authorization: Bearer`; the server derives actor and permitted approval types. Never pass `owner`, post legacy approval tags, or borrow another actor's credential.

## Content task creation

When Tom approves a weekly content review, create the task with `--type content`:

```bash
python3 tasks_api_client.py create \
  --title "SIndustries weekly content updates — YYYY-MM-DD" \
  --priority high \
  --type content \
  --tags "weekly-review,content-ops" \
  --description "$(cat <<'EOF'
**Source:** brain/content/sindustries-weekly-content/YYYY-MM-DD.md

**Review window:** YYYY-MM-DD to YYYY-MM-DD

---

## Quinn can execute

- [ ] ADD/EDIT/REMOVE ...

## Needs Tom approval

- [ ] ADD/EDIT/REMOVE ...

## Defer / needs more context

- [ ] ...
EOF
)"
```

Rules:
- `--type content` is required
- Each change item becomes one `- [ ]` checkbox line
- Omit empty sections
- Always include `--tags "weekly-review,content-ops"`
