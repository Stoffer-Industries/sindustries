# Production cloud cutover runbook

**Task:** `020f423e-a18d-4435-98cb-664b655f675b` — Execute production cloud cutover with rollback verification
**Window:** Sunday 22 November 2026, 19:00–21:00 NZDT
**Owner of the GO/ABORT decision:** Tom
**Owner of execution:** Quinn
**Owner of the engineering runbook:** Rowan
**Harness:** `scripts/cloud/cutover/` · **Route adapter:** `infra/cloud/cutover/traffic-route.mjs` · **Operator CLI:** `infra/cloud/bin/traffic-route`

This runbook is executable without consulting chat history. Every command, gate, abort condition and evidence path is written down. If a step in this document does not exist in the repository, the cutover does not start — that is a defect in the harness, not an operator judgement call.

---

## 0. What this cutover is, and what it is not

It moves the **route** for the Mission Control production runtime and its in-scope callers from the current prodlike source to the verified cloud deployment.

| | |
|---|---|
| **It does** | Change the live OpenClaw callers from the prodlike origins to the already-provisioned stable production endpoints, under continuous probes, with a rehearsed executable rollback. |
| **It does not** | Move data. The data migration is task `f2c23e26-9d26-451d-bf62-e1a357fa24ab`, and it runs **immediately before** this task in the same window. This task is not a second database migration. |
| **It does not** | Decommission prodlike. Prodlike is retained as a tested rollback surface until Tom explicitly accepts the observation period. AC5's decommissioning is a later, explicit operation. |
| **It does not** | Accept on Tom's behalf. The harness's final phase is `acceptance_pending`; it stops there. |

**Database topology:** production Neon already serves one database carrying the `tasks_api`, `content_scheduler` and `budget_api` schemas. This task switches callers to the existing production schemas. It does not create a database.

**In scope:** Tasks API, Content Scheduler, Mission Control, Tasks app, the relevant Fly production runtime configuration, agent workflows, cron/automation callers, deployment configuration and operator documentation.
**Deferred:** Budget API and GymTrack MCP.

---

## 0.1 The in-scope callers — AC2's inventory

AC2 requires that after the switch **no active in-scope caller still targets prodlike** except the explicitly documented rollback surfaces. That is only checkable if every caller is named. This is the inventory, as of 2026-11-19.

**The production URLs**

| Caller class | Production base URL |
|---|---|
| Tasks API | `https://tasks-api.sindustries.co.nz/api/v1` |
| Content Scheduler API | `https://content-scheduler-api.sindustries.co.nz/api/v1` |
| Mission Control | `https://mission-control.sindustries.co.nz` |
| Tasks app | `https://tasks.sindustries.co.nz` |

**The live route is the OpenClaw runtime configuration, not the GitHub checkout.** The adapter moves the runtime configuration; the repository-owned callers consume the same variables. §0.2 is that second class of in-scope caller, and the gate that keeps it honest.

Every in-scope surface's route lives in the runtime configuration. The adapter can only move a route it can read, so a surface with no managed caller is a surface the cutover cannot move — the manifest refuses it outright (see "Every in-scope surface names a managed caller" below).

| Managed caller file (relative to `SINDUSTRIES_CUTOVER_CALLER_ROOT`) | Key | Prodlike | Production |
|---|---|---|---|
| `.env` | `TASKS_API_BASE_URL` | `http://localhost:4001/api/v1` | Tasks API stable URL |
| `workspace/.env` | `TASKS_API_BASE_URL` | `http://localhost:4001/api/v1` | Tasks API stable URL |
| `.env` | `CONTENT_SCHEDULER_BASE_URL` | `http://localhost:4004` | Content Scheduler stable origin |
| `.env` | `MISSION_CONTROL_BASE_URL` | `http://localhost:5175` | Mission Control stable origin |
| `.env` | `TASKS_APP_BASE_URL` | `http://localhost:5174` | Tasks app stable origin |

The adapter atomically replaces only those URL literals, preserves the existing file mode, reads the files back, and refuses to record a route version unless every managed caller resolves the requested binding. The files may contain credentials; the adapter never prints their contents.

### 0.2 The repository-owned callers — the second in-scope class

The managed caller table above is the adapter's inventory: the files it writes and the read-back reads back. It is **not** the whole of AC2. AC2 names "agent workflows, cron/automation callers, deployment configuration and operator-facing docs", and those callers live in this repository.

A repository-owned caller follows the live route by **resolving the route variable**, never by pinning an origin:

```bash
set -a; [ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"; set +a
TASKS_API_BASE_URL="${TASKS_API_BASE_URL:-http://localhost:4001/api/v1}"
```

The prodlike literal is the local-dev fallback. The runtime value wins whenever the runtime environment carries the route — which, after the switch, it does.

**These surfaces are not in the manifest, so the adapter's read-back cannot see them.** That is why the repository carries its own gate, and it is a hard gate: a caller that pins a prodlike origin fails CI.

```bash
node tests/cloud/scripts/check-agent-caller-routes.mjs
```

It fails closed on a hard assignment (`TASKS_API_BASE_URL=http://localhost:4001/api/v1`), a `curl` that targets prodlike, an HTTP client call that targets prodlike, and a request method paired with a prodlike URL. It allows the origin as the *default* of a route variable, and allows prose that merely mentions one.

**AC2's proof is therefore two halves, not one.** The adapter's read-back proves the runtime configuration moved; this gate proves the repository-owned callers will follow it. Neither is sufficient alone — a caller that pins prodlike is invisible to the read-back, and a clean read-back is not a proof while such a caller exists.

**PREREQUISITE — the runtime configuration must already carry every route above.** The adapter refuses the whole switch if any managed caller cannot be read: a caller whose file is missing, or whose file carries neither the prodlike nor the production literal, is a caller the cutover cannot move, and the switch is refused before the first write rather than half-way through it. So `MISSION_CONTROL_BASE_URL` and `TASKS_APP_BASE_URL` must be present in `~/.openclaw/.env` **with the prodlike values above** before the window opens. Provision them out of band; the cutover does not create them, and it does not guess a value it did not find.

Verify the runtime configuration carries every route before the window — this is a read-only check:

```bash
for key in TASKS_API_BASE_URL CONTENT_SCHEDULER_BASE_URL \
           MISSION_CONTROL_BASE_URL TASKS_APP_BASE_URL; do
  grep -q "^${key}=" "$HOME/.openclaw/.env" || echo "MISSING: $key"
done
```

Before any mutating command on the operator host:

```bash
export SINDUSTRIES_CUTOVER_CALLER_ROOT="$HOME/.openclaw"
```

**The hosted-observability credential is a separate read.** The probe that watches the active alert count reads the hosted Grafana stack, so the stack URL and a credential must be in the operator's environment:

```bash
export GRAFANA_CLOUD_INSTANCE_URL="https://sindustries.grafana.net"
export GRAFANA_CLOUD_READER_AUTH="Bearer <read-scoped service-account token>"
```

Use the **read-scoped** credential, not the provisioning one. The provisioning token can write dashboards and delete alert rules; it must not be the credential the window is observed with.

**The read-scoped credential is NOT the credential in `.env.local`.** `infra/cloud/observability/.env.local` carries `GRAFANA_CLOUD_PROVISIONING_AUTH` — the write-scoped provisioning token — and nothing else. `GRAFANA_CLOUD_READER_AUTH` is a **separate** service account (Grafana Cloud → Users and access → Service accounts, `Viewer` plus `metrics:read`, `logs:read` and `alerts:read`), provisioned by Tom and exported into the operator's environment. Do not look for it in `.env.local`: it is not there.

Until that token exists, the window does not start. The hosted-signals probe fails closed without it, and the preflight names the missing credential instead of reporting an unhealthy service — see P13.

**The two tokens must not stand in for one another.** The preflight refuses the window when the hosted-observability credential is byte-identical to `GRAFANA_CLOUD_PROVISIONING_AUTH`, so a write-scoped token can never observe production and never reaches the window's evidence.

```bash
# Pre-window check: the credential must be present, and it must be the read-scoped one.
export GRAFANA_CLOUD_INSTANCE_URL="https://sindustries.grafana.net"
export GRAFANA_CLOUD_READER_AUTH="Bearer <read-scoped service-account token>"
[ "$GRAFANA_CLOUD_READER_AUTH" != "$GRAFANA_CLOUD_PROVISIONING_AUTH" ] \
  || echo "REFUSING: the provisioning token is standing in for the read-scoped credential"
```

See `docs/runbooks/hosted-observability-ops.md` for the reader credential's scopes and its rotation cadence.

This is a read-only check, and it can be run before the window:

```bash
curl -fsS -H "Authorization: ${GRAFANA_CLOUD_READER_AUTH}" \
  "${GRAFANA_CLOUD_INSTANCE_URL%/}/api/alertmanager/grafana/api/v2/alerts" \
  | jq 'length'
```

The number is how many alerts are firing right now. Zero is the state the window opens in.

The variable is mandatory for `execute` and `rollback`. A GitHub-hosted runner has only a disposable checkout, so the workflow deliberately refuses those two modes; run them on the OpenClaw operator host. Plan and observation remain safe on the hosted runner.

**Repository consumers are prepared before the window.** The merged prompts, heartbeat definitions, and skills read the runtime variables above instead of overriding them with localhost. Edge syncs those definitions from `origin/main`; that sync must be complete before preflight. The window then changes only the live runtime configuration and can reverse it without editing source.

`agents/definitions/lox/HEARTBEAT.md` mentions `tasks-api-prodlike-down` as a **probe name**, not as a target. It is an alert label and stays.

**The read-back proves the live callers and the surfaces.** `infra/cloud/bin/traffic-route readback` reads the managed runtime files and reports each observed binding. A surface recorded as production while one of its managed callers still carries the prodlike URL is not clean and cannot complete the cutover.

**The route state cannot prove itself.** The read-back takes a surface's binding from its LIVE managed caller. A surface with no live managed caller would fall back to the route state — which was written by the very command that moved the route, so reading it back proves only that the command recorded what it intended to do. Such a surface is now reported as `unprovenSurfaces` and the read-back is **not** clean. The documented rollback surfaces are the only exemption: their binding is the prodlike origin by definition, and "nothing moved it" is the point.

**Every in-scope surface names a managed caller.** The manifest validator refuses a surface that is in scope but declares no managed caller — one with no callers at all, or one with only `external` callers the adapter will never write. The reason is the same one: if nothing could have moved the surface, then nothing moving it must not be expressible as a manifest.

---

## 1. Roles and contact points

| Role | Who | Decides |
|---|---|---|
| GO / ABORT | Tom | Whether the window opens, whether to continue, and final acceptance of the observation period. |
| Execution | Quinn | Runs the scripts, captures the evidence, performs the read-backs. |
| Engineering | Rowan | Owns the harness, the runbook and the repository changes. On call for the window. |
| Communication | the agreed channel for the window | Every phase transition and every abort is announced here before it is actioned. |

**Observation duration** is recorded in the manifest (`run.observationMinutes`). An unset duration blocks execution — the manifest validator refuses it. The recommended default is 60 minutes.

---

## 2. Prerequisites — every one of these is checked by `preflight.sh`

The preflight is a **gate, not a report**. It fails closed: an environment it could not read is an *open* gate, never a silent pass. The executor refuses to start without a passing preflight.

| # | Prerequisite | How it is proven |
|---|---|---|
| P1 | Task `2850c5ac` (staging), `4b3d6e9c` (observability) and `f2c23e26` (production data) are **accepted** | Read from the Tasks API by the preflight; a dependency that is not in an accepted state fails the gate. |
| P2 | The data-migration evidence handoff from `f2c23e26` is recorded | `gates.requiredEvidence` → `dependency-acceptance` |
| P3 | The cloud and prodlike runtimes are on a schema-compatible commit/image | Operator-declared in the manifest; asserted by the route adapter. |
| P4 | Cloud services, database, Redis, worker, dashboards and alerts are green | `gates.requiredEvidence` → `local-fallback-health`, `worker-leadership` |
| P5 | The prodlike fallback boots and passes health checks **against the canonical cloud data plane** | The rollback script refuses a prodlike runtime that is not on the canonical data plane — a prodlike still pointing at the stale local database is not a valid rollback target. The preflight health-checks every in-scope surface on **both** bindings, so the prodlike surfaces must be **serving** at the moment of the window — see the note below. |
| P6 | Worker leadership is unambiguous — one active Content Scheduler worker fleet | `gates.requiredEvidence` → `worker-leadership`. The executor aborts on ambiguous leadership: duplicate external side effects are not an acceptable risk. |
| P7 | The latest production backup, its restore-test result, recovery point, RPO/RTO and checksum are recorded | `gates.requiredEvidence` → `backup-and-restore-test` |
| P8 | Route inventory, TTL and origin state match the manifest; no unrelated route drift | `gates.requiredEvidence` → `route-inventory`; the route adapter's compare-and-set refuses a version that moved underneath the operator. |
| P9 | Auth sessions, CORS, callback URLs and required external integrations pass pre-cutover checks | `gates.requiredEvidence` → `credential-and-callback-preflight` |
| P10 | Synthetic authenticated probe credentials exist in the provider secret runner and are excluded from logs | The probes record correlation IDs and booleans, never tokens or domain payloads. |
| P11 | Operators, communication channel, observation duration and abort thresholds are set | `gates.requiredOperatorFields` → `observationMinutes`, `operatorRoles.goNoGo`, `operatorRoles.execution` |
| P12 | No deploy, migration, secret rotation or competing cutover is in progress | The operator lock (`artifacts/cutover/cutover.lock`) plus the operator's own check. |
| P13 | The hosted stack answers and the read-scoped observability credential is present | The probe reads `GET <stack>/api/alertmanager/grafana/api/v2/alerts` and compares the count of firing alerts against `abortThresholds.activeAlertCount`. A missing credential, an unreadable endpoint or a payload that is not an alert list all **fail** the check — an unobserved signal is not a healthy signal. The preflight's `hosted-observability-credential` gate names the missing endpoint or credential directly, and refuses the window when the credential is the write-scoped provisioning token (see §0.1). |
| P14 | A **fresh passing rollback rehearsal** exists for this route mechanics | `gates.requiredEvidence` → `staging-rollback-rehearsal`. Documentation review cannot satisfy AC4. |

### The prodlike fallback must be WARM, not merely present

The preflight runs the health probes against **both** bindings — production and prodlike — and a failing prodlike probe fails the window. That is deliberate: prodlike is the rollback target, and a rollback target that is not serving is not a rollback target.

Two things follow for the operator host, and neither is discoverable from the failure alone:

- **The prodlike operator-facing surfaces must be running locally.** The prodlike Mission Control and Tasks app are the local dev servers on `:5175` and `:5174` — the ports `scripts/dev/mode-env.sh` assigns in prodlike mode (`MISSION_CONTROL_PORT=5175`, `TASKS_APP_PORT=5174`). `:5176` is the DEV-mode Mission Control port and nothing serves it in prodlike, so a prodlike URL on `:5176` is a dead route, not a slow one. If either surface is down, the `health:prodlike` gate fails with a connection error and the window does not start — even though the production binding is healthy. Start them before the preflight, not after it fails.
- **A frontend surface is health-checked at its document root.** The Mission Control and Tasks app surfaces declare `healthPath: "/"`, because they are single-page applications rather than services with a `/health` endpoint. The probe asks for the document the surface serves (`text/html`) rather than imposing a JSON content negotiation on it: the prodlike dev servers only serve their history fallback to a request that accepts HTML, so a health check that asks for JSON gets a 404 from a surface that is serving perfectly well. The preflight would then name the rollback fallback as unhealthy when it is not.

Read the two health gates together with the rest of the plan report before the window:

```bash
scripts/cloud/cutover/preflight.sh --manifest "$CUTOVER_MANIFEST_PATH" --plan
```

---

## 3. Before the window — the rehearsal (AC4's evidence)

The rehearsal uses production-like route mechanics and manifests, but refuses production account and domain IDs. It is a hard production preflight input, not a nice-to-have.

```bash
# 1. Copy the template and fill in the operator-owned values.
cp infra/cloud/cutover/production-manifest.example.json /tmp/cutover-staging.json
#    Edit: environment, origins, surfaces, phases, thresholds. No credentials, ever.

# 2. Rehearse against staging. The failure injection is safe and deliberate:
#    it stops one runtime process to prove the rollback path works.
scripts/cloud/cutover/rehearse.sh --manifest /tmp/cutover-staging.json
```

The rehearsal captures the current staging route and deployment state, canaries the cloud staging runtime, runs the same continuous probes production will use, injects a safe cloud runtime failure, invokes the **real** route adapter rollback to the prodlike target, verifies that traffic, authenticated workflows, worker leadership and signals recover, then restores the initial staging route and proves cleanup and idempotence.

The rehearsal also refuses a manifest that names a **production hostname**. The stable production hostnames are the bare per-service names (`tasks-api.sindustries.co.nz`); the stable staging hostnames are the per-service names under the environment label (`tasks-api.staging.sindustries.co.nz`). Only the bare names are refused — the staging surface is the rehearsal's own target, and a host that merely resembles the staging label (`notstaging.sindustries.co.nz`) is still a production host. The guard checks the **caller** targets as well as the surface URLs, because the rehearsal rewrites the live caller files to the manifest's production target: a caller left on a production hostname would be moved onto production by a staging rehearsal. `infra/cloud/cutover/check-production-hostnames.mjs` is the one implementation of that rule, and the rehearsal and its tests both call it rather than restating it.

```bash
# 3. Prove the prodlike fallback can be rebuilt from the accepted backup.
scripts/cloud/cutover/verify-local-recovery.sh \
  --manifest /tmp/cutover-staging.json \
  --reference <accepted-backup-reference> \
  --recovery-target <isolated-recovery-target>
```

This proves a **full** local recovery path exists, separately from the warm runtime fallback. It boots against a restored production backup in an isolated exercise; it never restores over the live prodlike fallback database.

> **If the rehearsal does not pass, the cutover does not happen.** Fix the harness, re-run the rehearsal, and record the new passing result. The production preflight reads the rehearsal result, and it must be fresh.

---

## 4. The window — wall-clock procedure

### 4.1 T-15 min — assemble

```bash
cd <repo>
export SINDUSTRIES_CUTOVER_ARTIFACT_DIR="$PWD/artifacts/cutover"

# The production manifest. It is a copy of the template with the
# operator-owned values filled in. It must never carry a credential.
export CUTOVER_MANIFEST_PATH="$PWD/artifacts/cutover/production-manifest.json"

# The typed confirmation. It is an ENVIRONMENT variable on purpose: a
# mistyped command alone can never start a production run.
export SINDUSTRIES_CUTOVER_PRODUCTION_ACK="CUTOVER PRODUCTION"
```

Confirm out loud, in the communication channel: Tom has the GO, Quinn has execution, Rowan is on call, and the window closes at 21:00 NZDT.

### 4.2 T-10 min — the preflight is the go/no-go

```bash
# Plan mode first: it reports what is outstanding without touching anything.
scripts/cloud/cutover/preflight.sh --manifest "$CUTOVER_MANIFEST_PATH" --plan

# Then the real thing, which writes the hashed, run-id-bound result.
scripts/cloud/cutover/preflight.sh --manifest "$CUTOVER_MANIFEST_PATH"
```

**Decision point — Tom's GO.** The cutover starts only when:

- the preflight exits 0, **and**
- Tom says GO in the communication channel, **and**
- the f2c23e26 data-migration handoff is explicitly confirmed complete.

A failed preflight is not a judgement call. Every unmet gate names its owner. Fix it, or do not proceed.

### 4.3 T-5 min — capture the pre-cutover state

```bash
infra/cloud/bin/traffic-route get
infra/cloud/bin/traffic-route plan --manifest "$CUTOVER_MANIFEST_PATH" --binding production
infra/cloud/bin/traffic-route readback --manifest "$CUTOVER_MANIFEST_PATH"
```

The read-back names every in-scope surface that still targets prodlike. Save it — it is the "before" half of AC2's proof.

### 4.4 T-0 — execute

Run this on the OpenClaw operator host, not in GitHub Actions:

```bash
export SINDUSTRIES_CUTOVER_CALLER_ROOT="$HOME/.openclaw"
scripts/cloud/cutover/execute.sh --manifest "$CUTOVER_MANIFEST_PATH"
```

The executor takes the operator lock, re-runs the preflight as a gate, and then walks the manifest's phases in order. For each phase it:

1. writes the plan to evidence **before** the change;
2. applies the phase's binding through the route adapter with compare-and-set against the live route version;
3. re-reads the live version and aborts if it is not the version the operator applied;
4. runs the continuous probes against the **active** binding and collects the phase's minimum number of samples;
5. evaluates the abort thresholds against the samples;
6. records the phase's evidence and advances the durable state.

The default phase progression in the shipped manifest:

| Phase | Binding | Hold | Min samples | What it proves |
|---|---|---|---|---|
| `baseline` | prodlike | 300s | 2 | The source is healthy before anything moves. |
| `canary` | production | 300s | 2 | The smallest amount of production traffic is healthy. |
| `partial` | production | 300s | 2 | — |
| `majority` | production | 300s | 2 | — |
| `cloud_active` | production | 600s | 3 | Production carries all traffic; prodlike stays warm. |
| `observing` | production | 3600s | 6 | The observation period, against the dashboards and alerts. |
| `acceptance_pending` | production | 0s | 1 | The window stops here, deliberately. |

**The window can be resumed.** If the operator is interrupted, `execute.sh --resume` continues from the recorded phase — but only when the live route still matches the recorded route version. A window whose manifest changed underneath it is not a resumed window, it is a different window, and it is refused.

### 4.5 During the observation period — AC3

For the full observation duration:

- The probes keep running against the active binding. Read the per-sample verdicts in the phase evidence.
- Watch the dashboards and the active alert count. The abort thresholds in the manifest are the approved ones.
- **Worker leadership is watched, not assumed.** One Content Scheduler worker fleet is active. Duplicate external side effects are an abort, not a metric.
- The prodlike fallback is continuously health-checked so it does not silently rot while it waits to be the rollback target.

### 4.6 The window closes at `acceptance_pending`

The script stops. It does not accept on Tom's behalf and it does not retire prodlike.

```bash
# AC2's "after" half: which in-scope surfaces still target prodlike?
infra/cloud/bin/traffic-route readback --manifest "$CUTOVER_MANIFEST_PATH"
```

The read-back must be clean **except** for the surfaces the manifest explicitly declares as `rollbackSurface`. Those are the documented rollback exceptions, and they are the only ones.

Fill in the record: `docs/infra/production-cloud-cutover-<YYYY-MM-DD>.md`, from
`docs/infra/production-cloud-cutover-record-template.md`.

### 4.7 After acceptance — AC5's decommissioning (a later, explicit operation)

Only after Tom has recorded acceptance of the observation period:

1. Prove that no active workflow, cron job, deployment/config reference or doc still points at prodlike.
2. Preserve the historical evidence and the rollback record — decommissioning deletes nothing.
3. Record the decommissioning in a separate, explicit operation with its own approval.

**Do not decommission prodlike merely because the switch succeeded.** That is the policy in the task, and it is what makes the rollback honest.

---

## 5. Abort conditions

Abort **immediately** and invoke the runtime rollback for any of the following. A failed rollback is itself an abort escalation, not a "we'll fix it later".

- Any required endpoint produces an unplanned failed probe during the route transition.
- An authenticated workflow fails, or its synthetic cleanup fails.
- HTTP 5xx / error rate or latency breaches the approved observability threshold.
- Database connectivity, saturation, replica lag, Redis or queue signals breach their thresholds.
- Worker leadership is ambiguous, or duplicate external side-effect risk appears.
- The route state differs from the expected version.
- Evidence collection is unavailable long enough that a safe state cannot be established.
- An operator calls abort.

### The manifest's thresholds are enforced, not merely declared

The manifest's `run.abortThresholds` are the authority for the probe-based abort conditions. All three are evaluated by the executor after **every** sample, not once at the end of the phase — a cutover that observes a degraded surface for an hour before noticing is worse than one that stops at the first sign of it.

| Threshold | What it measures | Breach |
| --- | --- | --- |
| `probeFailureCount` | Failed probe **samples** in the phase window | The count of failed samples reaches the threshold |
| `errorRate` | Failed probe **checks** ÷ all probe checks in the window | The measured error rate is above the declared rate |
| `p95LatencyMs` | The 95th percentile of the observed latencies, **per check id** | Any check's p95 latency is above the declared ceiling |

The error rate is the request-level rate across the window's checks, so it catches a slow bleed of failures that never reaches the failure *count*. The p95 latency is computed per check id rather than as one global pool, so the abort message names the surface that breached and a fast surface cannot mask a slow one.

**A latency breach aborts even when every HTTP status is healthy and every sample verdict is `PASS`.** That case was the reason the gates exist: the sample verdict only reflects whether a check failed, not whether it was fast enough.

The thresholds are evaluated by one module — `infra/cloud/cutover/thresholds.mjs` — so the executor, the runbook and the tests cannot drift apart on what the fields mean. **A window that cannot be evaluated is refused, never reported as a pass:** an unreadable sample, a malformed sample file or a manifest with no thresholds stops the window.

**The executor calls the evaluator through `infra/cloud/cutover/thresholds-cli.mjs`, never through the module.** The module decides whether to run its own command line by comparing the process entry point against its module URL, and that comparison is false whenever the path is not byte-identical to the URL — a symlinked checkout, a temporary directory, a path with a space in it. When it was false the module exited 0 **without evaluating anything**, and the executor read exit 0 as "no threshold breached": the abort thresholds were silently disabled. The wrapper imports the module and calls the evaluation unconditionally, so there is no entry-point detection on the path that matters and nothing to get wrong.

**Planned** canary errors caused by the explicit staging rehearsal do not apply to production. Any production probe outage is an AC failure **even if the rollback succeeds**.

### The active-alert threshold reads a real endpoint

The fourth threshold, `activeAlertCount`, is measured against the hosted Grafana stack's **Alertmanager v2 alerts endpoint** — `GET <stack>/api/alertmanager/grafana/api/v2/alerts` — which returns the alerts that are **firing right now** as a bare JSON array. The database, Redis, worker and queue alerts all live there, so a firing alert on any of them is an active alert for this threshold.

Three other Grafana endpoints look like candidates and are not:

| Endpoint | What it returns | Why it is not the active-alert count |
| --- | --- | --- |
| `/api/v1/provisioning/alert-rules` | The rule **definitions** — ten of them, with no `state` field | A definition count is not a firing count. The stack carries ten rules, so this would breach a threshold of one on every run. |
| `/api/prometheus/grafana/api/v1/rules` | Prometheus-shaped rules with a state | In this stack it answers `200` with **no groups at all**, so it would report zero active alerts forever. |
| `/api/datasources`, `/api/dashboards/...` | Configuration | Configuration is not state. |

**The probe fails closed on an unreadable signal.** A missing credential, an endpoint that does not answer, or a payload that is not an alert list all fail the check rather than counting as zero alerts. The earlier version of this probe read a `/api/v1/health` path that exists nowhere on the platform, and defaulted a missing `activeAlerts` field to zero — so an endpoint that answered with the wrong shape reported a **pass**. A count that cannot be read is not a count of zero.

```bash
export SINDUSTRIES_CUTOVER_CALLER_ROOT="$HOME/.openclaw"
scripts/cloud/cutover/rollback.sh \
  --manifest "$CUTOVER_MANIFEST_PATH" \
  --reason "<what triggered the abort>"
```

The rollback records the reason and the current route, data and worker state; validates that the prodlike runtime is healthy against the canonical cloud data plane; transfers worker leadership to the safe target; compare-and-set the route back to prodlike and waits for convergence; re-runs the full probe set; confirms the hosted signals recover; leaves the cloud deployment intact for diagnosis; and records whether the rollback completed as a runtime rollback or whether a data-layer recovery is now required.

---

## 6. Rollback modes — which one you are in

| Mode | When | What you do |
|---|---|---|
| **1. Runtime rollback (normal)** | The route or a runtime failed; the canonical cloud data plane is intact. | Route traffic back to the warm prodlike services. They keep using the canonical cloud PostgreSQL/Redis, so there is no data divergence. This is the expected fast rollback. |
| **2. Cloud data-layer incident** | Production writes were lost or the cloud data plane is unrecoverable. | **Do not** point prodlike at the stale pre-cutover database after production writes. Quiesce writes, select a recovery point from the accepted production backup/PITR procedure, restore and reconcile, then route **only** after the data go/no-go passes. |
| **3. Pre-write abort** | The cutover failed before any accepted production write. | The frozen local pre-cutover database may be used, but only after the write ledger and reconciliation prove no cloud-only writes occurred. |

A dual-write or multi-primary layer is **not** introduced by this task. It is out of scope and materially riskier.

---

## 7. Evidence checklist

Every item below is an artifact, not a claim.

| Evidence | Where |
|---|---|
| Preflight result (hashed, bound to the run id) | `artifacts/cutover/<run-id>/preflight*.json` |
| Per-phase plan (written **before** each change) | `artifacts/cutover/<run-id>/phase-<name>-plan.json` |
| Per-phase probe samples and verdicts | `artifacts/cutover/<run-id>/phase-<name>.json` |
| Route state and version history | `artifacts/cutover/production-route.json` |
| Prodlike read-back (the "after" proof for AC2) | `artifacts/cutover/<run-id>/prodlike-readback.json` |
| Rollback evidence, if a rollback happened | `artifacts/cutover/<run-id>/rollback-*.json` |
| Rehearsal result (AC4) | `artifacts/cutover/<run-id>/` from `rehearse.sh`, staging |
| Local recovery proof (AC5) | `artifacts/cutover/<run-id>/` from `verify-local-recovery.sh` |
| Human-facing record | `docs/infra/production-cloud-cutover-<YYYY-MM-DD>.md` |

**Redaction is enforced, not requested.** Every artifact passes through the shared redactor (`infra/cloud/platform/redact-output.mjs`) on the way in, and the redactor fails closed: if it cannot run, nothing is shown rather than the raw text. Operator output ends up pasted into task comments on a public repository, so a credential must never ride along.

The artifact directory is a local operator artifact. It is not a tracked file and must not be committed.

---

## 9. Production approval credential recovery

The platform deploy runs on every merge to `main`, and it registers the
production approval-credential set. Since task `3c004590` it MERGES the
platform's own validation actor with the operator actor set instead of
replacing the live secret, and it refuses to touch Fly at all when the
operator credential array does not match the manifest contract.

That makes one failure mode loud instead of silent: an agent write that
starts returning `401 AUTH_REQUIRED` on production means the credential
set on the live app is not the set the repository declares.

### Diagnose

1. Read the latest `production` platform workflow run. The provisioner
   names the exact source that is missing, malformed or mismatched —
   the deploy failed BEFORE any Fly write, so the live secrets are
   untouched and the running services are still serving with whatever
   was registered last.
2. Compare the manifest's actor set against the operator array in the
   protected GitHub Environment. **Never print the array and never print
   a token** — compare actor names and counts only.
3. Run the verifier through the protected workflow rather than by hand:

   ```bash
   node infra/cloud/platform/verify-platform-approval-credentials.mjs --environment production
   ```

   It presents every merged credential to its own service and requires
   the service to report the intended actor. It reports actor names and
   service names only.

### Repair

- **One actor's token is wrong or revoked:** rotate ONLY that actor's
  entry in the Environment operator array. Do not change actor
  membership or permissions unless the manifest changes in the same
  reviewed delivery.
- **The actor set itself changed:** update
  `infra/cloud/platform/platform-environments.mjs` (`operatorActors`)
  and the Environment operator array in the SAME reviewed change, then
  merge. The deploy refuses to proceed while the two disagree.
- **The array is empty or malformed:** the deploy refuses before it
  writes. Restore the array from the tokens already distributed to the
  callers; do not mint replacements without updating the callers, or the
  verifier will correctly fail and the agents will hold tokens the
  service no longer accepts.

Never paste a token into a task comment, a PR, a workflow log or a chat.


## 8. Related documents

- Tech design: `docs/specs/production-cloud-cutover-rollback-tech-design.md`
- Cloud platform handover: `docs/systems/cloud-platform.md`
- Data migration runbook (the preceding task): `docs/runbooks/production-data-migration-restore.md`
- Cutover record template: `docs/infra/production-cloud-cutover-record-template.md`
- Parent migration index: `brain/tasks/specs/open/sindustries-cloud-migration.md`
