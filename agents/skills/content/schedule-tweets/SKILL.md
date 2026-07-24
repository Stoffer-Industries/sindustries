---
name: schedule-tweets
description: Pick a weekly theme, draft themed tweets, and queue them into the Content Scheduler. Use when a weekly-content task needs its 5–7 daily tweets drafted and scheduled.
---

# schedule-tweets

## What this is

A weekly ritual for turning a completed content review file into a coherent 5–7 tweet arc queued into the Content Scheduler. One theme per week, one tweet per day.

Ivy calls this as part of her `doing` work on a weekly-content task. It is the same skill any other agent (or Tom directly) would use to seed a week of scheduled posts.

## When to use

- The task in play is a **weekly-content task** (title contains `weekly review` or `weekly content updates`).
- A weekly review file exists at `brain/content/sindustries-weekly-content/YYYY-MM-DD.md` for the current week.
- The task is in `doing` and no `[ivy-tweets-queued]` comment has been posted yet.

**Do not use** for:
- One-off tweets outside the weekly cadence (compose directly in Mission Control).
- Backfilling past weeks (only forward-scheduling makes sense).

## Inputs

- **Weekly review file path** — from the task body. Typically the most recent file in `brain/content/sindustries-weekly-content/`.
- **Content Scheduler API** — `http://localhost:4001/api/v1/content-scheduler/items`.
- **Task ID** — for the `[ivy-tweets-queued]` traceability comment.

## Outputs

- 5–7 new `ContentSchedulerItem` rows with `status=queued`, one per consecutive day, each `scheduledFor` set to `10:00 Pacific/Auckland`.
- A single task comment: `[ivy-tweets-queued] <id1>, <id2>, ...`.
- No PRs, no code changes, no direct publish. Tom approves each item in Mission Control; auto-post fires at `scheduledFor`.

## Steps

### 1. Read the weekly review file

Identify the file linked in the task body (or the most recent under `brain/content/sindustries-weekly-content/`). Read the whole file. Pay particular attention to:

- The Quinn-execute bucket (usually the strongest signals)
- The Tom-approval bucket (higher-stakes, narrative-worthy items)
- Cross-references (system proofs, release entries, story edits)
- The "Reference — Daily notes collected" section, if present

### 2. Pick ONE theme for the week

Themed beats scattergun. Narrative arcs land harder than 7 disconnected wins.

Scan the week's signals and pick the single strongest arc — a story with a beginning, middle, and end that can be told across 5–7 tweets. Good arcs typically look like:

- **A capability shipped**: "here's what didn't exist last week → here's how we built it → here's what it unlocks → here's the lesson"
- **A pattern discovery**: "we kept seeing X → we tried Y → Y didn't scale → we landed on Z → now we do this every time"
- **A system going live**: "we've been building X → here's the first end-to-end run → here's what it proves → here's what's next"
- **A workflow evolution**: "our old process had Y bottleneck → we tried Z → it worked → here's how it changed the team"

**Bad themes to avoid:**
- "Weekly wrap-up" — that's a format, not a theme
- Meta-commentary on the studio itself — themes should be about the *work*, not about how the studio operates
- Anything that requires context Tom hasn't publicly established (don't tease private client work, private team dynamics, etc.)

**Fallback:** if the week genuinely has no single arc (rare — usually a signal the week was low-shipping), draft 3–5 scattergun tweets from the strongest individual signals and note the shortfall in the traceability comment. Do not pad with weak signals.

### 3. Draft the arc

Sketch the arc as a bullet list first — one tweet per bullet, in order, telling the story. Refine before writing final copy.

For each tweet:

1. Apply `codebases/sindustries/agents/skills/content/sindustries-copy/SKILL.md` for voice (short-form register, factual, no puffery).
2. Run it through `codebases/sindustries/agents/skills/content/no-ai-slop/SKILL.md` before queueing.
3. Max 280 chars. Count characters precisely — X truncates without warning.
4. No hashtags unless the signal warrants one (rare — Tom's audience doesn't need them).
5. One idea per tweet. If a tweet needs a second sentence, make it a follow-up bullet in the arc instead.
6. Concrete over abstract: "shipped a 10-day calendar view in Mission Control" beats "improved our operating surface."

### 4. Schedule the sequence

- **First tweet:** tomorrow (today + 1) at `10:00 Pacific/Auckland`.
- **Subsequent tweets:** one per consecutive day, same time.
- **Timezone:** always compute the ISO in `Pacific/Auckland` with the correct NZST/NZDT offset. Reference `apps/mission-control/src/tabs/contentSchedulerCalendar.js` — the `zonedDateTimeToIso` helper handles the DST edge. Do not hardcode `+12:00` or `+13:00`.
- **Sequence length:** aim for 5–7. Prefer 5 tight tweets to 7 padded ones.

### 5. Queue each item into the Content Scheduler

For each drafted tweet, POST to the scheduler:

```bash
curl -sS -X POST http://localhost:4001/api/v1/content-scheduler/items \
  -H 'content-type: application/json' \
  -H 'x-actor: Ivy' \
  -d '{
    "body": "<tweet text>",
    "source": "ops_notes",
    "sourceRef": "brain/content/sindustries-weekly-content/YYYY-MM-DD.md",
    "scheduledFor": "<ISO datetime in Pacific/Auckland>",
    "status": "queued"
  }'
```

Capture each returned item's `id` — you need them for the traceability comment.

**Never set `status=published` from this skill.** Only `queued`. The auto-post job publishes after Tom approves in Mission Control.

### 6. Post the traceability comment

Post exactly one task comment in this format:

```
[ivy-tweets-queued] theme: <one-line theme summary>
- <id1> — <one-line what this tweet says>
- <id2> — <one-line what this tweet says>
...
```

Include the theme line so the reviewer (Tom / Quinn) can see the arc at a glance without opening Mission Control.

If you fell back to scattergun (step 2), state that explicitly:

```
[ivy-tweets-queued] theme: none — no clear arc this week, scattergun of N strongest signals
- <id1> — ...
```

### 7. Let Tom take it from here

- Tom sees the queued items in Mission Control's Content Scheduler tab.
- He edits any that need work, approves the rest.
- Auto-post fires at each `scheduledFor`.
- The `pr_transition` lobster gate for weekly-content tasks is satisfied by the `[ivy-tweets-queued]` comment, so the task can advance to `acceptance` when the PR side is also complete.

## Guardrails

- **One theme per week.** Do not draft two competing arcs.
- **Never publish directly.** Only queued.
- **Never overwrite.** If a `[ivy-tweets-queued]` comment already exists on this task, do not queue again — post a note escalating to Quinn instead.
- **Never write to `~/.openclaw/`** — same rule as everything else Ivy does.
- **If the review file is missing or the API is down:** stop and escalate via `codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md`. Do not queue placeholder tweets.

## Escalate to Quinn if

- The week's review has no signal worth publishing at all (even scattergun-worthy).
- The Content Scheduler API returns 4xx/5xx on the queue calls.
- Tom's identity (`x-actor`) fails auth against the scheduler.
- The `[ivy-tweets-queued]` comment cannot be posted to the task.
