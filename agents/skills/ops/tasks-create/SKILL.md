---
name: tasks-create
description: "Decide when and how to create a task via the Tasks API. Covers task type selection, required field formats per type, and when not to create a task at all."
---

# Task Creation

Use this skill whenever you need to create a task via the Tasks API. It tells you which type to use, what fields are required, and when creating a task is the wrong move entirely.

**Role:** This is the entry-point for task creation — covers all task types, type selection, when *not* to create a task, and common mistakes. For the feature-specific end-to-end workflow (spec format, AC text fidelity, workstreams YAML, exact CLI invocation), read `agents/skills/product/feature-task-create/SKILL.md`. Both skills are warranted: this one is the quick "which type?" reference; feature-task-create is the feature-task deep-dive that links back here for type selection.

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

The API accepts these `taskType` values (nullable string; leave unset and you lose type-driven routing — see "Blank type" below):

| Type | Use when | `--type` flag |
|---|---|---|
| `feature` | New capability. Requires spec + Tom approval before Rowan starts. Goes through the feature factory. | `feature` |
| `code` | Bug fixes, maintenance, cleanup, dependency bumps, refactors, security hardening, migrations, chores — anything that's a PR to fix or change existing code with no new product capability. | `code` |
| `content` | SIndustries website content updates (Ivy workflow). | `content` |
| `research` | Spikes, investigation, feasibility checks. Output is a doc/decision, not a code PR. | `research` |

**When in doubt between `feature` and `code`:** if it's adding something new → `feature`. If it's fixing, refactoring, or maintaining existing behaviour → `code`.

**When in doubt between `code` and `research`:** if the output is a code PR → `code`. If the output is a written decision or doc → `research`.

**Blank type — discouraged.** The Tasks API allows `taskType` to be null, but the lobsters and dashboards key off the value to route and filter work. If you genuinely can't pick a type, stop and ask Tom rather than leaving it unset.

---

## Step 3 — Required fields by type

### Feature task

Feature tasks go through the feature factory. Rowan cannot start until Tom has approved the spec (added `- [x] **Approved by Tom**` to the task description). For the full feature-task workflow (spec format, AC text fidelity, workstreams YAML, exact CLI invocation), see `agents/skills/product/feature-task-create/SKILL.md`.

```
tasks_api_client.py create \
  --title "🔧 <short description>" \
  --type feature \
  --priority <low|medium|high> \
  --assignee Rowan \
  --tags feature-factory rowan <topic> \
  --description "**Spec:** brain/tasks/specs/open/<slug>-YYYY-MM-DD.md

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
- The `**Spec:**` line for new chat-created feature specs must point to a real file in `brain/tasks/specs/open/` (write it first)
- The `- [ ] **Approved by Tom**` line must be unchecked — never pre-tick it
- ACs must be unchecked — never pre-tick them; Tom/QA ticks after testing
- Workstreams section must be present with `Branch: (pending)` and `PR: (pending)` placeholders

### Code task

Code covers bug fixes, maintenance, cleanup, dependency bumps, refactors, security hardening, migrations, and architecture/service-boundary corrections that do not add a new product capability. Code tasks do **not** need a product spec. They still need a description, observable ACs, and sometimes a tech design.

```
tasks_api_client.py create \
  --title "<short description>" \
  --type code \
  --priority <low|medium|high> \
  --assignee Rowan \
  --tags rowan <topic> \
  --description "<One sentence description of the change and why it matters.>

---

**Acceptance Criteria**

- [ ] AC1: <observable outcome>
- [ ] AC2: <observable outcome>"
```

**Rules:**
- Product spec is not required for code tasks
- ACs are still required and observable
- Attach a `docs/specs/<slug>-tech-design.md` when a code task changes service boundaries, moves data ownership, splits/merges services, adds migrations, touches cross-service API contracts, changes security posture, or is a non-trivial refactor
- Tech designs for code tasks do not require Tom product sign-off by default; they require review/sign-off only when they introduce security risk, data-loss/migration risk, user-visible behavior changes, new external credentials, or architecture decisions that need Tom/Quinn judgement
- Do not add prefix emoji manually; the Tasks UI renders type icons in the browser
- Pure chores (typos, renames, dep bumps) are fine with a single AC; bugs, security hardening, migrations, and refactors need ACs that describe the fix and verification

### Content task

Content tasks are created after Tom approves a weekly content review. Only create one manually if explicitly asked.

The description **must** follow this exact format — the content task lobster validates it:

```
tasks_api_client.py create \
  --title "✍️ SIndustries website content — YYYY-MM-DD weekly review (Tom approved)" \
  --type content \
  --priority high \
  --assignee Ivy \
  --description "**Source:** brain/content/sindustries-weekly-content/YYYY-MM-DD.md

**Review window:** YYYY-MM-DD to YYYY-MM-DD

---

## Quinn can execute

- [ ] EDIT experiment/slug — description of change
- [ ] ADD release — ...

## Needs Tom approval

- [ ] ADD system/slug — description of change
- [ ] EDIT story/slug — ..."
```

**Format rules (enforced by the content task lobster):**
- The `**Source:**` line must point to a real file at `brain/content/sindustries-weekly-content/YYYY-MM-DD.md`
- The heading names must be exactly `## Quinn can execute` and `## Needs Tom approval` — these mirror the sections in the review file and the lobster validates that each heading contains "Tom" or "Quinn"
- Each heading must have at least one checkbox line (`- [ ] ...`) beneath it — the lobster rejects tasks where a heading has no checkboxes
- Copy items verbatim from the review file into the relevant section; do not paraphrase or reword
- If a section has no approved items, omit that heading rather than leaving it empty
- The `**Review window:**` line is informational; include it but it is not validated

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
| Creating without `--type` flag | Always pass `--type feature\|code\|content\|research` |
| Pre-ticking ACs in description | Leave all checkboxes unchecked |
| No spec file for a feature task | Write the spec first, then create the task |
| Creating a task for immediate one-turn work | Just do it; no task needed |
| Putting `feature-factory` tag on a code/content/research task | Only feature tasks get the `feature-factory` tag |
| Using `--type bug` or `--type chore` | Those don't exist. Use `--type code` (covers both) |
| Leaving `--type` unset because you're unsure | Ask Tom — don't ship a typeless task |
| Content task headings like `## Tom` / `## Quinn` | Use exact names `## Quinn can execute` and `## Needs Tom approval` — mirrors review file sections |
| Content task has no checkbox lines under a heading | Each Tom/Quinn heading must have `- [ ] ...` lines beneath it or the lobster rejects it |
