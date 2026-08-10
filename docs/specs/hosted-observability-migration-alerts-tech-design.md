---
status: draft
task_id: 4b3d6e9c-d1ba-462c-aa72-4371ce81d8c7
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/hosted-observability-migration-alerts.md
shipped_pr: null
shipped_date: null
---

# Hosted Observability and Migration Alerts — Tech Design

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/hosted-observability-migration-alerts.md`
- Migration index: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/sindustries-cloud-migration.md`
- Task API detail: `http://localhost:4001/api/v1/tasks/4b3d6e9c-d1ba-462c-aa72-4371ce81d8c7`
- Predecessor design: `docs/specs/cloud-deployment-foundation-tech-design.md` (task `b2f62c36`, on branch `task-b2f62c36-cloud-deployment-foundation`) — the destination platform.

## Task and repository

- Task ID: `4b3d6e9c-d1ba-462c-aa72-4371ce81d8c7`
- Task title: `💻 Add hosted observability and migration alerts`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-4b3d6e9c-hosted-observability`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-4b3d6e9c-hosted-observability`

## Product intent summary

The existing local observability stack (Prometheus, Tempo, OTel Collector, Grafana) ships in `infra/docker-compose.observability.yml` and is wired through `packages/otel-node` for the Node services. That stack is a useful dev experience, but it does not satisfy the migration acceptance criteria because:

- All four components run on the local machine; cloud services that emit signals from the staging/production region never reach them.
- No alert routing exists beyond the Grafana dashboard; there is no Alertmanager, no PagerDuty / Slack / email integration.
- No documented ownership: who responds to a 5xx alert, who triages a database health alert, who owns the dashboard definitions.

Once this task lands, the cloud-deployed services ship traces, metrics, and database health to a hosted backend (Grafana Cloud is the recommended choice — see Open Questions). The hosted backend exposes the same shape of signals (PromQL queries, Tempo trace IDs, Postgres health views) that operators can use to diagnose failures without touching the local machine. Alerts route to owner-defined Slack channels with documented severity and response expectations.

## Service boundary and data ownership

- **Hosted backend — Grafana Cloud**, free tier (10k metrics series, 50GB traces, 14-day retention). Rationale: same vendor as the existing local Grafana, single auth plane, single UI, no new agents to ship. Self-hosting on Fly.io is the alternative (Open Question 1).
- **Telemetry pipeline** — services already use `@sindustries/otel-node` to emit traces and metrics via OTLP. The change here is environment: the collector/processor destination flips from the local Tempo/Prometheus to Grafana Cloud OTLP endpoints. The OTel SDK does not change.
- **Database signal source** — Postgres on Cloud (Neon) exposes connection health via PgBouncer or a cron'd `SELECT 1`. A small side process (also on Fly) runs the health probe and emits the result as a Prometheus metric. The metric is the durable source of truth; the cron'd query is a fallback.
- **Alert routing** — Alertmanager is not used in this task. Instead, Grafana Cloud's alerting routes directly to Slack via a webhook. The Slack workspace and channel topology is owner-supplied (Quinn owns the Slack workspace).
- **Dashboard ownership** — `docs/systems/observability.md` becomes the canonical owner index. The repo carries the dashboards as JSON in `infra/grafana/provisioning/dashboards/json/` (existing pattern); the hosted backend provisions those same JSONs via the Grafana provisioning API.
- **Service ownership** — domain ownership of the application services stays in `services/tasks-api`, `services/budget-api`, `services/gymtrack-mcp`. This task does not extend application code; it extends the runtime telemetry destination.

## `.openclaw` boundary notes

- **Owner-supplied secrets** — Grafana Cloud API key, Slack webhook URL, Slack channel names, Neon connection string for the health probe. These are Quinn-owned and **must not** be committed. The PR ships `infra/cloud/observability/.env.example` (redacted) and the wiring code; live values land in Fly.io secrets per the foundation task.
- **No `.openclaw` cron changes** — periodic health probes and metric scrape intervals are owned by the cloud runtime (Grafana Cloud's scrape config, the health-probe Fly app) and not by Quinn's local cron.
- **No DNS changes** — the hosted Grafana URL is owned by Grafana Cloud; SIndustries does not provision a `*.sindustries.dev` Grafana subdomain in this task. That's a future UX improvement, not a foundation requirement.

## Implementation plan

### 1. Backend choice documentation

Add `docs/systems/observability.md` describing:

- Backend: Grafana Cloud (rationale, alternatives).
- Region: closest to the deployed Fly.io region (Sydney).
- Cost model: free tier limits, expected growth, when to upgrade.
- Account ownership: who owns the Grafana Cloud org, who has billing, who can edit dashboards.
- Handover: what the recipient needs to know to operate alerts, dashboards, and trace queries.

This document is the durable answer to AC4 ownership.

### 2. Repository-side configuration

```
infra/cloud/observability/
  README.md
  bootstrap-observability.sh   # one-shot, idempotent: register Fly app, set secrets, deploy health probe
  health-probe/
    package.json
    src/probe.ts                # emits DB health, Fly app health, and queue depth metrics
    Dockerfile
  fly.toml                      # health probe app definition
  grafana/
    datasources.yaml            # mirrors existing infra/grafana/provisioning/datasources/datasources.yaml
    dashboards/
      tasks-api-red.json        # copied from local provisioning
      openclaw-diagnostics.json # copied from local provisioning
      cloud-overview.json       # NEW: staging cloud overview
      db-health.json            # NEW: db-health specific
      migration-alerts.json     # NEW: alert routing overview
  alertmanager/                 # NOT used; documenting why
    README.md
.github/workflows/
  deploy-observability-health-probe.yml
```

This tree is the runtime artefact answer to AC1 (visibility) and AC3 (diagnosis).

### 3. Backend wiring

The existing `packages/otel-node` package is the source of truth for OTLP export. The following environment-driven changes:

- New env vars (read by `packages/otel-node`):
  - `OTEL_EXPORTER_OTLP_ENDPOINT` — defaults to Grafana Cloud OTLP endpoint when set.
  - `OTEL_EXPORTER_OTLP_HEADERS` — defaults to Grafana Cloud's auth header.
  - `OTEL_RESOURCE_ATTRIBUTES` — adds `deployment.environment=staging` for stamps.
- The default behavior (no env vars) keeps pointing at the local OTel Collector so the local dev experience is unchanged. Production runs require the new env vars; the storefront `/healthz` endpoint will not behave differently.

### 4. Health probe

A small, single-purpose Node service that periodically emits:

- `sindustries_db_up{app="tasks-api"}` — `1` if the `SELECT 1` query returns, `0` otherwise.
- `sindustries_db_up{app="budget-api"}` — same for the budget-api database.
- `sindustries_db_query_duration_seconds` — histogram of the `SELECT 1` round-trip.
- `sindustries_fly_app_health{app="<name>"}` — `1` if `GET /healthz` returns 200, `0` otherwise. Per deployed app.
- `sindustries_redis_up{app="content-scheduler"}` — `1` if `PING` returns OK.

The probe is a single Fly app (`infra/cloud/observability/health-probe/`) that runs every 30 seconds. It is its own service, not a sidecar of the existing apps. The probe exposes its own `/healthz` and is allowed to be unavailable (it is the canary, not the path).

### 5. Dashboards

The hosted Grafana is provisioned with the dashboard JSON via the provisioning API. The four hosted dashboards:

- **Cloud overview** — per-app p95 latency, error rate, request count, with annotations for deploys.
- **DB health** — the `sindustries_db_up` and `sindustries_db_query_duration_seconds` metrics, broken down by app.
- **Migration alerts** — alert routing overview: which alerts are firing, which Slack channels they hit, how long each has been open.
- **Copy of existing local dashboards** — `tasks-api-red.json` and `openclaw-diagnostics.json` (existing) — proven to be useful in dev, ported to the hosted backend for parity.

Dashboards are JSON in `infra/cloud/observability/grafana/dashboards/`. The provisioning script uploads them via the Grafana provisioning API.

### 6. Alerts

Grafana Cloud's alerting (not Alertmanager) is the routing layer. Alert rules:

| Alert | Source | Condition | Severity | Channel | Owner |
| --- | --- | --- | --- | --- | --- |
| `tasks-api-down` | fly app health | `sindustries_fly_app_health{app="tasks-api"} == 0` for 2m | page | `#sindustries-p1` | Quinn |
| `budget-api-down` | fly app health | `sindustries_fly_app_health{app="budget-api"} == 0` for 2m | page | `#sindustries-p1` | Quinn |
| `tasks-api-5xx-spike` | request metrics | `rate(http_requests_total{status=~"5.."}[5m]) > 0.05` for 5m | warn | `#sindustries-p2` | Quinn |
| `budget-api-4xx-spike` | request metrics | `rate(http_requests_total{status=~"4.."}[5m]) > 0.20` for 10m | warn | `#sindustries-p2` | Quinn |
| `tasks-api-db-down` | db health | `sindustries_db_up{app="tasks-api"} == 0` for 1m | page | `#sindustries-p1` | Quinn |
| `budget-api-db-down` | db health | `sindustries_db_up{app="budget-api"} == 0` for 1m | page | `#sindustries-p1` | Quinn |
| `db-query-slow` | db health | `histogram_quantile(0.95, sindustries_db_query_duration_seconds) > 0.5` for 5m | warn | `#sindustries-p2` | Quinn |
| `redis-down` | redis health | `sindustries_redis_up{app="content-scheduler"} == 0` for 1m | page | `#sindustries-p1` | Quinn |
| `worker-queue-stuck` | queue metrics | `sindustries_queue_ready > 100` for 5m | warn | `#sindustries-p2` | Quinn |
| `deploy-failed` | CI workflow | GitHub Actions workflow failure | warn | `#sindustries-deploy` | Quinn |

Severity is either `page` (immediate, PagerDuty-equivalent urgent) or `warn` (next-business-day). Channels are separate Slack channels so the on-call rotation is unambiguous. Quinn is the canonical owner for every alert in this list; the runbook records how to reassign.

### 7. Bootstrap script

`infra/cloud/observability/bootstrap-observability.sh`:

- Idempotent: re-running does not destroy existing alerts.
- Verifies `fly`, `curl`, and the Grafana Cloud API key are available.
- Creates the health-probe Fly app if missing.
- Sets Fly secrets from Quinn's local `infra/cloud/observability/.env.local` (never committed).
- Uploads the dashboard JSONs via the Grafana provisioning API.
- Creates the alert rules via the Grafana provisioning API.
- Performs a smoke deploy (`fly deploy --strategy canary`).
- Surfaces a final report with the Grafana URL, the dashboard URLs, and the smoke-check result.

The script is the operational answer to AC1 (visibility) and AC4 (handover).

### 8. CI/CD

A single GitHub Actions workflow:

- Triggers on push to `main` only when the relevant paths are touched (`infra/cloud/observability/**`, `packages/otel-node/**`).
- Uses `flyctl/actions` with the `FLY_API_TOKEN` repo secret.
- Runs `fly deploy --strategy canary`.
- Runs a post-deploy smoke check (curl the health-probe's `/healthz`).
- Comments on the relevant PR with the Grafana URL and the smoke-check result.

### 9. Documentation handover

- `docs/systems/observability.md` — durable backend description (AC4).
- `infra/cloud/observability/README.md` — operator-facing index of artefacts.
- `infra/cloud/observability/env/.env.example` — the env-var contract (no live values).
- `docs/runbooks/cloud-alerts-response.md` — alert response runbook: each alert maps to a runbook section with on-call ownership, mitigation steps, and a contact tree.
- Update `docs/systems/tasks.md` (in a separate, much smaller PR) to add a paragraph on where the observability artefacts live. **Out of scope for this PR.**

## Data model and API contract changes

**None.** This task adds OTLP exporters, dashboards, alert rules, and a small health-probe service. No application code, no schema, no API contract changes.

The health-probe service is a new code drop, but it has no schema and no API surface beyond `/healthz`. It is a non-domain service (its purpose is purely operational); it falls under `infra/cloud/observability/` rather than `services/`.

If a missing env var is discovered during the bootstrap (e.g., the OTel SDK references a key that isn't documented), this task adds the missing entry to the service's `.env.example` and surfaces it in the runbook — it does not extend the deploy to add a new runtime feature.

## Workflow, cron, and skill changes

- **Cron:** none in `.openclaw`. The 30-second health-probe cadence is a Fly app's own responsibility, not a cron.
- **Skills:** no agent skill changes.
- **Workflow:** the lobster workflow is unchanged. The fact that hosted observability exists does not change task state semantics.

## Test plan

### Automated tests

- **Unit tests** for `infra/cloud/observability/health-probe/src/probe.ts`:
  - `SELECT 1` failure → emits `sindustries_db_up=0`.
  - `SELECT 1` success → emits `sindustries_db_up=1`.
  - `GET /healthz` failure → emits `sindustries_fly_app_health=0`.
  - `PING` failure → emits `sindustries_redis_up=0`.
- **Shellcheck** on `bootstrap-observability.sh` and the GitHub Actions YAML.
- **`fly config validate`** against the health-probe `fly.toml`.
- **Dockerfile lint** — `hadolint` in CI.
- **Smoke test** — `curl` against the health-probe's `/healthz` endpoint, asserting 200.
- **Provisioning contract test** — a Playwright/puppeteer script or `curl` chain that:
  1. Lists the dashboards in the hosted Grafana via the provisioning API and asserts the four expected dashboards are present.
  2. Lists the alert rules and asserts the ten expected rules are present.
  3. Asserts the alert `severity` field is `page` or `warn` for every rule.

These run as part of the SMOKE job in the GitHub Actions workflow, not as unit tests in the service repos.

### AC verification matrix

| AC | Verification approach | Planned evidence |
| --- | --- | --- |
| AC1 | Health probe emits the four `sindustries_db_*` and `sindustries_fly_app_health` metrics; traces and metrics from cloud-deployed services flow to Grafana Cloud via the `OTEL_EXPORTER_OTLP_ENDPOINT` env var. | Provisioning contract test + smoke check on the hosted Grafana. |
| AC2 | Ten alert rules defined in `infra/cloud/observability/grafana/alerts/`. Each rule has a documented condition, severity, slack channel, and owner. | Provisioning contract test asserts the alerts are present and the severity/channel/owner fields are populated. |
| AC3 | A representative workflow is run against the staging environment (the next workstream, `Cloud staging environment` task `2850c5ac`). The hosted dashboards show the request flow, error rate, and DB health. The trace query is a single Tempo URL. | Workstream `2850c5ac` accepts AC3 on the strength of the dashboards shipped here; this task's contribution is the dashboards existing and being queryable. |
| AC4 | `docs/systems/observability.md` covers the backend, region, account ownership, cost expectations, and handover. `infra/cloud/observability/README.md` indexes the artefacts. `docs/runbooks/cloud-alerts-response.md` documents each alert's response expectation. | The three doc files plus a checklist in the PR description that confirms each AC4 bullet is satisfied. |

### Manual verification

- Quinn runs `bootstrap-observability.sh` once with their live tokens and confirms the smoke check passes.
- Quinn triggers a synthetic failure (e.g., stops the budget-api Fly app) and confirms the alert routes to the right Slack channel within 2 minutes.
- Quinn runs a representative workflow (next workstream) and diagnoses a failure from the hosted dashboards. The trace ID is in the alert message; the dashboard deep-links to the trace.
- Owner-supplied steps are documented in `infra/cloud/observability/README.md` so a future operator can repeat them without re-deriving the procedure.

## Open questions and risks

1. **Backend choice — Grafana Cloud vs self-hosted.** Chosen Grafana Cloud for time and cost (free tier). Self-hosting on Fly.io would preserve vendor independence but adds a Fly app to operate. Flag for review before approval.
2. **Alertmanager vs Grafana Cloud alerting.** Chosen Grafana Cloud alerting for simplicity. Alertmanager is the de-facto standard for Prometheus, but adding it would add another service to operate. Flag for review.
3. **Slack channel ownership.** The list above assumes Quinn owns every channel. If Tom wants to be on-call for content-scheduler alerts, the routing table needs to change. The runbook documents it as a single find-and-replace.
4. **False-positive rate.** The 5xx threshold (5% over 5m) is conservative. If the alerts are noisy in practice, the threshold is adjustable in the JSON alerts file. The provisioning contract test enforces the severity field but not the threshold value.
5. **Health-probe single point of failure.** If the health-probe Fly app is down, the operators see all `sindustries_db_up=0` and every page fires. That is a known and acceptable failure mode for staging; the runbook documents the mitigation (restart the probe) and the longer-term fix (high-availability probe placement).
6. **Grafana Cloud cost growth.** The free tier is enough for the staging environment today. Production traffic will exceed the free tier. The handover document records the upgrade path.
7. **What happens if the observability stack drifts.** Same drift concern as the foundation task; a drift detection cron is a separate workstream.
8. **No backward compatibility required.** The hosted backend is the first time the migration has telemetry. There is no prior state to preserve.
9. **What's the relationship between this task and the `agent-incidents.md` spec.** The existing `docs/systems/agent-incidents.md` describes how the local stack reports agent incidents. This task does not extend that spec. Future work could route agent incidents through the same alerting machinery; out of scope here.

## AC matrix (cross-reference)

| AC | Spec text | Implementation reference |
| --- | --- | --- |
| AC1 | Service availability, request failures, latency, and database health are visible for the cloud environment. | `packages/otel-node` OTLP exporter to Grafana Cloud + health-probe service + cloud-overview dashboard. |
| AC2 | Alerts cover conditions that could make migrated services unavailable, unsafe, or materially degraded. | Ten alert rules in `infra/cloud/observability/grafana/alerts/`, each with severity, channel, owner. |
| AC3 | A failed representative workflow can be diagnosed from hosted signals alone. | cloud-overview + db-health + migration-alerts dashboards; trace IDs linked from alert messages. |
| AC4 | Dashboard and alert ownership, severity, and response expectations are documented. | `docs/systems/observability.md` + `infra/cloud/observability/README.md` + `docs/runbooks/cloud-alerts-response.md`. |
