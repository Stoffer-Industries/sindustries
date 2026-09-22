# Hosted Observability — Operator Index

This directory holds the artefacts that wire SIndustries' cloud-deployed services to a hosted observability backend (Grafana Cloud). The artefacts here are the runtime answer to task `4b3d6e9c` (Hosted Observability and Migration Alerts).

For the durable ownership handover see [`docs/systems/observability.md`](../../docs/systems/observability.md). For the per-alert response expectation see the "Alert ownership" table in `docs/systems/observability.md` (the prior `docs/runbooks/cloud-alerts-response.md` was retired in PR #583). For the platform context this stack is built on top of see [`docs/systems/cloud-platform.md`](../../docs/systems/cloud-platform.md).

---

## Directory layout

```
infra/cloud/observability/
  README.md                          # this file — operator index
  bootstrap-observability.sh         # idempotent local script with subcommand dispatch (validate | app | secrets | dashboards | alerts | deploy | smoke | evidence | all)
  evidence-capture.sh                # prints the closing-PR evidence pack template (md | sh | json)
  failure-inject.sh                  # 10 failure-injection scenarios with --dry-run (redis-down/up, tasks-api-down/up, budget-api-down/up, db-down/up, deploy-failed/restored)
  env/
    .env.example                     # redacted env-var contract
  grafana/
    datasources.yaml                 # mirrors local provisioning (Prometheus + Tempo + Postgres)
    dashboards/
      cloud-overview.json            # NEW — per-app latency, error rate, request count, deploy annotations
      db-health.json                 # NEW — sindustries_db_up, query duration by app
      migration-alerts.json          # NEW — alert routing overview
      tasks-api-red.json             # parity copy from local
      openclaw-diagnostics.json      # parity copy from local
    alerts/
      tasks-api-down.json            # ten alert rules (5 page-severity, 5 warn-severity)
      ...
  health-probe/
    package.json                     # single-purpose Node service (workspace @sindustries/health-probe)
    src/probe.ts                     # emits DB / app / Redis metrics
    src/server.ts                    # /healthz HTTP server for Fly
    Dockerfile
    fly.toml
    tests/                           # 17 unit tests
```

All runtime artefacts ship in this branch. Quinn's first-time setup below is the only thing standing between these artefacts and live data on staging.

---

## What each artefact does

### `env/.env.example`

The env-var contract for everything in this directory. Live values are operator-owned; this file lists **names** with redacted **placeholders** only.

### `grafana/dashboards/*.json`

Hosted Grafana dashboard JSON, uploaded via the Grafana provisioning API by the bootstrap script. Three new dashboards (`cloud-overview`, `db-health`, `migration-alerts`) plus two parity copies of existing local dashboards.

### `grafana/alerts/*.json`

Ten alert rules covering availability, latency, DB health, Redis health, queue depth, and deploy failures. Each rule is JSON, uploaded by the bootstrap script, and exposes a documented severity and owner in Grafana Cloud. No outbound notification integration is required.

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

After Tom hands over the Grafana Cloud + Fly + Neon credentials, the operator (Quinn) does:

1. Populate `infra/cloud/observability/.env.local` with the live values (this file is gitignored; the template lives at `infra/cloud/observability/env/.env.example`).
2. Sanity-check the env var set without performing any I/O:
   ```bash
   bash infra/cloud/observability/bootstrap-observability.sh validate
   ```
   The script exits with the missing-var count (capped at 125) so Quinn can re-run as each secret is handed over without Fly or Grafana auth.
3. Run the full idempotent provisioning flow:
   ```bash
   bash infra/cloud/observability/bootstrap-observability.sh all
   ```
   This creates the health-probe Fly app (if missing), sets Fly secrets, uploads dashboard JSONs and alert rules via the Grafana provisioning API, performs a canary deploy, and surfaces a final report with the Grafana URL, dashboard URLs, and smoke-check result. The whole script is idempotent — re-runs are safe.
4. Verify the smoke check passes and the five hosted dashboards show data within 5 minutes.
5. Capture the AC1-AC3 evidence pack for task 31233a0a AC4:
   ```bash
   bash infra/cloud/observability/evidence-capture.sh --format md > evidence.md
   # paste evidence.md into PR #724 body
   ```
6. Exercise the failure-injection surface to verify alerts fire and resolve:
   ```bash
   bash infra/cloud/observability/failure-inject.sh tasks-api-down     # induce
   bash infra/cloud/observability/failure-inject.sh tasks-api-up       # recover
   ```
   Both commands print the expected alert uid + for-window so Quinn can correlate with the matching Grafana state. `--dry-run` prints the plan without contacting Fly.

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
- **Cost alarm.** `sindustries_cost_alert` appears in Grafana Cloud when monthly active series crosses 80% of the paid-tier allowance. Configured in the bootstrap script.

---

## What is NOT in this directory

- **Alertmanager** — Grafana Cloud's built-in alerting is sufficient. Adding Alertmanager would add another Fly app to operate.
- **Drift detection cron** — the existing drift detection workstream (separate task) covers the observability stack as one of its targets.
- **Product analytics** — out of scope per the spec's non-goals.
- **A `*.sindustries.dev` Grafana subdomain** — owned by Grafana Cloud; future UX improvement, not a foundation requirement.

---

## Related docs

- [`docs/systems/observability.md`](../../docs/systems/observability.md) — durable ownership handover (AC4).
- `~/.openclaw/workspace/docs/infra/runbooks/cloud-alerts-response.md` — per-alert response runbook (was at `docs/runbooks/cloud-alerts-response.md`; retired in PR #583 — re-create in workspace the first time an alert fires).
- [`docs/specs/hosted-observability-migration-alerts-tech-design.md`](../../docs/specs/hosted-observability-migration-alerts-tech-design.md) — tech design.
- [`infra/cloud/README.md`](../README.md) — parent index of `infra/cloud/` artefacts.
- [`docs/systems/cloud-platform.md`](../../docs/systems/cloud-platform.md) — platform context.

## Contract tests

The CI pipeline runs two offline contract tests against this directory so drift is caught before merge:

- `bash infra/cloud/scripts/tests/observability-provisioning.test.sh` — asserts 5 dashboards, 10 alert rules, 3 datasources, the bootstrap script, and the health-probe package are present and well-formed.
- `bash infra/cloud/scripts/tests/observability-bootstrap.test.sh` — asserts `bootstrap-observability.sh`, `evidence-capture.sh`, and `failure-inject.sh` pass `bash -n`, that every subcommand and failure-injection scenario is documented and produces output under `--dry-run`, and that `validate` exits with the missing-var count.

Both are wired into the `health-probe-tests` CI job. Run them locally before any PR that touches this directory.
