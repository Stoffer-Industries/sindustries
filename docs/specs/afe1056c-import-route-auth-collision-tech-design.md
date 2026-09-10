# Tech design — `afe1056c` Reconcile CTO-Craft import-route auth collision (W34 T1.1)

**Task:** `afe1056c-1d7f-4600-9791-95acabfb2781` — "💻 Reconcile CTO-Craft import-route auth collision (W34 T1.1)"
**Audit finding:** `docs/repo-audits/2026-W34.md` § Security & correctness → High (T1.1)
**Author:** Rowan (Staff Engineer)
**Status:** Draft, awaiting Quinn's `tech_design` structured approval
**Date:** 2026-09-10

## 1. Context and re-scoping note

The W34 audit was written while the content-scheduler routes still lived inside `services/tasks-api/src/routes/contentScheduler.ts`, with the general mutation gate (`gateMutations` / `requireAuthenticatedUser`) mounted on the whole `/api/v1/content-scheduler` prefix in `tasks-api/src/app.ts`. Under that layout the audit's diagnosis was correct: the gate ran first, intercepted `POST /content-scheduler/imports/cto-craft` before its own `x-content-ingest-secret` check, and 401'd the real CTO-Craft client (which sends only the ingest header).

Since the audit was written, **task `94d5e4fc` (PR #507 — "Extract Content Scheduler from Tasks API")** moved the content-scheduler surface to a dedicated service: `services/content-scheduler-api/`. The current code already arranges the mount order so the import route is matched before any auth gate:

- `services/content-scheduler-api/src/app.ts:117` — `app.use('/api/v1', contentSchedulerServiceRouter)` (service-to-service routes, gated only by the per-route `x-content-ingest-secret` check in `contentSchedulerService.ts:240-296`)
- `services/content-scheduler-api/src/app.ts:130-138` — `methodGate(WRITE_METHODS, requireAuthenticatedUser)` is mounted on `/api/v1/content-scheduler/items` and `/api/v1/content-scheduler/reorder` only (NOT on the whole `/api/v1/content-scheduler` prefix)

Net effect: the **structural collision described in the audit no longer exists** in `main`. The import path is reachable with only `x-content-ingest-secret`, exactly as the production client (`agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py:104-108`) sends it.

What **does** still exist is the audit's secondary concern: **no test reproduces the production caller's header set.** Every existing test in `services/content-scheduler-api/test/contentSchedulerImport.test.ts` uses `authedRequest(app)`, which sends `Authorization: Bearer integration-test-token-long-enough` (per the test helper at `services/tasks-api/test/helpers/auth.ts:14-25`). A future mount-order regression — moving the gate before `contentSchedulerServiceRouter` — would reintroduce the W34 collision and CI would still pass.

**Therefore this task is re-scoped from "reconcile the collision" to "lock in the post-extraction mount order with a regression test that reproduces the production caller's header set."** No production code change is needed; the change is purely additive test coverage.

## 2. Decision needed before implementation

None for the design itself. The audit's open question OQ1 ("which auth is authoritative") is already answered by the post-extraction code: the route-local `x-content-ingest-secret` check is authoritative, and `requireAuthenticatedUser` is intentionally NOT in scope for `/imports/cto-craft`. No code change is required to make that true.

The one product call is whether to also update the W34 audit doc (T1.1 line) to reflect the post-extraction reality and close the loop with `➡️ Resolved by 94d5e4fc; regression test added by afe1056c`. **Recommendation:** yes, include the audit ack as AC4 — keeps the audit ledger accurate.

## 3. Approach

### 3.1 Add a regression test that uses the production caller's header set

File: `services/content-scheduler-api/test/contentSchedulerImport.test.ts` — append a new `describe` block:

```ts
describe('production client header set (regression for W34 T1.1 auth-collision finding)', () => {
  // Use the raw `request` helper (not `authedRequest`) so the test
  // mirrors what the CTO-Craft workflow client actually sends.
  // See agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/content_scheduler.py:104-108.

  it('accepts a request with ONLY x-content-ingest-secret (no Bearer, no session)', async () => {
    const secret = 'a'.repeat(64);
    process.env.CONTENT_SCHEDULER_INGEST_SECRET = secret;
    prismaMock.contentSchedulerItem.createMany.mockResolvedValue({ count: 1 });
    prismaMock.contentSchedulerItem.findMany.mockResolvedValue([asPersisted(STRONG_REF, 'id-1')]);

    const app = await createApp();
    const res = await request(app)
      .post('/api/v1/content-scheduler/imports/cto-craft')
      .set('x-content-ingest-secret', secret)
      .send({ items: [itemBody('body', STRONG_REF)] });

    expect(res.status).toBe(201);
    expect(res.body.data.createdCount).toBe(1);
  });

  it('rejects with 401 when only Bearer is sent (no ingest secret)', async () => {
    // Documents the contract: the ingest secret is required even when the
    // bearer token would otherwise be valid. A future mount-order change
    // that puts the gate before contentSchedulerServiceRouter would 401
    // here for a different reason (AUTH_REQUIRED vs UNAUTHORIZED).
    process.env.CONTENT_SCHEDULER_INGEST_SECRET = 'a'.repeat(64);
    const app = await createApp();
    const res = await authedRequest(app)
      .post('/api/v1/content-scheduler/imports/cto-craft')
      .send({ items: [itemBody('body', STRONG_REF)] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toContain('x-content-ingest-secret');
  });
});
```

The first test exercises the production header set (`x-content-ingest-secret` only, no Bearer). The second test pins the auth model: the ingest secret is the gate, even when a Bearer is present.

The raw `request(app)` call (from `supertest`, already imported indirectly via the test helper) is needed because `authedRequest` always sets the Bearer.

### 3.2 Add a one-line cross-reference comment

In `services/content-scheduler-api/src/app.ts`, the existing mount-order comment (lines 109-115) already explains the order. Add a single line:

```ts
// Test coverage for this invariant lives in
// services/content-scheduler-api/test/contentSchedulerImport.test.ts
// under "production client header set (regression for W34 T1.1)".
```

This protects the invariant from being silently broken by future refactors.

### 3.3 Update the W34 audit ledger (AC4)

In `docs/repo-audits/2026-W34.md`, replace the T1.1 trailing line:

```diff
-- ➡️ Tracked by task afe1056c (afe1056c-1d7f-4600-9791-95acabfb2781).
++ ➡️ Resolved by 94d5e4fc (PR #507 — Extract Content Scheduler); regression test added by task afe1056c (afe1056c-1d7f-4600-9791-95acabfb2781).
```

This keeps the audit and the task tracker aligned.

## 4. Acceptance criteria

- [ ] **AC1 — Production-header acceptance:** a regression test in `contentSchedulerImport.test.ts` posts to `/api/v1/content-scheduler/imports/cto-craft` with ONLY `x-content-ingest-secret` (no Bearer, no session cookie), and the response is `201` with the expected payload. Uses the raw `request(app)` helper to mirror the production client.
- [ ] **AC2 — Ingest-secret-required invariant:** a regression test posts with Bearer but no ingest header and asserts `401` with `error.code === 'UNAUTHORIZED'` and the error message references `x-content-ingest-secret`. Pins the auth model: even a valid Bearer does not bypass the ingest gate.
- [ ] **AC3 — Cross-reference comment in `app.ts`:** the existing mount-order block in `services/content-scheduler-api/src/app.ts` references the regression test by its describe name.
- [ ] **AC4 — Audit ledger update:** `docs/repo-audits/2026-W34.md` T1.1 line is updated to reflect the post-extraction resolution and the test added by `afe1056c`.
- [ ] **AC5 — CI green:** `pnpm --filter @sindustries/content-scheduler-api test` passes locally; the `content-scheduler-api tests (vitest)` CI job passes on the PR.

## 5. Files

| File | Change |
|---|---|
| `services/content-scheduler-api/test/contentSchedulerImport.test.ts` | Append the `production client header set` describe block (~30 lines) |
| `services/content-scheduler-api/src/app.ts` | Add a one-line cross-reference comment in the mount-order block |
| `docs/repo-audits/2026-W34.md` | Update T1.1 trailing line (audit ack) |

No production code changes. No package.json / lockfile changes.

## 6. Effort, risk, dependencies

- **Effort:** S (~30 LoC test + 1 line comment + 1 line audit edit; single PR; < 1h)
- **Risk:** Low. Additive test only; no runtime behaviour change.
- **Dependencies:** None. The post-extraction code in `main` is the substrate.
- **Out of scope:** any change to `app.ts` mount order, `requireAuthenticatedUser`, the `x-content-ingest-secret` validation logic, or the CTO-Craft workflow client.

## 7. Validation plan

1. Run the new tests locally: `pnpm --filter @sindustries/content-scheduler-api test contentSchedulerImport` — both new cases green; existing 10 cases remain green.
2. Negative-control sanity: temporarily move the `methodGate(...)` mount in `app.ts:130-138` to BEFORE `contentSchedulerServiceRouter` (line 117) and re-run; AC1 should now FAIL with `401 AUTH_REQUIRED` instead of `201`. Revert. (Recorded as a manual check in the PR description; not committed.)
3. CI: PR triggers the `content-scheduler-api tests (vitest)` job; green.
4. Quinn review approves → ACs `[x]` checked in PR body → structured `qa_agent` approval lands → Tom's `accepted` approval.

## 8. Open question for Quinn

None blocking. One nit:

- Should AC4's audit ack use a strict `Resolved by 94d5e4fc` phrasing, or a softer `Partially resolved; test gap closed by afe1056c`? The audit's classification was `tracked-code-task` on the assumption there was a code change to write. Since the code change was 0 LoC and the deliverable is a test + audit ack, the wording matters for the audit ledger's accuracy. **Default if no preference:** the strict phrasing above.
