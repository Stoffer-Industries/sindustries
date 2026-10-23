# Runbook — Hosted observability follow-up ops

This runbook captures the cloud/ops follow-up work owned by Quinn on
task `2c782afb` after the Grafana Cloud hosted observability stack
landed. It is the operator companion to the system reference
`docs/systems/observability.md` and the source brainstorm
`brain/ideas/hosted-observability-followups.md`. This document closes
**AC4** and **AC5** of the task spec.

**Provenance.** The hosted runtime artefacts landed via **PR #756**
(merged 2026-10-05, `69d159d8`). The earlier PR #724 with the same
title was closed without merging — do not look for a merged #724.
AC1–AC3 (dashboard metric-name and ratio fixes, queue-depth alert
removal, deploy-failure alert removal) shipped via **PR #797** (merged
2026-10-11, `c8cd5e70`) and are already in `origin/main`.

Every path, script name, env-var name, and API shape in this document
was verified against `origin/main`.

---

## AC4 — Read-scoped Grafana credential + alert fire→resolve verification

### Read-scoped Grafana credential

The shipped provisioning credential
(`GRAFANA_CLOUD_PROVISIONING_AUTH`) is a Grafana Cloud service-account
token with dashboard/folder/alert-rule **write** permissions. It is
over-scoped for verification work and should not double as the
credential an operator uses to *observe* alert state: a leak of it
allows silently deleting alert rules.

A second, **read-scoped** operator credential closes that gap.

- **Type:** Grafana Cloud service-account token, `Viewer` role, scoped
  to `metrics:read`, `logs:read`, and `alerts:read`. Not a
  provisioning token.
- **Where it lives:** `infra/cloud/observability/.env.local` (the
  gitignored repo-local store — see "Secret storage" below) as
  `GRAFANA_CLOUD_READER_AUTH`. It is deliberately a different env-var
  name from `GRAFANA_CLOUD_PROVISIONING_AUTH` so the two cannot be
  substituted for each other by accident.
- **Why two tokens:** rotating, revoking, or scoping down the
  read-scoped token does not affect provisioning, and revoking the
  provisioning token does not blind the operator from incident
  response. Neither can be used to do the other's job.
- **Authorisation:** Tom provisions the service account under
  **Grafana Cloud → Users and access → Service accounts**, granting
  Viewer plus the three read scopes, with a 90-day expiry. The token
  value is written into `.env.local` once and never printed outside
  that file.
- **Rotation cadence:** every 90 days, on the same calendar as the
  provisioning token so both roll together. A `[grafana-token-rotation]`
  reminder belongs in `brain/ops/runbooks.md` (cross-link to be added
  when that reminder is formalised).

### Secret storage (one store, stated once)

Live hosted-observability credentials live in
**`infra/cloud/observability/.env.local`** — a gitignored file at the
root of the observability directory. The redacted template is
`infra/cloud/observability/env/.env.example`, and
`bootstrap-observability.sh` reads `.env.local` for its one-time
provisioning run. This is the repo convention documented in
`infra/cloud/observability/README.md`.

Two other stores exist but are **not** where these keys go:

- `~/.openclaw/.env` — the OpenClaw host's own secret file. It holds
  the health-probe's local dev overrides, not the Grafana
  provisioning/reader tokens.
- Fly app secrets (`fly secrets set`) — where `bootstrap-observability.sh secrets`
  writes the *runtime* copies that the deployed health-probe reads
  (`GRAFANA_CLOUD_INSTANCE_URL`, `GRAFANA_CLOUD_OTLP_ENDPOINT`,
  `GRAFANA_CLOUD_OTLP_HEADERS`). This is a deployment surface, not a
  place to hand-author credentials.

### Fire→resolve verification path

The fire→resolve loop has to be exercised end-to-end before we trust
any alert to page. The verification runs once after the read-scoped
token lands, and is re-run after any alert-rule edit.

**Pre-conditions**

- `GRAFANA_CLOUD_READER_AUTH` and `GRAFANA_CLOUD_INSTANCE_URL` are
  exported.
- The hosted stack answers on `$GRAFANA_CLOUD_INSTANCE_URL` (same
  base URL `bootstrap-observability.sh` uses — stack base only, no
  trailing path).
- No incident is currently open for the rule under test.

**Procedure (per alert)**

1. Pick the alert rule and note its **UID**. UIDs are not generated at
   runtime: each committed rule file under
   `infra/cloud/observability/grafana/alerts/` carries it at
   `.groups[].rules[].uid` — for example
   `tasks-api-5xx-spike.json` →
   `.groups[0].rules[0].uid == "sindustries-tasks-api-5xx-spike"`.
   `bootstrap-observability.sh` translates those portable
   Prometheus-shaped files into Grafana provisioning payloads; the
   UID is the join key between the file and the live rule.

   ```bash
   jq -r '.groups[].rules[] | "\(.uid)\t\(.title)"' \
     infra/cloud/observability/grafana/alerts/tasks-api-5xx-spike.json
   ```

2. Confirm the rule exists in the live stack. The provisioning
   list endpoint returns an **envelope**
   (`{"total": N, "alertRules": [...]}`), not a bare array — select
   out of `.alertRules`, or the filter silently yields nothing and
   exits 0:

   ```bash
   curl -fsS -H "Authorization: $GRAFANA_CLOUD_READER_AUTH" \
     "$GRAFANA_CLOUD_INSTANCE_URL/api/v1/provisioning/alert-rules" \
     | jq '.alertRules[] | select(.uid == "sindustries-tasks-api-5xx-spike")'
   ```

   The bootstrap script's equivalent path is the single-rule GET
   `/api/v1/provisioning/alert-rules/${uid}`, which returns the rule
   directly.

3. Induce the failure condition using the shipped injector rather
   than hand-rolling one — it knows the expected alert and `for:`
   duration for each scenario:

   ```bash
   bash infra/cloud/observability/failure-inject.sh tasks-api-down
   ```

   The header of each scenario names the alert it should fire
   (e.g. `sindustries-tasks-api-down`, `for: 2m`). Available
   scenarios are listed by `failure-inject.sh` with no argument.

4. Wait one evaluation interval plus the rule's `for` duration (most
   committed rules use `interval: "1m"`; check the `for` value in the
   rule file), then read the rule's live state:

   ```bash
   curl -fsS -H "Authorization: $GRAFANA_CLOUD_READER_AUTH" \
     "$GRAFANA_CLOUD_INSTANCE_URL/api/v1/provisioning/alert-rules/sindustries-tasks-api-down" \
     | jq '{uid, title, state, noDataState, isPaused, updated}'
   ```

   Expect `state: "alerting"`.

5. Resolve the failure condition:

   ```bash
   bash infra/cloud/observability/failure-inject.sh tasks-api-up
   ```

6. Re-query after one evaluation interval; expect the rule to leave
   `alerting` within two intervals. `failure-inject.sh` also writes
   alert-state JSON to its capture directory as it goes.

7. Record the run in **§6 (Verification log) below** of this
   document — the date, the rule UID, and the observed state
   transition. Do not log it in `docs/systems/observability.md`; that
   file has no "Last verified" / "Verification log" section.

8. If the rule does not leave `alerting` within two intervals, file a
   follow-up against the alert's owning workstream. The ratio and
   metric-name fixes from PR #797 (`c8cd5e70`) are the most likely
   cause of a stuck rule, since they rewrote several expressions.

**Cadence.** Verification runs on first setup, after every alert-rule
edit, and at the start of every month. Every run is logged in §6.

---

## AC5 — Operational hardening (probe watchdog, secret hygiene, cardinality, bootstrap, alert routing)

### 1. Probe watchdog (separate runtime)

The health-probe is a single point of failure for the whole
observability story. A separate watchdog on a different runtime closes
most of the risk cheaply.

- **Where:** a `launchd` agent installed on the Mac mini — or any
  other always-on host that is **not** the machine running the
  health-probe service. Install path:
  `~/Library/LaunchAgents/openclaw.hosted-observability-watchdog.plist`
  on the host that runs it.
- **Greenfield, not an extension.** There is no `infra/launchd/` tree
  in this repository — `find . -name '*.plist'` returns zero files
  repo-wide. The launchd timers this project relies on (for example
  the `sindustries-main-guard` timer) are installed **outside the
  checkout** on their hosts. This plist is therefore a new file, not a
  copy of an existing in-repo boilerplate.
- **What it does:** `curl -fsS --max-time 5 $HEALTH_PROBE_URL/healthz`
  every 60s. On three consecutive failures it pages via the same
  channel used by the rest of the OpenClaw alert stack
  (`sessions_send` to a designated Telegram chat, mirroring Lox's
  incident-page pattern, documented under
  `codebases/sindustries/agents/lox/`).
- **Why a separate runtime:** if the host running the health-probe
  dies, the watchdog still pages; if the health-probe is merely stuck
  emitting nothing, the watchdog still catches it via `/healthz`.
- **Deployment health is a separate concern.** The watchdog entry
  above does only the `/healthz` poll. Post-deploy verification is a
  different job with a shipped implementation —
  `bash infra/cloud/observability/bootstrap-observability.sh smoke`
  runs the `/healthz` check against the deployed app and is also
  invoked by the `all` subcommand. Keep the two separate; do not fold
  smoke checks into the 60s watchdog loop.

### 2. Secret rotation and scoping

Every secret in the hosted observability stack is purpose-scoped and
lives in `infra/cloud/observability/.env.local` (gitignored) until
`bootstrap-observability.sh secrets` distributes the runtime copies to
Fly app secrets:

| Secret | Scope | Rotated via | Rotation |
| --- | --- | --- | --- |
| `GRAFANA_CLOUD_PROVISIONING_AUTH` | Service account: datasource read + dashboard/folder/alert-rule **write** | `.env.local` → `bootstrap-observability.sh secrets` | 90 days, paired with `GRAFANA_CLOUD_READER_AUTH` |
| `GRAFANA_CLOUD_READER_AUTH` | Service account: `Viewer` + `metrics:read`/`logs:read`/`alerts:read` only | `.env.local` (verification use only) | 90 days, paired with the provisioning token |
| `GRAFANA_CLOUD_OTLP_HEADERS` | Exporter header only (`Authorization=Basic <instance:policy-token>`); ingest path | `.env.local` → Fly app secrets | 90 days |
| `NEON_DB_DSN` (per service) | Single-database, app role | `.env.local` → Fly app secrets | 90 days, or on staff change |
| `UPSTASH_REDIS_URL` | Single Redis DB, restricted commands | `.env.local` → Fly app secrets | 180 days |
| Fly app secrets | App-scoped | `fly secrets set` per app | 180 days, or on deploy key change |
| `OPENCLAW_HOOKS_TOKEN` | Webhook auth | Host-local, not the observability tree | 180 days |

A shared full-access Grafana token is **explicitly disallowed**. The
provisioning token and the reader token are two distinct service
accounts with disjoint permissions: a leak of the reader token allows
no writes at all, and a leak of the provisioning token does not become
readable-by-accident because the read path never falls back to it.

`GRAFANA_CLOUD_OTLP_HEADERS` is not a bare header value — it is a
quoted `Key=Value` exporter header string. Consumers speaking plain
HTTP must parse it (`apps/gymtrack/api/telemetry.js`
`parseOtlpHeaderString()`); passing it through verbatim produces a
malformed `Authorization: Authorization=Basic ***` that Grafana Cloud
rejects with 401.

`infra/cloud/observability/.env.local` is a deliberate single-host
store for the current deployment. Once the cloud-readiness audit's
multi-host / multi-region work lands, it moves to the OpenClaw secrets
store per the audit contract (tracked under the W42 cloud-readiness
follow-up).

### 3. Cardinality and retention budget

Grafana Cloud free-tier ceilings as recorded in
`docs/systems/observability.md` (§ "Why Grafana Cloud" and "Account
ownership, secrets, and billing"):

- 10,000 active metrics series.
- 50 GB traces / month.
- 14-day metric retention.

Current usage is well under all three: **eight** committed alert-rule
files and five committed dashboards, covering `tasks-api`, `budget-api`,
`redis`, and the shared database, at staging scale.

Mitigations, with current status:

- **Series cardinality alert — NOT YET BUILT.** This is a real gap,
  not a shipped control. There is no `series-cardinality-budget` rule
  in `infra/cloud/observability/grafana/alerts/`. Before free-tier
  metrics become a production concern, add one alerting near 8,000
  active series against Grafana's `grafana_cloud_active_series` (or
  the equivalent self-reported counter). Owner: Quinn.
- **Per-service label budget:** the HTTP route label (`http_route`)
  is the highest-cardinality label currently emitted. New
  high-cardinality labels require a series-budget note in
  `docs/systems/observability.md` before they ship.
- **Retention decision point:** 14-day metric retention is acceptable
  for staging; extending it is a paid-tier decision tracked under the
  W42 cloud-readiness follow-up.
- **Alert rule cap:** Grafana Cloud caps alert rules per org. At eight
  committed rules there is headroom; re-evaluate when the count
  passes 80% of whatever the current plan's cap is.

### 4. Bootstrap script idempotency

`infra/cloud/observability/bootstrap-observability.sh` (dispatching
`validate | app | secrets | dashboards | alerts | deploy | smoke |
evidence | all`) must be re-runnable without duplicating state.

**As shipped:** alert rules are created or updated by UID. The script
`GET`s `/api/v1/provisioning/alert-rules/${uid}` and then:

- `200` → `PUT` back to `/api/v1/provisioning/alert-rules/${uid}`
- `404` → `POST` to `/api/v1/provisioning/alert-rules`

This is the correct create-or-update idiom: a create carries no UID,
so a `POST` is required on first provisioning, and only subsequent
runs use `PUT`. Do not "simplify" this to a PUT-only contract — that
would break first-time provisioning.

The remaining properties to hold:

- **Validate the target instance before any write.** `bootstrap-observability.sh validate`
  resolves each configured endpoint with a read-only reachability
  probe and prints the observed status code with a nameable cause,
  and it does **not** require Fly or Grafana auth. Run it first. It
  catches the wrong-account foot-gun by proving you are pointed at a
  live stack before anything is written.
- **Fail closed on partial failure.** If dashboards upload but an
  alert rule fails, the script exits non-zero without rolling back the
  dashboards. Grafana provisioning is eventually-consistent, so a
  partial state plus a clear error is safer than an automatic
  rollback. The error message names the failing step so the operator
  can re-run.
- **Re-runnability is verified** by running the script twice against a
  clean stack and asserting the rule/dashboard count is unchanged on
  the second run — `bash infra/cloud/observability/bootstrap-observability.sh all`
  includes the `smoke` step. Capture the evidence pack with
  `bash infra/cloud/observability/evidence-capture.sh --format md`.

### 5. Alert routing, runbooks, and drift detection

Open gaps that an alert firing in Grafana's UI alone does not page
anyone about at 3am:

- **Per-alert runbook link.** Every alert rule should carry a
  `runbook_url` annotation pointing at a section in
  `docs/runbooks/` (this document is the first such runbook). Without
  a runbook URL, an alert is not production-ready. The eight rules
  shipped by PR #797 do not all have one yet — audit and backfill.
- **On-call routing.** Today the only paging path is the watchdog in
  §1. Routing individual alerts to specific people is a paid-tier /
  PagerDuty-equivalent decision tracked under the W42 cloud-readiness
  follow-up.
- **De-duplication.** One outage can fire several related alerts to the
  same channel. A `group_by` / `group_wait` policy on the notification
  policy is the mechanism; **no such policy is committed in this
  repository today**. Set it in the Grafana Cloud UI, then write the
  chosen values back here once they are load-bearing. Re-tune after the
  first month of live alerts based on observed noise.
- **Drift detection.** The live Grafana dashboard/alert state is not
  reconcilable against git. A diff script that GETs the live state and
  diffs it against the committed JSON in
  `infra/cloud/observability/grafana/dashboards/` and
  `infra/cloud/observability/grafana/alerts/` is a low-priority
  follow-up. Without it, someone hand-editing a dashboard in the
  Grafana UI creates silent drift. (The paths above are where the
  committed JSON actually lives — there is no
  `infra/cloud/observability/provisioning/` directory.)

### 6. Verification log

Every run of the AC4 fire→resolve verification or an AC5 follow-up is
logged here with a date, the change exercised, and the outcome. This
is the only verification log for this runbook.

| Date | Section | Change | Result |
| --- | --- | --- | --- |
| 2026-10-12 | AC4 | Doc published, read token provisioning path documented | pending first live verification |
| 2026-10-23 | AC4/AC5 | Runbook corrected against `origin/main` per Rowan review on PR #801 — script/env/path names, alert-rules envelope shape, UID provenance, #756/#797 provenance, secret-store convention | doc corrected; live verification still pending |

---

## Out of scope (deliberate)

- **Deploy-failure alert producer.** The `deploy-failed` alert file was
  **removed** (PR #797, `c8cd5e70`) because no producer emits
  `sindustries_deploy_failed_total`. It is not merely paused. The
  minimum shape of the future producer is recorded in
  `docs/systems/observability.md` § "Deploy-failure telemetry", and
  the full design surface is in
  `brain/ideas/deploy-failure-telemetry-pipeline.md`. The contract
  test currently asserts the metric name is *absent*; that assertion
  flips when the producer ships.
- **Worker queue-depth alert.** Also removed by PR #797 for the same
  class of reason (no producer, plus `noDataState=OK` masking dead
  workers). Re-enable conditions are recorded in
  `docs/systems/observability.md` § "Worker queue-depth alert".
- **Paid-tier migration planning.** Tracked under the W42
  cloud-readiness follow-up.
- **On-call / PagerDuty-equivalent routing.** Same — a paid-tier
  decision, not a free-tier runbook concern.
- **Drift detection script.** Documented as a gap in §5; not shipped
  in this pass.
- **Multi-host secrets migration.** `.env.local` → OpenClaw secrets
  store is blocked on the W42 cloud-readiness audit.

---

## References

- `docs/systems/observability.md` — system reference for the hosted
  observability stack (PR #756). Also carries the endpoint
  pre-flight contract and the removed-alert rationale.
- `docs/specs/hosted-observability-migration-alerts-tech-design.md`
  — original tech design for the hosted stack.
- `brain/ideas/hosted-observability-followups.md` — source
  brainstorm and the gap analysis that produced AC4 and AC5.
- `infra/cloud/observability/README.md` — operator-facing index of the
  hosted observability artefacts.
- `infra/cloud/observability/bootstrap-observability.sh` — provisioning
  entry point; subcommand dispatch and idempotency contract (§4).
- `infra/cloud/observability/failure-inject.sh` — synthetic failure
  injection used by the AC4 verification procedure.
- `infra/cloud/observability/evidence-capture.sh` — evidence pack
  generator for the bootstrap re-runnability check.
- `codebases/sindustries/agents/lox/` — incident-page pattern used by
  the probe watchdog.
