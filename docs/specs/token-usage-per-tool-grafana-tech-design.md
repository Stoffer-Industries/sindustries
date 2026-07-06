---
status: draft
task_id: 73398199-da40-4ed2-80c4-bf644c65b893
product_spec: brain/tasks/specs/token-usage-per-tool-grafana-2026-07-03.md
shipped_pr: null
shipped_date: null
---

# Token Usage per Tool in Grafana — Tech Design

## Links

- Product spec: `brain/tasks/specs/token-usage-per-tool-grafana-2026-07-03.md`
- Tech design: `docs/specs/token-usage-per-tool-grafana-tech-design.md`
- Task: `73398199-da40-4ed2-80c4-bf644c65b893` (`🔧 Token usage per tool in Grafana`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/73398199-da40-4ed2-80c4-bf644c65b893`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-73398199-token-usage-per-tool-grafana`
- Worktree: `~/workspaces/rowan/sindustries`

## `.openclaw` Boundary Notes

No changes to `~/.openclaw/` are required for this feature. The OTel collector config and Grafana dashboard live in this repo. The openclaw gateway emits OTel spans to the collector as a closed binary — Rowan cannot modify the gateway. If the gateway's spans lack required attributes, Quinn must raise this with the openclaw project separately.

## Product Intent

Surface which agent tools are burning the most tokens, filterable by agent and model. The existing `openclaw_tokens_total` Prometheus counter gives totals per model but has no tool-level dimension. This feature adds a tool-name breakdown via OTel spanmetrics, so operators can answer "is `web_search` or `sessions_spawn` driving our cost?"

## Current Instrumentation State

The OTel collector receives traces from the openclaw gateway via OTLP. The spanmetrics connector already derives Prometheus metrics with these dimensions: `llm.model`, `agent_id`, `selection.listener`, `http.method`, `http.status_code`, `http.response.status_code`.

The existing `openclaw_tokens_total` metric comes from openclaw's Prometheus exporter (not from spanmetrics) and has no `tool.name` label.

**Key open question (see below):** It is not confirmed whether the openclaw gateway currently emits a span per tool-call invocation, or only per LLM completion turn. The design below assumes one span per tool call is emitted (or can be configured to be); if not, a workaround is documented.

## Implementation Plan

### AC1 — Verify span shape

Before writing any code, inspect a live Tempo trace to confirm what the openclaw gateway actually emits:

```bash
# Hit Tempo's search API to find recent spans from the quinn agent
curl -s "http://localhost:3200/api/search?service.name=openclaw-gateway&limit=5" | jq '.traces[0].traceID'
# Then fetch the full trace
curl -s "http://localhost:3200/api/traces/<traceID>" | jq '.resourceSpans[].scopeSpans[].spans[] | {name: .name, attrs: .attributes}'
```

Expected: spans with `tool.name` attribute and either `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` already present, or present only on the parent LLM-call span.

Two scenarios:

**Scenario A — Tool-call spans already exist with token attributes**
Proceed directly to AC2 (add `tool.name` to spanmetrics dimensions).

**Scenario B — Token attributes exist only on the LLM-call (parent) span, not per-tool child spans**
Token attribution per tool requires a different approach. The simplest is to emit a synthetic metric from the session cost-usage data in OpenClaw. This is an `.openclaw` boundary change; Rowan must file an `[openclaw-needed]` comment for Quinn. (See Risk section.)

**Scenario C — No tool-call spans at all**
File an `[openclaw-needed]` comment for Quinn to raise with the openclaw project. This task may be blocked pending a gateway update.

### AC2 — Add `tool.name` to spanmetrics dimensions

**File:** `infra/otel-collector/config.yaml`

Add `tool.name` and the GenAI token attributes to the spanmetrics connector:

```yaml
connectors:
  spanmetrics:
    dimensions:
      - name: llm.model
      - name: agent_id
      - name: tool.name          # NEW
      - name: selection.listener
      - name: http.method
      - name: http.status_code
      - name: http.response.status_code
    exemplars:
      enabled: true
```

The spanmetrics connector emits `traces_span_metrics_calls_total` and `traces_span_metrics_duration_*` counters with all listed label dimensions. These counters alone are sufficient for a "tool calls by agent" panel.

**Token sums (AC3):** The spanmetrics connector does not natively sum arbitrary span attribute values into a separate counter. To get a token-sum metric per tool, one of the following must be used:

**Option T1 — OTel collector `transform` processor + `count` connector approach**

Use the `routing` connector or a `connector/forward` pipeline to derive a dedicated tokens metric. The `spanmetrics` connector can be extended with a `sum_over_duration` if the OTel collector build supports it (check `infra/docker-compose.observability.yml` for the collector image version). If the image is `otel/opentelemetry-collector-contrib`, the `spanmetrics` connector does support `sum_metric` via its `metrics_expiration` and the `sum` histogram option — verify the config schema for the installed version.

**Option T2 — Emit token metrics directly from the gateway (`.openclaw` boundary)**

If span-level token attributes aren't available, emit a dedicated `openclaw_tool_tokens_total` counter from the gateway with labels `{tool_name, agent_id, model, token_type}`. This requires an `[openclaw-needed]` comment for Quinn to apply to the gateway config or plugin.

Rowan should default to Option T1 if the collector image version supports it. Fall back to T2 + `[openclaw-needed]` if not.

### AC3 — Verify spanmetrics output in Prometheus

After collector config change and restart:

```bash
curl -s http://localhost:8889/metrics | grep 'traces_span_metrics.*tool'
```

Expect labels like `tool_name="web_search"` in the output. If labels appear, the dimension is wired correctly.

### AC4 — Grafana dashboard panel

**File:** `infra/grafana/provisioning/dashboards/json/openclaw-diagnostics.json`

Add a new row section "🔧 Token Usage by Tool" with two panels:

**Panel 1 — Tool call rate by tool name (bar chart or time series)**

```promql
sum(rate(traces_span_metrics_calls_total{tool_name!=""}[$__rate_interval])) by (tool_name, agent_id)
```

**Panel 2 — Token cost by tool (if T1 or T2 is available)**

If token sum metrics exist:
```promql
sum(increase(openclaw_tool_tokens_total{token_type="input"}[$__rate_interval])) by (tool_name, agent_id)
```

Or via spanmetrics sum (if supported):
```promql
sum(rate(traces_span_metrics_gen_ai_usage_input_tokens_total[$__rate_interval])) by (tool_name, agent_id)
```

Both panels should have template variables `$agent_id` and `$model` wired to the existing dashboard variable selectors (add these if not already present).

**Dashboard variable additions (if not already present):**

```json
{
  "name": "agent_id",
  "type": "query",
  "query": "label_values(traces_span_metrics_calls_total, agent_id)",
  "multi": true,
  "includeAll": true
}
```

### AC5 — Smoke test

With a live openclaw session running:

1. Trigger a session that calls `web_search` and `sessions_spawn` tools
2. Wait one Prometheus scrape interval (15s)
3. Confirm `traces_span_metrics_calls_total{tool_name="web_search"}` increments in Grafana
4. Screenshot the new panel with visible tool breakdown and attach to the PR

## Data Model / API Contract Changes

None. No Tasks API changes, no database migrations.

## Test Plan

- Unit: No new Rust/TypeScript code in this task — the changes are config files and JSON.
- Smoke test: Described in AC5.
- Regression: The existing spanmetrics pipeline must still produce `traces_span_metrics_calls_total` without `tool.name` label (for spans that don't have the attribute), and `openclaw_tokens_total` must continue to increment as before. Confirm both in the dashboard after the collector restart.

## Open Questions and Risks

1. **Span shape unknown at design time.** The critical unknown is whether openclaw gateway emits per-tool-call spans with token attributes. This must be checked in AC1 before proceeding to AC2. If the gateway does not emit this data, the task may stall at an `.openclaw` boundary.

2. **spanmetrics connector version capability.** Not all builds of the OTel collector contrib image support numeric attribute summation in spanmetrics. Rowan must check `docker inspect sindustries-dev-o11y-otel-collector-1 | grep Image` and review the spanmetrics docs for that image version before committing to Option T1.

3. **High-cardinality risk.** Adding `tool.name` as a spanmetrics dimension multiplies the number of time series by the number of distinct tool names. Current tool inventory is ~20-30 tools. This is acceptable but should be confirmed against Prometheus retention/storage before shipping.

4. **Token attribution semantics.** If tokens are recorded on the LLM-call span (one per model turn) and multiple tools are called in that turn, there is no correct way to attribute tokens to a single tool. The safest framing for the Grafana panel label is "token cost of turns in which this tool was called" rather than "token cost caused by this tool." This should be noted in the panel description.
