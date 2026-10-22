# Hosted Observability and Migration Alerts — handover document

**Type:** System reference (handover)
**Status:** Runtime artefacts shipped on branch `task-31233a0a-hosted-observability-runtime-evidence` (PR #724, DRAFT); AC1-AC3 evidence gates on Quinn's Grafana Cloud + Fly + Neon credentials landing (Tom-owned authorisation).
**Last updated:** 2026-09-23
**Owner:** Rowan (engineering); Quinn owns the live Grafana Cloud account and Fly.io secrets
**Repos:** `Stoffer-Industries/sindustries`
**App:** Staging target on Fly.io (Sydney region); production rollout is tracked under the broader cloud migration plan

> **Naming history:** this workstream was originally scoped as a separate "Hosted Observability and Migration Alerts" spec (task `4b3d6e9c`). The artefacts land under `infra/cloud/observability/` plus two handover docs (`docs/systems/observability.md` and `infra/cloud/observability/README.md`); the prior per-alert response runbook (`docs/runbooks/cloud-alerts-response.md`) was retired in PR #583 — its per-alert content lives in the AC3/AC4 sections of `docs/specs/hosted-observability-migration-alerts-tech-design.md` and in this document's "Alert ownership" + "Runbook for each alert" sections. The local observability stack documented in `infra/docker-compose.observability.yml` continues to operate the developer's local machine unchanged.

---

## Context

SIndustries runs a multi-service Node/TypeScript stack against a Postgres + Redis back-end. The existing local observability stack (`infra/docker-compose.observability.yml` + `packages/otel-node` + `infra/grafana/`) ships traces, metrics, and dashboards to the developer's machine. That stack is a useful dev experience, but it does not satisfy the cloud migration acceptance criteria because:

- All four components run on the local machine; cloud services that emit signals from the staging/production region never reach them.
- No alert evaluation or documented ownership exists beyond the Grafana dashboard; there is no Alertmanager or external notification integration.
- No documented ownership: who responds to a 5xx alert, who triages a database health alert, who owns the dashboard definitions.

For the design rationale see [`docs/specs/hosted-observability-migration-alerts-tech-design.md`](../specs/hosted-observability-migration-alerts-tech-design.md). For the operator-facing index of artefacts see [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md). For the per-alert response expectation see this document's "Alert ownership" table below (the prior `docs/runbooks/cloud-alerts-response.md` was retired in PR #583). For the platform context this hosted stack is built on top of see [`docs/systems/cloud-platform.md`](cloud-platform.md).

This document exists so a new operator (or Quinn returning after a break) can answer the four handover questions — *what is this, who owns what, how much does it cost, and what happens when it breaks* — without having to reverse-engineer `infra/cloud/observability/`.

---

## Decision summary

| Concern                          | Choice                                                   | Owner  | Lives in                                                      |
| -------------------------------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Hosted backend                  | Grafana Cloud (free tier; upgrade path documented)       | Quinn  | Grafana Cloud org dashboard; credentials in Fly secrets       |
| Region                           | Closest Grafana Cloud region to Fly.io `syd`             | Quinn  | Provisioned at org creation                                  |
| Telemetry pipeline               | OTLP via `packages/otel-node` → Grafana Cloud OTLP       | Rowan  | `packages/otel-node/src/index.ts`; env vars below             |
| Env var contract                 | `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` (and friends) | Quinn | `infra/cloud/observability/env/.env.example` (redacted)       |
| Database signal source           | Health probe service on Fly (single-purpose Node app, `sindustries_db_up` + `sindustries_db_query_duration_seconds` + `sindustries_fly_app_health` + `sindustries_redis_up`)    | Rowan  | `infra/cloud/observability/health-probe/`         |
| Alert evaluation                 | Grafana Cloud alerting (not Alertmanager), UI/API state   | Quinn  | `infra/cloud/observability/grafana/alerts/` (10 rules, 5 page + 5 warn) |
| Hosted datasource identity       | Discovered from Grafana Cloud `/api/datasources` at bootstrap time | Quinn | Hosted Grafana API; the repo does not duplicate SaaS datasource URLs or UIDs |
| Dashboard ownership              | JSON in `infra/cloud/observability/grafana/dashboards/`  | Rowan  | Provisioned via Grafana provisioning API on bootstrap        |
| Dashboard definitions (local)    | `infra/grafana/provisioning/dashboards/json/` (existing) | Rowan  | Parity copy for hosted: `tasks-api-red.json`, `openclaw-diagnostics.json` |
| Dashboard definitions (cloud, new) | `cloud-overview.json`, `db-health.json`, `migration-alerts.json` | Rowan | `infra/cloud/observability/grafana/dashboards/`   |
| Bootstrap                        | Idempotent local script with subcommand dispatch (validate \| app \| secrets \| dashboards \| alerts \| deploy \| smoke \| evidence \| all)        | Quinn  | `infra/cloud/observability/bootstrap-observability.sh` |
| Evidence pack                    | Closing-PR evidence template (md \| sh \| json) for AC1-AC3 of task 31233a0a | Quinn  | `infra/cloud/observability/evidence-capture.sh`   |
| Failure injection                | 10 scenarios with --dry-run (redis-down/up, tasks-api-down/up, budget-api-down/up, db-down/up, deploy-failed/restored) | Quinn  | `infra/cloud/observability/failure-inject.sh`    |
| CI deploy                        | GitHub Actions, path-filtered, canary (`deploy-staging-health-probe.yml`)                    | Rowan  | `.github/workflows/deploy-staging-health-probe.yml` |
| Secrets                          | Fly app secrets + GH repo secrets                        | Quinn  | `fly secrets set …` (operator CLI); `secrets.FLY_API_TOKEN`   |
| Alert response runbook           | One section per alert; on-call, severity, mitigation      | Quinn  | Retired with PR #583 (was `docs/runbooks/cloud-alerts-response.md`). Re-create at `~/.openclaw/workspace/docs/infra/runbooks/cloud-alerts-response.md` when an alert fires for the first time and needs its own step list; for now the "Alert ownership" table below + the AC4 section of `docs/specs/hosted-observability-migration-alerts-tech-design.md` carry the same expectation. |
| Operator-facing artefact index   | README mapping each artefact to its purpose               | Rowan  | `infra/cloud/observability/README.md`                         |
| Contract tests                   | Two offline shell tests run in CI: provisioning + bootstrap | Rowan  | `infra/cloud/scripts/tests/observability-{provisioning,bootstrap}.test.sh` |
| Backward compatibility           | None required (no prior hosted telemetry)                | —      | —                                                             |

All env-var **names** referenced by deploy workflows are reviewable in the repo. Only the **values** are operator-owned.

---

## Why Grafana Cloud (and what we considered)

**Decision:** Grafana Cloud for the hosted backend. Grafana Cloud alerting for evaluation and state inspection (not Alertmanager).

### Grafana Cloud

- **Pros.** Same vendor as the existing local Grafana, single auth plane, single UI, no new agents to ship. Free tier covers staging (10k metrics series, 50GB traces, 14-day retention). Native OTLP endpoint (no agent-side translation). Provisioning API for dashboards + alert rules.
- **Cons.** Vendor lock-in. Free tier is generous but will require an upgrade when production traffic lands. Less control than self-hosted.
- **Alternatives considered.**
  - **Self-hosted Grafana + Prometheus on Fly.io** — preserves vendor independence, no egress cost. Adds a Fly app to operate; doubles the alert-routing surface (Alertmanager + Grafana alerting). Out of scope for a foundation milestone.
  - **Datadog / New Relic** — turnkey SaaS observability. Higher per-host cost; team has no operational history with either.
  - **AWS CloudWatch / GCP Cloud Operations** — natural pairing with the platform vendor. We don't run on AWS or GCP, so cross-cloud egress is wasteful.

Grafana Cloud is the right shape for the foundation milestone: zero new agents, single UI, generous free tier, and an exit path (the JSON dashboards and alert rules are portable to a self-hosted Grafana with minimal conversion).

### Grafana Cloud alerting (not Alertmanager)

- **Pros.** One fewer service to operate. Alert rules live as JSON in the same provisioning tree as dashboards, and their state is queryable through Grafana Cloud's UI/API.
- **Cons.** Tightly coupled to Grafana Cloud; portability to a Prometheus/Alertmanager self-host requires a small migration.
- **Alternatives considered.** **Alertmanager** is the de-facto standard for Prometheus, but adding it would add another Fly app to operate and a parallel routing config. Grafana Cloud's alerting is sufficient for the alert set documented in this document's "Alert ownership" table (the prior `docs/runbooks/cloud-alerts-response.md` was retired in PR #583).

---

## Region

The hosted backend is provisioned in the **Grafana Cloud region closest to Fly.io `syd` (Sydney, Australia)**. Reasoning:

- Fly apps already run in `syd` to keep latency low for Akahu/NZ traffic. The hosted backend in the same region keeps OTLP trace + metric export latency predictable and avoids cross-region egress costs.
- Operator UI is still accessible from any geography; only the data plane is regional.

If a future expansion adds Fly apps in additional regions, the hosted backend stays in `syd` and the OTLP exporter handles the cross-region hops (traces are batched, latency is acceptable for non-interactive telemetry).

---

## Account ownership, secrets, and billing

| Asset                            | Owner  | Where the value lives                                      |
| -------------------------------- | ------ | ---------------------------------------------------------- |
| Grafana Cloud org                | Quinn  | Grafana Cloud dashboard (email + 2FA)                      |
| Grafana Cloud API key            | Quinn  | Fly secrets on the health-probe app; locally in `~/.config/grafana-cloud/` |
| Fly secrets (OTEL_EXPORTER_*)    | Quinn  | `fly secrets set OTEL_EXPORTER_OTLP_ENDPOINT=…` per app     |
| Neon DB connection string        | Quinn  | Fly secrets on the health-probe app                        |
| Upstash Redis URL                | Quinn  | Fly secrets on the health-probe app                        |

The PR ships **`infra/cloud/observability/env/.env.example`** with all variable **names** and redacted **values** (placeholders, never live). The live values are bootstrapped once and then managed via `fly secrets`.

No live secret values appear in the repo at any commit.

---

## Cost expectations and upgrade path

- **Today (staging only).** Free tier is sufficient: 10k metrics series, 50GB traces, 14-day retention.
- **Expected staging growth.** Each deployed service emits ~50–200 series (HTTP requests, latency histograms, errors, dependencies). Three services + one health probe + one DB = ~500–1000 series. Well under the free tier for the next 12 months.
- **Production rollout.** Estimated 5–10× growth (longer retention, more services, more dashboards). Free tier will be exceeded; the upgrade path is documented in [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md) (Billing section).
- **Cost alarm.** A `sindustries_cost_alert` Grafana Cloud alert (added in the bootstrap script's follow-on PR) appears in Grafana Cloud when monthly active series crosses 80% of the paid-tier allowance.

---

## Dashboard and alert ownership (AC4 summary)

For the full per-alert response expectation see the "Alert ownership" table below + the AC4 section of `docs/specs/hosted-observability-migration-alerts-tech-design.md` (the prior `docs/runbooks/cloud-alerts-response.md` was retired in PR #583). For the dashboard inventory see [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md) (Dashboards section). The summary table here is the canonical ownership index.

### Dashboards

| Dashboard                       | Source                                  | Owning team | On-call rotation |
| ------------------------------- | --------------------------------------- | ----------- | ---------------- |
| `cloud-overview`                | NEW (hosted) — per-app latency, error rate, request count, deploy annotations | Rowan (engineering) | Quinn |
| `db-health`                     | NEW (hosted) — `sindustries_db_up`, query duration by app | Rowan (engineering) | Quinn |
| `migration-alerts`              | NEW (hosted) — alert routing overview    | Rowan (engineering) | Quinn |
| `tasks-api-red`                 | Existing local — ported to hosted for parity | Rowan (engineering) | Quinn |
| `openclaw-diagnostics`          | Existing local — ported to hosted for parity | Rowan (engineering) | Quinn |
| `gymtrack-browser-errors`       | NEW (hosted) — GymTrack browser error events (task e89db27f) | Rowan (engineering) | Quinn |

All dashboard definitions live as JSON in the repo (either `infra/grafana/provisioning/dashboards/json/` for local or `infra/cloud/observability/grafana/dashboards/` for hosted). Changes go through PR review; the bootstrap script provisions them via the Grafana provisioning API.

The hosted stack owns datasource URLs and UIDs. Bootstrap discovers the default Prometheus datasource and rewrites repository-local `prometheus` / `${DS_PROMETHEUS}` references while constructing each API payload. The repository deliberately does not carry a Grafana Cloud `datasources.yaml`: file provisioning is not the control plane for the managed instance.

### Alerts

| Alert                          | Severity | Owner  |
| ------------------------------ | -------- | ------ |
| `tasks-api-down`               | page     | Quinn  |
| `budget-api-down`              | page     | Quinn  |
| `tasks-api-5xx-spike`          | warn     | Quinn  |
| `budget-api-4xx-spike`         | warn     | Quinn  |
| `tasks-api-db-down`            | page     | Quinn  |
| `budget-api-db-down`           | page     | Quinn  |
| `db-query-slow`                | warn     | Quinn  |
| `redis-down`                   | page     | Quinn  |
| `worker-queue-stuck`           | warn     | Quinn  | **disabled 2026-Q4 (task 2c782afb AC2 Path B)** — see [Worker queue-depth alert](#worker-queue-depth-alert-disabled) |
| `deploy-failed`                | warn     | Quinn  | **removed 2026-Q4 (task 2c782afb AC3)** — see [Deploy-failure telemetry](#deploy-failure-telemetry) |
Severity is either `page` (immediate, P1 urgent) or `warn` (next-business-day, P2 informational). Quinn is the canonical owner for every alert in the v1 list; the runbook documents how to reassign individual alerts to Tom or another on-call. The two disabled/removed entries are documented below; both will return in a follow-up task with their durable producer, not by re-enabling the dead alert.

### Provisioning contract and common failures

- `GRAFANA_CLOUD_INSTANCE_URL` is the Grafana stack base URL used for dashboard, folder, datasource, and alert-rule APIs. It is not a Prometheus query endpoint.
- `GRAFANA_CLOUD_PROVISIONING_AUTH` is a quoted `Bearer <service-account-token>` value. The service account needs datasource read plus dashboard, folder, and alert-rule write permissions.
- `GRAFANA_CLOUD_OTLP_HEADERS` is a quoted `Authorization=Basic <base64(instance_id:access_policy_token)>` exporter header. It is a separate credential from provisioning auth. Because it is an exporter header string rather than a bare header value, consumers that speak plain HTTP must parse it (see `apps/gymtrack/api/telemetry.js` `parseOtlpHeaderString()`); passing it through verbatim produces a malformed `Authorization: Authorization=Basic …` header that Grafana Cloud rejects with 401.
- `GRAFANA_CLOUD_LOKI_ENDPOINT` is optional and required on multi-host tenants: Grafana Cloud serves OTLP from an `otlp-prod-*` gateway and the Loki HTTP push API from a separate `logs-prod-*` host, so a single OTLP base cannot describe both. When set it is used verbatim as the push endpoint.

### Endpoint pre-flight — `validate` resolves, not just collects

`bootstrap-observability.sh validate` does two things. It proves the required vars in `.env.local` are *populated*, then it resolves each configured endpoint with a read-only reachability probe and prints the observed status code with a nameable cause.

This exists because five defects behind the GymTrack browser-error-telemetry AC4 verification (PR #836, task `e89db27f`) were invisible to a green pre-flight. Each one passed `validate` and surfaced hours later, during the live run, as "telemetry is broken" — which points at the transport rather than at a misconfigured endpoint.

The probed set and the shapes below come from one table in the script (`endpoint_specs`), rendered into `infra/cloud/observability/env/.env.example` and this section. `infra/cloud/scripts/tests/observability-bootstrap.test.sh` diffs the generated block against both files, so adding a row to the table without updating the docs fails CI.

<!-- BEGIN generated: bootstrap-observability endpoint table — edit infra/cloud/observability/bootstrap-observability.sh instead -->
| Endpoint id | Env var | Role | Required shape |
| --- | --- | --- | --- |
| `grafana_instance` | `GRAFANA_CLOUD_INSTANCE_URL` | `grafana-instance` | https://<stack>.grafana.net — stack base URL only, no trailing path |
| `otlp_endpoint` | `GRAFANA_CLOUD_OTLP_ENDPOINT` | `otlp-endpoint` | https://<host> (Grafana Cloud serves OTLP under /otlp/v1/*) or https://<host>/v1/ |
| `loki_push` | `GRAFANA_CLOUD_LOKI_ENDPOINT` | `loki-push-endpoint` | OPTIONAL — https://<logs-host>/loki/api/v1/push — set on multi-host tenants, where Loki push is a different host from OTLP |
| `gymtrack_relay` | `GYMTRACK_RELAY_BASE_URL` | `gymtrack-telemetry-relay` | OPTIONAL — https://<gymtrack-host> — SPA base URL, no trailing path; validate probes <base>/api/telemetry |
| `fly_api` | `(fixed — no env var)` | `fly-api` | https://api.fly.io/ — no path, no credentials in the URL |
<!-- END generated: bootstrap-observability endpoint table -->

**The GymTrack relay probe is the one row whose verdict is not decided by the status code.** Every other row in the table classifies an HTTP status, because for those endpoints the status is the signal. `/api/telemetry` is different: the deployed GymTrack site runs an SPA catch-all rewrite, so a request for a path that has no function behind it comes back as a successful `200` serving `index.html` — a "reachable" answer that means the opposite of what it looks like. Two counter-examples, both reproduced against production, pin down why the obvious rule is wrong:

- A route that exists nowhere answers `405` on a `POST` — the same status a real POST-only function returns. Status alone cannot distinguish routed from unrouted.
- `x-vercel-cache` is `MISS` for a routed `GET` and for an unrouted `GET` alike, so that header discriminates nothing either.

The discriminator is the response shape. A real function answers with a JSON `content-type` **and** an `allow:` header (a `GET` on the POST-only relay returns `405` + `Allow: POST` + a JSON body), while the catch-all stamps `content-disposition: inline; filename="index.html"` on the built index. So `gymtrack_relay` reports `routed` (passes), `spa-catch-all` (fails — the function is not deployed, or the rewrite shadows it), or `not-a-function` (fails — a `405` with neither JSON nor `allow:`, the unrouted-counter-example shape). The probe is unauthenticated and read-only; it sends no token and receives no body.

**Reading the output.** Probes are unauthenticated by design, which is what makes a 401 informative rather than masked — a correctly configured Grafana Cloud instance answers an anonymous probe with `401`, a redirect to the login wall, or `405` on the POST-only Loki push path. All three are reported as `[OK]`. Only a genuinely unusable endpoint fails pre-flight:

| Status | Reported as | Blocks pre-flight? |
| --- | --- | --- |
| `2xx` | `ok` | no |
| `401` / `403` | `auth-required` | no |
| `302` / `303` | `instance-auth-wall` | no |
| `405` | `method-not-allowed` | no |
| `404` | `path-absent` | **yes** |
| `000` | `unreachable` | **yes** |
| `530` | `gateway-origin-failure` | **yes** |
| other `5xx` | `origin-error` | **yes** |
| n/a | `not-derivable` (no Loki push URL derivable from the OTLP base) | **yes** |

A `404` on the Loki push URL is the specific case AC3 targets: without this check it fails hours later as a `502 upstream_failure` relay error that reads as a broken relay rather than as a wrong endpoint.

Two operational notes. `validate` now needs network egress, so set `PROBE_SKIP_NETWORK=1` for an air-gapped run — it then reports the var list only. And when required vars are still missing, probes are skipped entirely: there is nothing configured to resolve, and `validate` stays usable as secrets are handed over one at a time.
- Dashboard upload wraps the checked-in model as `{dashboard: <model>, overwrite: true}`.
- Alert files stay in portable Grafana file-export format. Bootstrap translates each rule to the HTTP API schema (`folderUID`, `ruleGroup`, `orgID`), creates its deterministic folder if absent, then POSTs a new UID or PUTs an existing UID.
- The health-probe starts OTel through Node's `--require @sindustries/otel-node/register` preload. `./register` is a require-only package export and must not be imported from ESM application code; `OTEL_SERVICE_NAME=health-probe` in Fly config names the preloaded SDK.
- Fly resolves both `build.context` and `build.dockerfile` relative to the Fly config file. `infra/cloud/scripts/tests/fly-toml-context.test.sh` resolves every cloud config and rejects paths that do not reach the repository root or an existing Dockerfile.

## Worker queue-depth alert (disabled)

The `worker-queue-stuck` alert (file removed in task 2c782afb AC2 Path B, 2026-Q4) previously queried `sindustries_queue_ready` with a 100-ready-jobs threshold. Two problems forced the disable:

1. **No producer.** No runtime service in this repo emits `sindustries_queue_ready`. The content-scheduler BullMQ adapter exposes a `queueStats()` method, but the worker's startup path does not register an `ObservableGauge` for it. A naive wiring would also be unsafe — BullMQ's "ready" count includes scheduled (delayed) jobs, so a normal "schedule a tweet for tomorrow" workload would look like backlog.
2. **Dead-worker masking.** The original alert used `noDataState=OK`, which silently masks a worker that has crashed (no metric emitted → no alert). A correct wire-up needs both the gauge and a companion `sindustries_worker_up` indicator with a `noDataState=NoData` companion alert; neither is wired today.

**Decision:** the alert is removed from `infra/cloud/observability/grafana/alerts/worker-queue-stuck.json` and the contract test asserts absence. Re-enable only when both (a) a stale-aware `waiting`+`active` count is available from the adapter, and (b) the worker-up companion can be wired into the auto-post-worker boot path. Track this as a follow-up under task 2c782afb's decomposition or as a new code task; do not re-add the alert file speculatively.

## Deploy-failure telemetry

The `deploy-failed` alert (file removed in task 2c782afb AC3, 2026-Q4) previously queried `sindustries_deploy_failed_total` with a 10-minute increase threshold. No producer exists for that counter, and the design for the durable producer is larger than this task can land. The full design surface is captured in `brain/ideas/deploy-failure-telemetry-pipeline.md` (created alongside this section) and decomposes into a follow-up code task with its own tech design.

**Minimum shape of the future producer (recorded here so the next task can re-derive it without re-discovering the surface):**

- A small webhook receiver (Fly app, serverless function, or GitHub Actions relay) that accepts `workflow_run` events from GitHub Actions and converts `conclusion != "success"` events for the deploy workflows into an OTLP `sindustries_deploy_failed_total{repo, workflow, conclusion}` counter.
- Same OTLP endpoint as the rest of the hosted stack (`GRAFANA_CLOUD_OTLP_ENDPOINT` + `GRAFANA_CLOUD_OTLP_HEADERS`); reuse the existing `packages/otel-node` preload to keep the credential flow consistent.
- The producer is only as durable as its deploy target — placing it on a Fly app gives one deploy/credential surface; a serverless function trades durability for a different ops surface. The follow-up task picks one with its own trade-off document.
- The dead-metric-name contract test (`observability-provisioning.test.sh`) currently asserts that no JSON file contains `sindustries_deploy_failed_total`; the follow-up task's first action is to flip that assertion into a positive presence check once the producer ships.

The bootstrap script auto-discovers and uploads everything in `infra/cloud/observability/grafana/alerts/`; the file removal + the contract test update is sufficient to drop the alert from the hosted Grafana list on the next `bootstrap-observability.sh alerts` run.

---

## Handover checklist (for a new operator)

A future operator should be able to:

1. Run `bash infra/cloud/observability/bootstrap-observability.sh validate` to confirm all env vars are present (no Fly or Grafana auth required for `validate`; it only checks the env).
2. Run `bash infra/cloud/observability/bootstrap-observability.sh all` to provision everything (idempotent), and get a green smoke-check report back.
3. Open the five hosted dashboards from the URLs the bootstrap script prints, and see real data for the staging environment within 5 minutes.
4. Open the ten alert rules from the Grafana Cloud alerting UI/API, and see severity + owner populated for each.
5. Trigger a synthetic failure via `bash infra/cloud/observability/failure-inject.sh tasks-api-down` (10 scenarios available), observe the corresponding alert fires within 2 minutes, then `failure-inject.sh tasks-api-up` and watch the alert resolve.
6. Capture the AC1-AC3 evidence pack via `bash infra/cloud/observability/evidence-capture.sh --format md > evidence.md` and paste it into PR #724 body to flip AC1-AC3 + complete AC4 of task `31233a0a`.
7. Read the "Alert ownership" table below for the on-call response expectation of each alert (the prior `docs/runbooks/cloud-alerts-response.md` was retired in PR #583).

If any of those seven steps fails, the gap is filed as a follow-on feature task under the `4b3d6e9c` parent or as a new `infra` task depending on scope.

---

## Browser-side error telemetry

Task: `e89db27f` (Add GymTrack browser error telemetry to Grafana). The hosted stack above covers the **server** side — Fly app health, DB health, request latency, queue depth, deploy annotations — but the **browser** runs on users' devices and emits no signals to the hosted backend at all. A failing client either retries silently or surfaces as a user report. This subsection describes the browser-side surface that closes that gap for GymTrack.

**Flow (production builds only, gated on `VITE_TELEMETRY_ENABLED === '1'`):**

1. `apps/gymtrack/src/main.jsx` calls `installBrowserTelemetry()` once at module load (idempotent).
2. `apps/gymtrack/src/lib/browserTelemetry.js` registers `window.addEventListener('error', …)` and `window.addEventListener('unhandledrejection', …)`, and exposes `reportAuthError(error, context)` for the Clerk / Supabase auth paths.
3. Every event is built from a fixed allow-list (`environment`, `release`, `route`, `operation`, `provider`, `errorCode`, `status`, `message`, `stack`, `userAgent`, `timestamp`, `source`). Email addresses, `Bearer …` tokens, and `password=…` patterns are stripped from `message` and `stack` before they leave the bundle.
4. A 60-second dedupe on `errorCode + operation + route` collapses repeats; a hard cap of 5 events per minute prevents retry storms. Both reset on `visibilitychange === 'visible'`.
5. The browser POSTs the sanitized event to `apps/gymtrack/api/telemetry.js` (Vercel serverless function) with `Authorization: Bearer <VITE_TELEMETRY_TOKEN>`. The token is a per-deploy relay identifier, rotated by Quinn together with the server-side `TELEMETRY_RELAY_TOKEN` env var.
6. The serverless function validates the token with `crypto.timingSafeEqual`, enforces a 32 KB raw body cap and an 8 KB structured-payload cap, re-redacts the payload (defence in depth), rate-limits at 60 events/min/token, and forwards to the hosted Grafana Cloud Loki HTTP push endpoint with the server-held `GRAFANA_CLOUD_OTLP_HEADERS`. The push URL is resolved by `lokiEndpoint()`: an explicit `GRAFANA_CLOUD_LOKI_ENDPOINT` wins if set, otherwise the OTLP endpoint is rewritten — `…/v1` and `…/v1/{traces,metrics,logs}` (both bare and slash-terminated) all become `…/loki/api/v1/push`, and a value that is already a Loki push URL is passed through untouched. **On Grafana Cloud tenants OTLP and the Loki push API are served from different hosts (`otlp-prod-*` vs. `logs-prod-*`), so `GRAFANA_CLOUD_LOKI_ENDPOINT` is REQUIRED there.** The transport is chosen by `resolveForwardEndpoint()`, in this order: an explicit `GRAFANA_CLOUD_LOKI_ENDPOINT` wins first, then an explicit `GRAFANA_CLOUD_OTLP_LOGS_ENDPOINT`, then an **OTLP/logs** endpoint derivable from the OTLP base, then the **Loki push** rewrite `lokiPushUrl()`. The OTLP/logs branch exists because the two transports are genuinely different: `lokiPushUrl()` refuses to derive from any shape that does not end in `/v1[-suffix]` (e.g. a bare `https://otlp-gateway-prod-<region>.grafana.net`, the real production shape) and returns `null`, because OTLP and the Loki push API are served from different hosts on Grafana Cloud. For those shapes `otlpLogsUrl()` derives the OTLP/logs endpoint instead, under `/otlp/v1/*`:

| probe against `otlp-gateway-prod-au-southeast-1.grafana.net` | result |
|---|---|
| `POST /v1/logs` | `404` — path absent on this gateway |
| `POST /otlp/v1/logs` | `401` — path exists, auth required |
| `POST /v1/traces` | `404` |
| `POST /otlp/v1/traces` | `401` (control) |

So a bare host, a bare host with a trailing slash, and an `…/otlp/v1` prefix all resolve to `<base>/otlp/v1/logs`. **A bare host must NOT be rewritten to `<host>/v1/logs`** — that path is a 404 on this tenant, which is the same "config value present, URL does not resolve" failure mode that has made this path read as "the telemetry relay is broken". The canonical single-host collector shapes (`…/v1`, `…/v1/traces`, `…/v1/logs`) are deliberately left to the Loki rewriter, so single-host deployments keep forwarding exactly as before. When no transport can resolve, the handler returns **502 `misconfigured_endpoint`** (renamed from the Loki-specific `misconfigured_loki_endpoint` once two transports existed) and the message names **both** env vars it tried, so the operator can pick the right one instead of guessing. An unconfigured relay still answers `204`, and a half-armed "endpoint resolved, credential unset" state still answers `204`, so staged rollouts are unaffected.

**Transport-independent label contract.** Whichever transport carries the event, the stream labels are the same: `app`, `source`, `environment`, `release`, `route`, `operation`, `provider`, `errorCode`, `status`. On the Loki push path they are the `streams[].stream` keys. On the OTLP/logs path they are **`resourceLogs[].resource.attributes`** — resource attributes, never log-record attributes. That placement is load-bearing, not cosmetic: Loki's OTLP ingestion promotes resource attributes into indexed stream labels, while log-record attributes become structured metadata, which a LogQL **stream selector cannot match**. Putting `app`/`source` on the log record instead of the resource would forward cleanly, land the events, and then make `{app="gymtrack", source="browser"}` return nothing. The dashboard's `sum by (errorCode)`, `sum by (operation)` and `count by () (… by (route))` panels need the same treatment, which is why the full label set is emitted rather than just the two keys the operator query names. `apps/gymtrack/api/telemetry.test.js` pins this in both directions: `app` and `source` must be present as resource attributes, and the log record must carry no attributes of its own.

**Stated assumption (to be confirmed by AC4's live query).** The tests assert that *we emit* `app` and `source` as resource attributes; they cannot assert that the Grafana Cloud tenant's default index promotes those specific attributes to indexed labels on ingestion. If it does not, the events will land and the operator query will still return zero rows — which would look like "telemetry is broken" rather than "the labels were not promoted". **Verification path: run the query after provisioning and check for rows, not for a 200.** If rows are absent but the events are visible in the tenant's raw log view, the cause is label promotion on the tenant side, not the relay payload. `GRAFANA_CLOUD_OTLP_HEADERS` is parsed by `parseOtlpHeaderString()` rather than used as a raw header value: it arrives in the OTLP **exporter header string** form (`Authorization=Basic <base64>`, optionally comma-separated across several headers such as `X-Scope-OrgID`), which is the same format the OTel SDKs and `bootstrap-observability.sh` already consume. Splitting on the first `=` keeps base64 padding intact, values are URL-decoded, and a segment whose leading chunk is not a valid header name is treated as a bare header value so `Basic <b64>` keeps working. The relay's own unit tests live in `apps/gymtrack/api/telemetry.test.js` and assert this resolution, this header parsing, the token check, the rate limit, the redaction pass, and the size caps.
7. The hosted Loki tenant absorbs the new event source. The new `gymtrack-browser-errors` dashboard (JSON in `apps/gymtrack/grafana/dashboards/gymtrack-browser-errors.json`) is provisioned by the existing `bootstrap-observability.sh`; the script's `step_dashboards` function now also walks `apps/gymtrack/grafana/dashboards/*.json` in addition to its canonical tree.

**What the browser bundle does NOT hold:**

- The Grafana Cloud OTLP / Loki credentials (the serverless function holds them).
- Any user identity, session token, password, or authorization header (the redaction allow-list is the public contract; the unit tests in `apps/gymtrack/src/lib/browserTelemetry.test.js` and `apps/gymtrack/api/telemetry.test.js` assert the boundary on both the browser and relay sides, with representative Clerk and Supabase envelopes).
- The `CLERK_SECRET_KEY` (already server-only).

**Ownership and verification (production):**

- Quinn generates `TELEMETRY_RELAY_TOKEN` (Vercel) and `VITE_TELEMETRY_TOKEN` (build-time) with the same value, sets `VITE_TELEMETRY_ENABLED=1` in the Vercel env, and re-runs `bash infra/cloud/observability/bootstrap-observability.sh dashboards` to (re)provision the dashboard.
- Quinn induces a wrong-password sign-in on the production host, then captures a real uncaught browser exception by pasting this into the devtools console on that same production page:

  ```js
  setTimeout(() => { throw new Error('gymtrack-browser-error-telemetry-evidence-YYYY-MM-DD') }, 0)
  ```

  This raises a genuine uncaught `ErrorEvent` on `window`, so it travels the same `error` listener, redaction, dedupe, and relay path as a user-visible crash — with no code change, no deploy, and nothing to clean up. A deploy-only affordance must not be used for this: a throw route shipped to production has to be removed again on a separate cadence, and a forgotten one is a live footgun. Then query Loki with `{app="gymtrack", source="browser"}` to confirm both events within 60 seconds. Evidence (timestamps + Loki query) is recorded in the PR body.

  The two halves exercise different code paths into the relay, which is why AC4 needs both: the wrong-password sign-in goes through `reportAuthError` (`source: 'auth'`), the console throw through the global `error` listener (`source: 'window.error'`).
- Rowan owns the in-repo code (`apps/gymtrack/src/lib/browserTelemetry.js`, `apps/gymtrack/api/telemetry.js`, the dashboard JSON, the `bootstrap-observability.sh` upload step, and the unit tests). The full design and AC-by-AC test plan are in `docs/specs/gymtrack-browser-error-telemetry-tech-design.md` and `apps/gymtrack/SPEC.md` § "Error handling".

**Cross-product guidance.** The relay + redaction pattern is intentionally not packaged today. If Budget, Tasks, or Mission Control adopt the same surface, the shared package is a follow-up; for now the redaction helper, the relay, and the dashboard all live in `apps/gymtrack/` to keep the change scoped to the one product that needed it.

## Out of scope (explicit non-goals)

- Replacing the existing local observability stack (operators continue to use it on their dev machines).
- Building product analytics (Mixpanel/Amplitude-style events). Out of scope per the spec's non-goals.
- Alertmanager self-hosting. Grafana Cloud's alerting is sufficient.
- Outbound alert notification integrations (Slack, PagerDuty, email, or similar). These require a separate decision and task.
- Drift detection for the observability stack. Follow-on workstream.
- A `*.sindustries.dev` Grafana subdomain. Future UX improvement.

---

## Related docs

- [`docs/specs/hosted-observability-migration-alerts-tech-design.md`](../specs/hosted-observability-migration-alerts-tech-design.md) — tech design for this workstream.
- [`docs/systems/cloud-platform.md`](cloud-platform.md) — the cloud platform this hosted stack is built on.
- [`docs/systems/agent-incidents.md`](agent-incidents.md) — the local agent-incident reporting flow; future work may route agent incidents through the same alerting machinery.
- [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md) — operator-facing index of the artefacts.
- `~/.openclaw/workspace/docs/infra/runbooks/cloud-alerts-response.md` — per-alert response runbook (was at `docs/runbooks/cloud-alerts-response.md`; retired in PR #583 — re-create in workspace the first time an alert fires and needs its own step list; for now the "Alert ownership" table above is the source of truth).
- [`infra/cloud/README.md`](../../infra/cloud/README.md) — parent index of `infra/cloud/` artefacts.
