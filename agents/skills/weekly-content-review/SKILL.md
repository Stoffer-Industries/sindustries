# weekly-content-review

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

## Step 2 — Collect safe daily notes

Read note files from:
```
/Users/quinnstoffer/.openclaw/workspace/brain/ops/notes/YYYY-MM-DD.md
```

Collect files whose stem (filename without extension) falls within the 7-day window. Read each file in full. Copy the raw bullet lines as-is; do not summarise or classify them yet.

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

## Step 6 — Notify

After writing the file, post a short message to the session that triggered this skill:

> Weekly content review ready: `brain/content/sindustries-weekly-content/YYYY-MM-DD.md` — N change items (X Quinn / Y Tom / Z defer). Ready for your triage.

Keep the notification to 2 lines maximum. Do not summarise all the change items in the message.

---

## Step 7 — Assign PRs

After opening PRs, assign each one to the relevant owner:
- **Quinn's PR** (the one from `## Quinn can execute`) → assign to `quinnstoffer`
- **Tom's PR** (the one from `## Needs Tom approval`) → assign to `Stoff81`

Use `gh pr edit <url> --add-assignee <username>` for each PR.

This is mandatory before the task can move to acceptance — unassigned PRs will fail the acceptance check.

---

## What NOT to do

- Do not create Tasks API tasks — tasks are only created after Tom approves
- Do not distil or classify notes with a separate LLM call — read and reason natively
- Do not re-ingest the output review file as input on subsequent runs
- Do not write vague items like "review the experiment" — every item must specify add/edit/remove and what changes