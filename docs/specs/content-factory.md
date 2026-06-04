# Content Factory

**Status:** Live  
**Last updated:** 2026-06-04  
**Owner:** Quinn (orchestration) · Ivy (content production) · Tom (approval authority)

---

## What This Is

The content factory is the operating system for keeping the SIndustries website alive. As work happens — experiments ship, systems evolve, lessons land — the factory turns internal progress into public signal without Tom having to manually remember every update.

The core loop:
1. Quinn captures candidate notes during the week
2. Tom adds weekly context via a Lobster resume prompt
3. A weekly review is produced and approved items become Tasks API content tasks
4. Ivy picks up content tasks, writes the copy, and opens PRs
5. Quinn and Tom review and merge

Nothing publishes without review. Nothing requires Tom to write copy.

---

## Agents

### Quinn — Orchestrator

- Captures content signals during the week (heartbeat)
- Runs the weekly editorial sweep (cron, every Friday 4pm NZST)
- Prompts Tom for weekly input before finalising the review
- Creates content tasks in the Tasks API from approved review items
- Reviews and merges Quinn-approval PRs
- Runs the content-task Lobster each heartbeat to drive tasks forward

Quinn does not write final website copy. She is the orchestrator, not the author.

### Ivy — Content Agent

- Discovers assigned content tasks via her own heartbeat
- Produces all website copy: card copy, long-form, meta description, title/dek
- Authors both PRs (Tom-approval and Quinn-approval) under her own GitHub identity (`ivystoffer`)
- Monitors PRs for review comments and iterates
- Posts `[ivy-prs]` task comment so the Lobster can detect her work
- Never changes task status — the Lobster owns all state transitions

**Ivy's worktree:** `~/workspaces/ivy/sindustries`  
**GitHub identity:** `GH_CONFIG_DIR=~/.config/gh-ivy gh ...`

### Tom — Approval Authority

- Provides weekly context before the review is finalised
- Approves and merges Tom-approval PRs (strategic copy, stories, first-person voice)
- Reviews Quinn's weekly review artifact before content tasks are created

### The Lobster (content-task workflow)

A resumable workflow runner that drives content tasks through their lifecycle. Quinn's heartbeat fires one Lobster pass per active content task.

**Script:** `agents/workflows/scripts/content-task.lobster.yaml`  
**Entry point:** `agents/workflows/content-task.py`

---

## Content Types

### Experiments

Bounded bets and explorations. Website placement: Studio, optionally Signals.

```json
{
  "title": "...",
  "slug": "...",
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
  "source": "original | x-thread | bookmark-review | project-retro | release-note",
  "topics": [],
  "draftedAt": "YYYY-MM-DD",
  "publishedAt": "YYYY-MM-DD",
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
  "slug": "...",
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

Quinn's heartbeat appends short candidate notes to the current weekly content review file under a `Daily notes` section. One line per signal. Format: `[content-type] [slug if known] — [what changed and why it matters]`.

File location: `brain/reviews/website-content/YYYY-MM-DD.md`

### Friday 4pm NZST (weekly cron)

1. Cron fires the weekly review prompt
2. Quinn prompts Tom: *"What changed this week that SIndustries should remember?"*
3. Tom's reply (via Lobster resume token) is bundled into the review notes
4. Quinn produces the weekly review with exactly two sections:
   - `Needs approval from Tom`
   - `Needs approval from Quinn`
   - (plus `Daily notes` if raw appends exist)
5. Review is posted to the Sindustries channel for Tom to read and respond
6. Tom approves items (or requests changes)
7. Approved items become content tasks in the Tasks API

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
**Source:** brain/reviews/website-content/YYYY-MM-DD.md

**Review window:** YYYY-MM-DD to YYYY-MM-DD

---

## Quinn can execute

- [ ] ADD/EDIT/REMOVE ...

## Needs Tom approval

- [ ] ADD/EDIT/REMOVE ...
```

---

## Content Task Lifecycle

```
open → ready → doing → acceptance → done
```

The Lobster evaluates one task per pass and applies at most one transition.

| Transition | Criteria |
|---|---|
| `open → ready` | Task body has ACs under PR headings and a source review file link |
| `ready → doing` | Ivy's current `doing` task count is below capacity limit (default: 1) |
| `doing → acceptance` | Ivy has posted `[ivy-prs]` comment; PR URLs recorded on task metadata |
| `acceptance → done` | All PRs merged; branches cleaned up |

If earlier criteria regress, the Lobster moves the task backwards and posts a comment explaining why.

**Lobster invocation (Quinn heartbeat):**

```bash
TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 \
  /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/workflows/content-task.py --json
```

---

## Ivy's PR Workflow

### Discovery

Each heartbeat, Ivy queries:

```
assignee=Ivy AND status=doing AND taskType=content
```

For each task, checks if `[ivy-prs]` comment already posted. If not, proceeds to produce content and open PRs.

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

(or just one URL if only one PR was opened)

The Lobster parses this comment on the next pass to advance the task to `acceptance`.

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
- Systems: `apps/website/public/brand/systems/<slug>-hero.jpg`
- Experiments: `apps/website/public/brand/studio/<slug>-hero.jpg`

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
| Content authoring skill | `agents/skills/content-authoring/SKILL.md` |
| Weekly content review skill | `agents/skills/weekly-content-review/SKILL.md` |
| Lobster YAML | `agents/workflows/scripts/content-task.lobster.yaml` |
| Lobster entry point | `agents/workflows/content-task.py` |
| Transition scripts | `agents/workflows/content-task/` |
| Hero image skill | `agents/skills/sindustries-hero-images/SKILL.md` |
| Ivy agent docs | `workspace: agents/ivy/` |
| Weekly review files | `workspace: brain/reviews/website-content/YYYY-MM-DD.md` |

---

## Known Gaps

- `canonicalUrl` field defined in spec for stories but not yet populated in content files or skill field mapping — relevant when stories appear on external platforms (X threads, etc.)
- Content authoring skill field mapping table shows minimum fields only; Ivy should refer to the JSON schema examples in this doc for the full field list
- Weekly review is currently delivered as a channel message, not a PR against `brain/reviews/` — the PR-based review flow is the target model but not yet implemented
