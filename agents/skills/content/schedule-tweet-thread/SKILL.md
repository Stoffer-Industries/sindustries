---
name: schedule-tweet-thread
description: Queue a multi-part tweet thread into the Content Scheduler as one aggregate item (root + reply chain). Use only after the Ivy weekly-flow decision step concludes the content is genuinely a sequential thread, not a collection of standalones. Mirrors schedule-tweets but accepts a parts array and POSTs kind=thread.
---

# schedule-tweet-thread

A low-level primitive: given 2–7 ordered parts and a `scheduledFor` datetime, POST one aggregate thread to the Content Scheduler and return the item id.

Any agent can use this. No theme picking, no arc drafting, no decision logic — that lives in the caller (e.g. Ivy's `HEARTBEAT.md` weekly-campaign section). This skill just queues one thread as one item.

## When to use

- After the caller has decided that a story is genuinely a sequential thread (see Ivy's HEARTBEAT.md "Weekly tweet campaign" → "Decision point" — five conditions, all must hold). Standalone days keep independent posts via `schedule-tweets`, not threads.
- The thread is already drafted as an ordered list of 2–7 parts, each voiced and slop-checked by the caller.
- Every thread queued this way lands with `status=queued`, `kind=thread`, and parts persisted as one aggregate. Tom approves it as one unit in Mission Control; auto-post fires at `scheduledFor` and publishes the whole chain (root + replies) atomically with explicit `cleanup_required` recovery if compensation fails.

**Do not use** for:
- Publishing immediately (that's `POST /items/:id/publish`, only after approval).
- Editing an existing thread (that's `PATCH /items/:id` with a full parts replacement).
- Single tweets — use `schedule-tweets` instead. Forcing a one-part "thread" duplicates Tom's review surface and breaks the weekly-flow audit trail.
- A story where order does not carry meaning. If parts are independent, queue them as standalones on separate days.

## Inputs

- **`parts`** (array, length 2–7) — ordered reply parts. Each entry:
  - **`body`** (string, max 280 chars) — the part text, already voiced and slop-checked by the caller. Position `0` is the root tweet; positions `1..n` are replies chained on X to the immediately preceding published tweet.
- **`scheduledFor`** (ISO 8601 datetime) — when the thread publishes as a whole. Must be a valid ISO string with the correct `Pacific/Auckland` offset (see timezone note below).
- **`source`** (enum, optional, default `manual`) — one of `ops_notes`, `cto_craft`, `manual`, `other`. Use `ops_notes` when the thread came from a weekly review or an ops signal.
- **`sourceRef`** (string, optional) — a URL or file path pointing back to the source signal (e.g. `brain/content/sindustries-weekly-content/YYYY-MM-DD.md`).
- **`actor`** (string, default = the calling agent's name) — sent as the `x-actor` header for audit attribution. It must match the actor bound to the caller's Tasks API credential.

## Authentication

`TASKS_API_APPROVAL_TOKEN` is mandatory and must be the calling agent's own workspace-scoped credential. Never borrow another agent's token. The Tasks API derives the authoritative actor from the bearer credential; `x-actor` remains an audit signal and must match it.

Fail before making a request when the token is missing:

```bash
: "${TASKS_API_APPROVAL_TOKEN:?calling agent Tasks API credential is required}"
```

## Output

The scheduler returns the created `ContentSchedulerItem` JSON, including the server-assigned `id` and the normalized `parts` array. The caller should capture the `id` — it is needed for any follow-up (traceability comments, `PATCH`, approve, remove).

A thread counts as **one** scheduled unit (one calendar row, one daily-cap slot). The reply parts are not independently schedulable.

## Steps

### 1. Validate inputs

- `parts.length` ∈ [2, 7]. Fail fast outside that range — the API will reject it anyway, but caller-side validation keeps the traceability comment accurate.
- Each `parts[i].body`: non-empty, ≤ 280 chars. Fail fast if any part would truncate on X.
- The root (`parts[0]`) must state a concrete hook and promise the thread's payoff. The hook check is a caller discipline (see Ivy's HEARTBEAT.md "Decision point" → condition 3), not enforced here.
- `scheduledFor`: must be an ISO 8601 datetime with an explicit offset (`+13:00`, `+12:00`, or `Z`). Do not accept naive local times.
- One thread per call. Do not split a story across multiple aggregate threads — that loses the all-or-none publish semantics.

### 2. Build the correct `scheduledFor`

Compute the ISO in `Pacific/Auckland` with the correct NZST (+12:00) / NZDT (+13:00) offset for the target date. The reference implementation is `zonedDateTimeToIso` in `apps/mission-control/src/tabs/contentSchedulerCalendar.js`; it handles the DST edge (last Sunday of September).

**Never hardcode `+12:00` or `+13:00`.** Compute it from the target date.

A thread occupies one `scheduledFor`. Its reply parts are **not** assigned consecutive days. Schedule it once, on the day the root should land.

### 3. POST to the scheduler

```bash
: "${TASKS_API_APPROVAL_TOKEN:?calling agent Tasks API credential is required}"

curl -sS -X POST http://localhost:4001/api/v1/content-scheduler/items \
  -H "Authorization: Bearer ${TASKS_API_APPROVAL_TOKEN}" \
  -H 'content-type: application/json' \
  -H "x-actor: ${actor}" \
  -d '{
    "kind": "thread",
    "parts": [
      { "body": "<root tweet text>" },
      { "body": "<reply 1 text>" },
      { "body": "<reply 2 text>" }
    ],
    "source": "<source>",
    "sourceRef": "<sourceRef>",
    "scheduledFor": "<ISO datetime with correct NZ offset>",
    "status": "queued"
  }'
```

Endpoint: `http://localhost:4001/api/v1/content-scheduler/items`. Route is documented in `docs/systems/content-scheduler.md`.

The backend persists `parts[0].body` on the parent `body` field and `parts[1..n]` as `ContentSchedulerThreadPart` rows in one transaction. Sending a `body` together with `parts` is rejected with `body_and_parts_conflict` — keep the root text single-sourced through `parts[0]`.

### 4. Handle the response

- **`200`/`201`** → parse the returned JSON, capture the `id` and `parts`, return them to the caller.
- **`4xx`** with a structured `{ error: { code, message } }` body → return the error code to the caller. Common codes:
  - `AUTH_REQUIRED` — missing, stale, or invalid agent bearer credential.
  - `parts_too_few` / `parts_too_many` — outside [2, 7].
  - `part_too_long` — any part over 280 chars.
  - `part_empty` — a part body was empty after trim.
  - `body_and_parts_conflict` — both `body` and `parts` were sent.
  - `invalid_scheduled_for` — bad ISO or missing offset.
- **`5xx`** or connection failure → escalate via `agents/skills/ops/notify-soft-fail/SKILL.md`. Do not silently retry.

## Guardrails

- **Only `status: queued`.** Never send `status: published` from this skill. Publishing is a separate gated route.
- **One thread per call.** No batching. Callers that need multiple units call this skill in a loop, interspersing with `schedule-tweets` for standalones.
- **Use the calling agent's credential.** Never use Quinn's token as a fallback for another agent.
- **Do not post traceability comments here.** That is the caller's responsibility — a single-thread caller may not need one; a weekly-campaign caller posts `[ivy-tweets-queued]` and tags each entry as `thread (N parts)` or `single`.
- **Do not write to `~/.openclaw/`.**
- **Do not split a story across multiple threads.** If a story needs more than 7 parts, it is too long for X — sharpen the copy, do not chain two threads.
- **Do not schedule parts on consecutive days.** A thread publishes as one unit on its `scheduledFor`. Reply parts are not standalones.

## Escalate if

- The scheduler API returns 4xx/5xx on the queue call.
- The `x-actor` identity fails auth.
- The reference implementation for the NZ offset (`zonedDateTimeToIso`) is missing or the timezone math cannot be verified.
- A caller bypassed the Ivy weekly-flow decision step and is queueing a thread without confirming all five conditions hold.
