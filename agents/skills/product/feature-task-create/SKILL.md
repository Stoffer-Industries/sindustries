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
- [ ] **Approved by Tom**

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
  ACs: AC1, AC2, ...
  Branch: (pending)
  PR: (pending)
```

Do not add a Quinn workstream. If Quinn needs to make `.openclaw` changes, Rowan posts `[openclaw-needed]` via the established handoff. The pr-open skill fills in Branch and PR when Rowan opens a PR.

**Spec line rules:**
- Must be exactly `**Spec:** <path>` — no parentheticals after the path
- Lobster parses this with a strict regex; any suffix breaks it
- Path is relative to workspace root (not an absolute path)

---

## Step 4 — Call the Tasks API

Use `tasks_api_client.py create` with the `--spec` flag so the standard Spec line is composed automatically. Workstreams live in a small YAML file passed via `--workstreams` to avoid shell-escaping headaches:

```bash
cat > /tmp/task-ws.yaml <<'YAML'
- Owner: Rowan
  ACs: AC1, AC2, ...
  Branch: (pending)
  PR: (pending)
YAML

TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py create \
    --title '<Title>' \
    --spec 'brain/tasks/specs/<slug>-YYYY-MM-DD.md' \
    --workstreams /tmp/task-ws.yaml \
    --description '<body text from Step 3, minus Spec/Workstreams>' \
    --priority high \
    --tags rowan <topic-tag> \
    --type feature \
    --assignee Rowan
```

The CLI prepends `**Spec:** <path>` and appends the `**Workstreams**` block automatically when they're not already in the description. If the description still has no `**Spec:**` line, the CLI prints a stderr warning (the lobster will block `ready_checks` for feature tasks until you add one).

To update an existing task's description (replaces, not appends):

```bash
TASKS_API_BASE_URL=${TASKS_API_BASE_URL:-http://localhost:4001/api/v1} \
  python3 agents/skills/ops/tasks-api/tasks_api_client.py patch \
    --id <task-id> \
    --description '<new full description>'
```

Direct `urllib` POSTs remain valid as a fallback if the CLI is unavailable, but prefer the CLI for these reasons: it enforces the `**Spec:**` regex the lobster parses, it warns on missing fields, and the patch path correctly replaces the description rather than appending.

---

## Checklist before declaring done

- [ ] Spec written at `brain/tasks/specs/` (or existing spec identified)
- [ ] `**Spec:**` line is exact path, no trailing text
- [ ] ACs are observable outcomes, not implementation steps
- [ ] Branch name uses first 8 chars of task ID
- [ ] `taskType: feature` and `assignee: Rowan` set via API
- [ ] Task status is `open` (Lobster will advance it once spec is approved)
