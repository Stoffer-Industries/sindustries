---
name: schedule-tweets
description: Queue a single tweet into the Content Scheduler with a scheduled post time. Use whenever an agent needs to add one tweet to the scheduler for future publication.
---

# schedule-tweets

A low-level primitive: given a tweet body and a `scheduledFor` datetime, POST it to the Content Scheduler and return the item id.

Any agent can use this. No campaign logic, no theme picking, no arc drafting — that lives in the caller (e.g. Ivy's HEARTBEAT.md for the weekly cadence). This skill just queues one tweet.

## When to use

- Any time an agent has a fully drafted tweet ready to be added to the scheduler for future publication.
- Every tweet queued this way lands with `status=queued`. Tom approves in Mission Control; auto-post fires at `scheduledFor`.

**Do not use** for:
- Publishing immediately (that's `/items/:id/publish`, only after approval).
- Editing an existing item (that's `PATCH /items/:id`).
- Bulk import from CSV or files (build a caller that iterates and calls this skill per row).

## Inputs

- **`body`** (string, max 280 chars) — the tweet text, already voiced and slop-checked by the caller.
- **`scheduledFor`** (ISO 8601 datetime) — when the tweet should publish. Must be a valid ISO string with the correct `Pacific/Auckland` offset (see timezone note below).
- **`source`** (enum, optional, default `manual`) — one of `ops_notes`, `cto_craft`, `manual`, `other`. Use `ops_notes` when the tweet came from a weekly review or an ops signal.
- **`sourceRef`** (string, optional) — a URL or file path pointing back to the source signal (e.g. `brain/content/sindustries-weekly-content/YYYY-MM-DD.md`).
- **`actor`** (string, default = the calling agent's name) — sent as the `x-actor` header for audit attribution.

## Output

The scheduler returns the created `ContentSchedulerItem` JSON, including the server-assigned `id`. The caller should capture the `id` — it is needed for any follow-up (traceability comments, `PATCH`, approve, remove).

## Steps

### 1. Validate inputs

- `body`: non-empty, ≤ 280 chars. Fail fast if the body would truncate on X.
- `scheduledFor`: must be an ISO 8601 datetime with an explicit offset (`+13:00`, `+12:00`, or `Z`). Do not accept naive local times.

### 2. Build the correct `scheduledFor`

Compute the ISO in `Pacific/Auckland` with the correct NZST (+12:00) / NZDT (+13:00) offset for the target date. The reference implementation is `zonedDateTimeToIso` in `apps/mission-control/src/tabs/contentSchedulerCalendar.js`; it handles the DST edge (last Sunday of September).

**Never hardcode `+12:00` or `+13:00`.** Compute it from the target date.

### 3. POST to the scheduler

```bash
curl -sS -X POST http://localhost:4001/api/v1/content-scheduler/items \
  -H 'content-type: application/json' \
  -H "x-actor: ${actor}" \
  -d '{
    "body": "<tweet text>",
    "source": "<source>",
    "sourceRef": "<sourceRef>",
    "scheduledFor": "<ISO datetime with correct NZ offset>",
    "status": "queued"
  }'
```

Endpoint: `http://localhost:4001/api/v1/content-scheduler/items`. Route is documented in `docs/systems/content-scheduler.md`.

### 4. Handle the response

- **`200`/`201`** → parse the returned JSON, capture the `id`, return it to the caller.
- **`4xx`** with a structured `{ error: { code, message } }` body → return the error code to the caller. Common codes:
  - `body_too_long` — 281+ chars.
  - `invalid_scheduled_for` — bad ISO or missing offset.
- **`5xx`** or connection failure → escalate via `agents/skills/ops/notify-soft-fail/SKILL.md`. Do not silently retry.

## Guardrails

- **Only `status: queued`.** Never send `status: published` from this skill. Publishing is a separate gated route.
- **One tweet per call.** No batching. Callers that need multiple tweets call this skill in a loop.
- **Do not post traceability comments here.** That is the caller's responsibility — a traceability comment scope depends on the context (a single-tweet caller may not need one; a weekly-campaign caller posts `[ivy-tweets-queued]`).
- **Do not write to `~/.openclaw/`.**

## Escalate if

- The scheduler API returns 4xx/5xx on the queue call.
- The `x-actor` identity fails auth.
- The reference implementation for the NZ offset (`zonedDateTimeToIso`) is missing or the timezone math cannot be verified.
