Run a backlog maintenance pass: find open tasks with no taskType and assign them the correct type.

**Skills used in this prompt:**
- Type selection: `agents/skills/ops/tasks-create/SKILL.md`
- Feature task format + spec authoring: `agents/skills/product/feature-task-create/SKILL.md`

Read both skills before starting.

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

Use the type decision table from tasks-create skill. Clear cases → auto-patch. Ambiguous → skip and log.

Tasks with `source:bookmark-review-pipeline` tag are pre-feature candidates with their own promotion flow. Skip silently.

## Step 3 — Apply clear classifications

PATCH the task type and post a comment: `[backlog-maintenance] Auto-typed as \`<type>\`. Rule: <one-line reason>.`

For every task typed as `feature`: follow the feature-task-create skill end-to-end (spec + description format + API). Only write a spec if one doesn't already exist at the linked path. Post comment: `[backlog-maintenance] Reformatted to feature format. Spec at <path>.`

## Step 4 — Log ambiguous tasks as incidents

Write or update a watching entry in `brain/state/quinn-ops-state.json`:
- Slug: `backlog-untyped-<task-id-prefix>` (stable; **never append a date**), severity: `low`, needsTom: false
- This is one logical incident per task. If the stable slug already exists, update it in place: increment `attempts`, update `lastCheckedAt` and `lastAction`, and preserve its `firstSeen`/escalation history. Do not create a dated copy.

Use the ops state pattern from HEARTBEAT.md.

## Step 5 — Spec integrity: feature tasks missing a spec

```bash
curl -s "http://localhost:4001/api/v1/tasks?status=open&taskType=feature&limit=1000" | python3 -c "
import json, sys, re, os
WORKSPACE = '/Users/quinnstoffer/.openclaw/workspace'
data = json.load(sys.stdin)
problems = []
for t in data.get('data', []):
    desc = t.get('description', '')
    m = re.search(r'brain/tasks/specs/\S+\.md', desc)
    if not m:
        problems.append({'id': t['id'], 'title': t['title'], 'issue': 'no_spec_link'})
    elif not os.path.exists(os.path.join(WORKSPACE, m.group(0))):
        problems.append({'id': t['id'], 'title': t['title'], 'issue': 'spec_file_missing', 'path': m.group(0)})
print(json.dumps(problems, indent=2))
"
```

For each problem, apply the feature-task-create skill. If the description has enough substance (what + why or ACs), write the spec and reformat the description. If too thin to derive a spec, log or update a watching incident with the stable slug `backlog-spec-missing-<task-id-prefix>` (no date suffix, severity: `medium`) and post: `[backlog-maintenance] Description too thin to auto-write spec. Needs manual spec authoring.` Re-observations update `attempts`, `lastCheckedAt`, and `lastAction`; they must not create another incident for the same task/gate.

## Step 6 — Spec integrity: spec files with no task

```bash
python3 << 'EOF'
import os, re, json, urllib.request
WORKSPACE = '/Users/quinnstoffer/.openclaw/workspace'
SPEC_DIR = os.path.join(WORKSPACE, 'brain/tasks/specs/open')
spec_files = []
if os.path.isdir(SPEC_DIR):
    for f in os.listdir(SPEC_DIR):
        if f.endswith('.md'):
            spec_files.append(os.path.relpath(os.path.join(SPEC_DIR, f), WORKSPACE))
if not spec_files:
    print(json.dumps([]))
else:
    referenced = set()
    for status in ('open', 'doing', 'acceptance'):
        with urllib.request.urlopen(f'http://localhost:4001/api/v1/tasks?status={status}&limit=1000') as r:
            for t in json.loads(r.read())['data']:
                for m in re.finditer(r'brain/tasks/specs/\S+\.md', t.get('description', '')):
                    referenced.add(m.group(0))
    print(json.dumps([p for p in spec_files if p not in referenced], indent=2))
EOF
```

For real specs (has `## Outcome` or `## Acceptance Criteria`): follow the feature-task-create skill to create the task. Post comment: `[backlog-maintenance] Task created from orphaned spec file.`
For stubs: log or update a watching incident with the stable slug `backlog-orphan-spec-<filename-prefix>` (no date suffix, severity: `low`).

## Step 7 — Report

- N tasks auto-typed (title + type)
- M tasks skipped as ambiguous
- K tasks skipped as bookmark-pipeline candidates
- P feature tasks with spec problems (title + issue)
- Q orphan spec files (filename + action)

If all counts are 0: say exactly: NO_REPLY
