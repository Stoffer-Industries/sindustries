---
status: awaiting-approval
task_id: de9d8594-4825-40f5-bfb3-30ac31cc50e7
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Budget API async error containment

## Intent and scope

Task: **Contain rejected promises across Budget API handlers**. Source: `docs/repo-audits/2026-W42.md`, F1. Preserve successful responses and authentication decisions while making failed async dependencies reach the existing sanitized HTTP error handler. This is corrective code work, not a new product feature or approved implementation.

Repository: `Stoffer-Industries/sindustries`. Implementation branch: `task-de9d8594-budget-async-error-boundary`; worktree: `/Volumes/WD1/worktrees/rowan/task-de9d8594-budget-async-error-boundary`. The W42 audit draft (`docs/specs/budget-api-async-error-boundary-w42-tech-design.md` on the audit branch) is the original finding context; this file is the implementation-branch copy awaiting Quinn's structured `tech_design` approval.

## Local source-of-truth additions vs the W42 audit draft

The W42 audit draft is the correct shape; this copy keeps it intact and only adds the two implementation-branch metadata lines above. Any future edit to the design should land here first; the audit-branch copy remains the historical record.

## Ownership and boundaries

Natural source of truth: Budget API's HTTP boundary and its existing service-owned repositories. Keep the adapter in `services/budget-api/src/lib/`; do not create a cross-service shared package until another service has a demonstrated identical requirement. This service-local implementation is the final appropriate scope, not a temporary client shim. No database ownership, external credentials, cron, skill, or `.openclaw` runtime changes are required.

## Proposed implementation

1. Inventory every asynchronous Express middleware and route in `src/middleware/` and `src/routes/`.
2. Add a typed wrapper that safely invokes the handler, catches synchronous throws, and forwards rejected promises to `next(error)`. Do not introduce a global Express monkeypatch or an Express major upgrade.
3. Apply it to `requireSession` at one consistent layer and to async route callbacks. Preserve early-response behavior and avoid wrapping/calling a handler twice.
4. Keep the current JSON error envelope in `src/app.ts`; verify behavior when headers are already sent rather than emitting a second response. Do not turn dependency failures into authentication failures or expose Prisma/provider error text.
5. Update the relevant existing system reference if failure behavior changes need documenting; include an async-handler inventory in implementation evidence.

Data model: unchanged. Successful API shapes/status codes: unchanged. Intended correction: rejected dependencies produce a sanitized HTTP failure instead of a hanging request/unhandled rejection. Logs should contain actionable errors but no tokens or request authorization headers. No new credential or permission boundary is introduced.

## Verification matrix

| Task criterion | Planned evidence |
| --- | --- |
| AC1: rejected auth and route dependencies return sanitized 500 without hanging/unhandled rejection | Supertest against `createApp`, injecting rejecting Prisma session/read/write operations; bounded timeout; assert error envelope and no raw dependency message. |
| AC2: later request succeeds; ownership responses are preserved | Paired failure-then-success requests plus existing auth/ownership contract suites. |
| AC3: regression coverage and handler inventory | Table of every async Express callback with the wrapper location; rejection cases for middleware, read route and write route. |

Use an isolated child process if verifying unhandled-rejection absence would otherwise interfere with Vitest's process-wide handlers. Browser E2E is disproportionate for a dependency-failure transport invariant; HTTP integration is the directly observable boundary. Existing Budget DB ownership integration remains required, but do not reset shared dev/prodlike data.

## Risks, rollout and review

Risks: double-next, writing after headers have been sent, and accidentally converting business 401/404 responses into 500s. Review the wrapper and inventory together. Deploy through normal service CI; rollback is reverting the bounded implementation PR, with no migration. This draft needs normal technical review; it grants no structured approval. Do not postpone the localized fix to bundle category aggregation or session lifetime policy.
