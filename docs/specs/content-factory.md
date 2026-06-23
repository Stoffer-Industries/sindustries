# Content Factory

**Status:** Live  
**Last updated:** 2026-06-04  
**Owner:** Quinn (orchestration) · Ivy (content production) · Tom (approval authority)

---

## What This Is

The content factory is the operating system for keeping the SIndustries website alive. As work happens — experiments ship, systems evolve, lessons land — the factory turns internal progress into public signal without Tom having to manually remember every update.

The core loop:
1. Quinn captures candidate notes during the week as daily ops notes
2. A weekly review is produced from those notes for Tom's triage
3. Tom approves, rejects, or redirects review items
4. Approved items become Tasks API content tasks
5. Ivy picks up content tasks, writes the copy, and opens PRs
6. Quinn and Tom review and merge

Nothing publishes without review. Nothing requires Tom to write copy.

---

## Agents

### Quinn — Orchestrator

- Captures content signals during the week (heartbeat)
- Runs the weekly editorial sweep via the `sindustries-weekly-content` cron prompt
- Posts the weekly review location for Tom's triage
- Creates content tasks in the Tasks API after Tom approves review items
- Reviews and merges Quinn-approval PRs
- Runs the content-task workflow from heartbeat; the wrapper discovers active content tasks and drives each through the Lobster step chain

Quinn normally does not write final website copy. She is the orchestrator, not the author. The `content-authoring` skill still allows Quinn to handle one-off content tasks directly when explicitly needed.

### Ivy — Content Agent

- Discovers assigned content tasks via her own heartbeat
- Produces website copy for normal content tasks: card copy, long-form, meta description, title/dek
- Authors both PRs (Tom-approval and Quinn-approval) under her own GitHub identity (`ivystoffer`)
- Monitors PRs for review comments and iterates
- Posts `[ivy-prs]` task comment so the Lobster can detect her work
- Never changes task status — the Lobster owns all state transitions

**Ivy's worktree:** `~/workspaces/ivy/sindustries`  
**GitHub identity:** `GH_CONFIG_DIR=~/.config/gh-ivy gh ...`

### Tom — Approval Authority

- Provides context, approvals, and redirects during weekly review triage
- Reviews the generated weekly review artifact before content tasks are created
- Approves and merges Tom-approval PRs (strategic copy, stories, first-person voice)

### The Lobster (content-task workflow)

A resumable workflow runner that drives content tasks through their lifecycle. Quinn's heartbeat runs the `content-tasks/run.py` wrapper, which discovers all active content tasks and runs the Lobster step chain for each task.

**Script:** `agents/workflows/content-tasks/content-tasks.lobster.yaml`  
**Entry point:** `agents/workflows/content-tasks/run.py`

---

## Content Types

### Experiments

Bounded bets and explorations. Website placement: Studio, optionally Signals.

```json
{
  "title": "...",
  "slug": "...",
  "tag": "...",
  "status": "idea | active | paused | shipped | killed",
  "summary": "...",
  "why": "...",
  "successCriteria": "...",
  "currentLearning": [],
  "startedAt": "YYYY-MM-DD",
  "updatedAt": "YYYY-MM-DD",
  "links": [],
  "image": "/brand/studio/<slug>-hero.jpg",
  "visibility": "draft | review | published | archived"
}
```

File: `apps/website/src/content/experiments.json`

### Systems

Repeatable operating assets that compound. Website placement: Systems, optionally Stacks.

```json
{
  "title": "...",
  "slug": "...",
  "tag": "...",
  "status": "designing | building | operating | retired",
  "summary": "...",
  "problem": "...",
  "howItWorks": "...",
  "proof": "...",
  "updatedAt": "YYYY-MM-DD",
  "links": [],
  "image": "/brand/systems/<slug>-hero.jpg",
  "visibility": "draft | review | published | archived"
}
```

File: `apps/website/src/content/systems.json`

### Releases

Things that left the building. Website placement: Ships, optionally Signals.

```json
{
  "title": "...",
  "slug": "...",
  "releasedAt": "YYYY-MM-DD",
  "summary": "...",
  "type": "product | system | content | experiment | infrastructure",
  "links": [],
  "evidence": "...",
  "visibility": "draft | review | published | archived"
}
```

File: `apps/website/src/content/releases.json`

### Stories

Narrative posts: founder notes, lessons, build-in-public reflections. Website placement: Stories.

```json
{
  "title": "...",
  "slug": "...",
  "dek": "...",
  "body": "...",
  "source": "internal | original | x-thread | bookmark-review | project-retro | release-note",
  "topics": [],
  "draftedAt": "YYYY-MM-DD",
  "publishedAt": "YYYY-MM-DD | null",
  "canonicalUrl": "...",
  "displayOrder": 0,
  "visibility": "draft | review | published | archived"
}
```

File: `apps/website/src/content/stories/<slug>.json`

Stories always require Tom approval. First-person voice is fine — stories are written in Tom's voice and routed through the Tom-approval PR. Quotes are welcome.

### Stacks

Tools and operating choices behind the company. Website placement: Stacks.

```json
{
  "name": "...",
  "category": "agent | model | infra | app | workflow | design",
  "summary": "...",
  "whyWeUseIt": "...",
  "status": "core | testing | retired",
  "links": [],
  "updatedAt": "YYYY-MM-DD",
  "visibility": "draft | review | published | archived"
}
```

File: `apps/website/src/content/stacks.json`

---

## Weekly Cycle

### During the week (Quinn heartbeat)

Quinn appends short candidate notes to daily ops note files. One line per signal, with enough context for the weekly cron to understand it without session history.

File location: `brain/ops/notes/YYYY-MM-DD.md`

Format:

```markdown
- [YYYY-MM-DD] **<system or experiment slug>** — <what happened or changed> | why: <why this is content-relevant> | ref: <memory file, brain file, or workspace path relevant to this note>
```

### Weekly cron

1. Cron fires the weekly review prompt
2. Quinn reads the last 7 days of `brain/ops/notes/*.md`
3. Quinn compares the notes against current website content
4. Quinn writes the weekly review with these sections:
   - `Quinn can execute`
   - `Needs Tom approval`
   - `Defer / needs more context`
   - `Reference — Daily notes collected (...)`
5. Quinn posts a short notification with the review file path
6. Tom approves items, redirects them, or provides missing context
7. Approved items become content tasks in the Tasks API

Review file location: `brain/content/sindustries-weekly-content/YYYY-MM-DD.md`

### Content task creation

```bash
python3 tasks_api_client.py create \
  --title "SIndustries weekly content updates — YYYY-MM-DD" \
  --priority high \
  --type content \
  --tags "weekly-review,content-ops" \
  --description "..."
```

Task description format:

```
**Source:** brain/content/sindustries-weekly-content/YYYY-MM-DD.md

**Review window:** YYYY-MM-DD to YYYY-MM-DD

---

## Quinn can execute

- [ ] ADD/EDIT/REMOVE ...

## Needs Tom approval

- [ ] ADD/EDIT/REMOVE ...

## Defer / needs more context

- [ ] ...
```

---

## Content Task Lifecycle

```
open → ready → doing → acceptance → done
```

The `content-tasks/run.py` wrapper discovers active `content` tasks in `open`, `ready`, `doing`, and `acceptance`, then runs the Lobster step chain for each one. A task can pass through multiple consecutive gates in one wrapper run when later criteria are already satisfied.

| Transition | Criteria |
|---|---|
| `open → ready` | Task body has a source `brain/...md` file or URL, plus one or more Tom/Quinn owner headings with checkbox ACs. Lobster assigns the task to Ivy. |
| `ready → doing` | Task is assigned to Ivy and Ivy's current unblocked `doing` content task count is below the capacity limit (default: 1). |
| `doing → acceptance` | Ivy has posted the latest `[ivy-prs]` comment; Lobster records the PR URLs, injects them under the owner headings if missing, verifies every owner heading has a PR URL, verifies PR CI is successful, verifies each PR body has checked AC signatures for that owner section, and verifies Quinn/Tom PRs are assigned to `quinnstoffer`/`Stoff81`. |
| `acceptance → done` | All recorded PRs are merged to `main`. Before merge, the current implementation treats `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or any returned inline review comments on an unmerged PR as Ivy revision work and routes that feedback back to Ivy. |

If earlier criteria regress, the Lobster moves the task backwards and posts a comment explaining why. While a task is in `acceptance`, the Lobster can also route PR review feedback back to Ivy by posting a task comment.

**Workflow invocation (Quinn heartbeat):**

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 \
  /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/content-tasks/run.py --json
```

---

## Ivy's PR Workflow

### Discovery

Each heartbeat, Ivy queries Tasks API by assignee/status:

```
assignee=Ivy AND status=doing
assignee=Ivy AND status=acceptance
assignee=Ivy AND blocked=true
```

Ivy's workflow is scoped to content tasks; the current CLI query does not expose a `taskType` filter, so Ivy filters by task type after reading the returned tasks. For each `doing` content task, Ivy checks if `[ivy-prs]` has already been posted. If not, she proceeds to produce content and open PRs. For each `acceptance` task, she monitors linked PRs for review feedback and updates the same branches. Blocked tasks are escalated to Quinn rather than resolved directly by Ivy.

### PR naming

- Quinn-approval PR: `content/YYYY-MM-DD-<short-slug>-quinn`
- Tom-approval PR: `content/YYYY-MM-DD-<short-slug>-tom`

Both target `main`. Always branch from `main`.

### PR description

Every PR must:
- Copy all ACs from the task body under the relevant owner heading
- Mark ACs as `- [x]` when completed in the PR
- Include the task ID for traceability
- Use the `content-task` label

### Signalling completion

Immediately after opening PRs, Ivy posts a task comment:

```
[ivy-prs] tom: <url>, quinn: <url>
```

If both PRs exist, keep the order `tom` then `quinn`. If only one PR was opened, include just that labelled URL.

The Lobster parses the latest `[ivy-prs]` comment on the next pass, records the URLs in Lobster state, injects the links into the task description owner sections when needed, and advances the task to `acceptance` once all `doing → acceptance` criteria pass.

### Review iteration

While in `acceptance`, Ivy monitors for review comments and pushes new commits to the same branch. Never opens a new PR to address review feedback.

---

## Approval Rules

### Quinn can approve and merge

- Typo fixes
- Factual metadata updates (dates, links, status changes)
- Stack list additions or updates
- Release entries for already-public completed work
- `currentLearning` additions backed by task/release evidence
- Experiment status changes (`active → paused/shipped`) with evidence

### Tom must approve and merge

- Blog and story posts (all stories go to Tom regardless)
- Public strategic claims
- Copy in Tom's first-person voice
- Pricing, revenue, customer, or investment claims
- Anything referring to Tom's employer or family
- Anything that could look like a public commitment

---

## Copy Principles

Non-negotiable for all content:

1. **Specific beats clever.** Numbers and facts over adjectives.
2. **Proof beats promise.** Link evidence. If there's no evidence, say so.
3. **No fake certainty.** Never write "proven" or "best-in-class" without data.
4. **No startup theater.** No "disrupting", "revolutionising", "game-changing".
5. **No private context.** No inMusic, family, salary, or anything not already public.
6. **No implementation detail.** Don't expose internal paths, port numbers, or infrastructure names. Agent names (Ivy, Quinn, Rowan) are fine — they add personality.

For stories specifically: first-person voice is fine and encouraged. Quotes are welcome. All stories route through Tom-approval PRs before publishing.

---

## Images

Experiments and systems require an image. Use the `sindustries-hero-images` skill to generate:

```
agents/skills/sindustries-hero-images/SKILL.md
```

Save to:
- Systems: `apps/website/public/brand/systems/<slug>-hero.jpg` or `.png`
- Experiments: `apps/website/public/brand/studio/<slug>-hero.jpg` or `.png`

A PR with an `image` field pointing to a non-existent file will fail CI.

---

## Privacy and Safety Rules

Before any content moves to review:

- No secrets, keys, tokens, private URLs, or internal hostnames
- No private family details
- No private employer details
- No confidential third-party information
- No claims about customers or revenue unless approved
- No screenshots containing private chats, calendars, tasks, or logs
- No accidental impersonation of Tom

---

## Stale Content

Quinn's heartbeat flags experiments and systems with `updatedAt` older than 30 days as potentially stale. These appear in the weekly review as candidate updates, not automatic changes.

---

## Key File Locations

| What | Where |
|---|---|
| Content files | `apps/website/src/content/` |
| Content notes skill | `agents/skills/content-notes/SKILL.md` |
| Content authoring skill | `agents/skills/content-authoring/SKILL.md` |
| Weekly content review skill | `agents/skills/weekly-content-review/SKILL.md` |
| Lobster YAML | `agents/workflows/content-tasks/content-tasks.lobster.yaml` |
| Lobster entry point | `agents/workflows/content-tasks/run.py` |
| Transition scripts | `agents/workflows/content-tasks/scripts/` |
| Hero image skill | `agents/skills/sindustries-hero-images/SKILL.md` |
| Ivy agent docs | `workspace: agents/ivy/` |
| Daily ops notes | `workspace: brain/ops/notes/YYYY-MM-DD.md` |
| Weekly review files | `workspace: brain/content/sindustries-weekly-content/YYYY-MM-DD.md` |

---

## Known Gaps

- Story files are loaded and rendered, but story JSON is not schema-validated in `apps/website/src/content/index.js` yet.
- `canonicalUrl` is optional for stories and populated only when there is an external canonical source.
- Content authoring skill field mapping table shows minimum fields only; Ivy should refer to the JSON schema examples in this doc for the full field list.
- The content-authoring skill is stricter than this spec in one place: it routes release entries as `medium` risk/Tom approval, while the website content contribution guide and this spec allow Quinn to approve low-risk release entries for already-completed public work.
- Some supporting docs still have stale wording or paths: Ivy workspace docs point at older source/spec paths (`brain/reviews/...` or `brain/specs/...`), and the content-notes skill summary says the weekly cron creates tasks even though the current weekly-review skill only writes the review file. This `content-factory` spec should become the canonical reference going forward.
