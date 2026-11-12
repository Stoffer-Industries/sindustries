---
status: draft
task_id: a7938522-778e-40c9-bd17-423f00ff1470
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Grafana Cloud local OTel cutover — tech design

## Product intent

Local applications and the OpenClaw gateway already emit OTLP to the mode-specific collector on the Mac mini. That collector still exports traces to local Tempo and exposes Prometheus scrape metrics to the local Prometheus/Grafana stack. The intended end state is one local collector receiver per active mode forwarding traces, application metrics, and span-derived metrics to the existing Grafana Cloud tenant, followed by removal of the local Grafana, Prometheus, and Tempo services only after live cloud ingestion is proven.

Verified discovery from the handoff is part of the design input:

- Grafana Cloud OTLP gateway: `otlp-gateway-prod-au-southeast-1.grafana.net`.
- The tenant accepts traces at `/otlp/v1/traces`; the same payload at `/v1/traces` returns 404.
- Real credentials return 200 with `partialSuccess`; invalid credentials return 401 on the same route.
- `GRAFANA_CLOUD_OTLP_HEADERS` is an OTLP exporter header string (`Authorization=Basic <base64>`), not a bare Authorization value. Passing it through unchanged would emit `Authorization: Authorization=Basic ...` and return 401.

## Delivery metadata

- **Task:** `a7938522-778e-40c9-bd17-423f00ff1470` — Migrate local OTel export to Grafana Cloud, decommission local Grafana stack
- **Branch:** `task-a7938522-grafana-cloud-otel`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/task-a7938522-grafana-cloud-otel`
- **Repository:** `Stoffer-Industries/sindustries`
- **Product spec:** n/a; the task description is the approved product scope.

## Ownership boundary check

This is a **workflow/OpenClaw boundary** backed by repository-owned infrastructure configuration:

- `infra/otel-collector/config.yaml` owns collector pipelines and the Grafana Cloud exporter contract.
- `scripts/dev/` owns the host-side secret-loading and startup workflow. The existing `infra/cloud/observability/.env.local` remains the only credential source of truth.
- `infra/docker-compose.observability.yml` owns which local observability containers exist.
- `docs/systems/observability.md` owns the durable architecture and operator contract.
- `~/.openclaw/openclaw.json` remains outside the repository and is not changed. Its diagnostics endpoint already targets the local collector; post-cutover validation happens at this boundary.

The durable design keeps the collector as the single local receiver rather than configuring every app and OpenClaw independently with hosted credentials. That preserves mode-specific localhost ports, keeps secrets out of app processes, and provides one forwarding point for spanmetrics. No interim second credential file is introduced.

## Design decisions

### 1. One OTLP/HTTP exporter for traces and metrics

Replace the local `otlp/tempo` and `prometheus` exporters with one `otlphttp/grafana_cloud` exporter. Its endpoint is the existing `GRAFANA_CLOUD_OTLP_ENDPOINT`; the configured value must preserve Grafana Cloud's required `/otlp` prefix semantics. The traces, direct metrics, and `metrics/spanmetrics` pipelines all export through it. The `spanmetrics` connector and its `agent_id`, `llm.model`, tool, HTTP, and selection dimensions remain unchanged.

### 2. Parse the exporter header string before collector config consumes it

Add a small repository-owned shell helper under `scripts/dev/` that reads `infra/cloud/observability/.env.local`, parses `GRAFANA_CLOUD_OTLP_HEADERS` using the already-shipped GymTrack rules, and exports a collector-only `GRAFANA_CLOUD_OTLP_AUTHORIZATION` value. Parsing splits each comma-separated segment on the first `=`, preserves base64 padding, URL-decodes values, and accepts a bare Authorization value. Tests reuse the same input/output cases as `apps/gymtrack/api/telemetry.js::parseOtlpHeaderString()` so the two consumers cannot silently diverge.

`config.yaml` then uses a real map entry:

```yaml
headers:
  Authorization: ${env:GRAFANA_CLOUD_OTLP_AUTHORIZATION}
```

The raw `Authorization=...` string is never interpolated as the header value. The helper exports values only into the `tilt up` / Docker Compose process environment; it does not write a second secret file or print the credential.

### 3. Fail startup closed when cloud forwarding configuration is unusable

`scripts/dev/up.sh` sources the helper before starting Tilt whenever observability is enabled. Missing endpoint, missing header, a parsed header set without Authorization, or an endpoint shape that would produce the known 404 fails startup with an actionable secret-free message. `OBSERVABILITY=0` remains an explicit escape hatch for local work that does not need telemetry.

The collector service receives only the endpoint and parsed Authorization value. Direct `tilt up` is documented as requiring the same helper/export contract; the supported `make up` / `scripts/dev/up.sh` path performs it automatically.

### 4. Live evidence gates decommissioning

The delivery is intentionally ordered:

1. Reconfigure the collector while local Tempo/Prometheus/Grafana services remain running.
2. Restart one mode's collector and induce a uniquely named test trace plus counter/histogram sample.
3. Query the real tenant for the trace and metric series. Record exact hosted metric names and labels in the PR; do not infer them from the former local Prometheus scrape names.
4. Trigger an OpenClaw model call and query for a resulting diagnostic span/metric with `agent_id`.
5. Only after steps 2–4 pass, remove local Tempo, Prometheus, and Grafana services and stop/remove both modes' stale containers.

If cloud verification fails, the local stack remains available while the exporter/configuration is corrected.

### 5. Remove dead local-stack configuration after the cutover

After the live gate passes, `infra/docker-compose.observability.yml` retains only the collector. Local-only Tempo, Prometheus, Grafana provisioning, and datasource configuration is removed when repository search confirms no remaining consumer. Hosted dashboard definitions under `infra/cloud/observability/grafana/` remain canonical. `scripts/dev/up.sh`, `scripts/dev/down.sh`, Tilt resources, port-cleanup behavior, and operator output are updated to describe and manage the collector-only bridge.

## Implementation plan

1. **Credential adapter and validation**
   - Add a tested `scripts/dev/` helper that loads the existing cloud env file and emits only process environment variables.
   - Cover named, bare, comma-separated, URL-encoded, malformed, missing, and base64-padded header strings.
   - Validate endpoint normalization without logging secret values.
2. **Collector pipeline**
   - Update `infra/otel-collector/config.yaml` to use `otlphttp/grafana_cloud` for all trace and metric pipelines.
   - Keep the `spanmetrics` connector and dimensions unchanged.
   - Add configuration contract tests that reject a raw `GRAFANA_CLOUD_OTLP_HEADERS` header value and assert `/otlp` endpoint handling.
3. **Pre-decommission live gate**
   - Restart the collector with local storage backends still present.
   - Send a uniquely identifiable OTLP trace and metric through the local receiver.
   - Query Grafana Cloud for rows/series and record the actual metric names and labels.
   - Trigger and query an OpenClaw diagnostic signal with `agent_id`.
4. **Local stack removal**
   - Remove Tempo, Prometheus, and Grafana services/resources and collector dependencies from Compose/Tilt.
   - Remove now-unreferenced local-only config directories after an `rg` consumer check.
   - Stop/remove the dev and prodlike local observability containers only after the live gate passes.
5. **Durable documentation**
   - Update `docs/systems/observability.md`, `infra/cloud/observability/README.md`, and local dev output/runbook text so Grafana Cloud is the stated destination and the collector-only bridge is the local runtime.
   - Record the verified hosted metric name mapping and any dashboard query changes.
   - Mark this design `shipped` with the final PR number/date.

## Data model and API contract changes

- No application API or database schema changes.
- Collector environment contract adds `GRAFANA_CLOUD_OTLP_AUTHORIZATION`, derived in-memory from the existing `GRAFANA_CLOUD_OTLP_HEADERS` source.
- The externally visible metrics contract may change because Grafana Cloud's OTLP translation can normalize names and labels differently from the removed Prometheus scrape exporter. The live query result, not the old dashboard expressions, determines the final hosted dashboard contract.

## Workflow, cron, and skill changes

- No cron or skill changes.
- Local startup gains a required cloud-export preflight when observability is enabled.
- Host-local container removal and OpenClaw diagnostic verification are operational steps outside the committed repository diff; evidence is recorded in the implementation PR.
- `~/.openclaw/openclaw.json` is read-only verification input and is not modified.

## Acceptance-criterion verification matrix

| AC | Verification | Layer | Evidence |
|---|---|---|---|
| AC1 | Parse the existing header string into a map value; validate the collector config; assert traces, direct metrics, and spanmetrics all use the cloud exporter; assert `agent_id` and `llm.model` dimensions remain | File contract + unit/integration | Test output and collector config diff |
| AC2 | Send a uniquely named trace and metric through the local collector, then query the real Grafana Cloud tenant for both before removing local services | Manual live integration | Secret-free query output/screenshot in PR, including actual hosted metric names |
| AC3 | After AC2, remove three services from Compose/Tilt, stop/remove both modes' stale containers, and prove only collector containers remain | File contract + host runtime | `docker compose ps` / container-name evidence in PR |
| AC4 | Trigger an OpenClaw model call through the unchanged local diagnostics endpoint and query the tenant for a resulting span/metric with `agent_id` | Manual end-to-end | Secret-free Grafana query output/screenshot in PR |

There is no user-visible app flow, so browser E2E coverage is not applicable. The critical fallback is a real hosted-tenant integration, because file/unit tests cannot prove tenant path, authentication, translation, or label indexing behavior.

## Open questions and risks

1. **Hosted metric translation:** exact series names and label normalization are deliberately unresolved until AC2 queries the real tenant. Dashboard expressions must be updated if the tenant's names differ from `traces_span_metrics_*` or `http_server_duration_milliseconds_*`.
2. **Two active mode collectors:** dev and prodlike currently bind different host ports and can forward concurrently. Test signals need unique service/resource attributes so tenant evidence identifies which path was exercised.
3. **Credential exposure:** environment inspection can reveal the parsed Authorization value to a privileged local operator. This is no broader than the current `.env.local` access boundary; the helper must never echo it or persist it elsewhere.
4. **Rollback:** until AC2/AC4 pass, the local services stay running. After decommission, rollback is the reviewed Git revert plus Compose restart; no telemetry data is migrated from local Tempo/Prometheus because the requirement is forward cutover, not historical backfill.
5. **Collector config compatibility:** the pinned collector version must validate `otlphttp` endpoint and header environment substitution before live restart. A config-validation container run is required before touching the running collectors.
