---
status: draft
task_id: afe1056c-1d7f-4600-9791-95acabfb2781
product_spec: n/a (audit-driven fix; W34 finding T1.1)
shipped_pr: null
shipped_date: null
---

# Tech Design — Reconcile CTO-Craft import-route auth collision (W34 T1.1)

## 1. Product intent

Audit finding from `docs/repo-audits/2026-W34.md` (finding T1.1,
Security & correctness, High):

> The newly-added general mutation gate is mounted on the whole
> `/api/v1/content-scheduler` prefix and now intercepts
> `POST .../imports/cto-craft` before the route's own `x-content-ingest-secret`
> check — but the CTO Craft workflow client (and its cron) send only the
> ingest secret and no session/Bearer, so the entire CTO-Craft → Content
> Scheduler import path returns `401 AUTH_REQUIRED` in production.

**Important reframing.** The audit was written against the pre-extraction
code shape where `/api/v1/content-scheduler` lived on `services/tasks-api`
and `requireAuthenticatedUser` was mounted on the whole prefix
(`services/tasks-api/src/app.ts:130` at the time). After commit
`2609cdf6` (extracted Content Scheduler backend from tasks-api) and the
follow-up commit `fdfb5a0b` (scoped the auth middleware to write methods
on the user-facing prefixes only), the route mount order became:

```ts
// services/content-scheduler-api/src/app.ts:108-145 (current main)
app.use('/api/v1', contentSchedulerServiceRouter);   // includes /imports/cto-craft

// Auth gate is path-scoped to /items* and /reorder, method-scoped to WRITE
app.use(
  '/api/v1/content-scheduler/items',
  methodGate(WRITE_METHODS, requireAuthenticatedUser)
);
app.use(
  '/api/v1/content-scheduler/reorder',
  methodGate(WRITE_METHODS, requireAuthenticatedUser)
);
```

Express's `app.use('/api/v1/content-scheduler/items', mw)` does **not**
match a request to `/api/v1/content-scheduler/imports/cto-craft` (the URL
segment `items` ≠ `imports`), so the auth gate never reaches the import
route. The route-local `checkContentIngestSecret` helper on the
`imports/cto-craft` handler is the sole authentication for that endpoint
— exactly the trust boundary W34 wanted and the current code already
delivers.

What remains unaddressed is the second half of the audit complaint: the
test suite uses `authedRequest(app)` which injects a Bearer credential
the real client never sends. So the boundary works in production but the
test suite cannot prove it. **That gap is what this task closes.**

Goal: reproduce the production caller's header set in tests, and prove
that `POST /content-scheduler/imports/cto-craft` succeeds end-to-end with
only `x-content-ingest-secret: <correct>` and no Bearer / cookie. Also
restore an `AC2` rejection path test (wrong / absent secret → 401) and
confirm the auth gate still gates the rest of `/content-scheduler/items*`
mutations. Acceptance criteria below carry these smaller, more accurate
shapes than the original W34 wording.

## 2. Repo / branch / worktree

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-afe1056c-cto-craft-import-auth` (off `origin/main`,
  HEAD `6bdd6848` at design time)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/afe1056c-cto-craft-import-auth`
- **Task:** `afe1056c-1d7f-4600-9791-95acabfb2781` (code task, assignee Rowan)
- **Audit source:** `docs/repo-audits/2026-W34.md` (finding T1.1)

## 3. Service boundary and data ownership

**Owner:** `services/content-scheduler-api`. The import route already
lives in `services/content-scheduler-api/src/routes/contentSchedulerService.ts`
and is mounted on `contentSchedulerServiceRouter`, the sibling router
sibling of the user-facing `contentSchedulerRouter`. Service-to-service
auth (ingest secret) stays on the service router; user-facing auth
(session / Bearer) stays on the user router. No change of ownership.

**Why no service extraction:** the audit's "auth-prefix collision" is
already structurally resolved at the mount-point layer. The remaining
work is test coverage + a verification step that closes the W34 audit gap
without changing service topology.

**Why no shared auth package move:** extracting a
`packages/service-auth-middleware` is already an open call from
`docs/specs/content-scheduler-auth-tech-design.md` (follow-up note); this
task does not depend on that and is not the place to start it.

## 4. `.openclaw` boundary notes

None. The change is fully self-contained inside
`services/content-scheduler-api/` (test additions + a tiny route-mount
comment refresh). No agent config, scheduler, or workflow change. The
existing CTO Craft cron prompt
(`agents/crons/prompts/cto-craft-tweet-drafts.md`) already provisions
`CONTENT_SCHEDULER_INGEST_SECRET` correctly against the production API
base URL; no cron-side change required.

## 5. Implementation plan

### 5.1 New test cases

Add three tests to
`services/content-scheduler-api/test/contentSchedulerImport.test.ts`,
gated on `CONTENT_SCHEDULER_INGEST_SECRET` being configured (the
`afterEach` already deletes the env var; reuse the same hook):

#### `it('imports 1 item with only x-content-ingest-secret and no Bearer')`

Mirror the existing `'imports 3 new items with source=cto_craft,
status=draft'` happy-path test, but call with `request(app)` (not
`authedRequest(app)`), set `x-content-ingest-secret: 'test-secret'`,
and set `process.env.CONTENT_SCHEDULER_INGEST_SECRET = 'test-secret'`
before `createApp()`. Assert `201` and the same body shape as the
existing happy-path test. **This is the literal reproduction of the real
client's header set** — `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py:104-111`
sends only `Content-Type: application/json` and `x-content-ingest-secret:
<secret>`, so passing without a Bearer proves the auth boundary works
end-to-end.

#### `it('returns 401 when x-content-ingest-secret is missing')`

Set `process.env.CONTENT_SCHEDULER_INGEST_SECRET = 'test-secret'`,
call with plain `request(app)` (no Bearer, no `x-content-ingest-secret`).
Assert `401` with error envelope `{ error: { code: 'UNAUTHORIZED',
message: 'Missing x-content-ingest-secret header …' } }` matching the
existing rejection body shape from `checkContentIngestSecret`.

#### `it('returns 401 when x-content-ingest-secret is wrong')`

Same shape, with `x-content-ingest-secret: 'wrong-secret'` and
`process.env.CONTENT_SCHEDULER_INGEST_SECRET = 'test-secret'`. Assert
`401` and the `'Invalid x-content-ingest-secret header'` message
variant. **Important:** the existing
`checkContentIngestSecret` uses `timingSafeEqual` and rejects on
length mismatch with `'MISMATCH'`, so the test exercises both timing-safe
and length-mismatch paths via the `error: { code: 'UNAUTHORIZED' }`
shape.

### 5.2 No code changes (the route mount order is already correct)

The diff for this task is **tests only**. Reaffirming:

- `services/content-scheduler-api/src/app.ts` mount order (lines
  108-145) already puts `contentSchedulerServiceRouter` ahead of the
  auth gate.
- `services/content-scheduler-api/src/routes/contentSchedulerService.ts`
  `POST /content-scheduler/imports/cto-craft` handler already calls
  `checkContentIngestSecret` first (lines ~225-310) and returns 401 on
  missing / wrong secret before any business logic.
- The CTO Craft client
  (`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py`)
  already sends only the ingest header; no client change needed.

### 5.3 Comment refresh on the route-mount

Add a one-line code comment in `src/app.ts` next to the
`contentSchedulerServiceRouter` mount, explicitly citing this tech
design as the canonical answer to "why is imports/cto-craft not gated by
requireAuthenticatedUser." Without that comment, future contributors
re-introducing the prefix-scoped auth gate (exactly the
`app.use('/api/v1/content-scheduler', requireAuthenticatedUser)` shape
W34 flagged) will repeat the audit's complaint in a new guise. Existing
comment at lines 109-114 already says "service-to-service routes … must
be mounted BEFORE the auth middleware"; the new line is the linkage
back to this design.

### 5.4 Workspace validation (AC6)

After CI is green, run the CTO Craft cron in `--dry-run` against the
staging tasks-api (no `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS`
provisioned locally is fine; the test endpoint is the local content-
scheduler-api dev server with `CONTENT_SCHEDULER_INGEST_SECRET`
matching the cron-prompt value). Confirm the import step logs
`createdCount: 1` (or N for the dry-run fixture set) and that the
client classifies the response as success, not `AUTH_REJECTED`.

Per AC6 wording this is "WS validation." Concretely:

```bash
cd agents/workflows/cto-craft-tweet-drafts
CTO_CRAFT_LANGGRAPH_DATABASE_URL=… CONTENT_SCHEDULER_BASE_URL=http://localhost:5175 \
  CONTENT_SCHEDULER_INGEST_SECRET=<staging-shared-secret> \
  uv run --frozen python run.py run --dry-run --json
```

Expect: outcome=`"succeeded"` (not `"failed"`), an
`outcome_text` line confirming the import was attempted and the
items were persisted, and no `ImportError.code == 'AUTH_REJECTED'`
in the run log. If staging is not currently spun up locally, fall
back to a manual API call:

```bash
curl -fsS -X POST http://localhost:5175/api/v1/content-scheduler/imports/cto-craft \
  -H 'Content-Type: application/json' \
  -H 'x-content-ingest-secret: <staging-shared-secret>' \
  -d '{"items": [{"body": "WS validation probe", "sourceRef": "https://example.com/ws-probe"}]}'
```

Expect: `201 Created` with `data.createdCount === 1`. **No `-H
'Authorization: …'`**, by construction.

### 5.5 Files touched (summary)

- `services/content-scheduler-api/test/contentSchedulerImport.test.ts` —
  **+~60 LoC** (three test cases + fixtures identical to the existing
  helpers)
- `services/content-scheduler-api/src/app.ts` — **+1 line** comment,
  no behaviour change
- No client change (`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py`
  already matches production header shape)
- No `services/content-scheduler-api/src/routes/contentSchedulerService.ts`
  change (handler already enforces the secret before any DB work)
- No cron-prompt change (`agents/crons/prompts/cto-craft-tweet-drafts.md`
  already provisions `CONTENT_SCHEDULER_INGEST_SECRET`)

## 6. Operational notes

- **Failure mode if regressed:** if a future contributor removes the
  service-router-first mount ordering or replaces the
  `methodGate(WRITE_METHODS, requireAuthenticatedUser)` call with a
  bare `app.use('/api/v1/content-scheduler', requireAuthenticatedUser)`,
  the auth gate will start intercepting `/imports/cto-craft` and the
  CTO Craft cron will 401 in production. The AC3 ingest-only test
  catches this regression at the suite boundary; the new mount-order
  comment in §5.3 documents the why so a `git blame` on that line points
  back at this design.

- **No new dependencies.** No new env var. No new auth surface.

- **No stage / feature flag.** This is the durable boundary; no
  rollout coordination required.

## 7. AC-by-AC verification matrix

| AC  | Behaviour expected                                                                                          | Test layer       | Test file / location                                              |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| AC1 | `POST /content-scheduler/imports/cto-craft` succeeds with only `x-content-ingest-secret` and no Bearer / cookie (matches the real client's header set) | vitest (integration) | `test/contentSchedulerImport.test.ts` — `imports 1 item with only x-content-ingest-secret and no Bearer` |
| AC2 | `POST /content-scheduler/imports/cto-craft` returns 401 with code `UNAUTHORIZED` when `x-content-ingest-secret` is wrong or absent          | vitest (integration) | `test/contentSchedulerImport.test.ts` — `returns 401 when x-content-ingest-secret is missing`, `returns 401 when x-content-ingest-secret is wrong` |
| AC3 | New test case in `services/content-scheduler-api/test/contentSchedulerImport.test.ts` posts with **only** the ingest header (no Bearer, no cookie) and asserts success — reproduces the real client's header set so the collision is visible in CI | vitest | Same as AC1 (the `request(app)` path is the AC3 reproduction; the existing `authedRequest(app)` path stays where it is to keep coverage of the gated variants untouched) |
| AC4 | `requireAuthenticatedUser` is still the gate for the rest of `/api/v1/content-scheduler` mutations; the import path is the documented exception          | static + smoke  | The existing `test/contentScheduler.test.ts` suite (24+ cases) covers all gated mutation routes; the §5.3 comment refresh makes the intent explicit. The new AC1 test doubles as the "import path remains exempt" proof in CI. |
| AC5 | No regression on existing authenticated-path tests for the other write routes                                            | CI               | `.github/workflows/ci.yml` — `content-scheduler-api-tests` job: existing 30+ tests must stay green on the PR branch |
| AC6 | WS validation: a local CTO Craft cron run against the staging tasks-api with the production header set succeeds end-to-end | manual | Per §5.4 step |

**E2E coverage:** not possible as a Playwright/Cypress flow. The
unauthenticated-public ingest header is a programmatic HTTP API (no
user-visible UI flow); existing integration tests via `supertest`
already exercise the Express app in the same shape the production server
uses. Vitest + supertest is the proportional fallback. The WS
validation (§5.4) is the manual E2E-equivalent step at the production
API base URL.

## 8. Open questions and risks

1. **Does the CTO-Craft cron currently run against the production API
   base URL (`https://api.sindustries.dev`)?** If yes, AC6 is a
   production-incident pre-fix (every past run since the gate was
   scoped has been 401-ing); if it's still dormant, AC6 is a
   pre-launch check. The W34 audit did not answer this. **Needs Tom
   / Quinn** before the implementation PR. If the cron is dormant, AC6
   becomes a manual API call against staging; if it's live, AC6
   becomes a per-run log inspection against
   `api.sindustries.dev`. This is **OQ1 from the W34 audit, still
   open.**

2. **Should the existing `authedRequest(app)`-using import tests be
   rewritten to use plain `request(app)`?** No — they validate the
   route-local ingest-secret logic regardless of auth state and are a
   useful reference for future readers. **The fix is additive (the
   three new tests), not a rewrite.** If the existing test count ends
   up too high to maintain, the cleanest follow-up is to delete the
   duplicated happy-path-via-Bearer test and rely on the AC1 test to
   cover both header shapes — but that's out of scope for the W34
   T1.1 close-out.

3. **`CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS` provisioned
   locally.** Phase-1 local dev uses the same env var pattern as
   `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`; the AC1 test sets the
   ingest secret but does **not** provision a service credential, so
   no inadvertent cross-test interference with the gated mutations
   suite. CI fixture setup is unchanged.

4. **`checkContentIngestSecret` length-mismatch behaviour.** The
   helper uses `Buffer.length` comparison and returns `MISMATCH` when
   the provided buffer differs in length from the expected one
   (`contentSchedulerService.ts`). The AC2 wrong-secret test will
   only exercise the timing-safe equal path if the test lengths match.
   Pick a same-length wrong secret (`'wrong-secret-1234567'` vs
   `'test-secret-1234567890'`) so the timing-safe path is hit, not the
   length-mismatch fast path. **Implementation note, not a design
   decision.**

## 9. Definition of Done

- Tech design merged via the implementation PR (this doc moves to
  `status: shipped` with `shipped_pr` and `shipped_date` in the same PR).
- All 6 ACs covered — 3 new vitest cases for AC1/AC2, the existing
  content-scheduler test suite green for AC4/AC5, and the manual AC6
  WS validation recorded in the PR conversation.
- Existing ~30-test vitest suite green; CI `content-scheduler-api-tests`
  job green on the PR branch.
- No new runtime dependencies.
- No new env vars.
- No changes to the client
  (`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py`)
  or cron-prompt
  (`agents/crons/prompts/cto-craft-tweet-drafts.md`).
- `docs/systems/content-scheduler-api.md`: if it exists at ship time,
  cross-link the auth-boundary diagram; otherwise leave the systems
  doc tree alone (no new file).
- `apps/<ui-tasks-app>/SPEC.md`: no update — no user-visible behaviour
  changed; the import endpoint is a programmatic API.
