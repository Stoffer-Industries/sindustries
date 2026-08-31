# Hosted Observability and Migration Alerts — handover document

**Type:** System reference (handover)
**Status:** Ownership docs shipped (PR implementing 4b3d6e9c AC4); dashboards + alerts + health probe follow in subsequent PRs
**Last updated:** 2026-09-01
**Owner:** Rowan (engineering); Quinn owns the live Grafana Cloud account, Slack workspace, and Fly.io secrets
**Repos:** `Stoffer-Industries/sindustries`
**App:** Staging target on Fly.io (Sydney region); production rollout is tracked under the broader cloud migration plan

> **Naming history:** this workstream was originally scoped as a separate "Hosted Observability and Migration Alerts" spec (task `4b3d6e9c`). The artefacts land under `infra/cloud/observability/` plus three handover docs (`docs/systems/observability.md`, `infra/cloud/observability/README.md`, and `docs/runbooks/cloud-alerts-response.md`). The local observability stack documented in `infra/docker-compose.observability.yml` continues to operate the developer's local machine unchanged.

---

## Context

SIndustries runs a multi-service Node/TypeScript stack against a Postgres + Redis back-end. The existing local observability stack (`infra/docker-compose.observability.yml` + `packages/otel-node` + `infra/grafana/`) ships traces, metrics, and dashboards to the developer's machine. That stack is a useful dev experience, but it does not satisfy the cloud migration acceptance criteria because:

- All four components run on the local machine; cloud services that emit signals from the staging/production region never reach them.
- No alert routing exists beyond the Grafana dashboard; there is no Alertmanager, no Slack/PagerDuty integration.
- No documented ownership: who responds to a 5xx alert, who triages a database health alert, who owns the dashboard definitions.

For the design rationale see [`docs/specs/hosted-observability-migration-alerts-tech-design.md`](../specs/hosted-observability-migration-alerts-tech-design.md). For the operator-facing index of artefacts see [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md). For the alert response runbook see [`docs/runbooks/cloud-alerts-response.md`](../runbooks/cloud-alerts-response.md). For the platform context this hosted stack is built on top of see [`docs/systems/cloud-platform.md`](cloud-platform.md).

This document exists so a new operator (or Quinn returning after a break) can answer the four handover questions — *what is this, who owns what, how much does it cost, and what happens when it breaks* — without having to reverse-engineer `infra/cloud/observability/`.

---

## Decision summary

| Concern                          | Choice                                                   | Owner  | Lives in                                                      |
| -------------------------------- | -------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Hosted backend                  | Grafana Cloud (free tier; upgrade path documented)       | Quinn  | Grafana Cloud org dashboard; credentials in Fly secrets       |
| Region                           | Closest Grafana Cloud region to Fly.io `syd`             | Quinn  | Provisioned at org creation                                  |
| Telemetry pipeline               | OTLP via `packages/otel-node` → Grafana Cloud OTLP       | Rowan  | `packages/otel-node/src/index.ts`; env vars below             |
| Env var contract                 | `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` (and friends) | Quinn | `infra/cloud/observability/env/.env.example` (redacted)       |
| Database signal source           | Health probe service on Fly (single-purpose Node app)    | Rowan  | `infra/cloud/observability/health-probe/` (future PR)         |
| Alert routing                    | Grafana Cloud alerting (not Alertmanager) → Slack        | Quinn  | `infra/cloud/observability/grafana/alerts/` (future PR)       |
| Dashboard ownership              | JSON in `infra/cloud/observability/grafana/dashboards/`  | Rowan  | Provisioned via Grafana provisioning API on bootstrap        |
| Dashboard definitions (local)    | `infra/grafana/provisioning/dashboards/json/` (existing) | Rowan  | Parity copy for hosted: `tasks-api-red.json`, `openclaw-diagnostics.json` |
| Dashboard definitions (cloud, new) | `cloud-overview.json`, `db-health.json`, `migration-alerts.json` | Rowan | `infra/cloud/observability/grafana/dashboards/` (future PR)   |
| Bootstrap                        | Idempotent local script that registers everything        | Quinn  | `infra/cloud/observability/bootstrap-observability.sh` (future PR) |
| CI deploy                        | GitHub Actions, path-filtered, canary                    | Rowan  | `.github/workflows/deploy-observability-health-probe.yml` (future PR) |
| Secrets                          | Fly app secrets + GH repo secrets                        | Quinn  | `fly secrets set …` (operator CLI); `secrets.FLY_API_TOKEN`   |
| Alert response runbook           | One section per alert; on-call, severity, mitigation      | Quinn  | `docs/runbooks/cloud-alerts-response.md`                     |
| Operator-facing artefact index   | README mapping each artefact to its purpose               | Rowan  | `infra/cloud/observability/README.md`                         |
| Backward compatibility           | None required (no prior hosted telemetry)                | —      | —                                                             |

All env-var **names** referenced by deploy workflows are reviewable in the repo. Only the **values** are operator-owned.

---

## Why Grafana Cloud (and what we considered)

**Decision:** Grafana Cloud for the hosted backend. Grafana Cloud alerting for routing (not Alertmanager).

### Grafana Cloud

- **Pros.** Same vendor as the existing local Grafana, single auth plane, single UI, no new agents to ship. Free tier covers staging (10k metrics series, 50GB traces, 14-day retention). Native OTLP endpoint (no agent-side translation). Provisioning API for dashboards + alert rules.
- **Cons.** Vendor lock-in. Free tier is generous but will require an upgrade when production traffic lands. Less control than self-hosted.
- **Alternatives considered.**
  - **Self-hosted Grafana + Prometheus on Fly.io** — preserves vendor independence, no egress cost. Adds a Fly app to operate; doubles the alert-routing surface (Alertmanager + Grafana alerting). Out of scope for a foundation milestone.
  - **Datadog / New Relic** — turnkey SaaS observability. Higher per-host cost; team has no operational history with either.
  - **AWS CloudWatch / GCP Cloud Operations** — natural pairing with the platform vendor. We don't run on AWS or GCP, so cross-cloud egress is wasteful.

Grafana Cloud is the right shape for the foundation milestone: zero new agents, single UI, generous free tier, and an exit path (the JSON dashboards and alert rules are portable to a self-hosted Grafana with minimal conversion).

### Grafana Cloud alerting (not Alertmanager)

- **Pros.** One fewer service to operate. Slack webhook integration is built-in. Alert rules live as JSON in the same provisioning tree as dashboards.
- **Cons.** Tightly coupled to Grafana Cloud; portability to a Prometheus/Alertmanager self-host requires a small migration.
- **Alternatives considered.** **Alertmanager** is the de-facto standard for Prometheus, but adding it would add another Fly app to operate and a parallel routing config. Grafana Cloud's alerting is sufficient for the alert set in [`docs/runbooks/cloud-alerts-response.md`](../runbooks/cloud-alerts-response.md).

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
| Slack workspace                  | Quinn  | Slack workspace admin console                              |
| Slack webhook URL (per channel)  | Quinn  | Fly secrets per app; bootstrapped from `infra/cloud/observability/.env.local` |
| Slack channel ownership          | Quinn  | See alert table in [`docs/runbooks/cloud-alerts-response.md`](../runbooks/cloud-alerts-response.md) |
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
- **Cost alarm.** A `sindustries_cost_alert` Grafana Cloud billing webhook (added in the bootstrap script's follow-on PR) routes a Slack notification to `#sindustries-billing` when monthly active series crosses 80% of the paid-tier allowance.

---

## Dashboard and alert ownership (AC4 summary)

For the full per-alert response expectation see [`docs/runbooks/cloud-alerts-response.md`](../runbooks/cloud-alerts-response.md). For the dashboard inventory see [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md) (Dashboards section). The summary table here is the canonical ownership index.

### Dashboards

| Dashboard                       | Source                                  | Owning team | On-call rotation |
| ------------------------------- | --------------------------------------- | ----------- | ---------------- |
| `cloud-overview`                | NEW (hosted) — per-app latency, error rate, request count, deploy annotations | Rowan (engineering) | Quinn |
| `db-health`                     | NEW (hosted) — `sindustries_db_up`, query duration by app | Rowan (engineering) | Quinn |
| `migration-alerts`              | NEW (hosted) — alert routing overview    | Rowan (engineering) | Quinn |
| `tasks-api-red`                 | Existing local — ported to hosted for parity | Rowan (engineering) | Quinn |
| `openclaw-diagnostics`          | Existing local — ported to hosted for parity | Rowan (engineering) | Quinn |

All dashboard definitions live as JSON in the repo (either `infra/grafana/provisioning/dashboards/json/` for local or `infra/cloud/observability/grafana/dashboards/` for hosted). Changes go through PR review; the bootstrap script provisions them via the Grafana provisioning API.

### Alerts

| Alert                          | Severity | Slack channel        | Owner  |
| ------------------------------ | -------- | -------------------- | ------ |
| `tasks-api-down`               | page     | `#sindustries-p1`    | Quinn  |
| `budget-api-down`              | page     | `#sindustries-p1`    | Quinn  |
| `tasks-api-5xx-spike`          | warn     | `#sindustries-p2`    | Quinn  |
| `budget-api-4xx-spike`         | warn     | `#sindustries-p2`    | Quinn  |
| `tasks-api-db-down`            | page     | `#sindustries-p1`    | Quinn  |
| `budget-api-db-down`           | page     | `#sindustries-p1`    | Quinn  |
| `db-query-slow`                | warn     | `#sindustries-p2`    | Quinn  |
| `redis-down`                   | page     | `#sindustries-p1`    | Quinn  |
| `worker-queue-stuck`           | warn     | `#sindustries-p2`    | Quinn  |
| `deploy-failed`                | warn     | `#sindustries-deploy`| Quinn  |

Severity is either `page` (immediate, P1 urgent) or `warn` (next-business-day, P2 informational). Quinn is the canonical owner for every alert in the v1 list; the runbook documents how to reassign individual alerts to Tom or another on-call.

---

## Handover checklist (for a new operator)

A future operator should be able to:

1. Run `bash infra/cloud/observability/bootstrap-observability.sh` (once credentials are in place) and get a green smoke-check report back.
2. Open the four hosted dashboards from the URLs the bootstrap script prints, and see real data for the staging environment.
3. Open the ten alert rules from the Grafana Cloud alerting UI, and see severity + Slack channel + owner populated for each.
4. Trigger a synthetic failure (e.g., stop a Fly app) and observe the corresponding alert fires within 2 minutes and routes to the documented Slack channel.
5. Read [`docs/runbooks/cloud-alerts-response.md`](../runbooks/cloud-alerts-response.md) for the on-call response expectation of each alert.

If any of those five steps fails, the gap is filed as a follow-on feature task under the `4b3d6e9c` parent or as a new `infra` task depending on scope.

---

## Out of scope (explicit non-goals)

- Replacing the existing local observability stack (operators continue to use it on their dev machines).
- Building product analytics (Mixpanel/Amplitude-style events). Out of scope per the spec's non-goals.
- Alertmanager self-hosting. Grafana Cloud's alerting is sufficient.
- Drift detection for the observability stack. Follow-on workstream.
- A `*.sindustries.dev` Grafana subdomain. Future UX improvement.

---

## Related docs

- [`docs/specs/hosted-observability-migration-alerts-tech-design.md`](../specs/hosted-observability-migration-alerts-tech-design.md) — tech design for this workstream.
- [`docs/systems/cloud-platform.md`](cloud-platform.md) — the cloud platform this hosted stack is built on.
- [`docs/systems/agent-incidents.md`](agent-incidents.md) — the local agent-incident reporting flow; future work may route agent incidents through the same alerting machinery.
- [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md) — operator-facing index of the artefacts.
- [`docs/runbooks/cloud-alerts-response.md`](../runbooks/cloud-alerts-response.md) — per-alert response runbook.
- [`infra/cloud/README.md`](../../infra/cloud/README.md) — parent index of `infra/cloud/` artefacts.
