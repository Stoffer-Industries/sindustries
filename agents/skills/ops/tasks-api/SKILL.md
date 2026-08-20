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
checklist comments remain evidence. Without an attention stack, existing
assignee/PR classification remains the fallback.

### Attention owners: ordered action and escalation stack

`attentionOwners` is the primary blocker/handoff control plane. It is an ordered
list of role slots, not a set: position 0 is the next actionable owner and later
positions are escalation targets. Repeated names are meaningful and must be
preserved. Tom belongs later in the tail while agents can still act. Quinn is
the highest agent escalation; if Quinn cannot resolve the blocker, Quinn moves
Tom to position 0. `attentionOwners=["Tom"]` is the terminal human action state:
no fallback slot is required and no escalation exists beyond Tom. Tom merely
appearing later in a tail is dormant, not actionable.

Delivery (`assignee`) and gate eligibility/context (`workflowGates` and
structured approvals) remain independent. A normal stack can therefore be:
`assignee=Rowan`, `qa_agent` gate owner `Ash`, `attentionOwners=[Rowan, Tom]`.
Do not hide Ash and do not deduplicate Rowan across those roles.

```bash
# Full ordered replacement: Quinn acts now, then Rowan, then Tom.
python3 tasks_api_client.py patch --id <task-uuid> \
  --attention-owners "Quinn" "Rowan" "Tom"
```

OpenClaw/runtime blockers route to Quinn by putting Quinn first. Legacy
`[openclaw-needed]`, checklist, and other bracketed comments are audit history;
they are not routing state. The heartbeat queue automatically fetches the
invoking agent's attention-owned tasks and only treats a task as actionable when
that agent is position 0. Lower escalation slots remain dormant until advanced.

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
