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
| **It does** | Change which origin the stable production endpoints resolve to, under a continuous external probe, with a rehearsed, executable rollback. |
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

**Repo-side callers — Rowan owns these.** They are flipped in the window, not before it: pointing them at production before the switch would move traffic ahead of the route change the window is making.

| File | Current target | Post-cutover target |
|---|---|---|
| `agents/crons/prompts/task-lobsters.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` (4 references; one hardcodes the URL rather than defaulting to it) | Tasks API |
| `agents/crons/prompts/morning-brief.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` (2 references) | Tasks API |
| `agents/definitions/rowan/HEARTBEAT.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` | Tasks API |
| `agents/definitions/quinn/HEARTBEAT.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` | Tasks API |
| `agents/definitions/ivy/HEARTBEAT.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` | Tasks API |
| `agents/skills/dev/pr-open/SKILL.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` | Tasks API |
| `agents/skills/dev/pr-review/SKILL.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` | Tasks API |
| `agents/skills/dev/tech-design/SKILL.md` | `TASKS_API_BASE_URL=http://localhost:4001/api/v1` | Tasks API |
| `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` | defaults `TASKS_API_BASE_URL` to `http://localhost:4001/api/v1` | Tasks API |
| `agents/cron/bookmark-triage-report.py` | requires `TASKS_API_BASE_URL`; no default | Tasks API |
| `agents/skills/content/schedule-tweets/SKILL.md` | `CONTENT_SCHEDULER_API_BASE_URL` defaults to `http://localhost:4004/api/v1` | Content Scheduler API |
| `agents/skills/content/schedule-tweet-thread/SKILL.md` | `CONTENT_SCHEDULER_API_BASE_URL` defaults to `http://localhost:4004/api/v1` | Content Scheduler API |
| `agents/workflows/bookmarks/scripts/lobster_resolve_spec_request.py` | `CONTENT_SCHEDULER_API_BASE_URL` defaults to `http://localhost:4003/api/v1` | Content Scheduler API |
| `agents/workflows/cto-craft-tweet-drafts/src/cto_craft_workflow/settings.py` | `DEFAULT_CONTENT_SCHEDULER_BASE_URL` is the prodlike `:4004` | Content Scheduler API |
| `agents/crons/prompts/cto-craft-tweet-drafts.md` | `CONTENT_SCHEDULER_BASE_URL="<from secrets>"` | Content Scheduler API |

**`.openclaw`-owned callers — Quinn owns these.** The tech design is explicit that Rowan must inventory these but must not change them. The handoff is an `[openclaw-needed]` comment naming the exact paths and keys, the stable-URL substitution (no token values), the validation command, the rollback to the local URL, and the timing relative to the route cutover. Quinn applies it and posts `[openclaw-done]`.

| Caller | Current target |
|---|---|
| The cron/automation registrations that launch the prompts above, and the env injection they carry | `http://localhost:4001/api/v1` (Tasks API) and the prodlike Content Scheduler port |
| The Tasks API and Content Scheduler base URLs configured under `~/.openclaw` | as above |

**Two operational details that will bite if they are forgotten.**

1. `agents/definitions/*/HEARTBEAT.md` and `agents/crons/prompts/*` are **synced copies**. The canonical sources are the repo files; `sync-agent-definitions.sh` copies them into each agent's workspace on the next sync. A repo edit does not change a live agent's workspace until the sync runs — so the sync must happen before the flipped cron jobs are expected to use the new URL.
2. `agents/definitions/lox/HEARTBEAT.md` mentions `tasks-api-prodlike-down` as a **probe name**, not as a target. It is an alert label, not a caller, and it stays.

**The read-back proves the surfaces, not the files.** `infra/cloud/bin/traffic-route readback` reports which in-scope *surfaces* are bound to prodlike. The caller inventory above is what proves the *callers*. Both are required: a surface on production with a caller still pointed at prodlike is a half-finished cutover.

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
| P5 | The prodlike fallback boots and passes health checks **against the canonical cloud data plane** | The rollback script refuses a prodlike runtime that is not on the canonical data plane — a prodlike still pointing at the stale local database is not a valid rollback target. |
| P6 | Worker leadership is unambiguous — one active Content Scheduler worker fleet | `gates.requiredEvidence` → `worker-leadership`. The executor aborts on ambiguous leadership: duplicate external side effects are not an acceptable risk. |
| P7 | The latest production backup, its restore-test result, recovery point, RPO/RTO and checksum are recorded | `gates.requiredEvidence` → `backup-and-restore-test` |
| P8 | Route inventory, TTL and origin state match the manifest; no unrelated route drift | `gates.requiredEvidence` → `route-inventory`; the route adapter's compare-and-set refuses a version that moved underneath the operator. |
| P9 | Auth sessions, CORS, callback URLs and required external integrations pass pre-cutover checks | `gates.requiredEvidence` → `credential-and-callback-preflight` |
| P10 | Synthetic authenticated probe credentials exist in the provider secret runner and are excluded from logs | The probes record correlation IDs and booleans, never tokens or domain payloads. |
| P11 | Operators, communication channel, observation duration and abort thresholds are set | `gates.requiredOperatorFields` → `observationMinutes`, `operatorRoles.goNoGo`, `operatorRoles.execution` |
| P12 | No deploy, migration, secret rotation or competing cutover is in progress | The operator lock (`artifacts/cutover/cutover.lock`) plus the operator's own check. |
| P13 | A **fresh passing rollback rehearsal** exists for this route mechanics | `gates.requiredEvidence` → `staging-rollback-rehearsal`. Documentation review cannot satisfy AC4. |

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

```bash
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

**Planned** canary errors caused by the explicit staging rehearsal do not apply to production. Any production probe outage is an AC failure **even if the rollback succeeds**.

```bash
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

## 8. Related documents

- Tech design: `docs/specs/production-cloud-cutover-rollback-tech-design.md`
- Cloud platform handover: `docs/systems/cloud-platform.md`
- Data migration runbook (the preceding task): `docs/runbooks/production-data-migration-restore.md`
- Cutover record template: `docs/infra/production-cloud-cutover-record-template.md`
- Parent migration index: `brain/tasks/specs/open/sindustries-cloud-migration.md`
