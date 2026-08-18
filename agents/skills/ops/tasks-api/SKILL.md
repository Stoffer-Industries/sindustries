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
remains the sole owner of capacity and state admission. For feature and code
tasks, a missing `[implementer-prs]` is implementer work and therefore
`ACTIONABLE`; a posted
delivery is an external-wait candidate whose PR/review state must still be
verified.

### Attention-owners paging (the escape-hatch mechanism)

`attentionOwners` is for paging a specific person (Quinn, Lox, Tom) on a task
when none of the structured surfaces fit: not `[openclaw-needed]`, not
`[tech-design]`, not `assignee`. The most common cases are
"Quinn needs to make a product decision this workflow doesn't model" or
"Lox owes a platform-lane follow-up nobody else can pick up."

**Setting a page (caller side):**

```bash
# Rowan when blocked on a product call nobody else can answer:
python3 tasks_api_client.py patch \
  --id <task-uuid> \
  --attention-owners "Quinn"

# Multiple pages in one call. Each call REPLACES the full set.
python3 tasks_api_client.py patch \
  --id <task-uuid> \
  --attention-owners "Quinn" --attention-owners "Lox"
```

**Clearing only my own name (preserves siblings — the safe path):**

```bash
# Quinn / Lox / whoever wants to drop their own name while leaving any
# other attention owners on the task intact. The CLI helper composes
# fetch → mutate → PATCH for you; never use --clear-attention-owners
# here because that wipes every owner, not just yours.
python3 -c "
from agents.skills.ops.tasks_api.tasks_api_client import remove_self_from_attention_owners
print(remove_self_from_attention_owners('<task-uuid>', 'Quinn'))
"
```

**Discovering paged tasks (recipient side):**

```bash
# Quinn's heartbeat — surfaces any task paged to her, as well as her
# own assignee work. The assignee surface is always primary in the
# unified queue; attention-page entries appear below it.
python3 scripts/agent_task_queue.py \
  --assignee Quinn \
  --attention-owner Quinn

# Lox running the same script — only the --attention-owner value
# changes. The script accepts arbitrary names.
python3 scripts/agent_task_queue.py \
  --assignee Lox \
  --attention-owner Lox
```

**Why this isn't `[openclaw-needed]` / `[tech-design]` / `assignee`:**
those surfaces already mean specific things (workspace edit request,
design approval, delivery owner). `attentionOwners` is the
deliberately-unstructured name page; use it for one-off product or
platform decisions that don't fit the modelled gates. See
`docs/systems/tasks.md#taskattentionowner` for the data contract and
fetch → mutate → patch round-trip recipe.

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
