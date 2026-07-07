---
name: tasks-create
description: "Decide when and how to create a task via the Tasks API. Covers task type selection, required field formats per type, and when not to create a task at all."
---

# Task Creation

Use this skill whenever you need to create a task via the Tasks API. It tells you which type to use, what fields are required, and when creating a task is the wrong move entirely.

---

## Step 1 — Should you create a task at all?

**Don't create a task when:**
- The work is a one-liner fix, typo correction, or path/config rename
- Tom has given a direct verbal instruction and the work takes less than 30 minutes
- You're doing cleanup or housekeeping that doesn't produce a PR (e.g. archiving a stale file, deleting a duplicate)
- It's an immediate action you're about to take in the current turn

**Do create a task when:**
- The work produces a PR that needs tracking and review
- Multiple acceptance criteria exist and need sign-off
- The work will be picked up in a future session (not this turn)
- Tom asks you to track something

---

## Step 2 — Pick the task type

| Type | Use when | `--type` flag |
|---|---|---|
| `feature` | New capability, requires spec + Tom approval before Rowan starts, goes through the feature factory | `feature` |
| `bug` | Something broken that needs a fix PR; no spec required but needs ACs | `bug` |
| `chore` | Maintenance, cleanup, dependency bumps, non-functional changes | `chore` |
| `content` | SIndustries website content updates (Ivy workflow) | `content` |

**When in doubt between `feature` and `bug`:** if it's adding something new → `feature`. If it's fixing something that was supposed to work → `bug`.

**When in doubt between `feature` and `chore`:** if it requires a spec and Tom's approval before starting → `feature`. If it's routine maintenance with no new user-facing behaviour → `chore`.

---

## Step 3 — Required fields by type

### Feature task

Feature tasks go through the feature factory. Rowan cannot start until Tom has approved the spec (added `- [x] **Approved by Tom**` to the task description).

```
tasks_api_client.py create \
  --title "🔧 <short description>" \
  --type feature \
  --priority <low|medium|high> \
  --assignee Rowan \
  --tags feature-factory rowan <topic> \
  --description "**Spec:** brain/tasks/specs/<slug>-YYYY-MM-DD.md

- [ ] **Approved by Tom**

<One sentence description of what ships.>

---

**Acceptance Criteria**

- [ ] AC1: <observable outcome>
- [ ] AC2: <observable outcome>

---

**Workstreams**

- Owner: Rowan
  ACs: AC1, AC2, ...
  Branch: (pending)
  PR: (pending)"
```

**Rules:**
- The `**Spec:**` line must point to a real file in `brain/tasks/specs/` (write it first)
- The `- [ ] **Approved by Tom**` line must be unchecked — never pre-tick it
- ACs must be unchecked — never pre-tick them; Tom/QA ticks after testing
- Workstreams section must be present with `Branch: (pending)` and `PR: (pending)` placeholders

### Bug task

```
tasks_api_client.py create \
  --title "🔧 🐛 <short description>" \
  --type bug \
  --priority <low|medium|high> \
  --assignee Rowan \
  --tags rowan <topic> \
  --description "**Type:** bug
**Spec:** brain/bookmarks/specs/feature-factory-v2-2026-06-04.md

- [ ] **Approved by Tom**

<One sentence description of the bug and expected fix.>

---

**Acceptance Criteria**

- [ ] AC1: <observable outcome>

---

**Workstreams**

- Owner: Rowan
  ACs: AC1, ...
  Branch: (pending)
  PR: (pending)"
```

**Rules:** Same AC and approval-marker rules as feature tasks.

### Chore task

Chore tasks are lighter — no spec file required, but still need a description and ACs.

```
tasks_api_client.py create \
  --title "🔧 <short description>" \
  --type chore \
  --priority low \
  --assignee Rowan \
  --tags rowan <topic> \
  --description "<One sentence description.>

---

**Acceptance Criteria**

- [ ] AC1: <observable outcome>"
```

### Content task

Content tasks are created by the weekly content review workflow, not manually. Only create one manually if explicitly asked.

```
tasks_api_client.py create \
  --title "✍️ <description>" \
  --type content \
  --priority high \
  --assignee Ivy \
  --description "**Source:** brain/content/sindustries-weekly-content/<date>.md
..."
```

---

## AC checkbox rules (all types)

- **Never pre-tick `- [x]` AC checkboxes** in the task description — not even if you know the work is done
- **Never pre-tick `- [x] **Approved by Tom**`** — Tom adds that marker himself
- AC checkboxes in the task description belong to Tom/QA, ticked after testing
- Rowan ticks ACs in the **PR body** (with evidence) — not in the task description

---

## Common mistakes

| Mistake | Correct approach |
|---|---|
| Creating without `--type` flag | Always pass `--type feature\|bug\|chore\|content` |
| Pre-ticking ACs in description | Leave all checkboxes unchecked |
| No spec file for a feature task | Write the spec first, then create the task |
| Creating a task for immediate one-turn work | Just do it; no task needed |
| Putting `feature-factory` tag on a bug/chore | Only feature tasks get the `feature-factory` tag |
