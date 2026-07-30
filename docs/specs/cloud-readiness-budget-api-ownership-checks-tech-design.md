---
status: draft
task_id: f39a20a7-8eeb-42cb-9a3c-fced84754ad6
product_spec: n/a (audit-driven: docs/repo-audits/2026-W29.md Theme 1 / Milestone 1-B)
shipped_pr: null
shipped_date: null
---

# Cloud readiness: budget-api ownership checks

## Links

- Product spec: n/a — derived from `docs/repo-audits/2026-W29.md` Theme 1 / Milestone 1-B
- Tech design: `docs/specs/cloud-readiness-budget-api-ownership-checks-tech-design.md`
- Task: `f39a20a7-8eeb-42cb-9a3c-fced84754ad6`
- Tasks API record: `http://localhost:4001/api/v1/tasks/f39a20a7-8eeb-42cb-9a3c-fced84754ad6`
- Predecessor design: `docs/specs/cloud-readiness-budget-api-require-sessions-tech-design.md` (shipped via PR #316, task `ec42d3a1`)
- Audit: `docs/repo-audits/2026-W29.md` Theme 1 / Milestone 1-B

## Headline finding (please read before the rest)

**All ownership checks required by AC1/AC2/AC3 are already shipped in code**, landed as part of the PR #316 (sessions middleware, task `ec42d3a1`) refactor that immediately preceded this task. Every path-parameter route in scope already does the right thing:

- `services/budget-api/src/routes/cards.ts` lines 115, 142 — `POST /cards/:cardId/budget`, `GET /cards/:cardId/spend-summary`
- `services/budget-api/src/routes/alerts.ts` lines 46, 59, 93, 120 — `DELETE /alerts/:alertId`, `GET /cards/:cardId/alert-config`, `POST /cards/:cardId/alert-config`, `DELETE /cards/:cardId/alert-config`
- `services/budget-api/src/routes/transactions.ts` line 45 — `PATCH /transactions/:transactionId/category`

Each guard pattern is identical: `if (record.userId !== req.session!.userId) return 404`. The audit calls this out as the standard pattern (Milestone 1-B risk row: "Low — purely additive checks").

**What remains for this task is test coverage (AC5) and one AC-text clarification (AC4).** This makes the task materially smaller than its audit-estimated "S (<2h)"; the PR is a test-only diff against `auth-contract.test.ts` (or a sibling file), plus possibly a task-description PATCH for AC4.

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-f39a20a7-budget-api-ownership-checks`
- Worktree: `~/workspaces/rowan/sindustries-task-f39a20a7-budget-api-ownership-checks`
- Expected `.openclaw` follow-up: none.

## Scope

`services/budget-api` path-parameter routes must verify the resource belongs to the authenticated session user before reading, mutating, or returning it. This task covers the path-parameter routes called out in the audit (Milestone 1-B) and the AC list:

- `GET /cards/:cardId/alert-config`, `POST /cards/:cardId/alert-config`, `DELETE /cards/:cardId/alert-config` (AC1)
- `POST /cards/:cardId/budget`, `GET /cards/:cardId/spend-summary` (AC1, "card summary/budget routes")
- `DELETE /alerts/:alertId` (AC2)
- `PATCH /transactions/:transactionId/category` (AC3)

Out of scope:

- `/akahu/*`, `/categories/*`, `/categorize/*` — already verified to derive user from session, not from path. None of those routes take a `:cardId`/`:alertId`/`:transactionId` parameter today.
- Anything in `services/tasks-api` — covered by separate cloud-readiness tasks.

## Ownership boundary

- **Implementation: already done.** The guards are already present in the routes; PR #316 left them in place. We do not re-introduce or refactor them; we add coverage.
- **Test surface: shared `auth-contract.test.ts`.** Cross-user assertions live there per the file's own header comment ("Cross-user ownership assertions ... live in the sibling ownership task f39a20a7").
- **No new helper, no new shared package.** The guards in each route are 1–2 lines and read `req.session!.userId` directly. A shared `assertOwnership(req, record)` helper would be over-engineering for current scope; flag for future consolidation if it grows.

## Implementation plan

### Step 1 — Add same-user + cross-user coverage to `auth-contract.test.ts`

The file already has the per-route describe blocks for `cards.ts`, `alerts.ts`, `transactions.ts` (path-parameter IDOR vectors). The 401-only contract is satisfied; we extend each block with same-user success and cross-user denial assertions.

Test surface per route family:

- **Cards (`POST /cards/:cardId/budget`, `GET /cards/:cardId/spend-summary`)**:
  - Same-user: mint a session whose `userId` matches `linkedCard.userId = 'user_1'`. Expect 200 with the budget/spend payload.
  - Cross-user: mint a session for `user_2`. Stub `linkedCard.findUnique` to return `{ id: 'card_1', userId: 'user_1', ... }`. Expect 404 (matching the existing guard pattern).
  - Missing record: stub `findUnique` to return `null`. Expect 404.
- **Alert-config (`GET/POST/DELETE /cards/:cardId/alert-config`)**:
  - Same-user: 200 / 200 / 200 with the config.
  - Cross-user: 200 with `{ config: null }` for GET (matches existing behavior — `GET` returns null rather than 404 because the absence of an alert config for a card is not sensitive), 404 for POST and DELETE.
  - Missing card: GET → `{ config: null }`; POST/DELETE → 404.
- **Alerts (`DELETE /alerts/:alertId`)**:
  - Same-user: 200 `{ ok: true }`.
  - Cross-user: 404.
  - Missing alert: 404.
- **Transactions (`PATCH /transactions/:transactionId/category`)**:
  - Same-user: 200 with the updated transaction.
  - Cross-user: 404, **and** assert `prisma.transaction.update` was NOT called and `recordCategorizationFeedback` was NOT called (no mutation).
  - Missing transaction: 404.

Where the existing `mocks.prisma.*` setup returns `user_1`-owned records by default, we either reuse it (for same-user) or override in the cross-user test (`mockResolvedValueOnce({ ..., userId: 'user_1' })` while the session belongs to `user_2`). The session minting pattern follows `session-middleware.test.ts`.

### Step 2 — Resolve AC4 (decision needed before merge)

AC4 as written today: *"Cross-user access returns 403 and does not reveal or mutate the resource."*

The shipped code returns **404**, not 403. Both choices satisfy the security intent ("does not reveal or mutate"):

- **404** (current): Does not reveal whether the resource exists. Standard practice for ownership-on-path-param routes. Matches the audit's "does not reveal" phrasing.
- **403** (literal AC text): Reveals the resource exists but the caller can't access it. Easier to debug for legitimate cross-user flows.

Recommendation: **keep 404, PATCH the task AC4 text to match.** The security intent is preserved; the literal "403" in the AC was almost certainly written without checking the existing 404 pattern that PR #316 established.

Two paths:

- **Path A (preferred):** PATCH the task description via `PATCH /api/v1/tasks/f39a20a7-...` (JSON-wrapped, per the recent lessons) to change AC4 to *"Cross-user access returns 404 and does not reveal or mutate the resource."* This keeps the lobster's AC-text-verbatim check happy and avoids a behavior change.
- **Path B:** Flip the guards from 404 → 403 across all seven routes. This is a small but observable API behavior change, breaks the precedent set by PR #316, and is the wrong security tradeoff. We should not take this path without explicit Quinn/Tom direction.

This tech-design ships Path A. Quinn: please confirm or push back.

### Step 3 — System spec

`docs/systems/code-task-workflow.md` does not need an update; ownership-on-path-param is a local pattern, not a cross-cutting concern. Skip the `## System Spec` section in the PR body and include a one-line "no system spec change" rationale.

### Step 4 — App spec

`services/budget-api` has no `SPEC.md`. The route ownership behavior is documented in this tech design and (after merge) in the PR. No app-spec action needed.

## Data model / API contract

- No schema changes.
- API behavior change: none on the happy path; same-user responses are identical to today. Cross-user responses continue to return 404 (not 403) per the existing pattern.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — `GET /cards/:cardId/alert-config`, `POST /cards/:cardId/alert-config`, `DELETE /cards/:cardId/alert-config`, and card summary/budget routes verify card belongs to session user | Existing code already does this (`alerts.ts` lines 59/93/120, `cards.ts` lines 115/142). Test coverage added in `auth-contract.test.ts` proves same-user 200 and cross-user 404. |
| AC2 — `DELETE /alerts/:alertId` verifies alert belongs to session user | Existing code (`alerts.ts` line 46). Test coverage added. |
| AC3 — `PATCH /transactions/:transactionId/category` verifies transaction belongs to session user | Existing code (`transactions.ts` line 45). Test coverage added; assertion also proves `update` and `recordCategorizationFeedback` were NOT called. |
| AC4 — Cross-user access returns 403 and does not reveal or mutate the resource | Code returns 404; per Step 2, we PATCH the task AC4 text to say "404". The "does not reveal or mutate" intent is preserved; same-user-200/cross-user-404 tests prove it. |
| AC5 — `auth-contract.test.ts` or equivalent coverage proves same-user success and cross-user denial for each route family | The diff itself: ~7 new `it()` blocks across 4 describe blocks. |

User-visible ACs: none — this is server-internal hardening. The mobile app already sends the correct Bearer token per PR #316; no client change is required.

## Open questions and risks

- **AC4 text fix needs Quinn sign-off** (Step 2 Path A). If Quinn prefers Path B (flip to 403), the PR grows by ~10 lines of route diffs plus a deprecation note for any existing 404 callers (none expected — the mobile app treats 404 as "not found" and does not distinguish 403).
- **Mock fidelity for cross-user sessions.** The existing `auth-contract.test.ts` does not mint a real session; it relies on the request never reaching the route handler. For same-user success tests we need a valid session whose `userId` matches the stubbed record. The `session-middleware.test.ts` file shows the pattern; we mirror it.
- **`prisma` mock surface for cards/alerts/transactions.** The file already mocks `linkedCard.findUnique`, `cardMonthlyBudget.upsert`, `balanceAlertConfig.findUnique/upsert/delete`, `notificationEvent.findUnique`, `transaction.findUnique/update`. We may need to add `transaction.delete` mocks or similar minor surface; will discover when writing the tests.

## Linked audit

- `docs/repo-audits/2026-W29.md` — Theme 1 (Budget-API auth), Milestone 1-B, severity Critical. Effort estimate: S (<2h), risk: Low.

## Out of scope (recap)

- Path-parameter routes not in scope (none today beyond what's listed above).
- New shared ownership helper (premature; flag for future).
- Any change to `/akahu/*`, `/categories/*`, `/categorize/*` — no path params to guard.
- Cross-service auth consolidation (separate future boundary).