---
name: feature-task-create
description: "Create or clean up a feature task: decide whether to use the feature factory, write the spec, format the task description, and call the Tasks API."
---

# Feature Task Create

Use when turning a request into a tracked feature task. Covers the factory vs direct decision, spec placement, and task format.

## Step 1 — Feature Factory or Direct?

**Use the feature factory** when the work:
- Has more than one non-trivial acceptance criterion
- Requires spec approval from Tom before implementation starts
- Is a new capability, not a removal or rename
- Will take Rowan more than a few hours of focused work

**Assign directly** (no task needed) when the work is:
- Removing or renaming an old artifact
- A typo / cosmetic fix
- A config or path correction
- Something Tom has already verbally approved and scoped

For direct work: hand it to Rowan with a clear instruction and let him open a PR. No Tasks API call needed.

---

## Step 2 — Write or Identify the Spec

**Feature tasks need a spec.** Choose the right location:

| Situation | Spec location |
|---|---|
| New spec for this feature | `brain/tasks/specs/<slug>-YYYY-MM-DD.md` |
| Bookmark pipeline produced a spec | `brain/bookmarks/specs/<slug>-<key>.md` |
| An existing sindustries spec covers this | `docs/specs/<filename>.md` |

Do **not** amend an existing approved spec unless the task is explicitly an amendment. Do **not** create a new spec inside `docs/specs/` — that dir is for committed, reviewed specs only.

### Spec format (brain/tasks/specs/)

```markdown
# Spec — <Title>

**Status:** Draft
- [ ] Approved by Tom

## Outcome

One paragraph: what is demonstrably different after this ships?

## Acceptance Criteria

- [ ] AC1: observable outcome
- [ ] AC2: observable outcome

Rules: max 8 ACs, implementation-agnostic, no script names or file paths.

## Non-Goals

What this deliberately does not cover.

## Notes

Key constraints or non-obvious integration points. One paragraph max.
```

---

## Step 3 — Format the Task Description

```
**Type:** feature
**Spec:** <relative path from workspace root, e.g. brain/tasks/specs/my-spec-2026-06-29.md>

<One paragraph describing what the feature does and why it matters>

---

**Acceptance Criteria**

- [ ] AC1: ...
- [ ] AC2: ...

---

**Workstreams**

- Owner: Rowan
  Repo: Stoffer-Industries/sindustries
  Branch: task-<first 8 chars of task ID>-<short-slug>
  Worktree: ~/workspaces/rowan/sindustries
  PR: (pending)
  Scope: <what Rowan builds>
  ACs: AC1, AC2, ...
  Status: open

- Owner: Quinn          ← only if Quinn has ACs
  Scope: <what Quinn does>
  ACs: AC3, ...
  Status: open
```

**Spec line rules:**
- Must be exactly `**Spec:** <path>` — no parentheticals after the path
- Lobster parses this with a strict regex; any suffix breaks it
- Path is relative to workspace root (not an absolute path)

---

## Step 4 — Call the Tasks API

```python
import urllib.request, json

base = 'http://localhost:4001/api/v1'

# Create new task
payload = json.dumps({
    'title': '<Title>',
    'description': '<formatted description from Step 3>',
    'taskType': 'feature',
    'assignee': 'Rowan',
    'priority': 'high',  # or 'urgent' if blocking
    'tags': ['rowan', '<topic-tag>']
}).encode()

req = urllib.request.Request(f'{base}/tasks', data=payload,
    headers={'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(req) as resp:
    task = json.load(resp)['data']
    print('Created:', task['id'], task['title'])
```

To update an existing task (replace description, not append):

```python
req = urllib.request.Request(f'{base}/tasks/{task_id}',
    data=json.dumps({'description': desc, 'taskType': 'feature', 'assignee': 'Rowan'}).encode(),
    headers={'Content-Type': 'application/json'}, method='PATCH')
```

Note: `tasks_api_client.py patch --description` **appends** to the existing description. Use direct API calls to replace.

---

## Checklist before declaring done

- [ ] Spec written at `brain/tasks/specs/` (or existing spec identified)
- [ ] `**Spec:**` line is exact path, no trailing text
- [ ] ACs are observable outcomes, not implementation steps
- [ ] Branch name uses first 8 chars of task ID
- [ ] `taskType: feature` and `assignee: Rowan` set via API
- [ ] Task status is `open` (Lobster will advance it once spec is approved)
