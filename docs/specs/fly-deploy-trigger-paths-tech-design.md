---
status: draft
task_id: 2b66ae79-af60-4f0a-b236-5e6ddddf0d3f
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Align Fly deployment triggers with npm build inputs — tech design

**Parent task:** `2b66ae79-af60-4f0a-b236-5e6ddddf0d3f` (Align Fly deployment triggers with npm build inputs), tracked from audit `docs/repo-audits/2026-W38.md` finding **F2 — Fly deployment filters miss root npm lockfile changes**. Tranche **T3** of the W38 audit's "Milestone 2 — High-leverage delivery correctness."

This is a code task (not a feature task): no product spec, no user-visible behavior change. The change is a CI/deployment plumbing correction that closes a deploy-input gap before the sibling task `a858ffce` (Freeze the MCP image dependency graph — T4) lands its Dockerfile change, so both land against an honest `paths:` contract.

**Superseded as a trigger contract (2026-11-07 staging consolidation; verified 2026-11-21).** This is a design-time document, and the deploy-trigger contract it describes no longer exists in the form it names. It shipped in PR #677 (task `2b66ae79` is `done`), but the surface it was written against has since moved twice over:

1. **The per-workflow `paths:` filter is no longer the trigger contract.** Every deploy workflow in `.github/workflows/` is now `on: workflow_call:` only — there is no `on.push` block in any of them. The trigger is the central CI caller: the `changes` job in `.github/workflows/ci.yml` runs `dorny/paths-filter` and selects which reusable workflow to call. The shipped fixture test was rewritten to match (task `02c5475c`); its header reads "moved to the central CI caller by task 02c5475c" and it now parses `ci.yml`'s `changes` filters, not the four workflows' `on.push.paths`.
2. **Three of the four target workflows are retired.** `deploy-staging-tasks-api.yml`, `deploy-staging-budget-api.yml` and `deploy-staging-auto-post-worker.yml` had their deploy jobs removed on 2026-11-07 (task `219fb673`), their Fly apps destroyed ahead of the consolidation, and they are `workflow_call`-only with no caller — retained pending the §5 cleanup in `docs/runbooks/platform-consolidation-rollback.md`.

The W38 F2 gap itself is closed on the live contract: every live surface filter in `ci.yml`'s `changes` job (`website`, `platform`, `gymtrack`, `gymtrack_mcp`, `budget_mobile`, `health_probe`) already lists both `package.json` and `package-lock.json`, and the shipped fixture asserts exactly that. The ACs below are kept as the record of what shipped; where they name a surface, a line number, or an assertion shape that has since changed, the annotation says so rather than rewriting the design.

## Repository

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-2b66ae79-fly-deploy-triggers` (off `origin/main` @ `95094488`)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/fly-deploy-triggers`
- **PR:** (pending — to be opened after Quinn approves this design)

## Service boundary and ownership

No service-ownership change, no API contract change, no schema change, no new dependency. The fix is four GitHub Actions workflow files plus one new fixture test. Direct consumers:

- `.github/workflows/deploy-staging-{tasks-api,budget-api,auto-post-worker}.yml` — three staging Fly deploy workflows; consumed by GitHub Actions on push to `main`. **Superseded (2026-11-07 consolidation; verified 2026-11-21):** these three are retired — their deploy jobs were removed in `cc21a828` on 2026-11-07, their Fly apps were destroyed ahead of the consolidation, and each file is `workflow_call`-only with no caller. None of them is consumed by a push to `main`; the live staging deploy surface is `deploy-staging-platform.yml`, called by `ci.yml`.
- `.github/workflows/gymtrack-mcp-deploy.yml` — production Fly deploy workflow for GymTrack MCP; consumed by GitHub Actions on push to `main`. **Superseded (verified 2026-11-21):** this file is `workflow_call:` only and is called by `ci.yml`'s `changes` job (`gymtrack_mcp` filter), not by a push. The MCP app itself (`gymtrack-mcp`, `services/gymtrack-mcp/fly.toml`) is unaffected.
- `infra/cloud/scripts/tests/fly-deploy-trigger-paths.test.sh` — **new** fixture test, mirrors the existing `mission-control-deploy-fixtures.test.sh` pattern. Wired into the existing `infra-cloud-bootstrap-staging-tests` CI job at `.github/workflows/ci.yml` (no new job). **Superseded (verified 2026-11-21):** the shipped test asserts `ci.yml`'s `changes` filters for the `platform` and `gymtrack_mcp` surfaces, not the four workflows' `on.push.paths` — see the AC2 annotation below.
- `.github/workflows/ci.yml` — the CI workflow that already runs `bash infra/cloud/scripts/tests/*.test.sh`; this PR adds one more `run:` line.

No extraction or migration is involved. This task does not move code between workspaces. It does not change the lockfile contents, the Dockerfile build steps, or the Fly app configuration — only the GitHub-side `paths:` filter that decides when each workflow fires.

## `.openclaw` boundary

No `.openclaw` writes in this PR. Quinn retains ownership of `FLY_API_TOKEN`, Neon `DATABASE_URL`, Upstash `REDIS_URL`, DNS provider tokens, and the staging Fly app registrations — those are out-of-band for this fix. This task changes no env-var names, secret names, or `.openclaw` paths.

## Ownership boundary check (per `agents/skills/dev/tech-design/SKILL.md`)

**Natural source of truth:** the GitHub Actions `paths:` filter on each deploy workflow is the trigger contract. Today three of the four workflows reference `pnpm-lock.yaml` (which does not exist at the repo root) and one references neither manifest nor lockfile. The source of truth — what the Dockerfiles actually consume — is the root `package-lock.json` and `package.json` (`infra/cloud/docker/{tasks-api,budget-api,auto-post-worker}.Dockerfile:31/29/28` `COPY package*.json ./`; `services/gymtrack-mcp/Dockerfile` — see sibling task `a858ffce` for the freeze leg).

**Superseded (verified 2026-11-21):** the trigger contract is no longer the per-workflow `paths:` filter. Every deploy workflow is `on: workflow_call:` only, and the selection is made by the `changes` job in `.github/workflows/ci.yml` (`dorny/paths-filter`, task `02c5475c`), whose per-surface filter lists are the source of truth today. The build-input half of this paragraph still holds: the Dockerfiles consume the root `package-lock.json` and `package.json`, and the live `ci.yml` filters for `platform`, `gymtrack_mcp`, `gymtrack`, `website`, `budget_mobile` and `health_probe` each list both.

**Why fix in-place rather than shim.** A shim here would mean "leave the workflow `paths:` filter alone, accept the deploy gap, and rely on workflow_dispatch to manually redeploy when lockfiles change." That is the failure mode the W38 audit specifically flagged: a dependency-resolution-only commit can pass CI without triggering affected deployments, leaving the prior dependency graph running until a later trigger/manual release. The shim turns into a second source of truth (workflow_dispatch history vs. the natural push-trigger contract) and recreates the same gap at the next deploy incident. The durable boundary is: the workflow `paths:` filter agrees with what the Dockerfile copies.

**No interim solution.** Editing four workflow YAML files is the same shape of work as leaving them alone and adding a runbook entry — fixing in-place is strictly cheaper.

## Implementation plan

### AC1 — Root `package-lock.json` is in every deploy-workflow `paths:`; MCP also includes `package.json`

**Root cause.** Today:

| Workflow | Current `paths:` includes `package.json`? | Current `paths:` includes `package-lock.json`? |
| --- | --- | --- |
| `deploy-staging-tasks-api.yml:24-31` | yes | **no** (references `pnpm-lock.yaml`, which does not exist at the repo root) |
| `deploy-staging-budget-api.yml:25-32` | yes | **no** (same `pnpm-lock.yaml`) |
| `deploy-staging-auto-post-worker.yml:31-38` | yes | **no** (same `pnpm-lock.yaml`) |
| `gymtrack-mcp-deploy.yml:11-15` | **no** | **no** |

**Superseded (verified 2026-11-21):** this table records the pre-move state of four `on.push.paths` lists. None of the four files has an `on.push` block today — all four are `on: workflow_call:` only — and the three staging files no longer have a deploy job at all (removed 2026-11-07, task `219fb673`). The equivalent live contract is the per-surface filter list in `ci.yml`'s `changes` job; every live surface list already carries `package.json` and `package-lock.json`.

Result: a commit that touches only the root lockfile does not fire any of these workflows. A commit that touches only `package.json` does not fire the MCP workflow (which uses `npm ci` from the root lockfile).

**Why `pnpm-lock.yaml` is wrong, not just redundant.** Root `pnpm-lock.yaml` does not exist (`ls /Users/quinnstoffer/.openclaw/workspace/codebases/sindustries/pnpm-lock.yaml` → not found; confirmed at `95094488`). The repo root uses npm workspaces per `package.json:13`; only `agents/ash/pnpm-lock.yaml` and `services/tasks-api/pnpm-lock.yaml` exist (separate installers — Ash's own install, services/tasks-api stale entry; both are tracked in audit F6, separately tracked under `needs-human-decision: confirm which standalone install contracts remain before removal (Q3)`). Replacing `pnpm-lock.yaml` with `package-lock.json` is the right fix; leaving `pnpm-lock.yaml` alongside `package-lock.json` would create two paths triggering the same deploy and confuse the next reader.

**Fix.**
- `deploy-staging-tasks-api.yml`: replace `'pnpm-lock.yaml'` with `'package-lock.json'` in the `paths:` list. No other line changes.
- `deploy-staging-budget-api.yml`: same.
- `deploy-staging-auto-post-worker.yml`: same.
- `gymtrack-mcp-deploy.yml`: add `'package.json'` and `'package-lock.json'` to the `paths:` list, after `apps/gymtrack/server/agentData.js`. The MCP workflow retains its `apps/gymtrack/server/agentData.js` entry — that's a runtime-imported module (`services/gymtrack-mcp/Dockerfile:4` COPY pair plus the `agentData.js` reference), not a build-input filter (see T4 / task `a858ffce` for the freeze leg).

**Files touched (AC1 only).**
- `.github/workflows/deploy-staging-tasks-api.yml`
- `.github/workflows/deploy-staging-budget-api.yml`
- `.github/workflows/deploy-staging-auto-post-worker.yml`
- `.github/workflows/gymtrack-mcp-deploy.yml`

**Superseded (verified 2026-11-21):** this is the file list PR #677 shipped. The three staging files have since been reduced to `workflow_call`-only shells with no deploy job, and the MCP workflow's `paths:` list has been superseded by `ci.yml`'s `gymtrack_mcp` filter. The equivalent live change is in `.github/workflows/ci.yml`.

### AC2 — A dependency-input fixture check proves lockfile-only changes select all four deployments, and unrelated docs do not

**Approach.** A new bash test, `infra/cloud/scripts/tests/fly-deploy-trigger-paths.test.sh`, mirroring the existing fixture-test style (`mission-control-deploy-fixtures.test.sh`, `bootstrap-staging.test.sh`, `fly-toml-context.test.sh`, `package-json-no-pnpm-pin.test.sh` — same `set -euo pipefail`, same `REPO_ROOT` derivation). The test parses each of the four target workflows with node + the repo's vendored `yaml` package (no new dependency), then runs two assertion classes:

**Superseded (verified 2026-11-21):** the shipped test does not parse the four workflows. It parses `.github/workflows/ci.yml`, reads `jobs.changes.steps[filter].with.filters`, and asserts against the `platform` and `gymtrack_mcp` surface filters; it uses Python + PyYAML rather than node + the vendored `yaml` package, and its header records the move ("moved to the central CI caller by task 02c5475c"). The two assertion classes below still describe its shape, restated against the live filters.

1. **Static assertions** (always run):
   - All four workflows list `package-lock.json` under `on.push.paths` (or under the YAML-equal `on: [push: {paths: …, branches: …}]` shape).
   - MCP workflow additionally lists `package.json`.
   - The three staging workflows do **not** list `pnpm-lock.yaml` (regression guard — F6's decision on `services/tasks-api/pnpm-lock.yaml` is open, so the workflows should not be selecting on a path whose only current instance lives inside `services/tasks-api/`).
   - Each workflow's `on.push.branches` includes `main`.
   - Each workflow file passes basic YAML shape (one `on:`, one `jobs:`, an `on.push` block).

**Superseded (verified 2026-11-21):** the shipped test's static assertions are: the `platform` and `gymtrack_mcp` filters in `ci.yml` exist and are lists; each lists `package.json` and `package-lock.json`; neither lists `pnpm-lock.yaml`; and the four retired per-service filters (`tasks_api`, `budget_api`, `content_scheduler_api`, `auto_post_worker`) are absent. The per-workflow shape assertions above (`on.push.paths`, `on.push.branches` containing `main`, one `on:`/`one `jobs:`) no longer have a subject — no deploy workflow has an `on.push` block.

2. **Synthetic event assertions** (the audit's "lockfile-only changes select all four; docs-only changes select none"):
   - Build a tiny synthetic event generator that takes a list of changed file paths and returns the set of workflows that would fire under GitHub's `paths:` matching rules (GitHub treats `paths:` as OR — any match fires the workflow). Paths use the repo-root-relative form.
   - Assert: synthetic commit `["package-lock.json"]` → all four workflows selected.
   - Assert: synthetic commit `["package.json"]` → MCP selected, three staging workflows also selected (they already listed `package.json`).
   - Assert: synthetic commit `["docs/specs/foo.md"]` → no workflow selected.
   - Assert: synthetic commit `["apps/website/src/App.jsx"]` → no workflow selected (proves the Vercel website workflow is not in scope here).

**Superseded (verified 2026-11-21):** the shipped test's synthetic cases are `["package-lock.json"]` → both surfaces, `["package.json"]` → both surfaces, `["services/content-scheduler-api/src/server.ts"]` → `platform` only, `["docs/specs/foo.md"]` → none, and `["apps/website/src/App.jsx"]` → none. The "three staging workflows" selection rule above is gone with the per-workflow filters; the `platform` surface is what now stands in for the three consolidated services.

**Why bash + node inline, not a Vitest/pytest suite.** This is a structural guard, not a behavioral test of the deploy itself. The existing `infra/cloud/scripts/tests/` directory is the canonical location for this class of check; running as `bash infra/cloud/scripts/tests/fly-deploy-trigger-paths.test.sh` keeps it adjacent to `mission-control-deploy-fixtures.test.sh` and lets CI wire it via a single `run:` line. No new test framework, no new runner, no new CI job.

**CI wiring.** Add one line to the existing `infra-cloud-bootstrap-staging-tests` job in `.github/workflows/ci.yml` (after the existing `mission-control-deploy-fixtures.test.sh` step at line 635). No new job — this is a sub-second structural test, identical in posture to the four existing siblings.

**Why not use `dorny/paths-filter` to test.** That action tests `paths:` semantics at workflow runtime; we want the check on every PR (including PRs that don't touch the workflows themselves) without requiring the workflow to run. A bash fixture is faster and works regardless of which files a PR touches.

**Files touched (AC2 only).**
- `infra/cloud/scripts/tests/fly-deploy-trigger-paths.test.sh` — new (~100 lines).
- `.github/workflows/ci.yml` — one added `run:` line in the existing `infra-cloud-bootstrap-staging-tests` job.

## Test plan — AC verification matrix

| AC | Verification layer | Where it runs | What it proves | Disproportionate? |
| --- | --- | --- | --- | --- |
| AC1 | Static YAML inspection | `fly-deploy-trigger-paths.test.sh` (in CI) | Each of the four workflows declares the required path; regression guard against re-adding `pnpm-lock.yaml`. | n/a — pure YAML parse |
| AC1 | Manual: pre-PR dry-run of the synthetic event generator (described above) | Local on the worktree, before opening the PR | The synthetic commit `["package-lock.json"]` selects all four workflows; commits outside the four scopes do not. | n/a — runs in seconds |
| AC2 | Synthetic-event assertions in the same fixture script | `fly-deploy-trigger-paths.test.sh` (in CI) | All four required positive cases + at least two negative cases (docs-only, app-source outside the four). | n/a |
| AC2 | Cross-check: existing `mission-control-deploy-fixtures.test.sh` continues to pass | CI | New step doesn't regress the Vercel-staging fixture guard. | n/a |

**Superseded (verified 2026-11-21):** the shipped test asserts against the `platform` and `gymtrack_mcp` filters in `ci.yml`, not against four workflows — so the "all four" wording in the first, second and third rows above reads as "both live surfaces" today. The verification layers themselves (a static parse plus synthetic-event assertions, both in CI, no E2E) are unchanged.

E2E coverage is **not** planned for either AC. The full deploy cycle (GitHub push → Fly canary → `/health` curl) is already exercised by the four workflows themselves in CI on `main` (and Quinn-owned live smoke per the parent task's AC4). Adding another E2E layer for the filter change would duplicate that surface without new information; the synthetic event assertions in `fly-deploy-trigger-paths.test.sh` are the proportionate unit-level guard for "the filter is correct."

**Superseded (verified 2026-11-21):** the three staging workflows no longer deploy anything, so "the four workflows themselves in CI on `main`" no longer holds for three of them. The live cycle is `ci.yml` → `deploy-staging-platform.yml` / `gymtrack-mcp-deploy.yml` (and the health-probe and GymTrack workflows), selected by the `changes` job's filters. The conclusion — no additional E2E layer for a filter change — is unchanged.

## Workflow / cron / skill changes

- No agent workflow changes.
- No cron changes.
- No skill changes.
- The new test script lives in `infra/cloud/scripts/tests/` — an existing fixture-tests directory, not a new pattern.

## Open questions and risks

1. **Order of operations with sibling task `a858ffce` (Freeze the MCP image dependency graph, T4).** The W38 audit calls them out as a coordinated pair: T3 (this task) corrects the workflow triggers; T4 changes the MCP Dockerfile to consume the root lockfile. They can ship in either order — the `paths:` filter change here doesn't depend on the Dockerfile change, and vice versa — but they should both land before Quinn's next staging deployment review. No dependency in the Tasks API (both are independent `code` tasks). Plan: open this PR first, then `a858ffce` second, each as its own draft PR with its own reviewers. If Quinn prefers stacking, I can rebase `a858ffce` onto this branch before opening — flag during design review.

2. **`pnpm-lock.yaml` removal is out of scope.** F6 keeps `agents/ash/pnpm-lock.yaml` (legitimate separate install) and `services/tasks-api/pnpm-lock.yaml` (awaiting Q3 decision). Removing those is task territory beyond T3. This design only removes `pnpm-lock.yaml` from the workflow `paths:` filters — it does not delete any tracked file. The fixture test explicitly asserts "staging workflows do not list `pnpm-lock.yaml`" as a regression guard so the next reader cannot silently re-add it before Q3 lands.

3. **Risk: extra deploy frequency.** Adding `package-lock.json` to the staging `paths:` filters means `npm install` updates in PRs that touch only the lockfile will now trigger a staging deploy. Per the audit's risk assessment ("Low — extra deployment frequency"), this is acceptable: a lockfile change without an accompanied manifest change is unusual in npm workspaces (since `npm install` rewrites both), and the staging concurrency groups already serialize deploys (`concurrency.cancel-in-progress: false`). If Quinn wants a narrower trigger later (e.g. `package-lock.json` AND `services/<svc>/**`), that's a follow-up audit cycle, not a blocker here.

**Superseded (verified 2026-11-21):** the risk landed in its current form — `package-lock.json` is in the live `platform` and `gymtrack_mcp` filters, so a lockfile-only commit does trigger those deploys. The concurrency serialization is unchanged (`deploy-staging-platform.yml` keeps `concurrency.cancel-in-progress: false`). The "narrower trigger" option remains open against the `ci.yml` filters rather than against per-workflow `paths:` lists.

4. **Risk: false positive on the synthetic event generator.** GitHub's `paths:` matcher ignores paths outside the repo root and uses glob patterns (we currently use literal strings, not globs). If a future workflow adds `services/**` or `packages/*`, the literal-match fixture would need a glob layer. Today's four target workflows use literal-path patterns only, so the synthetic generator stays simple. If a future task adds glob patterns to one of these workflows, the fixture must be extended — flag in the fixture header comment.

5. **No `.openclaw` runs.** No agent definitions, no cron prompts, no OpenClaw skill files change. Quinn does not need an `.openclaw` reviewer for this PR.