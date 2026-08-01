# HEARTBEAT - Ivy

<!--
Heartbeat discovers and advances content tasks assigned to Ivy.

Workflow semantics for the content task workflow Lobster are defined in:
- agents/workflows/content-tasks/content-task.lobster.yaml

Ivy must NEVER change task status. The Lobster does that.

Heartbeat is for discovery and authoring, not state management.
-->

---

## Purpose

I am a heartbeat agent. I check the Tasks API on a regular interval for content work assigned to me. I do not wait to be briefed.

---

## Heartbeat Procedure

1. **Discovery must run before any silent result.** Query the Tasks API through the shared classifier for every active task assigned to Ivy:

   ```
   TASKS_API_BASE_URL=http://localhost:4001/api/v1 python3 /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/agents/skills/ops/tasks-api/scripts/agent_task_queue.py --assignee Ivy --json
   ```

   Do not return `NO_REPLY` or `HEARTBEAT_OK` before this query succeeds and its full result is classified. Use `reviewRequests`, `authoredPrFeedback`, and `mergeCandidates` for PR discovery, following `agents/skills/dev/pr-process/SKILL.md` for all review, feedback, and merge actions. The queue is read-only and never submits a review or merges automatically.

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

Alongside my usual PR work, I drive a themed 5–7 tweet arc into the Content Scheduler for the coming week. One theme per week, one tweet per day. Tom approves each in Mission Control; auto-post fires at `scheduledFor`.

This campaign must run while the task is still `doing`, even when the task already has one or more open PRs. Existing PRs suppress duplicate PR authoring only; they do not satisfy or suppress the `[ivy-tweets-queued]` gate.

The scheduler primitive lives in `agents/skills/content/schedule-tweets/SKILL.md` — that skill queues one tweet. This section owns the *campaign* logic: theme, arc, sequencing, traceability.

### Idempotence

If a `[ivy-tweets-queued]` comment already exists on this task, the campaign is done for this pass. Skip. Do not re-queue.

### 1. Read the weekly review file

Find the file linked in the task body (typically the most recent under `brain/content/sindustries-weekly-content/`). Read the whole file — Quinn-execute bucket, Tom-approval bucket, defer bucket, and the raw daily notes if present.

### 2. Pick ONE theme for the week

Themed beats scattergun. A narrative arc pulls the reader forward; 7 disconnected wins do not.

Scan the week's signals and pick the single strongest arc — a story with a beginning, middle, and end that can be told across 5–7 tweets. Good arcs look like:

- **A capability shipped:** "what didn't exist last week → how we built it → what it unlocks → the lesson"
- **A pattern discovery:** "we kept seeing X → we tried Y → Y didn't scale → we landed on Z → now we do it every time"
- **A system going live:** "we've been building X → here's the first end-to-end run → what it proves → what's next"
- **A workflow evolution:** "our old process had Y bottleneck → we tried Z → it worked → here's how it changed the team"

**Bad themes to avoid:**
- "Weekly wrap-up" — that's a format, not a theme
- Meta-commentary on the studio itself — themes should be about the *work*, not how the studio operates
- Anything referencing private client work, private team dynamics, or context Tom hasn't publicly established

**Fallback:** if the week genuinely has no single arc (rare — usually a signal the week was low-shipping), draft 3–5 scattergun tweets from the strongest individual signals and note the shortfall in the traceability comment. Do not pad with weak signals.

### 3. Sketch the arc, then draft each tweet

- Sketch first: one bullet per tweet, in order, telling the story. Iterate the arc before writing final copy.
- For each tweet:
  1. Apply `agents/skills/content/sindustries-copy/SKILL.md` for voice.
  2. Run it through `agents/skills/content/no-ai-slop/SKILL.md`.
  3. Max 280 chars — count precisely; X truncates without warning.
  4. No hashtags unless the signal warrants one (Tom's audience does not need them).
  5. One idea per tweet. If a tweet needs a second sentence, split it into a follow-up bullet in the arc.
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

### 4. Schedule the sequence

- First tweet: **tomorrow** (today + 1) at `10:00 Pacific/Auckland`.
- Subsequent tweets: one per consecutive day, same time.
- Aim for 5–7. Prefer 5 tight tweets to 7 padded ones.

### 5. Queue each tweet

For each drafted tweet, call `agents/skills/content/schedule-tweets/SKILL.md` with:
- `body` = the drafted text
- `scheduledFor` = the day's 10:00 NZ ISO datetime (with correct NZST/NZDT offset)
- `source` = `ops_notes`
- `sourceRef` = the weekly review file path
- `actor` = `Ivy`

Capture each returned item `id` — needed for the traceability comment.

### 6. Post the traceability comment

Post exactly one task comment in this format:

```
[ivy-tweets-queued] theme: <one-line theme summary>
- <id1> — <one-line what this tweet says>
- <id2> — <one-line what this tweet says>
...
```

The theme line lets the reviewer (Tom / Quinn) see the arc at a glance without opening Mission Control.

If you fell back to scattergun (step 2), state that explicitly:

```
[ivy-tweets-queued] theme: none — no clear arc this week, scattergun of N strongest signals
- <id1> — ...
```

### 7. Let the Lobster take it from here

- The `pr_transition` lobster gate detects the comment and no longer blocks `doing → acceptance` on tweets.
- Tom sees the queued items in Mission Control's Content Scheduler tab, edits any that need work, approves the rest.
- Auto-post fires at each `scheduledFor`.

### Guardrails

- One theme per week. Do not draft two competing arcs.
- Never queue with `status=published`. Only `queued`.
- If the review file is missing or the scheduler API is down, stop and escalate via `agents/skills/ops/notify-soft-fail/SKILL.md`.

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
