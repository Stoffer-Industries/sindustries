---
status: draft
task_id: 02c5475c-b4c9-420b-800b-7d6a9ecb0eb6
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# CI and deployment gates tech design

## Intent and scope

Harden the existing GitHub Actions delivery pipeline so failed or cancelled CI blocks merges and deployments, production is reachable only from `main`, staging smoke checks precede production where a staging target exists, deployment credentials fail fast, mutable deployment tooling is pinned, and concurrency matches the target environment. Per-pull-request website URLs and redesigning the shared staging alias are explicitly out of scope.

## Delivery metadata

- **Task:** `02c5475c-b4c9-420b-800b-7d6a9ecb0eb6` — Harden CI merge and deployment gates
- **Branch:** `task-02c5475c-ci-deploy-gates`
- **Worktree:** `workspace/worktrees/task-02c5475c-ci-deploy-gates`
- **Repository:** `Stoffer-Industries/sindustries`

## Ownership boundary

This is a **workflow/OpenClaw boundary** change. GitHub Actions workflow files are the source of truth for execution order, path selection, environments, tooling versions, and concurrency. GitHub repository rulesets and environment deployment policies are the source of truth for server-side enforcement. Application services remain unaware of the orchestration change.

Keeping the merge gate, change detection, and deploy calls in one caller workflow avoids a second status-aggregation service and lets every deployment depend on the exact CI run for the same commit. Existing deployment workflows become reusable units so their runtime ownership and rollback boundaries remain separate.

## Proposed workflow

1. `ci.yml` detects which deployable surfaces changed and runs all applicable verification jobs.
2. A stable `merge gate` job runs with `always()`, inspects every required predecessor result, and succeeds only when each predecessor succeeded or was intentionally skipped.
3. Pull-request website staging, main-branch staging, and all main-branch production jobs depend on `merge gate`.
4. Existing deployment workflows expose `workflow_call` only; they no longer have independent `push` triggers that can race CI.
5. On a `main` website change, the website staging call deploys and smoke-checks the candidate before the production call runs. Products without a staging target deploy to production directly after the merge gate.
6. Staging concurrency cancels superseded runs for the same deployment target/ref. Production concurrency is serialized with `cancel-in-progress: false`.

## Implementation plan

### CI orchestration

- Update `.github/workflows/ci.yml` with a pinned changed-path filter, the aggregate merge gate, and reusable deployment calls guarded by event, branch, and change outputs.
- Fold the path-scoped feature-task clippy check into `ci.yml` so the aggregate gate covers it; retire the standalone workflow.
- Move the EAS update out of the pre-CI position and place it behind the aggregate gate with production-safe concurrency.

### Deployment workflows

- Convert the website, three Fly staging, GymTrack, and GymTrack MCP workflows to `workflow_call` contracts.
- Add explicit target inputs/outputs where the website staging-to-production chain needs them.
- Add Fly credential preflight steps before CLI validation or deployment.
- Pin the Fly setup action by commit and `flyctl` by version; pin the Supabase setup action by commit and CLI by version.
- Add or retain smoke checks at the staging boundary.

### Server-side enforcement

- Add `CI / merge gate` as a required status check in the active `main` repository ruleset after the check has appeared on this pull request.
- Restrict the `production` GitHub environment to the protected `main` branch. Keep staging usable from pull-request branches; approval rules are not added in this slice.
- Perform Fly credential repair only through GitHub's masked environment/repository secret interface. No credential value is accepted in task comments, shell arguments, URLs, repository files, or chat.

### Documentation and tests

- Add a fixture test that parses the workflow YAML and asserts aggregation, dependency, environment, preflight, pinning, and concurrency contracts.
- Update `docs/systems/cloud-platform.md` with the delivered flow and masked setup runbook.

## Data model and API contracts

No application data model or API contract changes. Workflow-call inputs and outputs are internal CI contracts. The GitHub ruleset gains one required check context, `CI / merge gate`.

## `.openclaw` boundary

No OpenClaw configuration change is required. GitHub ruleset/environment mutations are external repository-administration operations and will be applied with the authenticated GitHub API only after their corresponding workflow behavior exists. Fly secret entry remains a human/admin masked-input action if the secret is absent or invalid.

## Verification matrix

- **AC1 — stable required merge gate:** fixture test verifies the named aggregate job, complete `needs` set, `always()` evaluation, and failure on non-success/non-skipped predecessors; GitHub ruleset read-back verifies the required context.
- **AC2 — deploys wait for CI:** fixture test verifies every deploy caller depends on `merge-gate`, and reusable deploy workflows have no independent push trigger.
- **AC3 — production restriction and staging smoke:** fixture test verifies production calls are `main`-only and the website production call depends on website staging; GitHub environment read-back verifies protected-branch policy.
- **AC4 — Fly credential preflight:** fixture test verifies every Fly workflow checks a secret-backed environment variable before any Fly CLI action; no live-secret test is performed.
- **AC5 — pinned tooling:** fixture test rejects mutable Fly/Supabase action refs and `latest` CLI versions.
- **AC6 — concurrency:** fixture test verifies staging cancellation is enabled and production cancellation is disabled.
- **AC7 — automated workflow tests:** run the new workflow-contract fixture alongside all existing `infra/cloud/scripts/tests/*.test.sh` checks; parse all workflow YAML with PyYAML using the repository's YAML 1.1 boolean-key workaround.

No app-flow E2E test is appropriate because this changes repository orchestration rather than user-visible behavior. Static workflow-contract tests plus GitHub API read-back are the closest executable verification layers.

## Risks and mitigations

- **Required-check deadlock:** GitHub cannot require a status that has never reported. Add the ruleset context only after the pull request emits `CI / merge gate`, then verify mergeability.
- **Reusable-workflow expression mistakes:** validate YAML and assert call graph/conditions in fixtures before pushing.
- **Path-filter omissions:** centralize deploy surface filters and cover lockfiles, shared packages, infra, and workflow self-changes in fixtures.
- **Website candidate mismatch:** the main-branch staging call must build the production candidate configuration before promotion/deployment; the fixture test verifies staging precedes production, while the smoke check verifies the deployed candidate endpoint.
- **Secret outage remains unresolved by code:** code can fail fast and document repair, but only an administrator can enter or rotate the real value through masked GitHub UI.
- **GitHub Actions cancellation:** a cancelled required merge-gate context remains non-successful and therefore blocks merge.

## Open questions

None. Tom explicitly approved items 1–4, 6, and 7 from the CI/CD hardening recommendation and excluded per-PR website preview URLs (item 5).
