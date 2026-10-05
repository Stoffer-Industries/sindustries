---
status: draft
task_id: 2c782afb-2499-4225-8936-c4d3c5279a03
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/ideas/hosted-observability-followups.md
shipped_pr: null
shipped_date: null
---

# Hosted Observability Follow-ups — Tech Design

## Product spec link

- Idea capture (decomposes the remaining work after PR #724): `/Users/quinnstoffer/.openclaw/workspace/brain/ideas/hosted-observability-followups.md`
- Parent tech design: `docs/specs/hosted-observability-migration-alerts-tech-design.md` (task `4b3d6e9c`, on branch `task-4b3d6e9c-hosted-observability`)
- Predecessor task: `4b3d6e9c-d1ba-462c-aa72-4371ce81d8c7` (shipped via PR #724 — runtime artefacts, dashboards, alert rules, health-probe service, bootstrap script)
- Current task: `2c782afb-2499-4225-8936-c4d3c5279a03`
- Task API detail: `http://localhost:4001/api/v1/tasks/2c782afb-2499-4225-8936-c4d3c5279a03`

## Task and repository

- Task ID: `2c782afb-2499-4225-8936-c4d3c5279a03`
- Task title: `💻 Hosted observability follow-ups`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-2c782afb-hosted-observability-followups`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-2c782afb-hosted-observability-followups`
- Task type: `code` (follows the code-task workflow per `agents/skills/dev/WORKFLOW.md` — no product spec gate, optional tech design, structured `qa_agent` approval before Tom's `accepted`)

## Product intent summary

PR #724 shipped the runtime side of the hosted observability stack: 5 Grafana dashboards, 10 alert rules, the health-probe Node service, datasources.yaml, the subcommand-driven `bootstrap-observability.sh`, evidence-capture.sh, and failure-inject.sh. With one critical exception now patched in PR #724 head (`a6bcce77` — exporting health probe gauges through OTLP so they actually reach Grafana Cloud), the runtime side is correct.

What's left is a focused set of follow-ups captured in `brain/ideas/hosted-observability-followups.md`. Three are code-side and fall under Rowan (AC1–AC3). Two are cloud/ops-side and fall under Quinn (AC4–AC5).

This task separates the merge-safe core (the dashboard/alert query fixes, the dead-alert removals, the queue-depth metric wiring) from later production-hardening (Quinn's watchdog cron, read-scoped credentials, alert routing, cardinality budget).

## Scope split (per task description)

| AC | Owner | Scope |
| --- | --- | --- |
| AC1 | Rowan | Fix Cloud Overview + the two HTTP alert rules to use the emitted `http_server_duration_milliseconds_*` contract and ratio-based error-rate expressions; regression verification. |
| AC2 | Rowan | Wire `sindustries_queue_ready` into the content-scheduler worker with stale/dead-worker handling, **or** explicitly disable the queue-depth alert with the reason documented. |
| AC3 | Rowan | Disable or remove the `deploy-failed` alert until a durable producer exists; document its separate telemetry design. |
| AC4 | Quinn | Read-scoped Grafana credential + a real alert fire-to-resolve verification path (without weakening the ingest-only workload credential). |
| AC5 | Quinn | Operational hardening — probe watchdog, secret rotation/scoping, cardinality/retention budget, bootstrap idempotency re-verification, alert routing/runbook gaps. |

**This tech design covers AC1–AC3 only.** AC4–AC5 are Quinn-owned; no design or implementation work from Rowan touches those.

## Service boundary and data ownership

- **Runtime services** — `services/tasks-api`, `services/budget-api`, `services/content-scheduler-api`, `services/content-scheduler/auto-post-worker`. All four already use `@sindustries/otel-node` to emit traces + metrics via OTLP. This task does not change the OTel SDK shape; it adjusts alert expressions and dashboard queries to match the actual metric names emitted by the SDK.
- **Health-probe service** — `infra/cloud/observability/health-probe/` (PR #724). Continues to own `sindustries_db_up`, `sindustries_db_query_duration_seconds`, `sindustries_fly_app_health`, `sindustries_redis_up`, `sindustries_health_probe_runs_total`, `sindustries_health_probe_errors_total`. No schema change.
- **Hosted Grafana artefacts** — `infra/cloud/observability/grafana/{dashboards,alerts,datasources.yaml}`. Owned by the bootstrap script (`infra/cloud/observability/bootstrap-observability.sh`) which idempotently PUTs them via the Grafana provisioning API. This task edits those JSON/YAML artefacts in place; no new files for the dashboards/alerts themselves unless a new metric producer (AC2) requires a new panel.
- **Content-scheduler worker** — `services/content-scheduler/auto-post-worker`. AC2 may add a `sindustries_queue_ready` ObservableGauge via the existing OTel preload (`packages/otel-node/src/register.ts`). No new service.
- **Operational/credential work** (Quinn's AC4–AC5) — out of scope here. No service or code changes for Quinn's items from this design.

## `.openclaw` boundary notes

- **No Quinn-owned secrets land in this PR.** All work is artefact/query/wiring changes that compile + lint + test locally. The Quinn credentials (`GRAFANA_CLOUD_*`, `NEON_DB_*`, `HEALTH_PROBE_DATABASES`, `FLY_API_TOKEN`) flow through `bootstrap-observability.sh` separately per the existing runbook.
- **No cron changes.** AC2's `sindustries_queue_ready` ObservableGauge runs inside the worker's existing OTel preload lifecycle, not as a `.openclaw` cron.
- **No DNS / network changes.** All dashboard + alert edits remain JSON/YAML on disk; provisioning happens through the existing Grafana provisioning API surface.
- **No agent skill / lobster workflow changes.** This task does not introduce new state semantics; it fixes existing artefacts. The code-task workflow already handles this surface.

## Implementation plan

### AC1 — Fix Cloud Overview + the two HTTP alert rules

**Root cause (per `brain/ideas/hosted-observability-followups.md`):** the Cloud Overview dashboard panel and the `tasks-api-5xx-spike` / `budget-api-4xx-spike` alerts query `http_requests_total` / `http_server_request_duration_seconds_*`, which do not exist. The deployed stack emits old-semconv OTel HTTP metrics: `http_server_duration_milliseconds_{bucket,sum,count}` with labels `service_name`, `http_method`, `http_status_code`, `http_route`. The existing local `tasks-api-red.json` dashboard already uses the correct metric names; copy the query pattern from there.

Additionally, the two alerts describe themselves as "5%/20% error rate" but currently use absolute request-rate thresholds. The expression must change to `sum(rate(...{status=~"5.."}[5m])) / sum(rate(...[5m])) > 0.05` (5xx ratio) and `... / ... > 0.20` (4xx ratio).

**Steps:**

1. Edit `infra/cloud/observability/grafana/dashboards/cloud-overview.json`: the request-rate / error-rate / p95 latency panels move to `http_server_duration_milliseconds_{count,sum,bucket}` with labels `service_name`, `http_method`, `http_status_code`, `http_route`. Match the panel structure and variable interpolation in `infra/grafana/provisioning/dashboards/json/tasks-api-red.json`.
2. Edit `infra/cloud/observability/grafana/alerts/tasks-api-5xx-spike.json`: replace the absolute-rate expression with the 5xx ratio, raise severity/owner unchanged, keep the `for = 5m` duration.
3. Edit `infra/cloud/observability/grafana/alerts/budget-api-4xx-spike.json`: replace the absolute-rate expression with the 4xx ratio, raise severity/owner unchanged, keep `for = 10m`.
5. Extend `infra/cloud/scripts/tests/observability-provisioning.test.sh`:
   - assert Cloud Overview references `http_server_duration_milliseconds_*` in every panel that touches HTTP latency/error/count;
   - assert the two alert rule JSON files contain a `/` in their query expression (the ratio operator — contract test for "this is a ratio, not an absolute rate");
   - assert no dashboard/alert JSON contains the dead `http_requests_total` or `http_server_request_duration_seconds_*` strings.
6. Extend the local Tasks/Budget API smoke test (already in `infra/cloud/contracts/tests/` or an equivalent) to seed both 2xx and 5xx responses, then assert the dashboard query shape (`sum by (service_name) (rate(http_server_duration_milliseconds_count{...[5m]}))`) resolves to non-empty data via the OTel test exporter.

**Regression verification:** `bash infra/cloud/scripts/tests/observability-provisioning.test.sh`, `npm test --workspace infra/cloud/observability/health-probe`, `bash /Users/quinnstoffer/.openclaw/workspace/agents/rowan/infra/cloud/scripts/tests/observability-bootstrap.test.sh` (offline), and a live Grafana dashboard render after Quinn runs `bootstrap-observability.sh all` against staging.

### AC2 — queue-depth alert: wire `sindustries_queue_ready` or disable

**Root cause:** `worker-queue-stuck` alert queries `sindustries_queue_ready` but no producer emits it. BullMQ adapter already has a tested `queueStats()` method (referenced in `brain/ideas/hosted-observability-followups.md`); the missing piece is an ObservableGauge wired into the worker's existing OTel preload.

Two traps documented in the idea doc must be designed around:

- **Delayed / future jobs.** BullMQ's "ready" count includes delayed (scheduled future) jobs, so a normal "schedule a tweet for tomorrow" workload looks like backlog. The gauge must count only jobs in the `waiting`/`active` states, excluding `delayed`. The BullMQ adapter's `queueStats()` exposes this distinction; verify before wiring.
- **Dead worker masking.** The alert currently uses `noDataState=OK`, which silently masks a worker that has crashed (no metric emitted → no alert). The wired gauge must emit a `sindustries_worker_up` companion (1 = last scrape emitted, 0 = stale or process dead) and the alert must use `noDataState=NoData` plus a companion `worker-stale` alert that pages on `sindustries_worker_up == 0 for 2m`.

**Two paths, pick one:**

**Path A — wire the producer (preferred):**

1. In `services/content-scheduler/auto-post-worker/src/`: add an ObservableGauge `sindustries_queue_ready` (sum of `waiting` + `active` across the worker's queues, labels `service_name`, `queue_name`) and an ObservableGauge `sindustries_worker_up` (constant 1, scraped via the OTel node-up pattern) into the worker startup alongside the existing metric registrations.
2. Wire a 30s scrape cadence matching the health-probe cadence; reuse the OTLP exporter config the worker already loads via `packages/otel-node/register.ts`.
3. Edit `infra/cloud/observability/grafana/alerts/worker-queue-stuck.json`: query `sindustries_queue_ready`, set `noDataState=NoData`. Keep severity=warn, owner=Quinn, `for=5m` unless evidence shows otherwise.
4. New file `infra/cloud/observability/grafana/alerts/worker-stale.json`: query `sindustries_worker_up == 0 for 2m`, severity=page, owner=Quinn, channel=`#sindustries-p1` (matches the existing page-tier routing).
5. Extend the provisioning contract test to assert both alert JSONs are present and the worker-up alert is `page`-tier.

**Path B — disable the alert with documented reason:**

If the BullMQ adapter exposes only "ready including delayed", or if the worker-up companion proves infeasible without restructuring the worker boot path, fall back to disabling the alert and documenting why. Steps:

1. Edit `infra/cloud/observability/grafana/alerts/worker-queue-stuck.json`: add `"noDataState": "OK"`, `"evaluationInterval": "0"` (disable), or remove the file entirely from the dashboard's alert group — the existing pattern in PR #724 ships alerts as JSON files referenced by the bootstrap script, so removing the file plus its provisioner reference is the cleanest disable.
2. Add a section to `docs/systems/observability.md` recording the decision: "queue-depth alert is disabled in 2026-Q4 — producer deferred until BullMQ adapter exposes a stale-aware `waiting`+`active` count or until the worker-up companion pattern can be wired into the auto-post-worker boot path."
3. Extend the contract test to assert the alert file is absent (or its evaluationInterval is `"0"`).

**Decision rule:** attempt Path A on the implementation slice. If the BullMQ adapter exposes only "ready including delayed" or the worker-up wiring proves unsafe, fall back to Path B in the same slice and document the switch in the PR description + the system spec.

### AC3 — disable or remove `deploy-failed` alert; document separate telemetry design

**Root cause:** `deploy-failed` alert queries `sindustries_deploy_failed_total` but no producer emits it. Per the idea doc, "deploy-failure telemetry is a bigger, separate-initiative-sized lift — needs a durable GitHub Actions → Grafana event pipeline, not a quick fix."

**Steps:**

1. Edit or remove `infra/cloud/observability/grafana/alerts/deploy-failed.json`. Same disable pattern as AC2 Path B. The cleanest move is to delete the file and drop its reference from `bootstrap-observability.sh`'s alerts upload step.
2. Extend the provisioning contract test to assert no JSON file with `"uid": "deploy-failed"` is shipped, and that `bootstrap-observability.sh` does not reference the removed uid.
3. Add a section to `docs/systems/observability.md` describing the **separate telemetry design** the alert would require: GitHub Actions workflow_run webhook → a small relay service or webhook → OTLP `sindustries_deploy_failed_total{repo, workflow, conclusion}` counter → Grafana. Note that this is out of scope for the current task and the suggestion is to land it in a follow-up code task with its own tech design.
4. Add an entry to `brain/ideas/deploy-failure-telemetry-pipeline.md` (new idea doc) capturing the design surface, the open questions (relay-service hosting on Fly vs serverless function, GitHub webhook secret storage, OTLP auth reuse vs new credential), and the proposed scope for the follow-up task.

**This is a removal + documentation.** No code in services/ or packages/.

### AC1–AC3 verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Provisioning contract test asserts the new dashboard queries reference `http_server_duration_milliseconds_*` and the two alert JSON files contain a `/` operator (the ratio contract). A live Grafana dashboard render against staging shows non-empty panels. The CI offline contract test asserts no dead metric names remain. | Contract test output (offline) + bootstrap-driven dashboard render (live) before AC1 box is flipped. |
| AC2 | Either (a) the worker's `sindustries_queue_ready` + `sindustries_worker_up` gauges are emitted at runtime, the `worker-queue-stuck` alert queries the gauge with `noDataState=NoData`, the new `worker-stale` alert is provisioned, and the contract test asserts both; **or** (b) the alert file is absent, the system spec records the decision, and the contract test asserts the absence. | CI offline + a synthetic emit-confirm run (no real failure injection). |
| AC3 | The `deploy-failed` alert JSON file is absent (or evaluationInterval=0), the bootstrap script does not reference its uid, the contract test asserts both, and `brain/ideas/deploy-failure-telemetry-pipeline.md` is committed alongside the system spec update. | Contract test + the new idea doc committed in the same PR. |

### AC1–AC3 unit / contract tests

- `infra/cloud/scripts/tests/observability-provisioning.test.sh` — extended in AC1 and AC3; ensures dead metric names are not reintroduced.
- `infra/cloud/scripts/tests/observability-bootstrap.test.sh` — extended to assert AC1 ratio expressions and AC3 alert-file absence.
- `npm test --workspace infra/cloud/observability/health-probe` — must remain 17/17 (the OTel fix in `a6bcce77` already shipped; this PR does not touch the health-probe surface unless AC2 wires a worker-up companion in the auto-post-worker).
- `npm test --workspace services/content-scheduler/auto-post-worker` — required when AC2 Path A lands; must remain green with the new ObservableGauge.

### Manual verification

- Quinn runs `bootstrap-observability.sh validate` then `bootstrap-observability.sh all` against staging. The dashboards render non-empty panels (AC1). The `worker-queue-stuck` and `worker-stale` alerts appear (or the alert is absent, AC2 Path B). The `deploy-failed` alert no longer appears in Grafana's alert list (AC3).
- Quinn triggers `infra/cloud/observability/failure-inject.sh redis-down` against staging. The existing `redis-down` alert fires; the new `worker-stale` alert (if AC2 Path A) does NOT fire because the probe is a separate process. Verifies the alert routing is correctly scoped.
- Quinn exports the alert list from the Grafana provisioning API and pastes the JSON into the PR description as AC1–AC3 evidence per the task's AC4 evidence pattern.

## Data model and API contract changes

**None.** This task edits dashboard JSON, alert JSON, a worker metric registration, a system spec doc, and an idea doc. No schema, no HTTP API contract changes, no service boundary changes.

## Workflow, cron, and skill changes

- **Cron:** none. The `sindustries_queue_ready` ObservableGauge (if AC2 Path A) runs inside the auto-post-worker process, not as a separate `.openclaw` cron.
- **Skills:** none. The code-task workflow already covers this PR shape.
- **Workflow (lobster):** none. The code-task lobster (via `agents/workflows/feature-task/code-task.lobster.yaml`) already handles `qa_agent` and `tech_design` approvals for tasks of this shape.

## Test plan

### Automated tests

- `bash infra/cloud/scripts/tests/observability-provisioning.test.sh` — extended for AC1 (dead-metric-name absence, ratio-expression presence) + AC3 (deploy-failed alert absence).
- `bash infra/cloud/scripts/tests/observability-bootstrap.test.sh` — extended for AC1 ratio expressions + AC3 bootstrap-script references.
- `npm test --workspace infra/cloud/observability/health-probe` — must remain green; not directly touched but provides the regression baseline.
- `npm test --workspace @sindustries/otel-node` — must remain 10/10; not directly touched.
- `npm test --workspace services/content-scheduler/auto-post-worker` — required only if AC2 Path A lands; covers the new ObservableGauge registration + scrape lifecycle.

### AC verification matrix (extended)

See the AC1–AC3 verification matrix above. The runtime evidence half (dashboard render against live staging) is the same shape as task `31233a0a` AC1–AC3 and remains Quinn-owned; Quinn will run the bootstrap + paste the JSON into the closing PR per the existing runbook.

### Manual verification

See the manual verification block above. Quinn's bootstrap run + `failure-inject.sh redis-down` smoke + alert-list JSON export cover AC1–AC3.

## Open questions and risks

1. **BullMQ adapter's "ready including delayed" trap.** If the adapter does not already distinguish `waiting`/`active` from `delayed`, AC2 Path A is non-trivial and may force Path B (disable with documented reason). Mitigation: read `services/content-scheduler/auto-post-worker/src/` adapter first; if the distinction is missing, the adapter change is a small extension to the existing `queueStats()` method and stays in this PR.
2. **Worker-up companion wiring.** `sindustries_worker_up` requires the worker process to register an ObservableGauge that emits at least once per scrape interval. The OTel JS SDK's `start()` is the obvious surface; if the worker's lifecycle makes this awkward (e.g., graceful shutdown stops the meter provider before the gauge emits), Path A becomes infeasible. Mitigation: prototype in the slice; if awkward, fall back to Path B.
3. **Cloud Overview dashboard variables.** The current Cloud Overview references `$app` and `$region` template variables. Switching metric names must preserve all variable usage to keep the dashboard usable across services. Mitigation: cross-check with the existing `tasks-api-red.json` dashboard's variable interpolation pattern; match it.
4. **No backward-incompatible signal changes.** The new `http_server_duration_milliseconds_*` queries match what is already deployed (per PR #724 head `a6bcce77`). There is no prior state to migrate; this is a query fix, not a metric rename.
5. **The OTel-metrics fix `a6bcce77` is in PR #724 head, not in main yet.** PR #724 is still DRAFT, BEHIND main by 11 commits, with the cherry-pick `a6bcce77` (Quinn's catch-up patch) on top. This task does NOT depend on PR #724 merging — the metric names are emitted by the deployed stack today; the dashboard query fix here aligns the dashboard to that deployed reality. PR #724's merge is a separate workstream owned by Quinn.
6. **System spec update alongside the code.** `docs/systems/observability.md` is updated in this PR (AC2 Path B decision + AC3 separate telemetry design). No follow-up docs PR; both ship together.
7. **The ideas doc** `brain/ideas/hosted-observability-followups.md` is the decomposition that drives this design; it stays as-is. The new `brain/ideas/deploy-failure-telemetry-pipeline.md` (AC3) is a follow-up idea doc, not a modification of this one.

## AC matrix (cross-reference)

| AC | Spec text | Implementation reference |
| --- | --- | --- |
| AC1 | Cloud Overview and the two HTTP alert rules use the emitted `http_server_duration_milliseconds_*` contract and ratio-based error-rate expressions, with regression verification. | `infra/cloud/observability/grafana/dashboards/cloud-overview.json` + `infra/cloud/observability/grafana/alerts/{tasks-api-5xx-spike,budget-api-4xx-spike}.json` + extended contract tests. |
| AC2 | The queue-depth alert is either backed by a worker-owned `sindustries_queue_ready` metric with stale/dead-worker handling, or explicitly disabled with the reason documented. | `services/content-scheduler/auto-post-worker/src/` ObservableGauge (Path A) **or** `docs/systems/observability.md` decision record (Path B). |
| AC3 | The deploy-failure alert is disabled or removed until a durable producer exists; its separate telemetry design is documented. | `infra/cloud/observability/grafana/alerts/deploy-failed.json` removal + `docs/systems/observability.md` separate-design section + `brain/ideas/deploy-failure-telemetry-pipeline.md`. |

## Out of scope (Quinn-owned)

- **AC4** — read-scoped Grafana credential + alert fire-to-resolve verification path. Quinn-owned; no design or implementation from this PR.
- **AC5** — probe watchdog cron, secret rotation/scoping, cardinality/retention budget, bootstrap idempotency re-verification, alert routing/runbook gaps. Quinn-owned; documented in the task description but not touched here.

The Quinn-owned ACs remain in this task's task description for routing visibility; nothing in this PR or its implementation branch lands them.