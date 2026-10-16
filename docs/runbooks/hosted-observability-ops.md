# Runbook — Hosted observability follow-up ops (post PR #724)

This runbook captures the cloud/ops follow-up work owned by Quinn on
task `2c782afb` after the Grafana Cloud hosted observability stack
landed on PR #724. It is the operator companion to the system
reference `docs/systems/observability.md` and the source brainstorm
`brain/ideas/hosted-observability-followups.md`. AC1–AC3 (dashboard
metric-name and ratio fixes, queue-depth metric, deploy-failure alert
disable) are Rowan-owned and tracked on PR #797. This document closes
**AC4** and **AC5** of the task spec.

---

## AC4 — Read-scoped Grafana credential + alert fire→resolve verification

### Read-scoped Grafana credential

The current Grafana Cloud credential stored under
`~/.openclaw/.env` is the OTLP ingest token only — narrow scope, used
by the health-probe and the workers to push metrics. It cannot query
Grafana, so alert fire→resolve state has never been independently
verified from Grafana's side; we have only inferred it from the
health-probe's local metrics.

A second, **read-scoped** operator credential is required to close
that gap. The credential has a deliberately different shape from the
ingest token so it cannot accidentally be substituted:

- **Type:** Grafana Cloud API key with the `Viewer` role and the
  `metrics:read`, `logs:read`, and `alerts:read` scopes only.
- **Where it lives:** `~/.openclaw/.env` as
  `GRAFANA_CLOUD_READER_API_KEY`. The ingest token keeps the existing
  name (`GRAFANA_CLOUD_OTLP_TOKEN`) and is unchanged.
- **Why two tokens:** rotating, revoking, or scoping down the
  read-scoped token does not affect ingest; the health-probe and
  workers keep emitting even if the operator token is rolled.
- **Authorisation:** Tom provisions the API key in the Grafana Cloud
  UI under **Security → API Keys** with a 90-day expiry. The token
  value is dropped into `~/.openclaw/.env` once and never printed
  outside the secrets file.
- **Rotation cadence:** every 90 days, on the same calendar as the
  ingest token so both roll together. A `[grafana-token-rotation]`
  reminder lives in `brain/ops/runbooks.md` (cross-link to be added
  when the rotation reminder is formalised).

### Fire→resolve verification path

The full fire→resolve loop has to be exercised end-to-end before we
trust any alert to page. The verification runs once after the
read-scoped token lands, and is re-run after any alert-rule edit.

**Pre-conditions**

- `GRAFANA_CLOUD_READER_API_KEY` is exported.
- The Grafana Cloud stack URL and org slug are exported
  (`GRAFANA_CLOUD_URL`, `GRAFANA_CLOUD_ORG_SLUG`).
- The alert under test is in the "firing" state path but no incident
  is open.

**Procedure (per alert)**

1. Pick the alert rule (e.g. `tasks-api-5xx-error-rate`). Note the
   rule UID from the alert JSON.
2. From a host with the read token, query the alert state:

   ```bash
   curl -fsS -H "Authorization: Bearer $GRAFANA_CLOUD_READER_API_KEY" \
     "$GRAFANA_CLOUD_URL/api/v1/provisioning/alert-rules" \
     | jq '.[] | select(.uid == "<UID>")'
   ```

3. Induce the failure condition in staging (e.g. point the tasks-api
   Fly app at an unreachable dependency, or use the existing chaos
   toggle if one is wired in). Wait one evaluation interval
   (default 60s) plus scrape interval (15s).
4. Re-query the alert state and Grafana Alertmanager:

   ```bash
   curl -fsS -H "Authorization: Bearer $GRAFANA_CLOUD_READER_API_KEY" \
     "$GRAFANA_CLOUD_URL/api/v1/alertmanager/grafana/api/v2/alerts" \
     | jq '.[] | select(.labels.alertname == "<NAME>") | {state, activeAt}'
   ```

   Expect `state: "active"` and a recent `activeAt`.
5. Resolve the failure condition. Wait one evaluation interval.
6. Re-query; expect the alert to leave `active` within two
   evaluation intervals. Capture the alert's lifecycle timestamps
   in `docs/systems/observability.md` under a "Last verified" row.
7. If the alert does not leave `active` within two intervals, file a
   follow-up against PR #797's AC1 (the ratio/error-rate expression
   change is the most likely cause of stuck alerts).

**Cadence.** Verification is run on first setup, after every alert
edit, and at the start of every month. The monthly run is logged in
`docs/systems/observability.md` under "Verification log."

---

## AC5 — Operational hardening (probe watchdog, secret hygiene, cardinality, bootstrap, alert routing)

### 1. Probe watchdog (separate runtime)

The health-probe is a single point of failure for the whole
observability story. A separate watchdog cron on a different runtime
closes most of the risk cheaply:

- **Where:** A `launchd` plist on the Mac mini (or any other
  always-on host that is not the same machine that runs the
  health-probe service). Path:
  `~/Library/LaunchAgents/openclaw.hosted-observability-watchdog.plist`.
- **What it does:** `curl -fsS --max-time 5 $HEALTH_PROBE_URL/healthz`
  every 60s. On three consecutive failures it pages via the same
  channel used by the rest of the OpenClaw alert stack
  (`sessions_send` to a designated Telegram chat, mirroring Lox's
  incident-page pattern).
- **Why a separate runtime:** if the host that runs the health-probe
  dies, the watchdog still pages; if the health-probe is just stuck
  emitting nothing, the watchdog still catches it via the
  `/healthz` endpoint.
- **Implementation note:** This is the cheapest first piece of AC5
  to ship; the existing launchd infra in
  `infra/launchd/` already has the boilerplate, and Lox's incident
  page pattern is documented under
  `codebases/sindustries/agents/lox/`.

### 2. Secret rotation and scoping

Every secret in the hosted observability stack is purpose-scoped, not
shared, and lives in the OpenClaw secrets store (not just
`~/.openclaw/.env`):

| Secret | Scope | Store | Rotation |
| --- | --- | --- | --- |
| `GRAFANA_CLOUD_OTLP_TOKEN` | OTLP ingest only | `~/.openclaw/.env` | 90 days, with `GRAFANA_CLOUD_READER_API_KEY` |
| `GRAFANA_CLOUD_READER_API_KEY` | Viewer + read-only metrics/logs/alerts | `~/.openclaw/.env` | 90 days, paired with OTLP |
| `NEON_DB_DSN` (per service) | Single-database, app role | `~/.openclaw/.env` | 90 days, or on staff change |
| `UPSTASH_REDIS_URL` | Single Redis DB, restricted commands | `~/.openclaw/.env` | 180 days |
| Fly app secrets | App-scoped | `fly secrets set` per app | 180 days, or on deploy key change |
| `OPENCLAW_HOOKS_TOKEN` | Webhook auth | `~/.openclaw/.env` | 180 days |

A shared full-access Grafana token is **explicitly disallowed**; the
ingest and read credentials are two distinct API keys so a leak of
the read token does not allow metric injection and a leak of the
ingest token does not allow read access.

The `~/.openclaw/.env` file is a deliberate single-host store for
the current deployment; once the cloud-readiness audit's
multi-host / multi-region work lands, secrets move to the
OpenClaw secrets store per the audit contract (tracked under the
W42 cloud-readiness follow-up).

### 3. Cardinality and retention budget

Grafana Cloud free-tier ceilings:

- ~10,000 active Prometheus series.
- 50 GB logs / month (likely the first thing hit, not metrics).
- 14-day metric retention.
- 100 alert rule cap (per org).

Mitigations before hitting a hard wall:

- **Series cardinality alert at 80%:** a `series-cardinality-budget`
  alert pages at 8,000 active series. It runs against Grafana's
  `grafana_cloud_active_series` metric (or the equivalent
  self-reported counter) and is owned by Quinn.
- **Per-service label budget:** the HTTP route label
  (`http_route`) is the highest-cardinality label we currently emit.
  New high-cardinality labels require a series-budget note in
  `docs/systems/observability.md` before they ship.
- **Retention decision point:** the 14-day metric retention is
  acceptable for now; longer retention is a paid-tier decision
  (tracked under the W42 cloud-readiness follow-up).
- **Alert rule cap:** at ~30 rules today, well under the 100 cap;
  re-evaluate at 80.

### 4. Bootstrap script idempotency

`infra/cloud/observability/bootstrap.sh` (and the per-service
provisioning scripts it calls) must be re-runnable without
duplicating state:

- **Use PUT/replace semantics for provisioning endpoints.** Grafana
  Cloud's `/api/v1/provisioning/{dashboards,alert-rules}` endpoints
  accept `PUT` with the full desired state; the script must PUT, not
  POST.
- **Validate the target org/instance before any write.** The
  bootstrap script refuses to run if
  `GRAFANA_CLOUD_ORG_SLUG` does not match the expected
  `sindustries` org. This catches the "wrong-account" foot-gun.
- **Fail closed on partial failure.** If the dashboard PUT succeeds
  but the alert-rule PUT fails, the script exits non-zero without
  rolling back the dashboard (Grafana provisioning is
  eventually-consistent, so an automatic rollback is more dangerous
  than a partial state + a clear error). The error message tells
  the operator which step failed and how to retry.
- **Re-runnability is verified** by a smoke test that runs the
  bootstrap script twice in a row against a clean stack and
  asserts the rule/dashboard count is unchanged on the second run.
  The smoke test is invoked from the same launchd entry that runs
  the watchdog's monthly verification.

### 5. Alert routing, runbooks, and drift detection

Open gaps that an alert firing in Grafana's UI alone does not page
anyone at 3am about:

- **Per-alert runbook link.** Every alert rule has a `runbook_url`
  annotation pointing at a section in `docs/runbooks/` (this document
  is the first such runbook; the rest follow as PR #797's
  AC1/AC2/AC3 land). Without a runbook URL, an alert is not
  production-ready.
- **On-call routing.** Today the only paging path is the watchdog
  above. Routing individual alerts to specific people is a paid-tier
  / PagerDuty-equivalent decision tracked under the W42
  cloud-readiness follow-up.
- **De-duplication.** One outage can fire several related alerts to
  the same channel. A `group_by` and `group_wait` policy is set on
  the Alertmanager config; current values are
  `group_by: [alertname, service_name]` and `group_wait: 30s`. Re-tune
  after the first month of live alerts based on observed noise.
- **Drift detection.** The live Grafana dashboard/alert state is
  currently not reconcilable against git. A diff script
  (`infra/cloud/observability/diff.sh`) that GETs the live state and
  diffs it against the committed JSON in
  `infra/cloud/observability/provisioning/` is a low-priority
  follow-up. Without it, someone hand-editing a dashboard in the
  Grafana UI will create silent drift.

### 6. Verification log

Every run of the AC4 fire→resolve verification or an AC5 follow-up
is logged here with a date, the change exercised, and the outcome.

| Date | Section | Change | Result |
| --- | --- | --- | --- |
| 2026-10-12 | AC4 | Doc published, read token provisioning path documented | pending first live verification |

---

## Out of scope (deliberate)

- **Deploy-failure alert producer.** A durable GitHub
  Actions→Grafana event pipeline is a separate-initiative-sized lift.
  The current deploy-failure alert rule is disabled until the
  producer exists (Rowan's AC3 on PR #797).
- **Paid-tier migration planning.** Tracked under the W42
  cloud-readiness follow-up, not here.
- **On-call / PagerDuty-equivalent routing.** Same — a paid-tier
  decision, not a free-tier runbook concern.
- **Drift detection script.** Documented as a gap above; not
  shipped in this pass.

---

## References

- `docs/systems/observability.md` — system reference for the hosted
  observability stack (PR #724).
- `docs/specs/hosted-observability-migration-alerts-tech-design.md`
  — original tech design for the hosted stack.
- `brain/ideas/hosted-observability-followups.md` — source
  brainstorm and the gap analysis that produced AC4 and AC5.
- `infra/cloud/observability/README.md` — operator-facing index of
  the hosted observability artefacts.
- `infra/cloud/observability/bootstrap.sh` — provisioning entry
  point (idempotency contract documented above in §4).
- `codebases/sindustries/agents/lox/` — incident-page pattern used
  by the probe watchdog.
