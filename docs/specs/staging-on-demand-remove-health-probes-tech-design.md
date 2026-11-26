---
status: draft
task_id: 39b79a40-e39a-4378-a30d-9bddcbb73a1d
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Make staging on-demand only and remove staging health probes

## Product intent summary

There is no linked product spec. This design implements the task directly:

> “Make the SIndustries staging environment on-demand only to eliminate unnecessary Fly.io spend.”

> “Staging must not keep machines running continuously, and the staging health-probe app/checks should be removed from the active staging topology rather than running as a background cost or wake-up source. Production must remain unchanged.”

The target is zero running staging Fly Machines outside an intentional validation window. An operator can explicitly deploy or wake the consolidated platform, execute validation, and return it to stopped. The standalone staging probe, its deploy path, staging target metadata, and operator paths that can recreate it are retired. Production keeps its current platform floor, probe, DNS, secrets, monitoring, and deployment behavior.

## Delivery coordinates

- Task ID: 39b79a40-e39a-4378-a30d-9bddcbb73a1d
- Title: Make staging on-demand only and remove staging health probes
- Repository: Stoffer-Industries/sindustries
- Branch: task-39b79a40-staging-on-demand
- Worktree: /Volumes/WD1/worktrees/rowan/staging-on-demand
- Product spec: n/a
- OpenClaw workspace repository: Stoffer-Industries/workspace (operator coordination only; no repository change planned)

## Service boundary and data ownership

This is an infrastructure lifecycle feature. The owner is infra/cloud plus the GitHub Actions workflows that invoke it, not a service under services/ or apps/.

- The runtime is owned by infra/cloud/fly/platform.fly.toml, environment overlays rendered by infra/cloud/platform/render-fly-config.mjs, and infra/cloud/platform/platform-environments.mjs.
- Explicit windows are owned by .github/workflows/deploy-staging-platform.yml and .github/workflows/cloud-staging-validate.yml.
- Probe code remains owned by infra/cloud/observability/health-probe/, but its only deployed consumer after this change is production. Staging has no replacement probe.
- Routing metadata is owned by infra/cloud/hostname-matrix.json; it must stop advertising a staging probe.
- Direct consumers are GitHub Actions, Fly.io, infra/cloud/bin operator commands, observability operator scripts, and cloud/observability docs. Product APIs and databases do not consume this contract.

Application services cannot enforce a Fly Machine floor or safely retire another Fly app. A new service would create the cost this task removes. There is no temporary placement or extraction migration: lifecycle policy stays in the durable cloud workflow/config boundary, and the staging probe is removed rather than moved. Production continues to render and deploy the existing probe package.

## Ownership boundary check

The natural source of truth is the workflow/OpenClaw and shared cloud-config boundary. It is not UI-local state, an API resource, or database data.

The durable shape is:

1. Keep topology shared in infra/cloud/fly/platform.fly.toml.
2. Add a staging overlay owning only http_service.min_machines_running = 0.
3. Keep the shared/production floor at 1, so production does not inherit staging cost policy.
4. Require staging deploy to render that overlay and make the workflow dispatch-only.
5. Put start/stop cleanup in both explicit workflows and serialize them with one concurrency group.

This is safer than changing the shared floor to 0 and repairing production with an override: the safe default for an accidentally unrendered production config remains 1, production blast radius is smaller, and AC4 is reviewable in one file. A narrow renderer extension is the durable environment-divergence mechanism already used for app and env values.

No interim shim is proposed. Workflow text replacement would create an unvalidated second renderer and weaken the fail-closed overlay contract.

## .openclaw boundary notes

No ~/.openclaw configuration, skill, cron, heartbeat, or secret change is required. Quinn/Tom must perform and record these external actions during the implementation PR:

1. Destroy sindustries-health-probe-staging after its repository deploy path is disabled.
2. Remove health-probe.staging.sindustries.co.nz and its Fly certificate.
3. Remove staging GitHub Environment/Fly secrets used only by the retired probe. Do not remove shared platform secrets such as HEALTH_PROBE_REDIS while the platform consumes them.
4. Record redacted Fly app/machine state in the PR.
5. Confirm the production probe app, DNS, certificate, secrets, and checks remain present.

These are Fly.io, DNS-provider, Grafana, and GitHub Environment mutations outside the repo. Tests must not perform them. The PR records actor and timestamp for each completed step.

## Implementation plan

### 1. Encode a staging-only zero floor

Add infra/cloud/fly/platform.staging.overlay.toml, bound to sindustries-platform-staging, with only:

    [http_service]
      min_machines_running = 0

Update infra/cloud/platform/render-fly-config.mjs. Its parser currently accepts single-quoted strings. Add a typed scalar representation that accepts a non-negative integer only for http_service.min_machines_running while retaining string-only rules for app and env. Reject every other http_service key, duplicate assignment, missing shared key, negative/non-integer value, and environment/app mismatch. Preserve non-owned lines and comments byte-for-byte.

Update infra/cloud/platform/tests/render-fly-config.test.mjs for staging render 0, production/shared topology 1, unsupported keys, invalid scalar types, missing shared key, and wrong-app overlays. Assert production render retains floor 1 without staging hostnames or app names.

Ignore generated infra/cloud/fly/platform.staging.fly.toml beside the existing generated production config.

### 2. Make deployment and validation explicit, serialized windows

Update .github/workflows/ci.yml. Remove deploy-platform-staging and deploy-health-probe-staging from push-to-main. Remove unused change outputs only when no test job consumes them. Health-probe package tests remain in CI because production still uses the package.

Update .github/workflows/deploy-staging-platform.yml:

- Add workflow_dispatch; retain workflow_call only if an explicit operator workflow needs it.
- Check the deploy opt-in before provisioning so a disabled dispatch cannot write secrets and restart Machines.
- Render the staging overlay, validate, deploy, and run current smoke checks.
- Stop every platform Machine in an always-run cleanup.
- Summarize commit, start time, checks, cleanup, and final states.

Update .github/workflows/cloud-staging-validate.yml:

- Generalize “Wake content-scheduler machines” to “Start staging validation window.”
- Record IDs this run starts under RUNNER_TEMP, wait for readiness, and run the existing black-box/failure-drill flow.
- Stop those IDs in always-run cleanup before artifact upload.
- Treat cleanup failure as workflow failure after preserving artifacts; AC3 requires the window to close.
- Include the final state query in the summary.

Both workflows use concurrency group staging-platform-lifecycle with cancel-in-progress false. This prevents one repository workflow stopping a Machine while another validates it. The runbook forbids overlapping manual control because GitHub cannot lock an operator shell.

Update infra/cloud/bin/status. Do not fetch public /__status when Fly reports no started Machine: auto_start_machines true turns that read into a wake source. Report “stopped (expected: on-demand)” and child state “not running — platform stopped,” not unhealthy. Update infra/cloud/bin/tests/status.test.sh.

### 3. Remove the staging probe from every active path

Delete .github/workflows/deploy-staging-health-probe.yml. Leaving a callable workflow could recreate the app. Keep .github/workflows/deploy-production-health-probe.yml behavior unchanged; update only comments that claim a live staging counterpart.

Update infra/cloud/platform/platform-environments.mjs and platform-environment-facts.mjs. Make probe app/base URL/artifact facts optional by environment. Staging has no probe app, origin, deploy gate, or artifact; production retains all. expectedAppForSharedConfig still binds the shared template to production and refuses a staging probe render.

Update infra/cloud/hostname-matrix.json. Keep the production health-probe surface but remove/null its staging hostname and CNAME target according to the schema. Tests must forbid a staging target while requiring production.

Harden infra/cloud/observability/bootstrap-observability.sh, evidence-capture.sh, and failure-inject.sh:

- No default resolves to sindustries-health-probe-staging.
- No command can create or deploy it.
- Production mutation requires an explicit production environment/app resolved from environment facts.
- Remove deploy-failed/restored paths invoking the deleted staging workflow.
- Keep environment-neutral Grafana provisioning.

Keep health-probe source, Dockerfile/tests, fly.production.overlay.toml, and the production workflow. Clarify health-probe/fly.toml as a shared render input that must never deploy directly. Add a guard proving no executable path deploys that file without the production overlay.

Extend infra/cloud/scripts/tests/retired-staging-apps.test.sh or add staging-on-demand-production-guard.test.sh. Assert:

- no workflow or CI caller can deploy the staging probe;
- no active script defaults to the retired app/hostname;
- staging render floor is 0 and production is 1;
- lifecycle stop commands contain only the staging platform, never production names or secrets;
- production workflows, hostname, and facts remain present.

Wire the guard into the unconditional cloud contract-test job in ci.yml.

### 4. Update durable docs and runbook

Update docs/systems/cloud-platform.md: replace the always-on model with zero-floor lifecycle, document delayed staging auto-post processing while stopped, remove the staging probe from live topology, and state production remains always-on.

Update docs/systems/observability.md and infra/cloud/observability/README.md: the Fly probe is production-only. Staging retains application-emitted telemetry while running but has no background probe or polling.

Add docs/runbooks/staging-on-demand.md. This is ongoing operation, not rollback. Document prerequisites, dispatch-by-ref, deploy/validate/stop, final-state checks, failed/cancelled cleanup, emergency stop, non-overlap, near-zero idle compute behavior, and staging auto-post latency.

Update docs/runbooks/platform-consolidation-rollback.md and docs/runbooks/hosted-observability-ops.md. Remove claims that the staging probe is live and link the new runbook. Historical dated evidence stays historical and is annotated as superseded.

## Data model and API contract changes

- No database migration or HTTP API request/response change.
- platform.staging.overlay.toml adds http_service.min_machines_running = 0.
- The renderer expands from string app/env assignments to one allow-listed integer assignment. Other numeric/table values fail closed.
- Staging probe facts become absent/not applicable. Production probe facts remain required.
- The hostname matrix staging probe endpoint/CNAME becomes absent; production remains required.

## Workflow, cron, and skill changes

- Normal main CI no longer deploys staging platform or probe.
- deploy-staging-platform.yml becomes explicit dispatch and always closes its window.
- cloud-staging-validate.yml explicitly opens and closes a window.
- deploy-staging-health-probe.yml is removed.
- No repository or OpenClaw cron changes: no staging health workflow has a schedule trigger, and no heartbeat/skill replaces the probe.
- No agent skill changes.

## Test plan and AC verification matrix

| AC | Automated verification | Live/manual verification | Layer and rationale |
| --- | --- | --- | --- |
| AC1 — zero floor and reproducible start | Renderer tests assert staging 0 and production 1; workflow contract requires dispatch-only deploy; status tests prove stopped status does not wake. | Dispatch a window, then record Fly machine JSON showing stopped outside it. | Unit + file/contract + manual Fly evidence. App E2E cannot prove provider lifecycle/billing. |
| AC2 — probe app/workflow/checks/monitoring removed | Guard proves workflow/caller absent, staging facts absent, scripts cannot recreate/default to it, and production contracts remain. | Record staging probe app-not-found, staging DNS absent, and no Grafana staging-probe polling target. | File/contract + manual provider evidence. Destructive provider changes cannot run in CI. |
| AC3 — explicit start/validate/stop; merge leaves off | Fixtures assert dispatch, shared concurrency, always-run cleanup, final-state check, and no push caller. Existing tests/cloud/staging-workflows.mjs remains the black-box payload. | Run explicit deploy/smoke and validation once; verify success and stopped final state. Inspect merged CI to prove no staging deploy ran. | Integration + live workflow E2E, the meaningful infrastructure E2E. |
| AC4 — production unchanged | Renderer/manifest/matrix tests require production floor/app/origin; guard rejects production names in staging lifecycle. Existing production deploy-contract tests stay green. | Diff-attest production workflows/DNS/secrets and smoke production health endpoints before/after without mutation. | Unit + contract + manual diff/smoke. “Unchanged” needs static and live evidence. |
| AC5 — docs and live evidence | Link/path checks point system docs to the new runbook; static tests verify commands target only staging. | Put redacted Fly state, DNS result, workflow URLs, cleanup result, and idle-cost explanation in the PR. | File + manual evidence because the AC explicitly requires PR-recorded live state. |

## Open questions and risks

### Needs Tom decision before completion

1. Authorize destructive retirement. Destroying the staging probe app and removing DNS/certificate are irreversible. Repository work can land first, but AC2/AC5 cannot complete until authorized and recorded.
2. Accept staging worker latency. At a zero floor, staging auto-post cannot drain queues while stopped. If timing must be deterministic, scope an event-triggered wake follow-up instead of restoring an always-on floor.

### Noted risks

1. Cleanup under infrastructure failure: always-run cleanup handles job failures and cancellation, but runner loss or Fly API failure can prevent it. The zero floor is the safety net; the runbook includes emergency stop and final checks.
2. Manual overlap: workflow concurrency cannot lock an operator shell.
3. Typed renderer blast radius: parser code is shared with production rendering. Keep integer handling key-scoped and run full renderer/production suites.
4. Tests currently assume every environment has a probe. Refactor to require it only where configured; do not weaken production assertions.
5. Historical references: dated evidence and shipped designs should not be rewritten. Guards distinguish historical/comment-only references from executable defaults.
6. Near-zero is not zero: explicit windows, storage, and retained resources can cost money. Docs claim removal of the always-on floor, not zero total staging cost.

### Blocking questions

None for repository implementation. Operator retirement authorization blocks final AC2/AC5 evidence, not coding.
