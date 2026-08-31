# Cloud Alerts Response Runbook

**Type:** Runbook (per-alert response expectation)
**Status:** Draft — alert rules ship in a follow-on PR; this runbook is the response contract that gets exercised when those rules land.
**Last updated:** 2026-09-01
**Owner:** Quinn (canonical on-call for all v1 alerts); reassignment per-alert is documented below.
**Related:** [`docs/systems/observability.md`](../systems/observability.md) (handover), [`infra/cloud/observability/README.md`](../../infra/cloud/observability/README.md) (artefact index), [`docs/systems/cloud-platform.md`](../systems/cloud-platform.md) (platform context).

---

## How to use this runbook

When a page fires on `#sindustries-p1` or a warn fires on `#sindustries-p2`:

1. Read the alert name. Look up the matching section below.
2. Acknowledge in Slack (`/ack`) so the alert doesn't keep firing the channel.
3. Follow the **Mitigation steps** in order. Each step has a documented command or link.
4. Once mitigated, post a one-line status in the Slack thread with the root cause (even if "unknown — investigating").
5. If the alert does not clear within 30 minutes, escalate per the **Escalation** subsection.
6. After the incident, file a post-mortem task with `lobster-feature-task` (or the appropriate workflow) referencing the alert name.

If a section is missing or out of date, that's a finding — file it as a follow-on task and link it from this runbook.

---

## Severity definitions

| Severity | Meaning                                                  | Slack channel         | Response time |
| -------- | -------------------------------------------------------- | --------------------- | ------------- |
| `page`   | Service unavailable, unsafe, or materially degraded      | `#sindustries-p1`     | Immediate     |
| `warn`   | Anomaly worth investigating within the business day       | `#sindustries-p2`     | Next business day |
| `info`   | Informational; no action required                        | `#sindustries-deploy` | No SLA        |

Severity is encoded in the alert rule JSON (`infra/cloud/observability/grafana/alerts/`) and is editable per-alert. To change severity for a v1 alert, file a follow-on task and link it from the affected section below.

---

## Alerts

### `tasks-api-down`

- **Source:** `sindustries_fly_app_health{app="tasks-api"} == 0` for 2 minutes
- **Severity:** page
- **Slack channel:** `#sindustries-p1`
- **Owner:** Quinn

**What it means.** The Fly health check for `tasks-api` has been failing for at least 2 consecutive minutes. The app is either crashing on boot, hung, or its `/health` endpoint is returning non-200.

**Mitigation steps.**

1. `fly status --app tasks-api-staging` — check machine state. Look for `stopped`, `crashed`, or `pending`.
2. `fly logs --app tasks-api-staging` — look for the most recent error. Common: OOM, missing env var, DB connection refused.
3. If OOM: `fly scale memory --app tasks-api-staging 1024` (current is 512).
4. If missing env var: compare `fly secrets list --app tasks-api-staging` against `infra/cloud/env/tasks-api.env.example` + `infra/cloud/observability/env/.env.example`. Set the missing var via `fly secrets set`.
5. If DB connection refused: check the Neon dashboard for the staging branch's status. If Neon is healthy, the connection string may have rotated — check `infra/cloud/observability/.env.local` and re-set `TASKS_API_DATABASE_URL` on the app.
6. If none of the above resolve within 10 minutes, `fly releases rollback --app tasks-api-staging <previous-good-version>`.

**Escalation.** If unresolved after 30 minutes, page Tom via Signal and post a status update in `#sindustries-p1`.

### `budget-api-down`

- **Source:** `sindustries_fly_app_health{app="budget-api"} == 0` for 2 minutes
- **Severity:** page
- **Slack channel:** `#sindustries-p1`
- **Owner:** Quinn

**What it means.** Same shape as `tasks-api-down` but for `budget-api-staging`.

**Mitigation steps.** Same playbook as `tasks-api-down`, substituting `budget-api-staging` and `BUDGET_API_DATABASE_URL`.

**Escalation.** Same as `tasks-api-down`.

### `tasks-api-5xx-spike`

- **Source:** `rate(http_requests_total{status=~"5.."}[5m]) > 0.05` for 5 minutes
- **Severity:** warn
- **Slack channel:** `#sindustries-p2`
- **Owner:** Quinn

**What it means.** The 5xx error rate for `tasks-api` is above 5% of total requests for 5 consecutive minutes. Likely a partial degradation — the app is responding but a meaningful share of requests are failing.

**Mitigation steps.**

1. Open the `cloud-overview` dashboard and click through to the `tasks-api-red` panel. Identify which endpoint(s) are emitting the 5xx.
2. `fly logs --app tasks-api-staging` — search for the most common error message. Recent deploy? DB query? Auth failure?
3. If the spike started immediately after a deploy, `fly releases rollback --app tasks-api-staging <previous-good-version>`.
4. If the spike correlates with a DB alert, follow the `tasks-api-db-down` mitigation steps first.
5. If the spike correlates with a specific endpoint, look up that endpoint's owner and route the investigation to them.

**Escalation.** If unresolved after 30 minutes or the error rate climbs above 20%, promote to a `page` by manually paging Quinn and cross-posting to `#sindustries-p1`.

### `budget-api-4xx-spike`

- **Source:** `rate(http_requests_total{status=~"4.."}[5m]) > 0.20` for 10 minutes
- **Severity:** warn
- **Slack channel:** `#sindustries-p2`
- **Owner:** Quinn

**What it means.** The 4xx error rate for `budget-api` is above 20% of total requests for 10 consecutive minutes. Often a client-side bug, a token rotation, or an auth regression — not a service outage, but worth investigating before business hours.

**Mitigation steps.**

1. Open the `cloud-overview` dashboard and look at the `budget-api-red` panel.
2. Drill into a single 4xx sample: pull a request log from Tempo by trace ID and look at the request headers + body.
3. Common causes: Akahu access token rotation (see [`rotate-akahu-access-tokens.md`](rotate-akahu-access-tokens.md)), OAuth scope change, missing `Authorization` header in a new client.
4. If the spike started immediately after a deploy, `fly releases rollback --app budget-api-staging <previous-good-version>`.

**Escalation.** Same as `tasks-api-5xx-spike`.

### `tasks-api-db-down`

- **Source:** `sindustries_db_up{app="tasks-api"} == 0` for 1 minute
- **Severity:** page
- **Slack channel:** `#sindustries-p1`
- **Owner:** Quinn

**What it means.** The health-probe service cannot connect to the `tasks-api` Postgres database. Either the DB is down, the connection string is wrong, or the probe is itself broken.

**Mitigation steps.**

1. Check the Neon dashboard for the staging branch's status. If Neon reports healthy, the connection string has likely rotated.
2. `fly logs --app tasks-api-staging` — check for `Error: P1001` (Can't reach database server) or similar Prisma errors.
3. If Neon is degraded: wait for Neon to recover. The probe will auto-clear once `SELECT 1` returns.
4. If Neon is healthy but the probe still fails: rotate `TASKS_API_DATABASE_URL` per [`cloud-data-env-provision.md`](cloud-data-env-provision.md). Re-set the secret on both `tasks-api-staging` and the `health-probe` Fly apps.
5. If the probe itself is broken (returns 0 even when DB is reachable), check `fly logs --app health-probe-staging` and follow the probe-specific debugging steps.

**Escalation.** If unresolved after 15 minutes, page Tom via Signal and post a status update in `#sindustries-p1`.

### `budget-api-db-down`

- **Source:** `sindustries_db_up{app="budget-api"} == 0` for 1 minute
- **Severity:** page
- **Slack channel:** `#sindustries-p1`
- **Owner:** Quinn

**What it means.** Same shape as `tasks-api-db-down` but for the `budget-api` database.

**Mitigation steps.** Same playbook as `tasks-api-db-down`, substituting `budget-api-staging` and `BUDGET_API_DATABASE_URL`.

**Escalation.** Same as `tasks-api-db-down`.

### `db-query-slow`

- **Source:** `histogram_quantile(0.95, sindustries_db_query_duration_seconds) > 0.5` for 5 minutes
- **Severity:** warn
- **Slack channel:** `#sindustries-p2`
- **Owner:** Quinn

**What it means.** P95 `SELECT 1` round-trip across the DBs the probe checks is above 500ms for 5 consecutive minutes. Often a precursor to a real DB outage, or an indication that the staging DB is being hit by a runaway query.

**Mitigation steps.**

1. Open the `db-health` dashboard and identify which app's DB is slow.
2. If it's a single DB, check Neon for active long-running queries (Neon's `Monitoring` tab).
3. If the slowness correlates with a specific time window, look at recent deploys in the `migration-alerts` dashboard.
4. If the slowness is steady and broad, it's likely Neon regional latency — check Neon's status page.

**Escalation.** If the slowness escalates into a full DB outage, follow the matching `*-db-down` playbook.

### `redis-down`

- **Source:** `sindustries_redis_up{app="content-scheduler"} == 0` for 1 minute
- **Severity:** page
- **Slack channel:** `#sindustries-p1`
- **Owner:** Quinn

**What it means.** The health-probe service cannot `PING` the Upstash Redis used by the content-scheduler queue.

**Mitigation steps.**

1. Check the Upstash dashboard for the staging Redis's status.
2. If Upstash reports degraded, wait for recovery. The probe will auto-clear.
3. If Upstash is healthy but the probe still fails, check `REDIS_URL` on both `auto-post-worker-staging` and `health-probe-staging`. Re-set the secret if it has rotated.
4. **Important:** while the queue is down, scheduled tweets are queued in memory and dropped on worker restart. Acknowledge in `#sindustries-p1` with the projected recovery time so Tom can decide whether to manually re-queue the dropped jobs after recovery.

**Escalation.** If unresolved after 15 minutes, page Tom via Signal — the content-scheduler queue has user-visible impact (missed scheduled tweets).

### `worker-queue-stuck`

- **Source:** `sindustries_queue_ready > 100` for 5 minutes
- **Severity:** warn
- **Slack channel:** `#sindustries-p2`
- **Owner:** Quinn

**What it means.** The content-scheduler queue has more than 100 ready (waiting) jobs for 5 consecutive minutes. Either the worker is stuck, throughput has dropped, or there was a sudden burst of scheduled tweets.

**Mitigation steps.**

1. Open the `cloud-overview` dashboard and check the queue-depth panel.
2. `fly logs --app auto-post-worker-staging` — check for stuck job loops or worker crashes.
3. If the worker is stuck (no recent log activity), `fly apps restart --app auto-post-worker-staging`.
4. If the burst correlates with a deploy or scheduled campaign, no action required — the worker will drain.
5. If the queue keeps growing past 500, escalate to `page` per the playbook below.

**Escalation.** If the queue crosses 500 jobs or the worker crashes repeatedly, page Quinn and cross-post to `#sindustries-p1`.

### `deploy-failed`

- **Source:** GitHub Actions workflow failure (filtered to `deploy-staging-*` workflows)
- **Severity:** warn
- **Slack channel:** `#sindustries-deploy`
- **Owner:** Quinn

**What it means.** A staging deploy workflow failed. The service is likely still running the previous version — no user impact unless the deploy was a hotfix.

**Mitigation steps.**

1. Open the workflow run in GitHub Actions. Look at the failure step.
2. Common causes: `flyctl` auth failure (token rotated), `pnpm install` cache miss, Docker build failure.
3. Re-run the workflow from the GitHub Actions UI. If it succeeds, no further action.
4. If it fails repeatedly, check `secrets.FLY_API_TOKEN` in the repo settings — it may have expired.

**Escalation.** If the failure blocks a hotfix deploy, page Quinn directly.

---

## On-call reassignment

Quinn is the canonical owner for every alert in the v1 list. To reassign an individual alert to Tom or another on-call:

1. Edit the corresponding JSON rule in `infra/cloud/observability/grafana/alerts/`.
2. Update the `Owner` field in [`docs/systems/observability.md`](../systems/observability.md) (Dashboard and alert ownership table).
3. Update the `Owner` field in the matching section of this runbook.
4. Open a PR with all three changes; review + merge like any other code change.

The alert rule's Slack routing does NOT need to change for ownership reassignment — routing is by alert severity, not by owner. The owner receives the alert because they are subscribed to the channel.

---

## Related runbooks

- [`cloud-deployment-rollback.md`](cloud-deployment-rollback.md) — `fly releases rollback` per-app rollback procedure.
- [`cloud-data-env-provision.md`](cloud-data-env-provision.md) — Neon DB connection-string rotation.
- [`rotate-akahu-access-tokens.md`](rotate-akahu-access-tokens.md) — Akahu token rotation (relevant for `budget-api-4xx-spike`).
- [`production-runtime-config.md`](production-runtime-config.md) — production env-var contract (future).
