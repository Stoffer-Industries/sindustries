---
status: draft
task_id: d1bfb40b-7e58-4568-a172-298417e167b0
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Content Scheduler preflight health gate

## Product intent

The task records two successive weekly campaign failures: one run "false-greened against the wrong default port" and the next reached the queue step before discovering a connection-refused scheduler, blocking all five planned tweets. The requested outcome is to "verify the scheduler endpoint is reachable and on the expected port before queuing any posts" so an unavailable or misrouted scheduler fails before campaign work begins.

Quinn's existing approval bounds the outcome as **preflight + page Tom, with no automatic restart**. The gate must:

1. probe the configured Content Scheduler origin before campaign drafting or queueing;
2. reject a healthy response from the wrong service, not merely accept any HTTP 200;
3. stop before any queue mutation and route one actionable failure through the existing Lox-to-Tom soft-failure path; and
4. observe only: never restart, deploy, reconfigure, or repair the service.

There is no linked `brain/tasks/specs/...` product spec. The current Tasks API record also lacks the acceptance-criteria checkboxes and workstreams referred to by the historical approval note. The four criteria above are the recoverable contract from the task text and Quinn's approval note; the exact original AC wording must be restored or confirmed before implementation acceptance.

## Task and repository metadata

- **Task:** `d1bfb40b-7e58-4568-a172-298417e167b0`
- **Title:** Add Content Scheduler Preflight Health Gate Before Publish
- **Branch:** `task-d1bfb40b-content-scheduler-preflight`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-d1bfb40b-preflight-health`
- **Code repository:** `Stoffer-Industries/sindustries`
- **Operational configuration:** OpenClaw workspace/operator environment outside this repository
- **Product spec:** `n/a`

## Service boundary and data ownership

`services/content-scheduler-api` owns scheduled-content state, queue mutations, publication, and the health contract. Its existing unauthenticated endpoints return `status`, `service`, and `version` from `services/content-scheduler-api/src/app.ts` and `services/content-scheduler-api/src/routes/health.ts`. Queue primitives already target its `POST /api/v1/content-scheduler/items` contract documented in `docs/systems/content-scheduler.md`.

The allow/abort decision for an agent campaign belongs to the **workflow/skill/OpenClaw boundary**, not to a new database resource. A repository-owned helper will consume the service health contract and produce a deterministic pass/fail. The service remains the source of truth; the helper stores no health state.

- **Content Scheduler API is appropriate:** it already owns the domain and health signal; no route change is needed.
- **Tasks API is not appropriate:** scheduler availability is not task state, and `docs/ARCHITECTURE.md` forbids scheduler-domain behavior returning there.
- **Mission Control is not appropriate:** UI-local state cannot guard headless Ivy/OpenClaw runs.
- **A new service is not appropriate:** this is stateless orchestration over an existing endpoint.

Direct consumers are `agents/definitions/ivy/HEARTBEAT.md`, `agents/skills/content/schedule-tweets/SKILL.md`, and `agents/skills/content/schedule-tweet-thread/SKILL.md`. Mission Control, the worker, and other services consume no new API.

There is no temporary app-local shim. The helper belongs under `agents/lib/` as shared workflow glue. If the service later exposes richer readiness, its endpoint can evolve behind the same identity/status envelope. No extraction or data migration is expected.

## Ownership boundary check

The natural source of truth is the **workflow/cron/skill/OpenClaw boundary consuming a service-owned health contract**:

- availability and identity come from `services/content-scheduler-api`;
- the expected target comes from operator-owned `CONTENT_SCHEDULER_BASE_URL`;
- the allow/abort decision belongs to Ivy and the queue skills.

This is the durable boundary. Tasks API state, database rows, or Mission Control state would be stale competing sources. The helper probes the exact configured origin and requires `status == "ok"` plus `service == "content-scheduler-api"`. That identity assertion is the expected-port check: a URL accidentally using Tasks API's port may return 200, but its identity will not match. Production can use HTTPS while local/prodlike intentionally use different ports (`4003` and `4004`), so one hard-coded numeric port would recreate drift.

## `.openclaw` boundary notes

- `~/.openclaw/.env` must continue to provide `CONTENT_SCHEDULER_BASE_URL`; implementation does not write it.
- No secret is added. Health is unauthenticated; the request and diagnostics must never include `CONTENT_SCHEDULER_API_APPROVAL_TOKEN`.
- After merge/definition sync, an operator must verify the live origin and run the manual smoke below.
- Failure follows `agents/skills/ops/notify-soft-fail/SKILL.md`: Ivy sends to `agent:lox:main`; Lox investigates and pages Tom through its existing Telegram path.
- No channel, recipient, cron, dashboard, secret, automatic restart, Fly deployment, or environment rewrite is added.

## Implementation plan

### 1. Shared preflight helper

Create `agents/lib/content_scheduler_preflight.py` with testable functions and a CLI:

- require `CONTENT_SCHEDULER_BASE_URL` (allow `--base-url` for tests/manual diagnostics);
- accept only an absolute `http`/`https` origin; reject credentials, query/fragment, and non-root paths;
- derive `<origin>/api/v1/health`, preserving scheme, host, and explicit port;
- perform one unauthenticated GET with a five-second timeout, no retry, and no redirects;
- require HTTP 200 JSON with `status: "ok"` and `service: "content-scheduler-api"`;
- emit only safe endpoint/service/version fields on success and exit zero;
- emit one categorized diagnostic on config, transport, timeout, HTTP, JSON, status, identity, or redirect failure and exit non-zero.

The helper performs no POST, subprocess/service command, environment write, or notification. Notification remains caller-owned for deterministic tests and correct OpenClaw routing.

### 2. Gate Ivy before content work

In `agents/definitions/ivy/HEARTBEAT.md`, keep the existing `[ivy-tweets-queued]` idempotence check first, then add preflight before reading the review, classifying, drafting, or queueing:

1. load the live environment in the established form;
2. run `python3 agents/lib/content_scheduler_preflight.py`;
3. continue unchanged on success;
4. on failure, stop, call neither queue skill, and do not post `[ivy-tweets-queued]`;
5. follow `notify-soft-fail` once with task/campaign, sanitized origin, category, and next action.

### 3. Guard both queue primitives

Update both scheduler skill files to invoke the helper after environment/input validation and immediately before `POST /content-scheduler/items`. A non-zero result forbids POST and follows existing soft-failure escalation. Existing auth, actor, request, response, and no-retry rules remain.

Campaign-level preflight prevents wasted drafting. Primitive-level checks protect non-Ivy callers and narrow the check-to-use window. The extra 3–6 GETs per weekly campaign are preferable to a cached freshness token that could false-green after an outage.

### 4. Automated contracts

Create `agents/lib/test_content_scheduler_preflight.py` with a local HTTP server or injected transport. Cover origin/port preservation, valid health, wrong-service 200, non-200, invalid JSON, unhealthy status, redirect, timeout/refusal, bad/missing URL, no Authorization header, GET-only, one attempt, and no repair subprocess.

Extend `agents/definitions/test_definitions.py` or add a focused file-contract test to prove Ivy orders preflight before review/draft/queue and forbids queueing/traceability on failure. Assert both queue skills require the shared helper before POST.

### 5. Durable documentation

Update `docs/systems/content-scheduler.md` with the health identity contract, helper/consumers, abort and Lox-to-Tom behavior, no-auto-restart boundary, and why identity rather than one universal port prevents false greens. No app `SPEC.md` changes are needed because there is no browser behavior.

## Data model and API contract changes

No database model, migration, backfill, queue job, or durable health state is added.

Existing request:

```http
GET <CONTENT_SCHEDULER_BASE_URL>/api/v1/health
Accept: application/json
```

Expected response:

```json
{
  "status": "ok",
  "service": "content-scheduler-api",
  "version": "<git-sha-or-null>"
}
```

Only `status` and `service` gate. `version` is diagnostic and may be null; extra fields are allowed. Redirects fail because following one can hide origin/port drift.

Helper contract:

```text
python3 agents/lib/content_scheduler_preflight.py [--base-url URL] [--timeout-seconds 5]
```

Exit zero means the exact origin answered healthy with scheduler identity. Non-zero forbids queue writes. Output must not expose credentials. No service API change is planned. The duplicate `/health` and `/api/v1/health` registrations are noted technical debt; this helper standardizes on the latter.

## Workflow, cron, and skill changes

- **Workflow:** Ivy's campaign gains an initial hard gate and abort semantics.
- **Skills:** both queue primitives call the shared helper before mutation.
- **Escalation:** existing `notify-soft-fail`; Lox remains Tom-facing owner.
- **Cron:** no schedule or prompt changes; behavior is reached through Ivy's heartbeat.
- **OpenClaw:** no runtime mutation; definition sync and live smoke are operator steps.

## Test plan

A true E2E that queues content or pages Tom would mutate live scheduler and messaging surfaces, so it is disproportionate. Use deterministic helper integration tests against local HTTP, static workflow-order contracts, and bounded manual prodlike smoke. There is no browser flow, so Playwright is inapplicable.

### Acceptance-criterion verification matrix

The current task omits its original checkbox text. Labels below reconstruct the four ACs from the approval note and task intent; Tom must confirm/restore wording before acceptance.

| AC | Recovered acceptance intent | Layer | Planned evidence |
| --- | --- | --- | --- |
| AC1 | Weekly campaign runs scheduler preflight before review/drafting/queue work. | File contract + integration | Definition test proves ordering; local HTTP test receives exactly `GET /api/v1/health` on configured origin/port. |
| AC2 | Unreachable endpoints and wrong-port false greens fail by validating scheduler identity, not 200 alone. | Unit/integration | Refusal/timeout/non-200 and 200 with `service: "tasks-api"` fail; valid scheduler envelope passes. |
| AC3 | Failed preflight queues no posts and pages Tom via Lox with actionable context. | File contract + manual OpenClaw smoke | Contracts require abort/no traceability plus `notify-soft-fail`; controlled closed-port smoke verifies no item-count change and one Lox inbound. |
| AC4 | Failure never automatically restarts, deploys, reconfigures, or repairs scheduler. | Unit + review | GET-only/single-attempt/no-subprocess test and explicit workflow rule; diff contains no Fly/service/env/retry command. |

Regression: run focused Python helper/workflow tests, existing agent definition tests, and `services/content-scheduler-api/test/health.test.ts`. No route tests change because the API is unchanged.

Manual prodlike smoke:

1. Correct origin passes and names `content-scheduler-api` without credentials.
2. Tasks API/wrong loopback port returns 200 but fails identity.
3. Closed port fails within timeout, mutates no items, and generates one controlled soft-failure notification.
4. Confirm neither failure runs restart/deploy/config actions.

## Open questions and risks

### Open questions

1. **BLOCKING — missing canonical AC text and workstreams.** The live task has no `**Spec:**`, AC checkboxes, or workstreams although the approval note says four ACs existed. Tom/Quinn must restore or confirm the recovered criteria before implementation acceptance.
2. **Needs Tom decision — page semantics.** This design interprets "page Tom" as Ivy → Lox → Tom via Telegram, not direct Ivy messaging. Confirm the intended urgency/channel.
3. **Noted — readiness depth.** Current health proves process reachability/identity, not database, Redis, worker, or X credentials. That covers observed failures; dependency readiness needs a separate task/AC.

### Risks

- **Noted — check-to-use race:** service may fail after a pass. Primitive probes narrow it; POST failure still aborts/escalates.
- **Noted — duplicate health routes:** app serves `/health` and mounts `/api/v1/health`; consolidation is out of scope.
- **Noted — repeated heartbeat alerts:** one notification per pass is allowed; durable dedupe would introduce alert state, so Lox correlates repeats.
- **Noted — redirects:** rejecting them may expose tolerated canonicalization; operators must configure the final origin.
- **Noted — local port variants:** identity validation catches a wrong service without hard-coding one environment's port.

## Out of scope

Automatic restart/deploy; env rewrite or fallback origin; queue retries; dependency readiness; item/thread/auth/publish contract changes; and campaign copy, quantity, schedule, or traceability changes.
