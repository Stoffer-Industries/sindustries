---
status: draft
task_id: 4c944152-4d21-43e6-a7a4-247142f0481c
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech Design — Automatically deploy changed production Vercel frontends

## Product intent summary

When a merge to `main` changes the Tasks app, Mission Control, or a repository-owned input used to build either app, the affected production frontend must enter the existing protected Vercel deployment path without someone remembering to dispatch it. This closes the silent state where a PR is merged and green while the stable production hostname serves an older bundle. The automatic path must retain every existing production control, avoid deploying an unaffected frontend, and fail before promotion when Vercel's live build-time environment cannot produce the URLs declared by the repository contract.

- Product spec: `n/a` (the task record is the product source for this internal delivery change)
- Task: `4c944152-4d21-43e6-a7a4-247142f0481c` — Deploy Vercel frontends automatically when `apps/tasks` or `apps/mission-control` changes land on `main`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-4c944152-vercel-frontend-auto-deploy`
- Worktree: `/Volumes/WD1/worktrees/rowan/task-4c944152-vercel-auto-deploy`

## Current state and failure

`.github/workflows/deploy-production-vercel-frontends.yml` is both manually dispatchable and reusable through `workflow_call`. It owns the `production` GitHub Environment, `PRODUCTION_VERCEL_DEPLOY_ENABLED`, serialized per-surface concurrency, Vercel project resolution, candidate build and smoke, promotion, TLS verification, and live-bundle verification. No job calls it, so only `workflow_dispatch` is active.

That omission was observed on 2026-11-23: PRs #1041 and #1027 merged while `tasks.sindustries.co.nz` continued serving the pre-merge build. A second failure mode was observed while repairing Mission Control: `VITE_TASKS_APP_URL` was successively missing, empty, and sensitive. Vercel's production-sensitive default caused `vercel pull` to write an empty value, so builds completed with the wrong URL baked in.

## Ownership-boundary check

**Natural source of truth: workflow/cross-app contract.** `.github/workflows/ci.yml` already owns changed-surface detection, the required merge gate, and automatic post-merge deployment calls. The durable solution is two CI change outputs and two callers of the existing reusable production-frontend workflow. Deploy implementation remains solely in `.github/workflows/deploy-production-vercel-frontends.yml`; no second auto-deploy workflow or duplicated shell sequence is introduced.

The affected-source contract is:

- `tasks_app`: `apps/tasks/**`, `packages/ui/**`, `packages/design-tokens/**`, `infra/cloud/vercel-env-matrix.json`, and `infra/cloud/hostname-matrix.json`.
- `mission_control`: `apps/mission-control/**`, `packages/ui/**`, `packages/design-tokens/**`, `infra/cloud/vercel-env-matrix.json`, and `infra/cloud/hostname-matrix.json`.

The shared packages are direct workspace dependencies imported by both apps. Either cloud matrix selects both surfaces because the matrices jointly choose projects, hostnames, and build-time values. An app dependency update changes its `package.json`, inside its app path. Root `package-lock.json` and `package.json` alone are deliberately not selectors: either can change for backend-only dependencies, and blanket frontend selection would violate AC3. A future new workspace import must add its package path to the corresponding filter and contract test.

This is a small mergeable cut, not an interim shim. Calling the reusable workflow is less code than a new dispatcher and prevents manual and automatic controls from drifting.

## `.openclaw` boundary notes

No `.openclaw` files, agents, skills, or crons change. Quinn remains the out-of-repo owner of the GitHub `production` Environment: its required-reviewer rule, deploy-gate variable, and masked Vercel secrets. A matching merge creates the deployment automatically, but GitHub still pauses the `environment: production` job for review. Quinn also owns repairing a live Vercel variable as a non-sensitive production value. No secret or value enters source, logs, or task comments.

## Implementation plan

### 1. Central changed-surface detection

Update `.github/workflows/ci.yml` to expose `tasks_app` and `mission_control` from the existing `changes` job and add the exact path filters above. Keep full-history checkout and the commit-pinned `dorny/paths-filter`. App-local changes select one surface; shared packages and either matrix select both; docs-only, service-only, and unrelated infra changes select neither.

### 2. Reuse the protected production workflow

Add `deploy-tasks-app-production` (`surface: tasks-app`) and `deploy-mission-control-production` (`surface: mission-control`) jobs to `.github/workflows/ci.yml`. Each job:

- needs `changes` and `merge-gate`;
- requires a `push` to `refs/heads/main`, a successful merge gate, and its own output equal to `'true'`;
- uses `./.github/workflows/deploy-production-vercel-frontends.yml` with `secrets: inherit`.

No deploy job runs on pull requests. The callee retains manual dispatch, `environment: production`, its deploy gate, per-surface concurrency, candidate/promotion sequence, and post-promotion live-bundle verifier. Thus the automatic path cannot bypass a manual-path control.

### 3. Validate the live Vercel environment after pull

Add `tests/cloud/scripts/check-live-vercel-env-contract.mjs`. Given a surface and the dotenv file written by `vercel pull`, it resolves that production project and expected `VITE_*` map from both cloud matrices, parses without logging values, and fails when a declared key is absent, empty, or unequal to the contract.

Call it immediately after the existing repository-root `vercel link` + `vercel pull` step and before `vercel build`. Vercel writes a production-sensitive value to `.vercel/.env.production.local` as empty, so the empty-value failure rejects the sensitive/encrypted state in AC4 using the exact artifact consumed by CI. `vercel env ls` is intentionally not used because name presence does not prove the build receives a value. Diagnostics name only project/environment/key and say the value must be non-sensitive.

### 4. Verify the built artifact before deployment

Add `tests/cloud/scripts/verify-built-vercel-bundle.mjs`. It reads the selected production contract and scans JavaScript assets under `.vercel/output/static` after `vercel build`, requiring every expected production value and rejecting every staging hostname.

Run it between `vercel build` and `vercel deploy --prebuilt`. This reproduces the predictive path (`repo root -> link -> pull -> build -> inspect output`) before any candidate is created. Retain the existing post-promotion `Verify stable hostname, TLS, and live bundle` step. Extract only expected-value/staging-needle derivation into a shared helper if needed so the built and live verifiers cannot disagree.

### 5. Repository contract tests

Extend `tests/cloud/scripts/check-production-vercel-deploy-contract.mjs` and its unit suite to assert:

- manual and reusable entries remain;
- both CI callers use this same callee, correct surface, inherited secrets, merge gate, and `main`-push condition;
- the callee retains the production Environment, deploy gate, non-cancelling concurrency, promotion, and live verifier;
- pulled-env validation is after pull and before build;
- built-bundle validation is after build and before deploy.

Extend `infra/cloud/scripts/tests/ci-deployment-gates.test.sh` (or add a focused Node suite if its fixture API is clearer) with path fixtures. Positives: each app, each direct shared package, and each matrix. Negatives: docs, backend service, and unrelated cloud infra. Shared/matrix fixtures select both; app fixtures select only one.

Add unit suites for both new scripts under `tests/cloud/tests/`. Env cases: matching, missing, empty/sensitive, wrong, and extra undeclared key (ignored because the contract declares requirements, not an exhaustive inventory). Bundle cases: matching, missing expected value, staging leak, and no JS assets.

### 6. Durable documentation

Update `docs/runbooks/production-cloud-cutover.md` with automatic triggers, reviewer pause, path rules, environment remediation, evidence, and rollback. Update `docs/systems/cloud-platform.md` with the CI caller topology and pulled-env/prebuilt/live checks. Ship implementation in its own PR. Record its post-merge frontend deployment run and a nearby successful non-frontend `main` run where both jobs skipped.

## Data model and API contract changes

No database, HTTP API, Tasks API, or user-facing app contract changes. Internal contracts added:

- CI outputs `tasks_app` and `mission_control`;
- `check-live-vercel-env-contract.mjs --surface <tasks-app|mission-control> --env-file <path> [--repo-root <path>]`;
- `verify-built-vercel-bundle.mjs --surface <tasks-app|mission-control> [--output-dir <path>] [--repo-root <path>]`.

Both script CLIs emit value-free errors and a stable one-line or machine-readable success result.

## Workflow, cron, and skill changes

- **Workflow:** `ci.yml` gains two outputs/callers; the existing deploy workflow gains pre-build env and pre-deploy artifact checks.
- **Cron:** none.
- **Skills:** none.
- **OpenClaw:** none; live GitHub/Vercel ownership remains with Quinn.

## Test plan and acceptance-criterion verification matrix

| AC | Planned layer | Verification |
|---|---|---|
| AC1 | Integration + E2E | Path fixtures prove each app, direct imported package, and both matrices select the correct surfaces. Workflow contract tests prove only successful `main` pushes call the callee. After merge, GitHub Actions must show the affected production job completed against the merged SHA after required review. |
| AC2 | File/integration + E2E | Contract tests assert both callers use the existing workflow and the callee retains the production Environment, deploy gate, concurrency, promotion, and live verifier. The post-merge run proves traversal; no duplicate deploy implementation exists. |
| AC3 | Integration + manual control evidence | Negative fixtures require both outputs false for docs/backend/unrelated infra. Record a real non-frontend `main` run with both jobs skipped and no Vercel release. Local E2E is disproportionate because proving provider non-mutation requires control-plane observation; deterministic filter integration is the fallback. |
| AC4 | Unit + integration + E2E | Unit fixtures fail for missing, empty/sensitive, and wrong pulled values. Ordering tests require root link/pull, env validation, build, built-output validation, deploy, then live validation. The protected post-merge run supplies live-project and bundle evidence; provider behavior cannot be simulated offline. |
| AC5 | File + E2E/manual evidence | File assertions cover both required docs and implementation stays in one PR. Attach the post-merge frontend-positive run and a non-frontend control-run URL. |

Planned local commands:

```sh
node tests/cloud/scripts/check-production-vercel-deploy-contract.mjs
node --test tests/cloud/tests/check-production-vercel-deploy-contract.test.mjs
node --test tests/cloud/tests/check-live-vercel-env-contract.test.mjs
node --test tests/cloud/tests/verify-built-vercel-bundle.test.mjs
bash infra/cloud/scripts/tests/ci-deployment-gates.test.sh
```

Live tests use the protected GitHub workflow, never developer-machine production credentials.

## Open questions and risks

1. **Human review remains intentional.** “Without human dispatch” does not mean without production approval. Removing the reviewer would violate AC2.
2. **AC5 positive evidence is post-merge.** The implementation PR's merge is the first real `main` push containing the callers. Quinn should approve only if task acceptance may collect that run afterward; the PR must not claim this evidence before it exists.
3. **Shared dependencies can drift.** Current direct runtime workspace imports are `packages/ui` and `packages/design-tokens`; new imports must update filter and test. A general dependency-graph engine is out of scope.
4. **Root lockfile trade-off.** Excluding lockfile-only changes prevents backend dependency churn from violating AC3. App/shared dependency changes remain selected by their adjacent manifest path. Blanket lockfile deploys would be a later policy change.
5. **Sensitive diagnosis is indirect but outcome-accurate.** Pull exposes sensitive values as empty, so the check may report “empty or sensitive” rather than distinguish metadata. Both states require the same repair and produce the same bad bundle.
6. **Matrix edits deploy both.** This can create two reviewer prompts but ensures both projects validate a shared contract change.
7. **Approval backlog.** `cancel-in-progress: false` preserves safety but repeated merges queue old SHAs. The runbook should explain cancelling obsolete queued runs; concurrency semantics are out of scope.

## Out of scope

- Weakening the production reviewer or deploy gate.
- Automatically mutating Vercel environment variables.
- Staging projects or other Vercel apps.
- General-purpose monorepo dependency graph generation.
- OpenClaw cron/agent changes.
