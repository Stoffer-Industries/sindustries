---
status: draft
task_id: 39b79a40-e39a-4378-a30d-9bddcbb73a1d
product_spec: n/a (cost-reduction infra task; no brain spec)
shipped_pr: null
shipped_date: null
---

# Make Staging On-Demand Only and Remove Staging Health Probes — Tech Design

## Links

- Task: `39b79a40-e39a-4378-a30d-9bddcbb73a1d` (`💻 Make staging on-demand only and remove staging health probes`)
- Task API: `https://tasks-api.sindustries.co.nz/api/v1/tasks/39b79a40-e39a-4378-a30d-9bddcbb73a1d`
- Repository: `Stoffer-Industries/sindustries`
- Branch (this design): `staging-on-demand-health-probe-removal` (from `origin/main`)
- Worktree (this design): `/Volumes/WD1/worktrees/quinn/staging-on-demand-health-probe-removal`
- Implementation branch/worktree: Rowan opens his own branch/worktree for the implementation PR; this design does not reserve one. Suggested name: `staging-on-demand-health-probe-removal-impl` (or Rowan's own convention) off `origin/main`.
- No PR for this document — committed straight to this branch per `agents/skills/dev/tech-design/SKILL.md`.
- Related docs read for this design: `docs/systems/cloud-platform.md` (`Shared-fate topology (staging)`, `Cost model`, `Production topology`), `docs/specs/fly-staging-service-consolidation-tech-design.md`, `docs/specs/hosted-observability-migration-alerts-tech-design.md`, `docs/specs/production-environment-provisioning-tech-design.md`, `docs/runbooks/platform-consolidation-rollback.md`, `docs/runbooks/hosted-observability-ops.md`.

## Product intent (one paragraph)

There is no brain spec for this task — it originated directly as a cost-reduction task (tags: `cost-reduction`, `fly`, `staging`). The intent, taken from the task description: staging currently runs one always-on Fly Machine (`sindustries-platform-staging`, `min_machines_running = 1`) plus a second always-on Fly Machine for the staging health probe (`sindustries-health-probe-staging`). Neither carries real user traffic. The probe's own staging cadence config (`FLY_APP_PROBE_INTERVAL_SECONDS`, `DB_PROBE_INTERVAL_SECONDS`) already documents that its daily polling exists specifically to avoid waking Fly Machines or holding a Neon connection open — i.e. the probe was already identified as a staging cost/wake-up source before this task. This task finishes that job: staging should run **zero** Fly Machines by default, start only when an operator or a CI run explicitly requests a validation window, and the staging health-probe app should stop existing as a running cost at all. Production is explicitly out of scope and must be provably unaffected.

## `.openclaw` boundary note

None. This is a pure repository change: Fly topology config, GitHub Actions workflows, and docs/runbooks. No agent identity, credential, or `~/.openclaw/` change is required. The one operator (Quinn-owned) action outside the repo's code — destroying the live `sindustries-health-probe-staging` Fly app and its registered secrets — is an infra operation against Fly/GitHub Environments, not an `~/.openclaw/` boundary; it is called out explicitly in the implementation plan and the PR's "Evidence" section (AC5) rather than left implicit.

## Ownership boundary check

The natural source of truth for both changes is the **existing shared/overlay Fly-config contract** (`infra/cloud/platform/render-fly-config.mjs`, `infra/cloud/platform/platform-environments.mjs`) plus the **existing CI deploy-workflow contract** (`.github/workflows/ci.yml` + the per-surface `deploy-*.yml` / `cloud-staging-validate.yml` workflows). Both already encode "staging vs. production" as a first-class axis (the environment manifest, the overlay allow-list, the separate `deploy-staging-*.yml` / `deploy-production-*.yml` workflow pairs). There is no durable-vs-shim tradeoff here: extending the *existing* overlay allow-list by exactly one narrow key (`[http_service].min_machines_running`) and reusing the *existing* machine start/stop pattern already present in `cloud-staging-validate.yml` ("Wake content-scheduler machines") is both the smallest change and the durable one — there is no cheaper interim shim, because the environment-divergence mechanism this needs already exists and only needs one new allow-listed key.

Concretely:

- `infra/cloud/fly/platform.fly.toml` ([http_service].min_machines_running) is the shared default (today: `1`, implicitly "staging's own always-on choice" per its own comments). This design flips the shared default to `0` and lets the **production overlay** — not a staging-specific file — restore `1` for production. This matches the renderer's documented intent ("the shared file stays the DEFAULT (staging)").
- `render-fly-config.mjs`'s overlay allow-list is extended by exactly one table (`http_service`) and one key inside it (`min_machines_running`), following the identical pattern already used for `[env]` keys (`ALLOWED_OVERLAY_TABLES`, a new `ALLOWED_OVERLAY_HTTP_SERVICE_KEYS` set, and the "shared config must already define this key" guard reused unchanged).
- The staging health-probe app has no durable replacement to design — its removal is deletion of a cost source, not a migration. The shared `infra/cloud/observability/health-probe/fly.toml` file is kept (production's overlay still renders from it); only the **staging app's live existence and its CI deploy path** are retired, using the exact precedent already in the repo for the four retired per-service staging workflows (`docs/runbooks/platform-consolidation-rollback.md` §5): the `ci.yml` job that calls the workflow is removed; the `deploy-staging-health-probe.yml` file itself is left in the tree, orphaned, until that same future cleanup pass deletes it.
- No incremental/interim shim is introduced on the lifecycle side either: the "start for validation, run, stop" lifecycle reuses the exact machine list/start/stop flyctl calls `cloud-staging-validate.yml` already has for content-scheduler wake-up, just generalized to the whole platform app and paired with an explicit stop step. No new script, binary, or service is introduced.

## Implementation plan

### 1. Staging on-demand lifecycle (AC1, AC3)

**File: `infra/cloud/fly/platform.fly.toml`**

- Change `[http_service] min_machines_running` from `1` to `0`.
- Rewrite the long comment block above that line (currently justifying `1` for the auto-post worker) to instead explain the on-demand trade: the platform now scales fully to zero when idle; the auto-post worker (queue-bound, no HTTP listener) only drains its queue while the Machine happens to be running (an explicit validation window, or a request to one of the three HTTP surfaces that auto-starts it). Cross-reference the updated `docs/systems/cloud-platform.md` "Shared-fate topology (staging)" row this replaces (see §4 below) and the updated cost-model note.
- Production is restored to `1` via the overlay (next bullet) — the shared file's new default of `0` only takes staging-shaped effect because nothing else in this repo deploys the shared file directly to production.

**File: `infra/cloud/fly/platform.production.overlay.toml`**

- Add:
  ```toml
  [http_service]
    min_machines_running = 1
  ```
- Add a comment explaining this is the one place production diverges from staging's new on-demand default, and why: production has real traffic and must stay always-on.

**File: `infra/cloud/platform/render-fly-config.mjs`**

- Add `'http_service'` to `ALLOWED_OVERLAY_TABLES`.
- Add a new `ALLOWED_OVERLAY_HTTP_SERVICE_KEYS = new Set(['min_machines_running'])` (same shape as `ALLOWED_OVERLAY_ENV_KEYS`), and extend `parseOverlay`'s table-dispatch + `mergeFlyConfig`'s per-table merge loop to handle the `http_service` table exactly like `env` is handled today (own allow-list check, own "shared config must already define this key" check, in-place line replacement). This is a mechanical generalization of the existing `env`-only code path, not new policy — the policy (``overlay may touch only what's allow-listed, only if the shared file already defines it'') is reused verbatim.
- Keep the module doc comment's "An overlay may set the top-level `app` key and keys inside the `[env]` table, and nothing else" sentence updated to also name `[http_service].min_machines_running`, so the allow-list statement in the comment and the allow-list in code cannot drift.

**File: `infra/cloud/platform/tests/render-fly-config.test.mjs`**

- Add cases (mirroring the existing `[env]` allow-list tests):
  - Shared config with `min_machines_running = 0`; production overlay sets `min_machines_running = 1`; rendered production output has `1` (not `0`).
  - An overlay that tries to set any other `[http_service]` key (e.g. `auto_stop_machines`, `processes`) is rejected with the existing "may not set" error shape.
  - An overlay that sets `min_machines_running` when the shared config does not define `[http_service]` at all is rejected (reuses the existing "shared config does not define" guard, now generalized past `env`).
  - The staging (shared, unrendered) config's `min_machines_running` is asserted to be `0` directly (string/regex match on `infra/cloud/fly/platform.fly.toml`), so a future accidental revert back to `1` fails CI even if nobody touches the overlay.

**File: `.github/workflows/cloud-staging-validate.yml`** (AC3 — the explicit validation-window lifecycle)

- Generalize the existing "Wake content-scheduler machines" step (it already lists stopped machines on `sindustries-platform-staging` and starts them by ID) to a "Wake platform machines" step that runs unconditionally at the top of the job (today it is gated on `env.SCHEDULER_API_URL != ''`; with `min_machines_running = 0` *every* staging validation run needs this, not only scheduler-dependent ones).
- Add a new **"Stop platform machines"** cleanup step with `if: always()`, placed after the AC3 failure-drill step and before "Upload redacted results": list every machine on `sindustries-platform-staging` that this run started (track the IDs the wake step started, not every machine that happens to be running, so a machine another concurrent process is using is not stopped out from under it) and call `fly machines stop <id> --app sindustries-platform-staging` for each. Log a `::notice::` (not a failure) if a stop call errors, since the Machine will still auto-stop on idle under the new `min_machines_running = 0` floor — the explicit stop is a determinism improvement (AC3's "stop it afterward", verified promptly) over relying solely on Fly's idle-stop timer, not a correctness requirement.
- No change to the `workflow_dispatch`-only trigger — staging still never deploys or starts unattended.

**File: `.github/workflows/deploy-staging-platform.yml`** (AC3 — "the normal merge path does not leave staging running")

- After the existing three smoke-check steps, add a **"Stop platform machine after deploy"** step, gated the same way the deploy itself is (`if: steps.deploy.outputs.enabled == 'true'`): list the Machine(s) just deployed to and call `fly machines stop` on each. This makes "a normal merge does not leave staging running" a deterministic property of the merge-triggered deploy job itself, rather than an inference from Fly's (externally-controlled, not repo-documented) idle-stop timing. `STAGING_PLATFORM_DEPLOY_ENABLED` staying off entirely (today's default) continues to mean no deploy and no running Machine, unchanged.

### 2. Remove the staging health probe from the active topology (AC2)

**File: `.github/workflows/ci.yml`**

- Remove the `deploy-health-probe-staging` job (and its `needs:` / path-trigger wiring in the `changes` job's `.github/workflows/deploy-staging-health-probe.yml` filter entry) from the active merge path — the exact precedent already used for the four retired per-service staging deploy jobs at the 2026-11-07 consolidation (task `219fb673`; see `docs/runbooks/platform-consolidation-rollback.md` §5). `deploy-production-health-probe.yml`'s job (`deploy-health-probe-production`) and its own trigger wiring are untouched.
- `deploy-staging-health-probe.yml` itself is **not** deleted in this change — it is left in the tree as a `workflow_call`-only file with no caller, exactly like `deploy-staging-tasks-api.yml` / `-budget-api.yml` / `-content-scheduler-api.yml` / `-auto-post-worker.yml` already are. Add a header comment to the file documenting that it joined that same orphaned-and-pending-deletion set via this task, pointing at `docs/runbooks/platform-consolidation-rollback.md` §5 as the eventual cleanup.

**File: `docs/runbooks/platform-consolidation-rollback.md`**

- Extend the §5 cleanup checklist to also name `deploy-staging-health-probe.yml` and the (to-be-destroyed) `sindustries-health-probe-staging` Fly app, so the one future cleanup pass picks up five orphaned workflow files instead of four.

**Operator step (Quinn-owned, outside this PR's merge but tracked by it):**

- Destroy the live `sindustries-health-probe-staging` Fly app (`fly apps destroy sindustries-health-probe-staging`) and remove its registered secrets/GitHub-environment values that exist only to configure it (its `DATABASE_URL`s, `HEALTH_PROBE_REDIS`, `OTEL_*`). This is the step that actually satisfies "no staging probe keeps a Fly machine awake" — removing the CI deploy path stops *future* deploys from recreating it, but an already-running app keeps running until it is destroyed. The implementation PR's AC5 evidence capture (live Fly machine states) must show this app gone, not merely "not redeployed."
- `sindustries-health-probe-production` and all of its secrets are untouched.

**File: `infra/cloud/observability/health-probe/fly.toml` (shared config) — NOT changed**

- This file stays as-is. It is still the shared topology template `fly.production.overlay.toml` renders from (image, probe process, VM shape, canary strategy, the two probe-cadence env keys). Its literal `app = 'sindustries-health-probe-staging'` line is cosmetic for rendering purposes (the production render always overwrites `app` via the overlay) but is left alone rather than edited, to avoid implying the shared template itself was repointed — the comment block already explains the overlay-replaces-`app` mechanism, and no rendering logic depends on this line's content being anything other than *a* string.
- Add one new top comment line noting that the staging deploy path for this app is retired (task `39b79a40`) and the app only continues to exist, structurally, as the production render's shared base.

### 3. AC4 — production-isolation guard

**New file: `infra/cloud/scripts/tests/staging-on-demand-production-guard.test.sh`** (bash, same shape/style as the existing `infra/cloud/scripts/tests/retired-staging-apps.test.sh`)

Asserts, failing CI if any check fails:

1. `infra/cloud/fly/platform.production.overlay.toml` contains an `[http_service]` table with `min_machines_running = 1` (grep/regex — the file is small and line-oriented, same technique the renderer itself uses).
2. Rendering the production platform config via `render-fly-config.mjs --shared infra/cloud/fly/platform.fly.toml --overlay infra/cloud/fly/platform.production.overlay.toml --environment production` (to a scratch path) produces `min_machines_running = 1` in the output — this is the end-to-end proof, not just "the overlay file says 1" (catches a renderer regression the unit test in step 1 above might not).
3. `.github/workflows/ci.yml` still contains a `deploy-health-probe-production:` job definition, unchanged in its `uses:` target (`./.github/workflows/deploy-production-health-probe.yml`).
4. `.github/workflows/deploy-production-health-probe.yml` and `.github/workflows/deploy-production-platform.yml` do not contain the string `min_machines_running` at all (production's floor is set only via the overlay + shared-file mechanism above, never inlined into a workflow — an inlined value there would be a second, driftable source of truth).
5. Neither of the two new "Stop platform machine(s)" steps added to `cloud-staging-validate.yml` / `deploy-staging-platform.yml` references `sindustries-platform-production` or any `PRODUCTION_*` secret/variable name (grep for the literal strings) — a copy-paste of the staging stop step into a production file, or a staging step accidentally parameterized with a production app name, fails this check immediately.

This test is wired into `.github/workflows/ci.yml` alongside the existing `infra-cloud-bootstrap-staging-tests` job (same job, as a new step, or a new sibling job — Rowan's call at implementation time; either satisfies AC4 as long as it runs on every PR, not just on staging-path-changed PRs, since a production-isolation guard must run even when a PR's path filter would otherwise skip staging-only jobs).

### 4. Docs and runbooks (AC5)

**File: `docs/systems/cloud-platform.md`**

- "Shared-fate topology (staging)" table: replace the "The platform never scales to zero" row with a row describing the new on-demand behavior (`min_machines_running = 0`; the auto-post worker drains its queue only while a Machine happens to be running) and cross-reference the new runbook section below.
- "Cost model" section: update the staging Fly line from "~$20/mo … HTTP services stop when idle; the worker stays available for queued jobs" and the consolidated-platform "~$6.70/mo" framing to state the new expected steady-state (near-$0 Fly spend for staging when no validation window is active; the real number is Fly's prorated per-second billing for however many Machine-seconds a validation window actually uses — do not invent a number here, it is measured and recorded per AC5's "verify live Fly machine states" requirement at implementation time, the same way the original consolidated-platform section already refuses to quote the task spec's unverified figure).
- Remove the staging health-probe app from the service table / app list wherever it is currently listed as a live app, and add a short note that it was removed (task `39b79a40`) with a pointer to the runbook below.

**File: `docs/runbooks/hosted-observability-ops.md`**

- Remove/strike the staging-specific operational guidance (the daily-cadence rationale, the staging dashboard panel references) and replace with a short note that staging observability monitoring was retired for cost reasons (task `39b79a40`); production guidance is unchanged.

**New section in `docs/runbooks/platform-consolidation-rollback.md`** (or a new focused runbook `docs/runbooks/staging-on-demand.md` if Rowan judges the rollback runbook is the wrong home — see Open Questions):

- How to start staging for an intentional validation window: dispatch `cloud-staging-validate.yml` (which now wakes the Machine itself), or manually `fly machines start <id> --app sindustries-platform-staging` / let the first HTTP request auto-start it (`auto_start_machines = true` is unchanged).
- How to confirm staging is stopped: `fly machines list --app sindustries-platform-staging --json | jq '.[].state'` should read `stopped` outside of an active window.
- Expected cost-saving behavior: staging bills Fly only for the Machine-seconds an explicit validation window (or an ad hoc request) actually uses, not 24/7.
- That the staging health-probe app no longer exists, and that staging has no automated health monitoring as a deliberate cost trade (staging is a dev artifact; production retains its full probe).

## Data/config contract changes

- `infra/cloud/fly/platform.fly.toml`: `[http_service].min_machines_running` default changes `1` → `0`. This is a **shared-file default** change, so it is reviewed as touching every environment that renders from this file; the production-isolation guard (§3) is what makes that safe rather than merely assumed.
- `infra/cloud/fly/platform.production.overlay.toml`: gains a new `[http_service]` table (previously only `app` + `[env]`).
- `infra/cloud/platform/render-fly-config.mjs`: `ALLOWED_OVERLAY_TABLES` and a new `ALLOWED_OVERLAY_HTTP_SERVICE_KEYS` constant change the renderer's accepted overlay surface — a public contract other overlays (there are currently two: platform and health-probe) could technically also use, but only the platform production overlay uses it in this change; the health-probe overlay is untouched.
- No database, API, or task-schema contract changes. No `services/*` application code changes.

## Workflow, cron, and skill changes

- `.github/workflows/ci.yml`: removes the `deploy-health-probe-staging` job + its path-trigger entry from the active merge path (no change to any `schedule:`/cron trigger — there was none for this job).
- `.github/workflows/cloud-staging-validate.yml`: generalizes the wake step, adds a stop step. Still `workflow_dispatch`-only.
- `.github/workflows/deploy-staging-platform.yml`: adds a stop step after the merge-triggered deploy.
- No agent skill changes. No OpenClaw cron/heartbeat changes — staging's health was never polled from inside `~/.openclaw/`; the probe is purely a Fly-hosted service polling Grafana Cloud.

## Test plan — AC-by-AC verification matrix

| AC | Verification | Layer | Notes |
| --- | --- | --- | --- |
| **AC1** — no always-on staging floor; documented, reproducible start path | 1. `render-fly-config.test.mjs` asserts shared `platform.fly.toml` has `min_machines_running = 0`.<br>2. Live check: after merge, `fly machines list --app sindustries-platform-staging --json` shows no machine in `started` state outside an active validation window (recorded as AC5 evidence in the PR, per the task's explicit "verify live Fly machine states" requirement).<br>3. `docs/runbooks/...` documents the start command and `cloud-staging-validate.yml`'s dispatch path. | Unit (config) + manual/operator evidence (live state) | No E2E possible — this is infra lifecycle, not app-flow behavior. Manual evidence capture is the correct fallback layer and is explicitly required by AC5 anyway. |
| **AC2** — staging health-probe app/workflow/checks removed from the active path; no staging probe wakes anything | 1. `ci.yml` no longer contains a `deploy-health-probe-staging:` job (grep/contract test, new or extended `infra-cloud-bootstrap-staging-tests`).<br>2. Live check: `fly apps list` / `fly status --app sindustries-health-probe-staging` returns "app not found" after the operator-owned destroy step (AC5 evidence).<br>3. `retired-staging-apps.test.sh`-style guard (or an extension of it) can optionally also assert the staging health-probe app name does not appear in any *executable* (non-comment) line outside the explicitly-retired `deploy-staging-health-probe.yml` file. | Contract/unit (workflow file) + manual/operator evidence (live app absence) | Destroying a live Fly app is an operator action outside CI; the PR records it as evidence rather than asserting it in an automated test (CI has no credential to destroy production-adjacent infra as a side effect of a test run). |
| **AC3** — staging can still be started on request, validated, and stopped; normal merge path doesn't leave it running | 1. `cloud-staging-validate.yml`'s new "Stop platform machines" step: integration-test by dispatching the workflow (manually, once, as implementation evidence) and confirming the post-run machine state is `stopped`.<br>2. `deploy-staging-platform.yml`'s new "Stop platform machine after deploy" step: same, triggered by a real merge-path deploy; confirm machine state is `stopped` within a bounded window after the job completes.<br>3. Existing AC2/AC3 harness (`tests/cloud/staging-workflows.mjs`, `tests/cloud/staging-failure-drill.sh`) is unaffected — both already run against URLs, not machine-state assumptions, and the new wake step (generalized from today's scheduler-only wake) still runs before them. | Integration (live workflow dispatch, since this is infra orchestration with no meaningful unit-test surface) + existing harness regression | The two "wake"/"stop" steps are themselves infra orchestration, not application behavior — a live dispatch is the correct verification layer; a dry-run/mocked flyctl unit test would not catch the actual Fly API contract. |
| **AC4** — production unchanged; guard proves staging-only changes cannot target production | 1. New `staging-on-demand-production-guard.test.sh` (§3), wired into `ci.yml`, runs on every PR. 2. `render-fly-config.test.mjs` new cases (§1) prove the renderer still outputs `min_machines_running = 1` for production even though the shared default moved to `0`. 3. Diff review: `deploy-production-health-probe.yml`, `deploy-production-platform.yml`, `platform.production.overlay.toml` (aside from the one added `[http_service]` table), hostname matrix, and all production secrets are untouched by this change — captured as an explicit "no production file changed except the one line below" statement in the implementation PR description. | Unit + contract test (new) + manual diff attestation | This AC is best served by a dedicated guard test precisely because "nothing changed" cannot be asserted by functional testing — only by a contract test that would fail if a future PR tried to collapse the staging/production divergence this design deliberately introduces. |
| **AC5** — runbooks/docs updated; live Fly machine states verified and recorded | 1. `docs/systems/cloud-platform.md` and the relevant runbook(s) updated per §4 — reviewed in the PR diff. 2. The PR description/body includes a live `fly machines list --app sindustries-platform-staging --json` output (redacted of any non-public identifiers if needed) showing the stopped/on-demand state, and `fly apps list` (or equivalent) confirming `sindustries-health-probe-staging` no longer exists. | Manual (docs review) + manual (operator evidence capture, required by the AC's own text) | AC5's own wording requires "record the result in the PR" — this is inherently a manual evidence-capture AC, not something to script around. |

## Open questions and risks

1. **Auto-post worker queue latency.** With `min_machines_running = 0`, the auto-post worker (a supervisor child with no HTTP listener) only runs while the platform Machine happens to be up. A staging-scheduled post queued while the Machine is stopped will not process until something else wakes the Machine (an explicit validation window, or a request to one of the three HTTP surfaces). This is an accepted trade for a non-production environment with no real audience, but it should be stated explicitly in the runbook (§4) rather than discovered later as "staging auto-posts are delayed." No action needed beyond the doc note unless Rowan or Tom decides staging auto-post timing needs to be deterministic, in which case the fix is a dedicated wake call in whatever triggers a staging-scheduled post, not a floor change.
2. **Idle-stop timing is Fly's, not ours.** `auto_stop_machines = 'stop'` already existed; this design does not control exactly how fast Fly stops an idle Machine after the explicit stop steps' own stop call "wins" the race (i.e., the explicit stop makes the behavior deterministic regardless of Fly's idle timer, but if the explicit stop call itself fails transiently, the Machine falls back to Fly's own idle-stop schedule, not an immediate guarantee). AC5's live-state evidence capture is what proves this in practice rather than theory.
3. **Where does the new runbook content live?** §4 proposes either extending `docs/runbooks/platform-consolidation-rollback.md` or creating `docs/runbooks/staging-on-demand.md`. Per `docs/CONVENTIONS.md`'s consolidation bias for system/runbook docs, the rollback runbook is about a different event (the 2026-11-07 consolidation cutover) and this is an ongoing operational mode, not a one-time rollback step — leaning toward a new focused runbook, but leaving the final call to Rowan at implementation time since either choice satisfies AC5 and the decision has no architectural consequence.
4. **`infra/cloud/bin/status`** (not inspected in depth for this design) may assume a staging Machine is usually running when reporting staging status; Rowan should check it does not misreport "unhealthy" for a correctly-stopped on-demand Machine.
5. **Scope of the renderer's new `http_service` allow-list.** This design deliberately allow-lists only `min_machines_running`. If a future change needs to overlay another `[http_service]` key (e.g. a different `auto_stop_machines` policy per environment), that is a new, separately-reviewed allow-list addition — this design does not pre-approve a broader `[http_service]` surface.
6. **Health-probe shared file's staging app name staying literal.** Leaving `app = 'sindustries-health-probe-staging'` in the now-"staging-deploy-retired" shared `fly.toml` could read as misleading to a future reader who does not know the production overlay always replaces it. The design accepts this (§2) to avoid touching a file whose only remaining live consumer is production's render, but flags it here in case Rowan prefers an explicit comment-only clarification (already included) over leaving any ambiguity.
