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

### Attention owners: ordered action and escalation stack

`attentionOwners` is the primary blocker/handoff control plane. It is an ordered
list of role slots, not a set: position 0 is the next actionable owner and later
positions are escalation targets. Repeated names are meaningful and must be
preserved. Tom belongs later in the tail while agents can still act. Quinn is
the highest agent escalation; if Quinn cannot resolve the blocker, Quinn moves
Tom to position 0. `attentionOwners=["Tom"]` is the terminal human action state:
no fallback slot is required and no escalation exists beyond Tom. Tom merely
appearing later in a tail is dormant, not actionable.

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
when a concrete action requires Tom now.

Delivery (`assignee`) and gate eligibility/context (`workflowGates` and
structured approvals) remain independent. A normal stack can therefore be:
`assignee=Rowan`, `qa_agent` gate owner `Ash`, `attentionOwners=[Rowan, Tom]`.
Do not hide Ash and do not deduplicate Rowan across those roles.

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
the merged PR bodies and task evidence before acting. Address a real gap; if the
checklist is stale, clear the stale top attention slot again. Do not leave the
assignee in the attention stack as a passive watch state.

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
