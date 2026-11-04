---
status: draft
task_id: 75032fad-1b5d-4409-af5f-c803166b7933
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tasks API Analytics — Bounded, Measured Queries — Tech Design

## Links

- Task: `75032fad-1b5d-4409-af5f-c803166b7933` (💻 "Bound Tasks API analytics reads with a measured query contract")
- Task API detail: `http://localhost:4001/api/v1/tasks/75032fad-1b5d-4409-af5f-c803166b7933`
- Research task (complete): `c1f6fd7f` — analytics read-growth measurement
- Research deliverable: `brain/research/w43-analytics-query-budget.md` (private workspace repo, not committed to `sindustries`)
- Audit ledger: `docs/repo-audits/2026-W44.md` F4 — already carries `➡️ Tracked by task 75032fad (…)`; the audit-ledger edit is **not** part of this task
- Prior finding: `docs/repo-audits/2026-W43.md` F4 (carried forward)
- Contract documentation to update: `docs/systems/tasks.md:504-506` (the three analytics endpoints)

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-75032fad-analytics-bounded-queries`
- Worktree: `/Volumes/WD1/worktrees/rowan/task-75032fad-analytics-bounded-queries`
- Primary surfaces:
  - `services/tasks-api/src/routes/featureTaskAnalytics.ts` — weekly aggregation (`:289-388`), per-task events (`:215-230`), percentile helpers (`:275-281`)
  - `services/tasks-api/src/lib/featureTaskAnalyticsQuery.ts` (new) — the two bounded reads, isolated from the HTTP layer so they can be measured directly
  - `services/tasks-api/test/featureTaskAnalytics.test.ts` — unit coverage for the response contract and pagination contract (Prisma-mocked, as today)
  - `services/tasks-api/test/featureTaskAnalyticsBudget.integration.test.ts` (new, wired into `vitest.integration.config.ts`) — AC1/AC2/AC4/AC5 regression and budget assertions against a real Postgres
  - `agents/skills/ops/tasks-analytics/scripts/tally_events.py` — follow the new pagination contract so its tallies are unchanged
  - `apps/mission-control/src/tasksApi.js` — `fetchFeatureTaskAnalyticsReplay` follows the pagination contract
  - `docs/systems/tasks.md` — document the bounded read contract and the pagination envelope
- No new service, route, table, migration or index. No `.openclaw` runtime change. No new GitHub Actions permissions.

## Problem Summary

Two analytics reads in `tasks-api` are unbounded in ways the response shape does not reveal.

**`GET /feature-task-analytics/weekly?weeks=N`** returns a fixed-shape weekly aggregate (8 buckets ≈ 2.3 KB; 52 buckets ≈ 14 KB) but materialises **every** matching event row into Node memory and aggregates in JS (`featureTaskAnalytics.ts:299-311`, `:340-368`). Measured at 10× fixture volume over a 52-week window: **13,700 rows read, 23.25 MB retained heap, 123 ms p50**. Response bytes grew 1.7% while rows read grew 10× — any monitoring built on response size sees this endpoint as flat forever.

**`GET /feature-task-analytics/tasks/:taskId/events`** returns raw events with no cap, no cursor and no pagination parameter (`featureTaskAnalytics.ts:222-225`). One pathological task produced a **7.2 MB** response body and **29.06 MB** retained heap for 13,002 events. Current prodlike worst task is 61 events, so this is latent — but nothing in the code prevents a task with 100k events from returning ~50 MB.

The weekly endpoint's numbers are *reproducible*, not approximate: every statistic except the percentiles is a count or a distinct-count Postgres can compute per bucket, and the percentiles depend only on `terminal_summary` rows (≈5% of events). Moving the aggregation into SQL and fetching only the percentile inputs cuts rows materialised by ~95% **without changing a single returned number**.

## Product intent

No end-user feature. The intent is that Mission Control's Flow dashboard and the weekly retro keep showing exactly the numbers they show today, while the server stops paying a cost that grows with retained history and stops being able to emit an unbounded response body.

## Decision 1 — Weekly: two bounded reads instead of one full materialisation

Replace the single `findMany` with two reads:

**Read A — grouped counts (one row per week bucket).** A raw SQL query that joins the event table to the bucket boundaries and aggregates in Postgres:

```sql
SELECT b.bucket_index,
       COUNT(*) FILTER (WHERE e."eventType" = 'terminal_summary')                      AS terminal_task_count,
       COUNT(*) FILTER (WHERE e."eventType" = 'gate_failure')                         AS gate_failure_count,
       COUNT(*) FILTER (WHERE e."eventType" = 'gate_failure' AND e."cause" = 'capacity') AS capacity_failure_count,
       COUNT(*) FILTER (WHERE e."eventType" = 'gate_failure' AND e."cause" = 'quality')  AS quality_failure_count,
       COUNT(DISTINCT e."taskId") FILTER (WHERE e."eventType" = 'gate_failure')       AS task_with_failure_count
FROM (VALUES …) AS b(bucket_index, start_at, end_at)
LEFT JOIN "FeatureTaskAnalyticsEvent" e
       ON e."occurredAt" >= b.start_at AND e."occurredAt" < b.end_at
GROUP BY b.bucket_index
ORDER BY b.bucket_index;
```

**Read B — narrow percentile inputs.** `findMany` restricted to `eventType = 'terminal_summary'` inside the same window, selecting only `occurredAt`, `taskId`, `prCycleTimeSeconds`, `evidenceTypeDistribution`. **No `take`/`LIMIT`** — this fetch must return every terminal summary in the window, because it is the percentile input (AC4).

### Why each aggregate maps exactly to the current JS loop

| Current JS (`featureTaskAnalytics.ts:340-368`) | SQL equivalent | Equal? |
| --- | --- | --- |
| `stats.terminalTaskCount += 1` per `terminal_summary` event | `COUNT(*) FILTER (WHERE eventType='terminal_summary')` | Yes — counts **events**, not distinct tasks (`_terminalTasks` is computed but never read) |
| `stats.gateFailureCount += 1` per `gate_failure` event | `COUNT(*) FILTER (WHERE eventType='gate_failure')` | Yes |
| `cause === 'capacity'` / `cause === 'quality'` counters | `COUNT(*) FILTER (… AND cause = …)` | Yes — any other cause (including null) counts only in `gateFailureCount`, exactly as the `else if` chain does |
| `stats._failureTasks.add(event.taskId)` then `.size` | `COUNT(DISTINCT e."taskId") FILTER (WHERE eventType='gate_failure')` | Yes |
| `stats._prCycleTimes.push(prCycleTimeSeconds)` when `typeof === 'number'` | narrow fetch, same filter in JS | Yes — the numeric filter stays in JS so `null`/non-number semantics are untouched |
| `evidenceTypeDistribution` merge | narrow fetch, same merge loop in JS | Yes — merging JSON in SQL would change numeric behaviour; the merge stays in JS |

Events of any other `eventType` are ignored by both the old loop and the new queries.

## Decision 2 — Bucket boundaries are computed in JS and passed into SQL (timezone safety)

The current bucket boundaries come from `isoMonday()` / `isoDateOnly()` (`featureTaskAnalytics.ts:291-306`), which use **local-time** components (`setHours(0,0,0,0)`, `getFullYear/getMonth/getDate`) and the `weekStart` label is a local-date string. `date_trunc('week', …)` in Postgres truncates on **UTC** boundaries. If the server's local zone is not UTC, a SQL-side truncation shifts bucket boundaries relative to the labels the dashboard already displays.

**Decision:** the route keeps computing `buckets` exactly as today (start/end `Date` objects + `weekStart` label) and passes those boundaries to SQL as parameters in a `VALUES` join (`Prisma.sql` + `Prisma.join`, never string interpolation). The SQL never derives a week boundary itself.

Consequences:

- Bucket membership is decided by the same instants the current code uses — the JS `findIndex` boundary check (`occurred >= b.start && occurred < b.end`) is reproduced by the join predicate verbatim.
- The `weekStart` label remains a JS-computed local-date string, so the dashboard's week alignment (`flowMetrics.isoMonday()` convention) is untouched.
- Zero timezone ambiguity in the new code path, regardless of the server's `TZ`.

Rejected: `date_trunc('week', "occurredAt")` with a timezone argument — it duplicates the week-start rule in two languages and silently diverges from the JS convention whenever `TZ` is not UTC.

## Decision 3 — Percentile inputs are never truncated (AC4)

The narrow fetch has **no limit and no sampling**. `median()` and `percentile()` (nearest-rank, `featureTaskAnalytics.ts:275-281`) run over the complete set of `terminal_summary` rows in the window, exactly as today.

This is the one place where a "bound the read" implementation could silently corrupt published statistics, so it is called out in the implementation plan, in the test plan, and in the route code comment. The budget is enforced **upstream** of the percentile inputs (the aggregate query), never by truncating the input array.

`median()`'s even-length averaging and rounding, and `percentile()`'s nearest-rank convention (`Math.ceil((p/100) * n)`, clamped index), are carried over unchanged — no "improvement" to the statistics in this task.

## Decision 4 — Events endpoint: bounded pagination with a keyset cursor and a byte budget

**Decision: additive, server-enforced bounds.**

- **Query parameters:** `limit` (optional) and `cursor` (optional). Both new; absent today.
- **Default page size:** 500. **Hard maximum:** 2,000 events per response. A `limit` above the maximum is clamped to 2,000 (not an error — clamping keeps old clients working and makes the ceiling unmissable).
- **Cursor:** opaque base64url of `{occurredAt, createdAt, id}`, i.e. a keyset cursor over the existing `(occurredAt asc, createdAt asc)` order with `id` added as a final tiebreaker. `id` is added to the `orderBy` so the keyset is a total order; ties today are returned in an unspecified order, so this is a deterministic refinement, not a semantic change.
- **Envelope:** `{"data": [...], "pagination": {"limit", "returned", "hasMore", "nextCursor"}}`. The `data` array is unchanged; `pagination` is an **additive** sibling key. Existing consumers that read `.data` keep working.
- **Malformed cursor:** `400 INVALID_CURSOR`. Malformed/invalid `limit`: `400 INVALID_LIMIT` (non-numeric or ≤ 0). Previously neither parameter existed, so no existing behaviour changes.
- **Byte budget (AC3):** the response body must be ≤ 1 MB. The measured average event serialises to ≈ 554 bytes, so 2,000 events ≈ 1.1 MB — the event cap alone does **not** satisfy the byte cap. The route therefore enforces both: it fetches at most `min(limit, MAX_EVENTS_PER_RESPONSE)` rows, serialises them, and if the encoded body exceeds `MAX_RESPONSE_BYTES` (1 MiB), it **trims the page** to the largest prefix that fits and sets `hasMore: true` with a `nextCursor` pointing at the first dropped event. The logical result set stays complete across pages; no event is ever lost.

Rejected alternatives:

- **Unbounded default with opt-in pagination** (the research's suggestion) — AC3 requires *every* response to be ≤ 2,000 events, so the default must be bounded. A bounded default is also the only way to close the hole for a caller that never learns to paginate.
- **Truncating the array and returning a bare flag** — loses the ability to resume; a cursor is required for correctness under concurrent inserts.
- **Offset pagination** — `OFFSET` degrades linearly on large tables and can skip/duplicate rows when new events arrive mid-scan. A keyset cursor does not.
- **Dropping fields from the event payload** — `tally_events.py` groups by verbatim `message` text, so the payload must not shed fields.

## Decision 5 — Consumers are updated so their output does not change

| Consumer | Change | Gate |
| --- | --- | --- |
| `agents/skills/ops/tasks-analytics/scripts/tally_events.py` | Follow `pagination.nextCursor` until `hasMore` is false, accumulating events across pages | Its `total` / `byGate` / `byCause` / `byMessage` output must be **identical** to the pre-change output on the same fixture — that is the acceptance test |
| `apps/mission-control/src/tasksApi.js` → `fetchFeatureTaskAnalyticsReplay` | Follow pages (the export currently has no caller) | The helper must return the complete event list; leaving it un-paged would turn a future caller into a silent-truncation trap |
| `weekly_summary.py`, Mission Control Flow dashboard, `factory-retro` cron | **No change** | They consume the weekly aggregate, whose response is byte-identical |

The deployed copy of `agents/skills/ops/tasks-analytics/scripts/tally_events.py` is the one in this repo (the skill is loaded from `codebases/sindustries/agents/skills/ops/tasks-analytics/`), so the change ships with the merge to `main`. No separate sync step and no `.openclaw` write is needed.

## Decision 6 — Where the budgets are asserted

AC1, AC2 and AC4 cannot be proven by the existing Prisma-mocked unit test: they are about rows read, heap retained and exact percentile inputs over a 10× fixture, which requires a real database.

**Decision: a new integration test file** wired into `services/tasks-api/vitest.integration.config.ts` (which already runs against a real Postgres with the repo's migrations, in CI as the `tasks-api-tests` job's "Run DB integration tests" step).

- **Fixture:** the research's deterministic 10× seed — 1,240 tasks, 13,700 events (12,990 `gate_failure` + 710 `terminal_summary`), with strictly increasing `occurredAt` per event so the pre-change scan order and the new canonical order coincide (see "Evidence key order" below).
- **AC1 (byte-identical):** the test computes the expected body with a **reference implementation of the pre-change algorithm** (the current JS aggregation loop, run over the rows fetched with the pre-change query shape) and asserts `JSON.stringify(actual) === JSON.stringify(expected)` — a byte comparison of the whole response body, including `medianPrCycleTimeSeconds` and `p90PrCycleTimeSeconds`. The reference implementation lives in the test file so it cannot drift from the pre-change behaviour silently: it is a verbatim copy of the current loop, and the test fails if the two ever disagree.
- **AC2 (rows read):** the test instruments the Prisma client with a counting proxy that records the number of rows **materialised in the application process** by each query, issues a real 52-week HTTP request through `createApp()`, and asserts the total ≤ 2,500. **Metric definition (stated because the research's "rows read" meant matching rows scanned):** the budget is on rows materialised in Node, which is what drives heap and latency; the aggregate query still scans the matching rows inside Postgres. Both numbers are reported in the test output so the change in *scan* volume is visible rather than hidden.
- **AC2 (heap):** the test measures `process.memoryUsage().heapUsed` around the request with a forced GC before and after (vitest needs `--expose-gc`; the integration config gains the matching `execArgv`), matching the research's measurement method, and asserts the retained delta ≤ 8 MB.
- **AC4 (percentiles):** the fixture seeds a known, complete set of `prCycleTimeSeconds` values (including duplicates and an even-length bucket) and asserts the endpoint's median/p90 equal the values computed over the **complete** set. The test additionally asserts the terminal-summary fetch returned every seeded row (no truncation) — so a future "optimisation" that caps the input fails loudly.
- **AC3 (pagination):** seeded task with > 2,000 events → the response contains ≤ 2,000 events, the encoded body is ≤ 1 MB, `hasMore` is true, and following `nextCursor` to the end yields every seeded event exactly once, in order.
- **AC5 (`weeks` validation):** the same cases as today — missing/empty → default 8; `0`, `53`, `-1`, `abc` → `400 INVALID_WEEKS`; `52` accepted.

### Evidence key order (one accepted difference, stated plainly)

`evidenceTypeDistribution` is a JSON object merged across terminal summaries. Its **key order** in the serialized body follows first-appearance order in the row order. Today the rows arrive in the unspecified order of an unordered `findMany`; in the new implementation they arrive in `(occurredAt, createdAt, id)` order. The **values** are identical either way; only the JSON key order can differ, and only when two terminal summaries in the same bucket introduce different evidence keys in a different order.

The AC1 fixture is seeded with strictly increasing `occurredAt` and evidence keys introduced in sorted order, so the two orders coincide and the body is byte-identical — which is exactly what AC1 asks ("byte-identical … for the same fixture data"). The design deliberately does **not** re-sort the merged keys, because that would be a response change beyond this task's remit; the ordering nuance is recorded here instead of being silently absorbed.

## Decision 7 — No cache, no new index, no migration

- **No cache.** The weekly response is already small; caching would mask the server-side cost rather than remove it and would introduce a staleness contract the dashboard does not have.
- **No new index.** The weekly filter is already covered by `FeatureTaskAnalyticsEvent_occurredAt_idx` and `FeatureTaskAnalyticsEvent_eventType_occurredAt_idx`; the bottleneck was transferring rows to Node, not index availability. The aggregate query is an index-range scan plus aggregation.
- **No migration, no new table, no new service.** The change is confined to how `tasks-api` reads a table it already owns.

## Service boundary and ownership

- **Source of truth:** `tasks-api` owns task/workflow state and the `FeatureTaskAnalyticsEvent` table that backs this analytics. The aggregation stays inside `tasks-api`; no domain moves.
- **Direct consumers:** Mission Control (`apps/mission-control/src/tasksApi.js`), `agents/skills/ops/tasks-analytics/scripts/{weekly_summary,tally_events}.py`, and the `factory-retro` cron. All are listed in Decision 5; none of them needs a new service, a new route or a shared package.
- **Why not a shared package:** the aggregation is SQL over one service's table. A cross-service analytics package would move domain data across a boundary that does not exist.
- **Temporary placement:** none — the placement is the durable one.

## `.openclaw` boundary

None. No OpenClaw runtime config, permissions, workflow or skill change is required. The one skill script in scope (`tally_events.py`) is repo-owned and deployed from this repo.

## Data model / API contract changes

- **Data model:** none. No table, column, index or migration changes.
- **API contract:** one **additive** change — `GET /feature-task-analytics/tasks/:taskId/events` gains optional `limit`/`cursor` query parameters and an additive `pagination` object in the response envelope. The `data` array is unchanged; the endpoint is now bounded by default (≤ 2,000 events, ≤ 1 MB per response) instead of unbounded. `GET /feature-task-analytics/weekly` is **byte-identical** — no contract change at all.
- **Consumer-visible consequence to call out in review:** a caller that previously assumed one response contained a task's entire event history now receives a page. The only such caller is `tally_events.py`, which is updated in the same PR.

## Implementation plan

**Slice 1 — extract the reads (no behaviour change).** Move the weekly query and the events query into `src/lib/featureTaskAnalyticsQuery.ts` with explicit result types. Route handlers call the module. Run the existing unit suite: still green, no response change. This slice exists so that the measurement in the next slice has a single, countable seam.

**Slice 2 — weekly aggregation in SQL.** Implement Read A (grouped counts) and Read B (narrow terminal-summary fetch) per Decisions 1–3. Keep the JS merge for `evidenceTypeDistribution` and the percentile computations. Add the integration test (AC1, AC2, AC4, AC5). The byte-identical assertion is the gate for this slice: if the two implementations disagree, the numbers are wrong and the slice does not land.

**Slice 3 — events pagination.** Implement Decision 4: `limit`/`cursor` parsing, keyset query, envelope metadata, byte-budget trimming. Add the AC3 integration test (cap, byte budget, complete traversal).

**Slice 4 — consumers.** Update `tally_events.py` to follow pages, with a test asserting its output is unchanged on a fixture that spans multiple pages. Update `fetchFeatureTaskAnalyticsReplay` in `apps/mission-control/src/tasksApi.js` to follow pages.

**Slice 5 — docs.** Update `docs/systems/tasks.md:504-506` with the bounded read contract, the pagination envelope and the budgets. No `apps/*/SPEC.md` change (no user-visible behaviour change in any app — the dashboard renders identical numbers).

## Test plan — AC verification matrix

| AC | Verification | Layer |
| --- | --- | --- |
| AC1 | Integration test: real Postgres, 10× fixture, expected body computed by the pre-change reference algorithm; `JSON.stringify(actual) === JSON.stringify(expected)` — byte comparison including `medianPrCycleTimeSeconds` and `p90PrCycleTimeSeconds` | integration (new file, `vitest.integration.config.ts`) |
| AC2 | Same fixture, real 52-week request through `createApp()`: Prisma counting proxy asserts rows materialised ≤ 2,500; heap delta after forced GC ≤ 8 MB; both numbers printed for review | integration |
| AC3 | Task seeded with > 2,000 events: response ≤ 2,000 events, encoded body ≤ 1 MB, `pagination.hasMore === true`, full traversal via `nextCursor` yields every event exactly once in order; malformed `cursor` → `400 INVALID_CURSOR` | integration + unit |
| AC4 | Fixture with a known complete `prCycleTimeSeconds` set (duplicates, even-length bucket): endpoint median/p90 equal the values computed over the complete set; the test also asserts the terminal-summary fetch returned every seeded row, so a truncating optimisation fails loudly | integration |
| AC5 | `weeks` cases unchanged: missing/empty → 8; `0`, `53`, `-1`, `abc` → `400 INVALID_WEEKS`; `52` accepted; window bounded at 52 weeks | unit + integration |
| Consumer regression | `tally_events.py` output (`total`, `byGate`, `byCause`, `byMessage`) identical pre/post change on a multi-page fixture | unit (script-level) |
| Process | This document committed on `task-75032fad-analytics-bounded-queries`; `[tech-design]` comment posted; Quinn's structured `tech_design` approval recorded **before** implementation starts | task API read-back |

**E2E coverage:** not applicable — no user-visible app flow changes; the Mission Control dashboard renders identical numbers. The fallback layers are the new integration test (real DB, real HTTP through `createApp()`), the existing unit suite, and the `tally_events.py` output comparison.

## Open questions / risks

1. **Risk — the bucket-boundary SQL is the highest-risk part of this change.** A wrong boundary or a wrong `COUNT(DISTINCT …) FILTER` silently changes published dashboard numbers. Mitigation: the AC1 byte-identical assertion over a multi-week fixture gates the slice; the fixture must span a week boundary, a month boundary and a bucket with zero events.
2. **Risk — "rows read" has two honest meanings** (rows scanned in Postgres vs rows materialised in Node). The design budgets the second and reports both. If the intent was to bound **scan** cost too, that is a different (index/partition) piece of work and should not be smuggled into this one. Flagged for Quinn.
3. **Risk — the 1 MB byte budget with a 2,000-event cap needs a trim rule, and the trim rule is a new behaviour.** It only ever *reduces* a page (never loses an event across pages), and the trim is observable through `returned`/`hasMore`/`nextCursor`. If Quinn would rather see a smaller default page and no trim, the alternative is default 1,000 / max 2,000 with no byte trim — simpler, but then the ≤ 1 MB guarantee depends on the average event size staying under 512 bytes. **Open question for Quinn: byte-budget trim vs smaller fixed page.**
4. **Risk — `tally_events.py` now issues more requests per task.** For the current data (≤ 61 events/task) that is one request either way; the multi-request path only appears for hot tasks. Acceptable, and it is the price of the bound.
5. **Risk — the integration test needs `--expose-gc` for the heap assertion.** The integration vitest config gains the matching `execArgv`; if the runner does not permit it, the heap assertion degrades to an RSS-based measurement and the test says which metric it used.
6. **Residual — the weekly endpoint still scans every matching row inside Postgres.** The change moves the work, it does not eliminate it. At the measured trajectory (~380 events/month, 13-week retention) the 52-week window holds ~1,300 rows today and ~4,900 at a year of history — comfortably inside the budget, but worth re-measuring if retention changes.
7. **Assumption stated explicitly:** no clarification needed on scope, because the task fixes the ACs, the research fixes the measurements and the budgets, and the audit finding fixes the ledger linkage. The genuinely open judgment calls are items 2 and 3, both recorded rather than silently decided.
