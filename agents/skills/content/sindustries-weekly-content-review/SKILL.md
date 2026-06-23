---
name: sindustries-weekly-content-review
description: "Create the SIndustries weekly content review from ops notes, memory, and current website content."
---

# SIndustries Weekly Content Review

Quinn's native workflow for the SIndustries weekly content review. Compares recent daily ops notes against live website content, then proposes specific content changes for Tom's triage.

**Do not create Tasks API tasks.** Tasks are only created after Tom approves the review.

---

## Overview

The goal is not to classify notes. It is to:
1. Read current website content to understand what is already published
2. Read the last 7 days of daily notes to understand what has happened
3. Identify specific content items (experiments, systems, stacks, releases, stories) that should be **added**, **edited**, or **removed** given the notes
4. Write a review file for Tom's triage — brief, actionable, opinionated
5. Post a short notification that the file is ready

---

## Step 1 — Determine review date and window

Use today's date as the review date (`REVIEW_DATE`). The note window is `REVIEW_DATE - 6 days` through `REVIEW_DATE` inclusive (7-day rolling window).

---

## Step 2 — Collect safe daily notes and memory

**Ops notes** — read from:
```
/Users/quinnstoffer/.openclaw/workspace/brain/ops/notes/YYYY-MM-DD.md
```
Collect files whose stem falls within the 7-day window. Copy the raw bullet lines as-is.

**Memory files** — also read from:
```
/Users/quinnstoffer/.openclaw/workspace/memory/YYYY-MM-DD*.md
```
Collect memory files whose stem starts with a date in the 7-day window. Read them for narrative context — what was being worked on, what broke, what shipped, what the arc of the week looked like. Do not copy memory lines verbatim into the review; synthesise them at a high level (e.g. "struggled with approval routing reliability before landing the fix", not the raw debug logs). Memory adds colour to the ops notes; ops notes remain the primary signal.

**Safety rule:** Skip any file whose name or content contains markers like `sindustries weekly content review`, `needs approval from tom`, `review queue`. These are generated output, not input.

---

## Step 3 — Read current website content

The SIndustries website content lives at:
```
/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/apps/website/src/content/
```

Read each of these files in full:
- `experiments.json` — Studio experiments (title, slug, status, summary, currentLearning, updatedAt)
- `systems.json` — Operating systems (title, slug, status, summary, proof, updatedAt)
- `stacks.json` — Technology stacks (name, category, status, summary, updatedAt)
- `releases.json` — Shipped releases (title, slug, releasedAt, summary, type)
- `stories/*.json` — Published long-form stories (title, slug, draftedAt, publishedAt, body)

Build a mental model of: what is currently published, what statuses exist, when each item was last updated.

---

## Step 4 — Compare and generate change items

For each daily note bullet, ask:
- Does this note signal a change that should be reflected on the website?
- Which content item does it relate to? (experiment, system, stack, release, story)
- What specifically needs to change: **add**, **edit**, or **remove**?
- Is the change factual/technical (Quinn can execute) or strategic/narrative/first-person (needs Tom)?

Produce a flat list of proposed change items. Each item should be:
- One line, starting with the action: `ADD`, `EDIT`, or `REMOVE`
- Specifying the content type and slug/name
- Describing what specifically changes (one clause)

Example items:
```
EDIT experiment/ops-notes-system — add to currentLearning: "weekly content pipeline now live and feeding review files"
ADD release — "Content ops pipeline" (system, releasedAt: 2026-06-01): new automated content review system shipped
EDIT system/openclaw — update proof: reference the content pipeline as an active workflow outcome
EDIT experiment/social-content — update currentLearning to note posting cadence gap still open
```

**Classification rule:**
- **Quinn can execute**: factual status updates, `updatedAt` bumps, `currentLearning` additions with evidence, new release entries for shipped infrastructure, stack status changes
- **Needs Tom approval**: changes to `summary`, `why`, `body` (narrative voice), `successCriteria`, new experiment creation, removing published items, new story content, any public commitment or claim about revenue/customers
- **Defer / needs more context**: notes that signal something happened but not enough detail to know what the content change should be

---

## Step 5 — Write the review file

Write to:
```
/Users/quinnstoffer/.openclaw/workspace/brain/content/sindustries-weekly-content/YYYY-MM-DD.md
```

Use `REVIEW_DATE` for the filename and the heading date.

File structure:

```markdown
# SIndustries Weekly Content — YYYY-MM-DD

## Quinn can execute

_Factual updates, status changes, currentLearning additions, release entries — no Tom needed._

- EDIT experiment/ops-notes-system — add to currentLearning: "..."
- ADD release — ...
- ...

## Needs Tom approval

_Narrative changes, summary rewrites, new experiments, strategic claims, first-person voice._

- EDIT experiment/social-content — update summary to reflect...
- ...

## Defer / needs more context

_Signals noted but insufficient detail to act on._

- [note slug] — unclear which content item this maps to; needs Tom context

---

## Reference — Daily notes collected (YYYY-MM-DD to YYYY-MM-DD)

<!-- Raw notes appended for context. Do not re-ingest these in subsequent runs. -->

[paste raw note bullets here, grouped by date]
```

**Rules:**
- If a section has no items, write `<!-- no items this week -->` rather than leaving it blank
- Keep change items brief — one line each, enough for Tom to approve or redirect without reading paragraphs
- The reference section must be clearly separated with `---` so it is not mistaken for actionable items

---

## Step 6 — Update state-of-the-nation

Read `docs/state-of-the-nation.md`. Using the ops notes already collected, apply changes directly.

- Add a new bullet to **What Already Exists** when something shipped (new system, pipeline stage, skill, or cron). One line, present tense, naming the key artifact.
- Mark a bullet in **Current Frictions** as resolved when ops notes or memory show it was addressed: replace with ~~strikethrough~~ + `(resolved YYYY-MM-DD)`.
- Add a new bullet to **Current Frictions** when memory files reveal a recurring problem, blockers, or pain points that kept coming up this week and aren't already listed. One line, present tense, concrete. Only add if it genuinely recurred — not a one-off debug session.

**Rules:**
- Surgical additions and removals only — do not rewrite sections
- If nothing changed this week that affects the doc, skip this step silently

---

## Step 7 — Notify

After writing the file, post a short message to the session that triggered this skill:

> Weekly content review ready: `brain/content/sindustries-weekly-content/YYYY-MM-DD.md` — N change items (X Quinn / Y Tom / Z defer). Ready for your triage.

Keep the notification to 2 lines maximum. Do not summarise all the change items in the message.

---

## What NOT to do

- Do not create Tasks API tasks — tasks are only created after Tom approves
- Do not distil or classify notes with a separate LLM call — read and reason natively
- Do not re-ingest the output review file as input on subsequent runs
- Do not write vague items like "review the experiment" — every item must specify add/edit/remove and what changes
