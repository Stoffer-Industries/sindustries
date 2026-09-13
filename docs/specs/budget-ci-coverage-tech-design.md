---
status: draft
task_id: 1eb22a09-7b55-4cb4-a7a4-2058fb4d27f2
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Close Budget CI coverage and database verification gaps — tech design

**Parent task:** `1eb22a09-7b55-4cb4-a7a4-2058fb4d27f2` (Close Budget CI coverage and database verification gaps), tracked from audit `docs/repo-audits/2026-W38.md` finding **F4 — Budget CI overstates database coverage and omits shared-domain checks**. Tranche **T0 / F4 — Safety net** of the W38 audit.

This is a code task (not a feature task): no product spec, no user-visible behavior change, no schema change. The change is CI workflow restructuring plus one new test file that exercises the existing app/repository boundary against a real migrated Postgres database. The change closes a long-standing audit gap where the CI job labeled "unit + db integration" only ran unit tests and never invoked the budget-domain or budget-mobile checks that the rest of the workspace already declared.

## Repository

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-1eb22a09-budget-ci-gaps` (off `origin/main` @ `95094488`)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-1eb22a09-budget-ci-gaps`
- **PR:** (pending — to be opened after Quinn approves this design)

## Service boundary and ownership

No service-ownership change, no API contract change, no schema change, no new runtime dependency. The fix touches CI only and adds one test file that exercises the existing budget-api HTTP surface against the same Postgres service the existing `tasks-app-e2e` job already provisions. Direct consumers:

- `.github/workflows/ci.yml` — the existing CI workflow. Currently contains one misleadingly-named job (`budget-api-tests`) that runs unit tests, then `prisma:migrate` + `prisma:seed`, then exits. This PR splits that job into two honestly-named jobs (`budget-api-unit` and `budget-api-db-integration`), adds the budget-domain + budget-mobile checks to the unit job, and wires the new integration test into the db-integration job.
- `services/budget-api/test/ownership-contract-integration.test.ts` — **new** Vitest suite. Calls the actual `createApp()` boundary the mocked `services/budget-api/test/ownership-contract.test.ts:1` already constructs, but uses real Prisma against the existing CI Postgres service instead of `vi.mock('../src/lib/prisma.ts')`.
- `services/budget-api/src/auth/session.ts` — `hashSessionToken` is imported unchanged so the integration test mints session rows the same way `services/budget-api/src/routes/session.ts` does in production. No edit to this file.

The same Postgres service used by the existing `tasks-app-e2e` job (`.github/workflows/ci.yml:57`, `:408`) is reused; no new service image, port, or `DATABASE_URL` is introduced.

## `.openclaw` boundary

None. CI changes only. No `~/.openclaw/`, cron, or skill changes.

## Source of truth (ownership boundary check)

The natural source of truth for "does the budget-api ownership contract actually hold against the real database" is the **Postgres service the budget-api is designed to run against**. The current CI does not exercise that source — it mocks Prisma entirely (`services/budget-api/test/ownership-contract.test.ts:4–21`), so a real bug in the Prisma layer (mistyped field, missing `where`, broken transaction boundary) would silently pass CI.

The durable boundary is therefore: **CI must run an integration suite that calls the real app/repository boundary against the real migrated database, with deterministic per-test cleanup and external HTTP stubs only where the real network is not reachable from CI.** Anything that keeps the existing "mocks only" pattern is a regression of this finding; the audit calls this exact gap "migration/seed success is mistaken for API/database integration coverage" (`docs/repo-audits/2026-W38.md` F4).

There is no useful interim shim: a separate Vitest project that runs the same Prisma calls but mocks the `prisma` import is just the existing test with a different name. The fix is the real DB.

## Implementation plan

### File/module scope

Three file changes plus one new test file:

1. **`.github/workflows/ci.yml`** — restructure the existing `budget-api-tests` job:
   - **Rename** `budget-api-tests` → `budget-api-unit` and update the displayed `name:` from "budget-api tests (unit + db integration)" to "budget-api unit + domain/mobile checks". The current name is the lie AC3 fixes.
   - **Append** three steps after the existing `Run unit tests` step (after `.github/workflows/ci.yml` line `:336`):
     - `Run packages/budget-domain tests`: `npm test --workspace packages/budget-domain`
     - `Run packages/budget-domain typecheck`: `npm run typecheck --workspace packages/budget-domain`
     - `Run apps/budget-mobile typecheck`: `npm run typecheck --workspace apps/budget-mobile`
   - These match the `test` and `typecheck` scripts already declared in `packages/budget-domain/package.json:9` and `apps/budget-mobile/package.json:10`.
   - **Add** a new sibling job `budget-api-db-integration` that mirrors the same checkout + Node + cache + `npm ci` + prisma:generate + prisma:migrate + prisma:seed steps (so the migration is real, not skipped), then runs the new integration test file:
     - `Run ownership-contract integration (real DB)`: `npm test --workspace services/budget-api -- ownership-contract-integration`
     - This depends on the same Postgres service the existing `tasks-app-e2e` job already declares (`postgres:16` on port 5432), so we reuse that shape inline.
   - **Wire** the new job to depend on `budget-api-unit` only if needed for ordering (it does not need to — both jobs are independent fast checks against the same migration). Independent is cheaper.

2. **`services/budget-api/test/ownership-contract-integration.test.ts`** — **new**, ~150–200 lines, mirrors the structure of `services/budget-api/test/ownership-contract.test.ts` (same test descriptions, same fixtures shape) but without the `vi.mock('../src/lib/prisma.ts')` and `vi.mock('../src/services/categorizer.ts')` blanket mocks. Specific shape:
   - **Setup (in a `beforeAll` block)**: clean any existing rows from the integration tables (`session`, `linked_card`, `card_monthly_budget`, `transaction`, `notification_event`, `balance_alert_config`, `account_balance_snapshot`, `categorization_feedback`) using `prisma.$executeRawUnsafe('TRUNCATE TABLE ... CASCADE')`. Then insert two real users (USER_1, USER_2), two hashed sessions (via `hashSessionToken` from `services/budget-api/src/auth/session.ts:9`), and two linked cards.
   - **Per-test (in `beforeEach`/`afterEach`)**: clean only the rows touched by the test (the relevant subset of the tables above) to keep tests independent. Truncate-with-cascade is the cleanup primitive; the existing Prisma schema's `onDelete: Cascade` is what makes this safe (`services/budget-api/prisma/schema.prisma`).
   - **Tests**: same assertions as the mocked test — same-user success, cross-user 404 (no info-leak), missing record 404 — but against real Postgres. Cover `/cards/:cardId/budget`, `/cards/:cardId/spend-summary`, `/transactions/:id`, `/alerts`, `/categories/:transactionId`. ~10–12 cases total.
   - **Akahu stub**: the existing budget-api code calls `akahuClient` (`services/budget-api/src/services/akahuClient.ts`) which makes real outbound HTTP calls. In CI, those endpoints are not reachable and the audit explicitly says "keep external Akahu calls stubbed." Stub the network layer using `nock` (already a devDep in the workspace) at `services/budget-api/test/akahuClient.test.ts:1` is already installed; same primitive applies. Stub `GET /v1/accounts` and `GET /v1/cards` for the two fake user IDs. Alternatively, mock the `akahuClient` module-level export only — `nock` is more honest because it exercises the real HTTP path.
   - **Skip in non-CI**: the test sets `process.env.BUDGET_API_INTEGRATION_TEST = '1'` at the top and `it.skip` if the env var is unset, so local developers running `npm test` against a non-existent DB are not broken. CI sets the env var in the new job's `env:` block.

3. **`.github/workflows/ci.yml` (continued)** — add a `BUDGET_API_INTEGRATION_TEST: '1'` env var to the new `budget-api-db-integration` job's `env:` block.

4. **No changes to** `services/budget-api/src/**`, `services/budget-api/prisma/**`, `packages/budget-domain/**`, `apps/budget-mobile/**`. The whole point of the audit's safety-net tranche is that the code is fine and the CI is what was lying.

### Trade-offs

- **CI runtime increase.** Adding the budget-domain and budget-mobile checks adds ~30–60 seconds to the unit job (budget-domain Vitest is fast, mobile typecheck is the slow one). The new integration job adds ~60–120 seconds for the real-DB suite. Acceptable because both are caught by the existing weekly retro if they grow.
- **Two parallel jobs vs. one.** Splitting the unit and integration jobs into two means duplicating the checkout + Node + `npm ci` + prisma:generate + prisma:migrate setup (~30 seconds of duplicated work). Considered running them as sequential steps in one job; rejected because AC3 explicitly asks the labels to "distinguish" the two, and a single job with a misleading step name repeats the original lie at finer granularity.
- **External Akahu stubs.** Using `nock` is the honest choice (real HTTP path, stubbed at the network edge) and reuses an existing devDep. Considered mocking the `akahuClient` module directly; rejected because it bypasses the part of the code that actually serializes the request.

## Data model / API contract / schema changes

None.

## Workflow / cron / skill changes

None beyond the CI workflow file changes above. No new cron, no new skill.

## Test plan and AC verification matrix

AC1: *CI runs packages/budget-domain tests and typecheck and apps/budget-mobile typecheck.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `npm test --workspace packages/budget-domain` runs the existing `src/budgets.test.ts` and `src/categories.test.ts` and passes in the renamed `budget-api-unit` job | CI | CI |
| `npm run typecheck --workspace packages/budget-domain` (`packages/budget-domain/package.json:9`) passes | CI | CI |
| `npm run typecheck --workspace apps/budget-mobile` (`apps/budget-mobile/package.json:10`) passes | CI | CI |
| The new steps are visible as distinct `Run ...` steps in the GitHub Actions UI so the coverage is greppable from the run log | CI | CI |

AC2: *An isolated Postgres integration suite exercises budget session lookup and cross-user ownership against real migrated rows without Prisma mocks, after migration in CI.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `services/budget-api/test/ownership-contract-integration.test.ts` runs in the new `budget-api-db-integration` job against the real CI Postgres service (no `vi.mock('../src/lib/prisma.ts')`) | integration | CI |
| Same-user scenarios succeed (HTTP 200) for `/cards/:cardId/budget`, `/cards/:cardId/spend-summary`, `/transactions/:id`, `/alerts`, `/categories/:transactionId` | integration | CI |
| Cross-user scenarios return 404 (no info-leak) for the same routes | integration | CI |
| Per-test cleanup: each `afterEach` truncates the touched tables so a failing test does not leak state into the next run | integration | CI |
| Akahu outbound calls are stubbed at the network layer (`nock`) so the test never hits the real Akahu API | integration | CI |
| The test self-skips when `BUDGET_API_INTEGRATION_TEST` is unset so `npm test` locally still works | integration | test code |
| Existing mocked unit tests (`services/budget-api/test/ownership-contract.test.ts`) remain unchanged and continue to pass in the unit job | unit | CI |

AC3: *CI labels distinguish unit contracts from real database integration; existing unit tests remain green.*

| Verification | Layer | Owner |
| --- | --- | --- |
| Job `budget-api-tests` is renamed to `budget-api-unit` with `name: "budget-api unit + domain/mobile checks"` — the misleading "(unit + db integration)" string is gone | CI | CI |
| New job `budget-api-db-integration` has `name: "budget-api db integration (real Postgres)"` and is listed as a separate job in the workflow file | CI | CI |
| Both jobs appear as distinct entries in the GitHub Actions run summary | CI | CI |
| The existing mocked unit test suite (`ownership-contract.test.ts`) is not modified and continues to pass | unit | CI |
| The renamed unit job runs the same suite of unit tests the old job ran, plus the three new declared checks (AC1), with no regression in pass/fail count | CI | CI |

E2E coverage note: the ACs are CI verification contracts, not user-visible behavior. The closest "E2E" surface for AC2 is exactly the new integration suite — it exercises the actual Express app + actual Prisma + actual Postgres, which is as close to a deployed smoke test as CI can get without spinning up Fly. Lower-level fallback (`unit`/`component`) is what the existing mocked `ownership-contract.test.ts` already covers, so the new file is purely additive and targets the specific gap the audit called out.

## Open questions and risks

- **Open question:** does `apps/budget-mobile`'s typecheck depend on `@sindustries/ui` or `@sindustries/design-tokens` workspaces building first? `apps/budget-mobile/package.json:9–10` imports both as `file:` references. The existing CI step `Ensure Rollup Linux native binary is present` (`apps/tasks` analogue at `.github/workflows/ci.yml:402`) suggests the workspace install handles this; if mobile typecheck fails on a missing tsc path, fix by adding the same Rollup binary install step. Implementation confirms on first CI run.
- **Risk (low):** the budget-domain Vitest setup uses `chai` and `std-env` (`packages/budget-domain/node_modules/chai` present at the workspace root). If those are not declared as devDeps in `packages/budget-domain/package.json:13–14`, `npm test --workspace packages/budget-domain` will fail to find them — but they are likely hoisted from the root install. Implementation checks on first CI run.
- **Risk (medium):** adding `nock` to the integration test means a new devDep at `services/budget-api/package.json`. The audit says reuse `nock` because it is already a devDep at the workspace root; if `services/budget-api` does not currently declare it, the workspace install will still hoist it, but the integration test's import will work. If hoisting breaks (rare for root-only deps), add `"nock": "*"` to `services/budget-api/package.json:devDependencies` as a separate one-line follow-up. Implementation first attempts without the explicit dep and falls back to declaring it if needed.
- **Risk (low):** truncating tables in CI is destructive to whatever data the migration + seed put there. The CI Postgres service is throwaway (one container per job), so this is safe — but if a future change shares the Postgres service across jobs, this PR's `TRUNCATE` would erase data mid-run. Implementation documents this constraint in the test file header comment so a future engineer changing the CI topology does not silently break this.
- **Risk (low):** the renamed `budget-api-unit` job will appear as "new" in CI run history for the first merge — anyone with a saved `branch == main` required-check on the old job name will see the check flip off until they update the required-check policy. This is a Tom-side one-line change; mention it in the PR description so it is not a surprise.

## Coordination with sibling tasks

- **Task `2b66ae79` (Align Fly deployment triggers with npm build inputs)** touches `.github/workflows/*.yml` for paths filters, not the CI workflow. No conflict.
- **Task `a858ffce` (Build GymTrack MCP from the tested npm lockfile)** touches `.github/workflows/gymtrack-mcp-deploy.yml` and `services/gymtrack-mcp/Dockerfile`. No conflict.
- **Task `37f4d7d2` (Remediate high/critical npm audit vulnerabilities)** is a separate dependency remediation workstream. The new `npm ci` step in the integration job uses the same root `package-lock.json`, so any lockfile change from that workstream lands naturally.
