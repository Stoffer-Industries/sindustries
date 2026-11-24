Run a backlog maintenance pass: find open tasks with no taskType and assign them the correct type.

**Skills used in this prompt:**
- Type selection: `agents/skills/ops/tasks-create/SKILL.md`
- Feature task format + spec authoring: `agents/skills/product/feature-task-create/SKILL.md`

Read both skills before starting.

## Runtime safety precondition

Before any Tasks API call or task/spec mutation, load the configured route and
fail closed if it is unavailable. Never substitute localhost or another default
route:

```bash
set -a
[ -r "$HOME/.openclaw/.env" ] || { echo "Missing ~/.openclaw/.env" >&2; exit 1; }
. "$HOME/.openclaw/.env"
set +a
: "${TASKS_API_BASE_URL:?TASKS_API_BASE_URL must be set in ~/.openclaw/.env}"
```

If this precondition fails, stop and report the run as blocked. Do not classify,
patch, comment on, create, or reformat any task/spec.

## Step 1 — Fetch untyped tasks

Load the live route from `~/.openclaw/.env` using the Runtime safety
precondition above. The route is required; this cron has no local-dev fallback.

```bash
set -a
[ -r "$HOME/.openclaw/.env" ] || { echo "Missing ~/.openclaw/.env" >&2; exit 1; }
. "$HOME/.openclaw/.env"
set +a
: "${TASKS_API_BASE_URL:?TASKS_API_BASE_URL must be set in ~/.openclaw/.env}"
```

```bash
curl -s "${TASKS_API_BASE_URL}/tasks?status=open&limit=1000" | python3 -c "
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

For clear non-feature cases, PATCH only the task type and post a comment:
`[backlog-maintenance] Auto-typed as \`<type>\`. Rule: <one-line reason>.`

For every task classified as `feature`, do not rewrite its description, create or
modify a spec, or otherwise reformat it in this cron pass. Route the task through
the Tasks API by putting `Quinn` at `attentionOwners[0]` (preserving any later
owners), and post: `[backlog-maintenance] Feature classification requires Quinn
review before description/spec rewrite.` A routed owner is not approval: the cron
must not infer approval from the route or from a substantive description. Quinn's
normal workflow must explicitly authorize or perform the feature-task-create
changes in a later pass.

## Step 4 — Handle ambiguous tasks without incident entries

Do not write ambiguous task classification into `brain/state/quinn-ops-state.json`.
Post a task comment explaining why classification is ambiguous. If the ambiguity
requires a human decision, route the task through the Tasks API by putting the
appropriate person at `attentionOwners[0]` (preserving any later owners); otherwise
leave it un-routed for a later backlog pass. Task state and task comments are the
source of truth for backlog work, not the agent incident registry.

## Step 5 — Spec integrity: feature tasks missing a spec

```bash
set -a
[ -r "$HOME/.openclaw/.env" ] || { echo "Missing ~/.openclaw/.env" >&2; exit 1; }
. "$HOME/.openclaw/.env"
set +a
: "${TASKS_API_BASE_URL:?TASKS_API_BASE_URL must be set in ~/.openclaw/.env}"
curl -s "${TASKS_API_BASE_URL}/tasks?status=open&taskType=feature&limit=1000" | python3 -c "
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

For each problem, do not automatically write a spec or reformat the task
description. Route the task through the Tasks API by putting `Quinn` at
`attentionOwners[0]` (preserving any later owners), and post:
`[backlog-maintenance] Feature spec repair requires Quinn review before
description/spec rewrite.` If the description is too thin to derive a spec, append
` Description too thin to auto-write spec.` Do not create an incident for the
missing spec. The Quinn workflow may apply the feature-task-create skill only
after explicit review/authorization; a later cron pass must not treat the route
itself as authorization.

## Step 6 — Spec integrity: spec files with no task

```bash
set -a
[ -r "$HOME/.openclaw/.env" ] || { echo "Missing ~/.openclaw/.env" >&2; exit 1; }
. "$HOME/.openclaw/.env"
set +a
: "${TASKS_API_BASE_URL:?TASKS_API_BASE_URL must be set in ~/.openclaw/.env}"
python3 << 'EOF'
import os, re, json, urllib.request
WORKSPACE = '/Users/quinnstoffer/.openclaw/workspace'
TASKS_API_BASE_URL = os.environ.get("TASKS_API_BASE_URL")
if not TASKS_API_BASE_URL:
    raise SystemExit("TASKS_API_BASE_URL must be set in ~/.openclaw/.env; refusing local-dev fallback")
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
        with urllib.request.urlopen(f'{TASKS_API_BASE_URL}/tasks?status={status}&limit=1000') as r:
            for t in json.loads(r.read())['data']:
                for m in re.finditer(r'brain/tasks/specs/\S+\.md', t.get('description', '')):
                    referenced.add(m.group(0))
    print(json.dumps([p for p in spec_files if p not in referenced], indent=2))
EOF
```

For real specs (has `## Outcome` or `## Acceptance Criteria`): follow the feature-task-create skill to create the task. Post comment: `[backlog-maintenance] Task created from orphaned spec file.`
For stubs: leave a backlog-maintenance comment or note for the next backlog pass. Do not create an incident; if a person must act, route the owning task through `attentionOwners`.

## Step 7 — Report

- N tasks auto-typed (title + type)
- M tasks skipped as ambiguous
- K tasks skipped as bookmark-pipeline candidates
- P feature tasks with spec problems (title + issue)
- Q orphan spec files (filename + action)

If all counts are 0: say exactly: NO_REPLY
