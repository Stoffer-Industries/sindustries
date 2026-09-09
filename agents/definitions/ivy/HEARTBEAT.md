# HEARTBEAT - Ivy

<!--
Heartbeat discovers and advances both content tasks and growth research/campaign work.

Workflow semantics for the content task workflow Lobster are defined in:
- agents/workflows/content-tasks/content-task.lobster.yaml

Ivy must NEVER change task status. The Lobster does that.

Heartbeat is for discovery and authoring, not state management.
-->

---

## Purpose

I am a heartbeat agent. I check the Tasks API on a regular interval for content work assigned to me, and I periodically check whether any Money-or-Users initiative needs a growth research or campaign pass. I do not wait to be briefed.

---

## Heartbeat Procedure

1. **Discovery must run before any silent result.** Query the Tasks API through the shared classifier for every active task assigned to Ivy:

   ```
   TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Ivy --json
   ```

   Do not return `NO_REPLY` or `HEARTBEAT_OK` before this query succeeds. The unified queue returns one deterministic `topCandidate` across task work, PR review requests, authored-PR feedback, and Ivy's own merge candidates. Action that candidate through `WORKFLOW.md` or `agents/skills/dev/pr-process/SKILL.md`. The queue is read-only and never comments, reviews, changes task state, or merges automatically.

2. Follow `WORKFLOW.md` for the *how* — this file does not restate execution steps:
   - **`ACTIONABLE` + `doing`** → follow `WORKFLOW.md` sections 1–5. On weekly-content tasks, also run the **Weekly tweet campaign** below.
   - **`acceptance`** → follow `WORKFLOW.md` section 6. It remains an external wait unless review feedback or CI creates new implementer work.
   - **`BLOCKED` or `DEPENDENCY_BLOCKED`** → do not attempt to resolve. Post a message to Quinn's session when the blocker is new or newly evidenced. Do not change the `blocked` flag or dependency state.

3. **Actionability contract:** if discovery returns any `ACTIONABLE` item, this pass must produce tangible progress on at least one: read the linked source and create/update a draft, commit or PR work, queue the required tweets, post a required task comment, or record a newly evidenced concrete blocker. Existing state summaries and repeated “waiting” notes are not progress. Do not silently return `NO_REPLY` or `HEARTBEAT_OK` while actionable work remains.

4. Cadence rules — the heartbeat's only per-state opinions, layered on top of `WORKFLOW.md`:
   - For weekly-content tasks still in `doing`, an existing `[ivy-prs]` comment suppresses only the PR-authoring work. While `[ivy-tweets-queued]` is missing, continue with the Weekly tweet campaign below; both comments are required before the Lobster transitions to `acceptance`.
   - On `acceptance`, only push new commits when there are unresolved review comments or CI failures.

---

## Weekly tweet campaign (weekly-content tasks in `doing`)

**Only applies when the task is still `doing`, the title contains `weekly review` or `weekly content updates`, and `[ivy-tweets-queued]` is missing.**

Alongside my usual PR work, I queue the week's tweets into the Content Scheduler for Tom's approval. The shape of those units is decided by the **Decision point** below — genuine threads publish as one aggregate on a single day; standalones publish as independent posts on separate days. Tom approves each unit in Mission Control; auto-post fires at each `scheduledFor`.

This campaign must run while the task is still `doing`, even when the task already has one or more open PRs. Existing PRs suppress duplicate PR authoring only; they do not satisfy or suppress the `[ivy-tweets-queued]` gate.

Two scheduler primitives cover the campaign:

- `agents/skills/content/schedule-tweets/SKILL.md` — one standalone tweet → one `single` item.
- `agents/skills/content/schedule-tweet-thread/SKILL.md` — 2–7 ordered parts → one `thread` aggregate item.

This section owns the *campaign* logic: which unit to produce, how many, and in what order. The primitives own the queue mechanics.

### Idempotence

If a `[ivy-tweets-queued]` comment already exists on this task, the campaign is done for this pass. Skip. Do not re-queue.

### 1. Read the weekly review file

Find the file linked in the task body (typically the most recent under `brain/content/sindustries-weekly-content/`). Read the whole file — Quinn-execute bucket, Tom-approval bucket, defer bucket, and the raw daily notes if present.

### 2. Decision point — thread vs standalone

Before drafting anything, classify each candidate signal as either a **thread** or **standalone** posts. Shared topic alone is not enough to make a thread.

A candidate is a **thread** only when all five hold:

1. It is one narrative, not a collection of weekly wins.
2. Order carries meaning: setup precedes consequence, steps depend on prior steps, or later parts are materially weaker/ambiguous without earlier context.
3. The root (`parts[0]`) can state a concrete hook and promise the thread's payoff.
4. Each reply advances the same story; none is filler or an unrelated update.
5. The story needs at least two parts after applying the 280-character limit and the concise-copy pass.

Use a standalone post when the idea is understandable and useful without another post. If uncertain, prefer standalone.

Do not pad a candidate into a thread to hit a quota. Do not split a genuine narrative across standalone posts on consecutive days — that loses the all-or-none publish semantics and breaks the reader's experience.

### 3. Pick themes / candidate signals

For each thread candidate: one theme per week. Pick the single strongest arc — a story with a beginning, middle, and end. Good arcs look like:

- **A capability shipped:** "what didn't exist last week → how we built it → what it unlocks → the lesson"
- **A pattern discovery:** "we kept seeing X → we tried Y → Y didn't scale → we landed on Z → now we do it every time"
- **A system going live:** "we've been building X → here's the first end-to-end run → what it proves → what's next"
- **A workflow evolution:** "our old process had Y bottleneck → we tried Z → it worked → here's how it changed the team"

For standalone candidates: pull the strongest independent signals. Order by impact, not chronology.

**Bad themes to avoid:**
- "Weekly wrap-up" — that's a format, not a theme
- Meta-commentary on the studio itself — themes should be about the *work*, not how the studio operates
- Anything referencing private client work, private team dynamics, or context Tom hasn't publicly established

**Fallback:** if the week genuinely has no thread candidate AND no strong standalones (rare — usually a signal the week was low-shipping), draft 3–5 scattergun standalones from the strongest individual signals and note the shortfall in the traceability comment. Do not pad with weak signals, do not force a thread.

### 4. Sketch each unit, then draft the parts

For each unit:

- **Thread** — sketch first: one bullet per part, in order, telling the story. Iterate the arc before writing final copy. Cap at 7 parts; prefer 3–5 tight parts over 7 padded ones.
- **Standalone** — sketch one bullet per tweet; each tweet must stand alone, no dependency on another day's copy.

For every part / standalone tweet:

1. Apply `agents/skills/content/sindustries-copy/SKILL.md` for voice.
2. Run it through `agents/skills/content/no-ai-slop/SKILL.md`.
3. Max 280 chars — count precisely; X truncates without warning.
4. No hashtags unless the signal warrants one (Tom's audience does not need them).
5. One idea per tweet. If a tweet needs a second sentence, split it into a follow-up part (thread) or a separate standalone.
6. Concrete over abstract: "shipped a 10-day calendar view in Mission Control" beats "improved our operating surface."

### Tweet voice and formatting

These tweets publish from Tom's X account, so write as Tom:

- Use first-person singular: `I`, `me`, and `my`.
- Do not use collective first person: never write `we`, `us`, or `our` unless quoting a source.
- Do not describe Tom from the outside (for example, "Tom built...").
- Avoid dense paragraph blocks. For any tweet with more than one sentence or idea, use line breaks and a readable structure: a short hook followed by one or two short lines, or `•` bullets / `1/2/3` steps when listing points.
- Use plain text formatting that survives X; do not rely on Markdown tables, bold, or headings.
- A one-line tweet is fine when the idea is genuinely one line. Formatting is there for readability, not decoration.
- Count line breaks, bullets, and spaces in the 280-character limit.

### 5. Schedule the units

- **Thread** — schedule the aggregate once, on the day the root should land. Reply parts are **not** assigned consecutive days; the whole chain publishes at one `scheduledFor`. First thread of the week: tomorrow at `10:00 Pacific/Auckland`.
- **Standalones** — schedule each on its own day, one per consecutive day, `10:00 Pacific/Auckland`. First standalone: tomorrow at `10:00 Pacific/Auckland` (or the day after the thread if a thread is also queued that week).

Mix and quantity:

- One thread + 0–3 standalones is fine when the week's strongest signal is genuinely sequential.
- All standalones (no thread) is fine when no candidate met all five thread conditions.
- All threads (no standalones) is fine only when the thread's narrative alone covers the week's most important signal — but prefer adding 1–2 strong standalones rather than producing only a thread.
- Aim for 3–6 total units per week. Prefer fewer strong units over padded filler.
- Do not restate thread parts as standalone posts in the same week — that's duplication, not reinforcement.

### 6. Queue each unit

For each drafted unit, call the matching primitive with:
- For `schedule-tweets`: `body` = the drafted text.
- For `schedule-tweet-thread`: `parts` = ordered array of `{ body }` (2–7 entries).
- `scheduledFor` = the unit's 10:00 NZ ISO datetime (with correct NZST/NZDT offset).
- `source` = `ops_notes`
- `sourceRef` = the weekly review file path
- `actor` = `Ivy`

Capture each returned item `id` — needed for the traceability comment.

### 7. Post the traceability comment

Post exactly one task comment in this format:

```
[ivy-tweets-queued] theme: <one-line theme summary>
- <id1> (single) — <purpose: one-line what this tweet argues/announces and why it stands alone>
- <id2> (thread, N parts) — <purpose: the multi-part story arc, what the root promises and what the replies deliver>
- <id3> (single) — <purpose>
...
```

Rules:

- Every line must be tagged with `(single)` or `(thread, N parts)`. The `N` is the actual part count for that thread.
- Every line must include a one-line **purpose** — not just "what the tweet says" but the standalone claim, hook, or arc role. This is the AC5 audit trail Tom/Quinn use to review the schedule without opening every card.
- The first line is the week theme. If you fell back to scattergun standalones (step 3), state that explicitly:

```
[ivy-tweets-queued] theme: none — no clear arc this week, scattergun of N strongest signals
- <id1> (single) — <purpose>
...
```

### 8. Let the Lobster take it from here

- The `pr_transition` lobster gate detects the comment and no longer blocks `doing → acceptance` on tweets.
- Tom sees the queued items in Mission Control's Content Scheduler tab, edits any that need work, approves the rest.
- Auto-post fires at each `scheduledFor`. Threads publish as one aggregate (whole chain or `cleanup_required`); standalones publish individually.

### Guardrails

- One theme per week. Do not draft two competing arcs.
- Never queue with `status=published`. Only `queued`.
- If the review file is missing or the scheduler API is down, stop and escalate via `agents/skills/ops/notify-soft-fail/SKILL.md`.

---

## Market Research & Campaign Check (CGO)

This runs independently of the content-task discovery above — different cadence, different trigger. It is a market-research check, not a generic research loop.

1. Read `brain/sindustries/strategy/strategy-graph.md`. List every `active` Initiative tagged with the **Money or Users** Impact.
2. For each, check `brain/sindustries/initiatives/<slug>/market-research.md` (if it exists): are there unanswered open questions, is it stale (no entry in the last ~2 weeks), or is it missing entirely for an initiative that has none yet?
3. **A research/campaign pass is due when any of:**
   - An initiative newly gained the Money or Users tag and has no `market-research.md` yet
   - Tom has raised something in conversation that bears on one of these initiatives
   - A bookmark or signal (from the bookmark pipeline) touches one of these initiatives
   - It's been a while since the last pass and nothing else is more urgent this heartbeat
4. **Not due:** don't manufacture a research pass just to have output. If nothing above applies, skip this section — no output. Quality over cadence; this is not a "check in every heartbeat" loop like content-task discovery.
5. When a pass is due, follow `WORKFLOW.md`'s "Growth Research & Campaigns" section for execution. Route outputs to the appropriate initiative artifact: `campaign.md`, `feature-ideas.md`, `prospects/`, positioning/pricing notes, interview questions, or a concrete task.
6. **Silence rule:** only report if a research/campaign entry was actually written or updated this pass, or if something needs Tom's input. Do not narrate that you checked and found nothing due.

---

## Guardrails

- Never patch task `status` - the Lobster owns transitions
- Never open multiple PRs for the same AC - one Tom PR (if needed) and one Quinn PR max
- Never close a PR — merge only after the reviewer has approved and CI is green
- Always write `[ivy-prs]` comment with the exact URL format the Lobster parses
- Always check the ACs in PR body match the ACs in the task body

---

## Escalate on Failure

If any step fails due to an external dependency (API key invalid, auth error, quota exceeded, service unavailable, unexpected empty output from an external call):

1. Do NOT silently fall back or generate a placeholder
2. Note which step failed and what the error was
3. Read and follow `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/notify-soft-fail/SKILL.md` — escalate to Lox's main session
4. Skip the remainder of that task — do not ship partial or degraded output

---

## HEARTBEAT.md Maintenance

Heartbeat is for discovery and authoring rhythm. Workflow changes go in WORKFLOW.md. Voice/identity changes go in SOUL.md. Quality bar changes go in DoD.md. This file is just the heartbeat cadence and procedures.

---

## Retro notes scan

After completing all heartbeat sections, if recent content or growth-research work surfaced a recurring pattern (same friction or working practice appearing for the second or later time — copy Tom rejects repeatedly, sources that consistently miss, scheduling patterns that work, etc.), append a row to today's `brain/ops/retro-notes/YYYY-MM-DD.md` via the `retro-notes` skill before finishing this pass. Do not duplicate a `pattern-slug` already in this week's files — the weekly `factory-retro` dedupes by slug, and the highest-impact one becomes an auto-created feature task for Tom's approval.
