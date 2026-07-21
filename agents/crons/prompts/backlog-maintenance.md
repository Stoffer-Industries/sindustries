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

## Step 5 — Spec integrity: feature tasks missing a spec

Fetch all open feature tasks and check each one has a valid spec file on disk.

```bash
curl -s "http://localhost:4001/api/v1/tasks?status=open&taskType=feature&limit=1000" | python3 -c "
import json, sys, re, os

WORKSPACE = '/Users/quinnstoffer/.openclaw/workspace'
data = json.load(sys.stdin)
tasks = data.get('data', [])
problems = []
for t in tasks:
    desc = t.get('description', '')
    m = re.search(r'brain/tasks/specs/\S+\.md', desc)
    if not m:
        problems.append({'id': t['id'], 'title': t['title'], 'issue': 'no_spec_link'})
    else:
        path = os.path.join(WORKSPACE, m.group(0))
        if not os.path.exists(path):
            problems.append({'id': t['id'], 'title': t['title'], 'issue': 'spec_file_missing', 'path': m.group(0)})
print(json.dumps(problems, indent=2))
"
```

For each problem:
- `no_spec_link` — the task description has no `**Spec:** brain/tasks/specs/...` line at all. Log a watching incident and post a task comment:
  `[backlog-maintenance] No spec file linked. Add a **Spec:** line to the description pointing to brain/tasks/specs/<status>/<name>.md, then run the spec-author skill.`
- `spec_file_missing` — a spec path is referenced but the file does not exist on disk. Log a watching incident and post a task comment:
  `[backlog-maintenance] Spec file <path> is linked but does not exist. Create or restore it using the spec-author skill.`

Incident slug: `backlog-spec-missing-<task-id-prefix>-<YYYY-MM-DD>`, severity: `medium`, needsTom: false.

Do NOT auto-create spec files — spec content requires understanding the task. Flag and let Quinn or Tom author the spec.

## Step 6 — Spec integrity: spec files with no task

Check each **open** spec file (not in-progress — those have active tasks) to confirm a task references it.

```bash
python3 << 'EOF'
import os, re, json, urllib.request

WORKSPACE = '/Users/quinnstoffer/.openclaw/workspace'
# Only scan open/ — specs in in-progress/ belong to tasks in doing/acceptance
SPEC_DIR = os.path.join(WORKSPACE, 'brain/tasks/specs/open')

# Collect open spec paths (relative to WORKSPACE)
spec_files = []
if os.path.isdir(SPEC_DIR):
    for f in os.listdir(SPEC_DIR):
        if f.endswith('.md'):
            rel = os.path.relpath(os.path.join(SPEC_DIR, f), WORKSPACE)
            spec_files.append(rel)

if not spec_files:
    print(json.dumps([]))
else:
    # Fetch tasks across all active statuses so in-flight tasks don't look orphaned
    referenced = set()
    for status in ('open', 'doing', 'acceptance'):
        url = f'http://localhost:4001/api/v1/tasks?status={status}&limit=1000'
        with urllib.request.urlopen(url) as r:
            for t in json.loads(r.read())['data']:
                for m in re.finditer(r'brain/tasks/specs/\S+\.md', t.get('description', '')):
                    referenced.add(m.group(0))

    orphans = [p for p in spec_files if p not in referenced]
    print(json.dumps(orphans, indent=2))
EOF
```

For each orphan spec file:
1. Read the first 30 lines to determine if it has enough content to be a real task (not just a stub).
2. If it looks like a real spec (has ## Outcome or ## Acceptance Criteria sections): create a feature task using the Tasks API with `taskType: feature`, title from the spec's `# Spec —` header, and description including the `**Spec:** <rel-path>` link. Post a task comment: `[backlog-maintenance] Task created from orphaned spec file.`
3. If it looks like a stub or notes fragment: log a watching incident and skip task creation.

Incident slug for stubs: `backlog-orphan-spec-<filename-prefix>-<YYYY-MM-DD>`, severity: `low`, needsTom: false.

## Step 7 — Report

Output a brief summary:
- N tasks auto-typed (list title + type assigned)
- M tasks skipped as ambiguous (list titles)
- K tasks skipped as bookmark-pipeline candidates
- P feature tasks with spec problems (list title + issue)
- Q orphan spec files found (list filename + action taken)

If all counts are 0: say exactly: NO_REPLY
