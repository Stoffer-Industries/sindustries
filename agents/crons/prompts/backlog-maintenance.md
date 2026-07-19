Run a backlog maintenance pass: find open tasks with no taskType and assign them the correct type.

## Step 1 — Fetch untyped tasks

```bash
curl -s "http://localhost:4001/api/v1/tasks?status=open&limit=1000" | python3 -c "
import json, sys
data = json.load(sys.stdin)
tasks = [t for t in data.get('data', []) if not t.get('taskType')]
print(json.dumps(tasks, indent=2))
"
```

If the list is empty, say exactly: NO_REPLY

## Step 2 — Classify each task

Read the type selection rules in:
`/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-create/SKILL.md`

For each task, evaluate its title and description against the type decision table:

| Signal | Type |
|--------|------|
| New capability, has spec or AC | `feature` |
| Bug fix, refactor, cleanup, chore, migration | `code` |
| Investigation, spike, feasibility, output is a doc | `research` |
| SIndustries website content update | `content` |

**Clear cases** — one type is obvious from title+description alone → auto-patch.
**Ambiguous cases** — genuinely unclear or could be multiple types → skip and log as incident (do NOT guess).

Tasks with `source:bookmark-review-pipeline` tag and `taskType: null` are pre-feature candidates waiting for Tom's spec approval. Do NOT auto-type these as `feature` — they have their own promotion flow. Skip them silently.

## Step 3 — Apply clear classifications

For each clear case, PATCH the task type via the API:

```bash
curl -s -X PATCH "http://localhost:4001/api/v1/tasks/<task-id>" \
  -H "Content-Type: application/json" \
  -d '{"taskType": "<type>"}'
```

Post a task comment explaining the auto-classification:
```
[backlog-maintenance] Auto-typed as `<type>` based on title/description. Rule applied: <one-line reason>.
```

## Step 4 — Log ambiguous tasks as incidents

For each ambiguous task, write a watching entry to `brain/state/quinn-ops-state.json`:
- Slug: `backlog-untyped-<task-id-prefix>-<YYYY-MM-DD>`
- severity: `low`
- needsTom: false (watching only, do not escalate)
- lastAction: describe what was ambiguous

Read/write the ops state file using the pattern in HEARTBEAT.md's OPS STATE MANAGEMENT section.

## Step 5 — Report

Output a brief summary:
- N tasks auto-typed (list title + type assigned)
- M tasks skipped as ambiguous (list titles)
- K tasks skipped as bookmark-pipeline candidates

If N = 0 and M = 0: say exactly: NO_REPLY
