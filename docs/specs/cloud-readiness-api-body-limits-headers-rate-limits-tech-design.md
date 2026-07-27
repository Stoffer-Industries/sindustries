---
status: draft
task_id: cc7a4e38-89c8-4adc-bdce-8ce2c4a5e4a6
product_spec: n/a (audit-driven: docs/repo-audits/2026-W25.md S3/S5 + docs/repo-audits/2026-W27.md budget-api hardening)
shipped_pr: null
shipped_date: null
---

# Cloud readiness: add API body limits, headers, and rate limits

## Links

- Product spec: n/a — derived from `docs/repo-audits/2026-W25.md` (S3, S5) and `docs/repo-audits/2026-W27.md` budget-api hardening findings
- Tech design: `docs/specs/cloud-readiness-api-body-limits-headers-rate-limits-tech-design.md`
- Task: `cc7a4e38-89c8-4adc-bdce-8ce2c4a5e4a6`
- Tasks API record: `http://localhost:4001/api/v1/tasks/cc7a4e38-89c8-4adc-bdce-8ce2c4a5e4a6`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-cc7a4e38-cloud-readiness-api-body-limits-headers-rate-limits`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: none.

## Scope

Before cloud exposure, both `services/budget-api` and `services/tasks-api` need baseline HTTP hardening: explicit JSON body size limits, Helmet-compatible security headers, and targeted rate limiting on high-risk endpoints. The two services share a need but ship independently; this design covers both so the same pattern is visible across services.

## Ownership boundary

- HTTP hardening is a per-service concern: each service configures its own body limit, headers, and rate limits. We do **not** move these into a shared package in this task — the configuration values differ per service.
- We do align on a common `helmet` config preset (`docs/standards/helmet-preset.ts` style) so audits can verify both services match. The preset is a copy-paste reference, not a runtime dependency.
- Rate limit storage: in-memory (`express-rate-limit`'s default store) is fine for v1 because we run a single instance per service in cloud. If we move to multi-instance, we move to Redis-backed limits — out of scope.

## Implementation plan

File/module scope:

- `services/budget-api/src/server.ts` — add `express.json({ limit: process.env.BUDGET_API_JSON_LIMIT ?? '100kb' })` (replace any unbounded default). Add `helmet()` with the documented preset. Add `express-rate-limit` to `/akahu/exchange` and `/session/dev-login` with `windowMs` and `max` from env.
- `services/tasks-api/src/server.ts` — same: explicit `express.json({ limit: '100kb' })`, `helmet()`, and rate limits on Content Scheduler publish + task creation endpoints.
- `services/budget-api/src/middleware/helmetPreset.ts` — new. Small wrapper around `helmet()` with the documented CSP/HSTS/CORS config. Exported so the same shape can be mirrored in `services/tasks-api`.
- `services/budget-api/src/middleware/rateLimit.ts` — new. Factory `createRateLimit({ name, windowMs, max })` returning a configured `express-rate-limit` middleware. Logs hits at debug, blocks at warn.
- `services/budget-api/.env.example` — document `BUDGET_API_JSON_LIMIT`, `BUDGET_API_RATE_LIMIT_WINDOW_MS`, `BUDGET_API_RATE_LIMIT_MAX`. Defaults are dev-safe (large window, high max).
- `services/tasks-api/.env.example` — same trio with `TASKS_API_` prefix.
- `services/budget-api/test/body-limit.test.ts` — new. Posts a 200KB JSON payload, asserts 413 (Payload Too Large). Posts a 1KB payload, asserts 200.
- `services/budget-api/test/rate-limit.test.ts` — new. Hits `/akahu/exchange` past `max` in a window, asserts 429 on subsequent calls; resets after window.
- `services/budget-api/test/headers.test.ts` — new. Asserts response headers include `X-Content-Type-Options`, `Strict-Transport-Security`, `X-Frame-Options` per helmet preset.
- `services/tasks-api/test/{body-limit,rate-limit,headers}.test.ts` — mirrors of the above for tasks-api.
- `services/budget-api/README.md` + `services/tasks-api/README.md` — document the knobs and the env vars that change them.

## Data model / API contract

- No schema changes.
- New behavior:
  - Requests with JSON body > `JSON_LIMIT` return 413.
  - Rate-limited endpoints return 429 with `Retry-After` header when blocked.
  - All responses carry helmet headers per the preset.

## Workflow / cron / skill changes

- None.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — budget-api: explicit `express.json({limit})`, helmet headers, rate limits on `/akahu/exchange` + `/session/dev-login` | `body-limit.test.ts`, `headers.test.ts`, `rate-limit.test.ts` per service. |
| AC2 — tasks-api: explicit `express.json({limit})` + helmet headers | Same trio of tests under `services/tasks-api/test/`. |
| AC3 — rate limits configurable for cloud/runtime, safe for local tests | Env vars override defaults; defaults are large enough not to break tests; tests assert the override path works. |
| AC4 — tests cover oversized JSON + rate-limit behavior | See above. |
| AC5 — service READMEs or env examples document knobs | README + `.env.example` diffs in PR. |

User-visible ACs: none — these are infrastructure-level behaviors with user-visible effect only under attack/abuse. E2E not applicable. Coverage is at the unit/integration layer for each service.

## Open questions and risks

- **Helmet CSP and the mobile app**: budget-mobile's webview may need a permissive CSP for OAuth callbacks. We start with a strict CSP and add per-route exceptions only if a concrete page breaks.
- **Rate-limit storage**: single-instance assumption holds for v1. If cloud moves to multi-instance, switch to `rate-limit-redis`. Flagged in the README.
- **`express.json` order**: must be registered **before** route handlers. Easy to misorder during refactor — add a comment in `server.ts` noting the order constraint.

## Linked audits

- `docs/repo-audits/2026-W25.md` — S3 (body size), S5 (security headers).
- `docs/repo-audits/2026-W27.md` — budget-api hardening medium findings.