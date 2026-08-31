# Hosted Observability — Operator Index

This directory holds the artefacts that wire SIndustries' cloud-deployed services to a hosted observability backend (Grafana Cloud). The artefacts here are the runtime answer to task `4b3d6e9c` (Hosted Observability and Migration Alerts).

For the durable ownership handover see [`docs/systems/observability.md`](../../docs/systems/observability.md). For the per-alert response runbook see [`docs/runbooks/cloud-alerts-response.md`](../../docs/runbooks/cloud-alerts-response.md). For the platform context this stack is built on top of see [`docs/systems/cloud-platform.md`](../../docs/systems/cloud-platform.md).

---

## Directory layout

```
infra/cloud/observability/
  README.md                          # this file — operator index
  bootstrap-observability.sh         # idempotent local script (future PR)
  env/
    .env.example                     # redacted env-var contract
  grafana/
    datasources.yaml                 # mirrors local provisioning (future PR)
    dashboards/
      cloud-overview.json            # NEW (future PR)
      db-health.json                 # NEW (future PR)
      migration-alerts.json          # NEW (future PR)
      tasks-api-red.json             # parity copy from local (future PR)
      openclaw-diagnostics.json      # parity copy from local (future PR)
    alerts/
      tasks-api-down.json            # ten alert rules (future PR)
      ...
  health-probe/
    package.json                     # single-purpose Node service (future PR)
    src/probe.ts                     # emits DB / app / Redis metrics
    Dockerfile
    fly.toml
```

The current PR ships only the docs (this README + `env/.env.example`) and the handover docs. The runtime artefacts (dashboards JSON, alert rules JSON, health-probe service, bootstrap script) ship in subsequent PRs.

---

## What each artefact does

### `env/.env.example`

The env-var contract for everything in this directory. Live values are operator-owned; this file lists **names** with redacted **placeholders** only.

### `grafana/dashboards/*.json`

Hosted Grafana dashboard JSON, uploaded via the Grafana provisioning API by the bootstrap script. Three new dashboards (`cloud-overview`, `db-health`, `migration-alerts`) plus two parity copies of existing local dashboards.

### `grafana/alerts/*.json`

Ten alert rules covering availability, latency, DB health, Redis health, queue depth, and deploy failures. Each rule is JSON, uploaded by the bootstrap script, and routes to a documented Slack channel with a documented severity and owner.

### `grafana/datasources.yaml`

Mirrors `infra/grafana/provisioning/datasources/datasources.yaml` so the hosted Grafana has the same datasource shape as the local one (Postgres for DB health, Prometheus for app metrics, Tempo for traces).

### `health-probe/`

A small, single-purpose Node service that periodically emits:

- `sindustries_db_up{app="<name>"}` — 1 if a `SELECT 1` query returns, 0 otherwise. One series per app database.
- `sindustries_db_query_duration_seconds` — histogram of the `SELECT 1` round-trip, labelled by app.
- `sindustries_fly_app_health{app="<name>"}` — 1 if `GET /healthz` returns 200, 0 otherwise. Per deployed app.
- `sindustries_redis_up{app="content-scheduler"}` — 1 if Redis `PING` returns OK.

The probe is its own Fly app (`infra/cloud/observability/health-probe/`) that runs every 30 seconds. It is its own service, not a sidecar of the existing apps. The probe exposes its own `/healthz` and is allowed to be unavailable (it is the canary, not the path).

### `bootstrap-observability.sh`

Idempotent local script. Verifies `fly`, `curl`, and the Grafana Cloud API key are available. Creates the health-probe Fly app if missing. Sets Fly secrets from Quinn's local `infra/cloud/observability/.env.local` (never committed). Uploads dashboard JSONs and alert rules via the Grafana provisioning API. Performs a smoke deploy. Surfaces a final report with the Grafana URL, the dashboard URLs, and the smoke-check result.

---

## First-time setup

After this PR lands, the operator (Quinn) does:

1. Create the Grafana Cloud org in the closest region to Fly.io `syd`. Save the OTLP endpoint + API key.
2. Create three Slack Incoming Webhooks (`#sindustries-p1`, `#sindustries-p2`, `#sindustries-deploy`, `#sindustries-billing`).
3. Populate `infra/cloud/observability/.env.local` with the live values (this file is gitignored).
4. Run `bash infra/cloud/observability/bootstrap-observability.sh` once the runtime artefacts land in a follow-on PR.
5. Verify the smoke check passes and the four hosted dashboards show data within 5 minutes.

---

## Local dev experience

The local observability stack (`infra/docker-compose.observability.yml` + `packages/otel-node` + `infra/grafana/`) continues to operate the developer's machine unchanged. When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the OTel SDK in `packages/otel-node/src/index.ts` falls back to the local OTel Collector (the default OTLP endpoint `http://localhost:4318`).

To send local dev traffic to Grafana Cloud instead (useful for debugging hosted dashboards from a dev machine):

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.cloud
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(instance_id:api_key)>"
pnpm --filter <service> dev
```

Do NOT commit the live `OTEL_EXPORTER_OTLP_HEADERS` value. The redacted `.env.example` is the only file in the repo that references these variable names.

---

## Billing

- **Free tier today (staging).** 10k metrics series, 50GB traces, 14-day retention. Sufficient for the current staging footprint.
- **Expected staging growth.** ~500–1000 active series; well under the free tier for the next 12 months.
- **Production rollout.** Expected 5–10× growth. Free tier will be exceeded. Upgrade path is to the Grafana Cloud Pro tier (~$8/1k active series + $5/50GB traces).
- **Cost alarm.** `sindustries_cost_alert` routes a Slack notification to `#sindustries-billing` when monthly active series crosses 80% of the paid-tier allowance. Configured in the bootstrap script.

---

## What is NOT in this directory

- **Alertmanager** — Grafana Cloud's built-in alerting is sufficient. Adding Alertmanager would add another Fly app to operate.
- **Drift detection cron** — the existing drift detection workstream (separate task) covers the observability stack as one of its targets.
- **Product analytics** — out of scope per the spec's non-goals.
- **A `*.sindustries.dev` Grafana subdomain** — owned by Grafana Cloud; future UX improvement, not a foundation requirement.

---

## Related docs

- [`docs/systems/observability.md`](../../docs/systems/observability.md) — durable ownership handover (AC4).
- [`docs/runbooks/cloud-alerts-response.md`](../../docs/runbooks/cloud-alerts-response.md) — per-alert response runbook.
- [`docs/specs/hosted-observability-migration-alerts-tech-design.md`](../../docs/specs/hosted-observability-migration-alerts-tech-design.md) — tech design.
- [`infra/cloud/README.md`](../README.md) — parent index of `infra/cloud/` artefacts.
- [`docs/systems/cloud-platform.md`](../../docs/systems/cloud-platform.md) — platform context.
