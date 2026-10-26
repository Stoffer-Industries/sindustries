---
status: draft
task_id: a37b31c9-1ddc-4732-b8c8-9968726c9c0c
product_spec: brain/research/akahu-sync-completeness-and-deadlines.md
shipped_pr: null
shipped_date: null
---

# Budget / Akahu — pagination completeness and request deadlines

**Task:** `a37b31c9-1ddc-4732-b8c8-9968726c9c0c` (code) — "Implement complete, bounded Akahu transaction sync (pagination + request deadlines)"
**Audit source:** `docs/repo-audits/2026-W44.md` — F2 (High) "Akahu transaction continuation is discarded", F3 (Medium) "Akahu requests have no application deadline"
**Research (complete, cited below):** `brain/research/akahu-sync-completeness-and-deadlines.md` (research task `db74f2ed`)
**Repository:** `Stoffer-Industries/sindustries`
**Branch:** `task-a37b31c9-akahu-pagination-deadlines`
**Worktree:** `/Volumes/WD1/worktrees/rowan/rowan-a37b31c9-akahu-pagination`
**Author:** Rowan · **Date:** 2026-10-26 · **Status:** draft, awaiting Quinn's `tech_design` approval

---

## 1. Product intent

The Budget app links a user's Akahu accounts and ingests settled and pending transactions so the mobile dashboard can show real spend. Today that ingestion is silently lossy and unbounded:

- **Completeness.** `services/budget-api/src/services/akahuClient.ts:13` declares `cursor?: { next?: string }` in the list-response type, but `akahuGetTransactions` (`:139`–`:170`) sends no `cursor` query parameter and returns only `json.items`. Akahu pages at a fixed 100 rows per page (`cursor.next` is `null` on the final page, and `start`/`end` must repeat on every page). Any window containing more than 100 settled transactions is truncated to the first page with **no error, no log, and no signal to the caller**. The sync route (`services/budget-api/src/routes/akahu.ts:108`) then advances `lastSyncedAt` unconditionally (`:292`), so the omitted rows fall outside every future 7-day overlap window (`INCREMENTAL_OVERLAP_MS`, `:23`) and are never requested again. The research model (`/tmp/rowan-akahu/sync-model.mts`) measured **150 of 250 rows (60%) permanently lost** for a 60-day/250-row user.
- **Boundedness.** None of the five provider `fetch` calls carry an `AbortSignal` (`:63`, `:86`, `:109`, `:152`, `:175`), and the body read is awaited separately from `fetch`. The route issues the three provider calls in one `Promise.all` (`:108`), so one stalled provider call holds the whole user-facing sync request open indefinitely. Research fixtures confirmed stalled-header and stalled-body calls remain `STILL_PENDING` past a 2 s watchdog.

**Goal of this task:** make a sync *complete* only when the requested window's pages were exhausted and persisted; make every provider call *bounded* by an explicit deadline; make the checkpoint advance only on completeness; and provide a bounded, dry-run-first, idempotent backfill for rows already lost. The change is **additive**: it adds rows and never removes settled rows.

**Out of scope (explicitly):** bank-side deletion / absence handling (Akahu removes its copy when a bank removes a transaction; ~0.1% of heavily mutated transactions are re-issued with a new identifier). That is a separate defect class and must not be conflated into this change (research, "Caveat that this fix must not absorb").

---

## 2. Ownership boundary — the natural source of truth

| Decision | Value |
|---|---|
| Natural source of truth | **API-owned contract + database-backed domain data**, inside `services/budget-api`. |
| Domain owner | `services/budget-api` owns budget/finance data and the Akahu integration boundary (`docs/ARCHITECTURE.md:38`). |
| Consumers | `apps/budget-mobile` (`DashboardScreen.tsx:190`, `:447` — `POST /akahu/sync`), `GET /transactions`, `GET /categories/timeseries`, `GET /alerts`. |
| Why not another service | The provider contract (cursor, page size, retry rules) is Akahu-specific and has exactly one consumer — the Budget sync route. Extracting it would add a service boundary with no second consumer. |
| Why not a shared package | The pagination/retry helpers are Akahu-provider-specific. A shared package would be a premature abstraction across one provider in one service. |
| Why not UI-local state | The completeness signal is financial truth, not a client display concern. The mobile app must reflect it; it must not own it. |
| Why not a workflow/cron/skill boundary | The backfill is a bounded, one-off, data-repair operation over the same provider contract, executed with the same code path and the same budgets. It is not a recurring workflow and does not belong in the OpenClaw automation surface. |

**Durability note.** The durable boundary is designed now, not as a shim: the paged provider client, the deadline/retry helper, and the completeness contract all land in the provider-facing layer of `budget-api` and are consumed by the route. There is no interim local-only state, no duplicated metadata, and no second source of truth. The only new persistent state is the backfill run record (§5), which is written by the same code path that performs the backfill.

---

## 3. `.openclaw` boundary

None of this work writes outside the repository, and nothing here requires a change under `~/.openclaw/`. Specifically:

- No new cron, skill, or OpenClaw workflow is introduced.
- The backfill is an in-repo script under `services/budget-api/scripts/`, invoked manually (or from an operator runbook), not by the automation surface.
- Provider credentials remain in the existing env/secret boundary (`AKAHU_CLIENT_ID`, `AKAHU_CLIENT_SECRET`, `AKAHU_REDIRECT_URI`, `AKAHU_DEV_USER_ACCESS_TOKEN`); no new secret is introduced and no secret value appears in this doc, in code, or in any PR artifact.

If implementation later needs an OpenClaw-side change, route Quinn at `attentionOwners[0]` per `WORKFLOW.md` and record the evidence with an `[openclaw-needed]` comment.

---

## 4. Implementation plan

Two implementation PRs on one branch, in dependency order, plus the backfill script.

### PR 1 — provider client: cursor support, deadlines, retry policy

**Files**

- `services/budget-api/src/services/akahuClient.ts` (modify)
- `services/budget-api/test/akahuClient.test.ts` (extend)

**Changes**

1. **Shared request helper** `fetchAkahu(url, init, { timeoutMs, kind })`:
   - Creates `AbortSignal.timeout(timeoutMs)` **inside** the helper and passes it to `fetch` — one signal per call covers headers *and* body in undici (research, "Per-call deadline"). The timer is cleared when the body read completes.
   - Maps failures to typed errors: `AKAHU_TIMEOUT` (deadline exceeded / aborted) and `AKAHU_HTTP_<status>`.
2. **Retry policy lives in one place**, parameterised by call kind so the unsafe paths are excluded *by construction*, not by convention:
   - `kind: 'read'` (`GET /v1/accounts`, `GET /v1/transactions`, `GET /v1/transactions/pending`) — retryable on `429`, `502`, `503`, `504`, and network/timeout errors. Bounded exponential backoff with jitter, honouring `Retry-After` when present. **Not** retryable on `400`, `401`, `403` (permanent).
   - `kind: 'write'` (`POST /oauth.akahu.nz/token` authorization-code exchange, `POST /v1/refresh`) — **never retried**. Authorization codes are single-use; a blind replay fails and a retried refresh deepens provider throttling. The existing error text and the existing `429 → { requested: false, rateLimited: true }` mapping on `/refresh` (`:123`) are preserved.
   - Every retry attempt is checked against the remaining whole-sync budget before it starts — a retry storm must not outlive the budget.
3. **Paged transactions API.** `akahuGetTransactions` gains a `cursor` parameter and returns `{ items, nextCursor }` instead of a bare array. The existing `start`/`end` query parameters are re-sent on every page (provider requirement), and `cursor` is sent only when present. `cursor.next === null` is the only completion signal; a `null` cursor is never sent back to the provider (Akahu errors on it).
4. `akahuGetAccounts` and `akahuGetPendingTransactions` are unchanged in shape (they are not paged — the pending endpoint declares no `cursor`) but gain the deadline and read-retry behaviour.

**Caller blast radius:** `akahuGetTransactions` is the only changed signature, and its only caller is `routes/akahu.ts:112`. PR 1 therefore lands green on its own **only if** the route is updated in the same PR or the client keeps a thin array-returning wrapper. **Decision:** PR 1 changes the return type and updates the route call site to destructure `items`, leaving traversal itself to PR 2. The route's *behaviour* does not change in PR 1 — it still syncs one page and still advances the checkpoint — so PR 1 is a no-op refactor at the route level and therefore safe to review and merge independently.

### PR 2 — sync route: traversal, completeness contract, budget, cancellation

**Files**

- `services/budget-api/src/routes/akahu.ts` (modify)
- `services/budget-api/test/akahuSync.test.ts` (extend — see the mocking caveat below)
- `services/budget-api/test/akahuSyncTraversal.test.ts` (new — real client against a mocked `fetch`)

**Changes**

1. **Traversal.** Settled transactions are paged to exhaustion using a cursor-aware iterator with **cycle detection**: if a cursor repeats, traversal stops and is reported as **incomplete**, never as success.
2. **Completeness invariant (I1).** `lastSyncedAt` advances **only** when the traversal of the requested window terminated with `cursor.next === null` *and* the page cap was not hit. Otherwise the checkpoint is left unchanged and the next sync re-requests the same window (safe: the upsert is idempotent by `providerTransactionId`).
3. **Page cap.** 50 pages (≈5 000 rows at Akahu's fixed 100-row page size). A cap hit is a partial traversal → invariant I2 applies (no checkpoint advance), never silently treated as completion.
4. **Whole-sync budget.** 20 s across the entire `/akahu/sync` request — shared by the three parallel provider calls *and* every pagination round. 10 s per provider call. The budget is enforced by an `AbortSignal` that is checked before each page and passed into each call, so an overrun aborts the sync instead of hanging.
5. **Cancellation.** A request-scoped signal is derived from `req` (`req.on('close')` → abort) so a client disconnect stops provider work rather than leaving it running. On abort: no checkpoint advance, and a distinguishable error rather than a generic `BAD_REQUEST`.
6. **Response contract.** `POST /akahu/sync` gains explicit completeness fields:

   ```json
   {
     "ok": true,
     "complete": true,
     "checkpointAdvanced": true,
     "pagesFetched": 3,
     "transactionsFetched": 250,
     "accounts": 2,
     "created": 250,
     "updated": 0,
     "pendingCreated": 4,
     "balanceSnapshotsCreated": 2,
     "categorized": 254,
     "refresh": null,
     "alerts": []
   }
   ```

   On a partial traversal the route returns `200` with `complete: false`, `checkpointAdvanced: false`, and the pages actually fetched — a partial sync is a truthful result, not a silent success and not a 500.

7. **Mocking caveat (must be addressed).** `services/budget-api/test/akahuSync.test.ts:39` mocks the **entire** provider module, so route fixtures cannot exercise real cursor traversal — this is precisely why the defect is invisible to the current suite. The new route tests must drive the **real** client against a mocked `fetch` (the research harness pattern), in a new file so the existing module-mocked suite keeps working.

### Backfill — bounded, dry-run-first, idempotent

**Files**

- `services/budget-api/scripts/akahu-backfill.ts` (new)
- `services/budget-api/test/akahuBackfill.test.ts` (new)

**Behaviour**

- Takes an explicit window (`--start`, `--end`), a `--user` (or the single linked user in a local run), and `--dry-run`.
- **Refuses** any window that extends outside the app's configured historical allowance. The allowance is read from the provider's app configuration (`access_granted_at` on `/me`) — it is **not** guessed or hardcoded to a number. A window outside the allowance is rejected before any request is issued.
- `--dry-run` counts rows and **writes nothing** — no transaction upserts and no backfill run record.
- Apply mode pages the whole window to completion, upserts by `providerTransactionId` (`akahu:<provider _id>`), and records the covered range in `AkahuBackfillRun` (§5). A second run over the same window creates no duplicates (upsert by construction) and updates the existing run record's counters.
- Backfill **never deletes** settled rows and **never** touches `lastSyncedAt` — the checkpoint is the sync watermark, not a backfill artefact.
- Runs inside the same per-call and whole-sync budgets as the normal sync, so a backfill can fail partially and be re-run safely.

### Documentation deliverables (in the implementation PRs)

- `docs/systems/budget-api.md` — **new**. A budget-api system doc does not exist today (`docs/systems/` contains `budget-mobile-distribution.md`, which covers mobile distribution, not the API). Consolidation self-check: (1) subject matter not covered by any existing system doc — yes; (2) authoritative for ≥2 future changes — yes (pagination, deadlines, backfill, alerting, categorisation all live in this service); (3) describes a service boundary and operational surface — yes. The doc records the provider contract, the completeness invariant, the budget model, the backfill runbook, and the checkpoint semantics.
- `docs/specs/budget-akahu.md` — update the Akahu section with the finalised provider contract and sync semantics.
- `apps/budget-mobile/SPEC.md` — update if user-visible behaviour changes. It does: `DashboardScreen.tsx:452` currently sets `Sync complete` from the route response; with the new contract the app must distinguish a complete sync from a partial one.
- `docs/repo-audits/2026-W44.md` — F2/F3 already carry `➡️ Tracked by task a37b31c9 …`; no ledger edit is needed from this task (the audit-ledger PR #888 landed on `main`).

---

## 5. Data model and API contract changes

### Prisma

One new model, one migration:

```prisma
model AkahuBackfillRun {
  id            String   @id @default(cuid())
  userId        String
  windowStartMs BigInt
  windowEndMs   BigInt
  mode          String   // "apply" (dry runs write nothing)
  status        String   // "completed" | "partial" | "failed"
  pagesFetched  Int      @default(0)
  rowsSeen      Int      @default(0)
  rowsUpserted  Int      @default(0)
  startedAt     DateTime @default(now())
  finishedAt    DateTime?

  @@index([userId, windowStartMs])
}
```

**No change to `AkahuConnection.lastSyncedAt`'s column type.** Its *meaning* tightens from "time of the last sync" to "watermark of the last **complete** sync". The invariant is enforced in the route; the column stays a timestamp, so no migration is needed for it and no second watermark is introduced.

### API contract

`POST /api/v1/akahu/sync` response gains `complete`, `checkpointAdvanced`, `pagesFetched`, `transactionsFetched`. All existing fields are retained. The mobile app treats `complete === false` as "some history may be missing" and must not display "Sync complete".

**Error contract:** provider failures continue to surface as `400 BAD_REQUEST` with a message, as today — except that a deadline overrun or client disconnect is reported with a distinguishable message (`AKAHU_TIMEOUT` / `AKAHU_CANCELLED`) so the client can tell a timeout from a bad request. A **partial traversal is not an error**: it is a `200` with `complete: false`.

---

## 6. Workflow, cron, and skill changes

None. No lobster workflow, cron job, or skill is added or modified by this task. The code-task workflow gate is satisfied by the `[tech-design]` comment on the task plus Quinn's structured `tech_design` approval; implementation follows on the same branch.

---

## 7. Test plan and AC verification matrix

**Layers available:** `services/budget-api` runs `vitest run` (`services/budget-api/package.json:6`); `supertest` is available for route-level tests; `vi.stubGlobal('fetch', …)` is the established mocking mechanism (`services/budget-api/test/akahuClient.test.ts:24`).

**E2E note:** no AC here is a browser/app-flow AC. The ACs are provider-contract, deadline, and persistence assertions that require deterministic control of the transport boundary and the provider's page boundaries — neither is achievable through a mobile E2E harness, and doing so would require live banking credentials, which the research explicitly kept out of scope. **Fallback layer for every AC: `unit` (client, mocked `fetch`) and `integration` (route, real client against a mocked `fetch`, real Prisma test DB).** The user-visible consequence of a partial sync is covered by the mobile app's own contract test surface rather than by a browser E2E.

| AC | Planned verification | Layer | Fixture | Assertion |
|---|---|---|---|---|
| **AC1** — two pages, cursor sent, `start`/`end` repeated | `akahuClient.test.ts` → "returns every page and repeats start/end with the cursor param" | unit (real client, mocked `fetch`) | page 1 `{ items: [a,b], cursor: { next: 'page-two' } }`, page 2 `{ items: [c], cursor: { next: null } }` | both pages' transactions returned; request 2 carries `cursor=page-two`; `start`/`end` byte-identical on both requests |
| **AC2** — repeated cursor stops; empty final page is complete | `akahuClient.test.ts` → "stops on a repeated cursor" and "treats an empty final page as complete" | unit | provider always returns `cursor.next = 'same'`; and a final page `{ items: [], cursor: { next: null } }` | traversal stops on the repeat and reports **incomplete** (not success); the empty final page is reported **complete** |
| **AC3** — stalled headers/body time out; whole-sync overrun aborts with the checkpoint unchanged | `akahuClient.test.ts` → "rejects with AKAHU_TIMEOUT when headers stall" / "…when the body stalls"; `akahuSyncTraversal.test.ts` → "aborts when the whole-sync budget is exceeded" | unit + integration | `fetch` never resolves (headers); headers resolve and the body never completes; a sync whose page sequence exceeds the whole-sync budget | a typed `AKAHU_TIMEOUT` is raised within the per-call budget (assert elapsed < budget + margin); the whole-sync overrun aborts the sync and `lastSyncedAt` is **unchanged** |
| **AC4** — 250 rows persisted and the checkpoint advances; a page-2-of-3 failure leaves the checkpoint unchanged and reports `complete: false` | `akahuSyncTraversal.test.ts` → "persists every transaction in a multi-page window" and "does not advance the checkpoint when a later page fails" | integration (real client, mocked `fetch`, real Prisma) | 250 transactions across 3 pages; and a window whose second of three pages rejects | all 250 rows persisted and `lastSyncedAt` advanced; for the failure case, `lastSyncedAt` unchanged and the response reports `complete: false` with the pages fetched |
| **AC5** — token exchange and `/v1/refresh` are never retried; a 429 on a read is retried a bounded number of times within the budget | `akahuClient.test.ts` → "never retries the token exchange", "never retries the refresh", "retries a 429 read within the budget" | unit | token exchange returns 500; `/v1/refresh` returns 429; a `GET /v1/transactions` returns 429 twice then 200 | call count asserted as exactly 1 for the two write paths; the read path is retried a bounded number of times and succeeds, with the total attempts bounded by the whole-sync budget |
| **AC6** — the backfill is idempotent, supports a dry run, and refuses an out-of-allowance window | `akahuBackfill.test.ts` → "a dry run writes nothing", "a second apply creates no duplicates", "refuses a window outside the configured historical allowance" | integration | fixed window with a known row count; provider app config with an `access_granted_at` bound | dry run returns the row count with zero transaction rows and zero `AkahuBackfillRun` rows written; the second apply leaves the row count unchanged and creates no duplicate `providerTransactionId`; an out-of-allowance window is rejected before any provider request is issued |

**Regression guard:** AC4's 250-row case fails against the current code (only 100 rows persist), so it must exist in the branch before the fix lands — it is the test that proves the defect and the fix.

**Acceptance of the change:** `npm run test` in `services/budget-api` (Vitest, including the Prisma-backed integration suites), plus the repository CI checks for the changed service.

---

## 8. Risks, trade-offs, and open questions

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Advancing the checkpoint only on complete traversal means a chronically failing window is re-requested every sync (extra provider load). | Medium | Bounded backoff on the provider side; the page cap and whole-sync budget limit each attempt; re-requesting is idempotent. |
| Retry-on-429 could deepen provider throttling. | Medium | Bounded attempts, jittered backoff, `Retry-After` honoured, all bounded by the whole-sync budget; write paths are never retried. |
| A page cap that is hit on a legitimately huge window reports incomplete forever. | Low | The cap (50 pages ≈ 5 000 rows) is far above a personal-account window; a capped window is a signal to run the backfill path, which has its own bound. |
| Changing the sync response shape breaks a consumer that reads it strictly. | Low | All existing fields are retained; only new fields are added. The mobile app is updated in the same PR. |
| The backfill touches persisted financial records. | High | Additive only — no deletes; dry-run first; idempotent by `providerTransactionId`; window bound read from provider config, not guessed; the run is recorded in `AkahuBackfillRun`. |

### Trade-offs accepted

- **A 20 s whole-sync budget may truncate a legitimately slow provider.** Accepted: an unbounded hang is a worse failure mode for a user-facing sync, and a truncated sync now reports `complete: false` rather than pretending success.
- **Cursors are opaque provider tokens**, so traversal state cannot be serialised across processes. The design therefore keeps the cursor in-request only and makes the backfill a full re-read of a bounded window rather than a resumable cursor job.
- **The backfill is a script, not an endpoint.** It avoids adding an administrative surface with its own auth/audit burden; the operator runs it deliberately.

### Open questions for Quinn (design-approval gate)

1. **Backfill audit table** — is `AkahuBackfillRun` justified as the one schema change, or should the backfill be log-only with no table (smaller diff, no migration, no auditable run history)? *Recommendation: keep the table* — a data-repair operation over financial records should leave a durable record of what window it covered.
2. **Partial-sync HTTP status** — the design returns `200` with `complete: false` for a partial traversal. Alternative: `206 Partial Content`, or a `503`. *Recommendation: `200` + explicit flags*, because a partial sync is a successful operation that did not achieve completeness, and the mobile app already reads the body.
3. **Budget values** — 10 s per call and 20 s whole-sync are research recommendations, not measurements against the deployed environment. *Recommendation: adopt them, keep them configurable by env var, and treat a latency probe against `api.akahu.io` as a pre-merge sanity check* (research residual unknown #5).
4. **Backfill trigger** — script-only (current design) vs. an admin-authenticated endpoint. *Recommendation: script-only*, since this is a one-off repair and the route surface should stay minimal.
5. **Historical allowance source** — the design reads `access_granted_at` from the provider's `/me` endpoint. If that field is unavailable in the deployed Akahu app configuration, an explicit operator-supplied bound may be needed instead. *Recommendation: read `/me`, require an explicit `--max-lookback-days` override when it is unavailable, and refuse to guess.*

### Research residual unknowns carried into implementation

Item ordering within a window is not documented by Akahu — it affects the *count* of rows recovered by a backfill, not whether loss occurred. The pending endpoint's item cap is undocumented but pending rows are rebuilt wholesale each sync, so the risk is pending-only. Provider rate limits determine how aggressive the 429 backoff may be. None of these block the design; all are recorded so the backfill window is fixed from provider configuration rather than from an assumption.

---

## 9. Milestones (independently testable, reversible, mergeable)

1. **M1 — client foundation.** PR 1: deadline helper, typed errors, read/write retry policy, paged transactions API, client unit tests. Mergeable on its own; no behaviour change at the route.
2. **M2 — traversal and completeness.** PR 2: cursor traversal with cycle detection, page cap, whole-sync budget, cancellation, completeness invariants, response contract, route integration tests (including the 250-row regression guard).
3. **M3 — bounded backfill.** Script + tests: dry-run, idempotency, allowance refusal, run record.
4. **M4 — documentation.** `docs/systems/budget-api.md` (new), `docs/specs/budget-akahu.md`, `apps/budget-mobile/SPEC.md`, and the mobile app's "sync complete" handling for the partial case.
5. **M5 — frontmatter close-out.** On merge, set `status: shipped`, `shipped_pr`, `shipped_date` in this file, in the same PR as the feature code.
