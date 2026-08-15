---
status: draft
task_id: 020f423e-a18d-4435-98cb-664b655f675b
product_spec: brain/tasks/specs/open/production-cloud-cutover-rollback.md
shipped_pr: null
shipped_date: null
---

# Execute production cloud cutover with rollback verification

## Links and delivery metadata

- Product spec: `brain/tasks/specs/open/production-cloud-cutover-rollback.md`
- Parent migration index: `brain/tasks/specs/open/sindustries-cloud-migration.md` (workstream 7 of 7)
- Task: `020f423e-a18d-4435-98cb-664b655f675b`
- Task title: `🔧 Execute production cloud cutover with rollback verification`
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-020f423e-a18d-4435-98cb-664b655f675b-production-cloud-cutover-rollback`
- Worktree: `/Users/quinnstoffer/.openclaw/workspace/worktrees/rowan-production-cloud-cutover`
- Tech design: `docs/specs/production-cloud-cutover-rollback-tech-design.md`

## Product intent

The product spec requires a controlled, observable production transition to the already-verified cloud deployment. The route change must have explicit prerequisites, decision points and abort conditions; required endpoints must avoid unplanned interruption; authenticated workflows and operational signals must remain healthy through an agreed observation period; rollback must be rehearsed before cutover; and the local deployment must remain recoverable until Tom explicitly accepts the cutover.

This design treats rollback as an executable state transition with data-safety rules, not a DNS note.

## Clarification and assumptions

No clarification is needed before design approval because this final task cannot execute until its production-data (`f2c23e26-9d26-451d-bf62-e1a357fa24ab`), staging (`2850c5ac-252e-404a-863b-b83755b2f618`), and observability (`4b3d6e9c-d1ba-462c-aa72-4371ce81d8c7`) dependencies are accepted. The design defines fail-closed interfaces and records the human-selected values at execution time.

Assumptions:

1. The foundation exposes a stable production route/front-door and an atomic or weighted origin-switch interface. Raw DNS replacement with an uncontrolled TTL is insufficient for no-interruption cutover.
2. Production data has already been migrated, reconciled, backed up, and restore-tested. The cloud production database is canonical at cutover.
3. Local and cloud runtimes can temporarily use the same canonical cloud PostgreSQL/Redis services. Local compute is the fast rollback target; database disaster recovery uses the accepted production backup/restore procedure.
4. Auth/session verification, CORS origins, external callback URLs, X/Akahu credentials, and hosted telemetry are consistent across the two runtimes before traffic moves.
5. The observation duration and operators are written into the cutover record before execution. Recommended default is 60 minutes; an unset value blocks execution.

## Scope

In scope:

- provider-bound route inventory and cutover adapter;
- a versioned cutover manifest and operator runbook;
- prerequisite/go-no-go checks and abort conditions;
- production-like rollback rehearsal before production;
- weighted/canary transition while local remains healthy;
- continuous unauthenticated and authenticated workflow probes;
- hosted signal observation and evidence capture;
- fast runtime rollback to local compute;
- proof that a full local recovery remains possible from accepted backups;
- explicit Tom acceptance before fallback retirement.

Out of scope:

- production data migration itself;
- cloud provider or domain selection;
- immediate local decommissioning;
- unrelated product changes;
- active-active multi-primary databases or a new dual-write layer;
- changing OpenClaw's local-hosted execution model.

## Architecture and ownership boundary

### Natural source of truth

This is an **infra/workflow boundary**. The stable public endpoints and route state belong to the cloud/edge deployment layer. Services continue to own their APIs and databases. The cutover orchestration observes those contracts but does not become a product service or persist domain state.

- `infra/cloud/cutover/` owns declarative target aliases, route weights/state, and provider adapter configuration without credentials.
- `scripts/cloud/cutover/` owns guarded preflight, switch, observe, and rollback orchestration.
- Hosted observability remains owned by the observability workstream.
- The cloud production PostgreSQL schemas remain owned by Tasks API and Budget API respectively.
- `docs/runbooks/production-cloud-cutover.md` is the operator procedure; `docs/infra/` stores the redacted execution record.
- Tom owns final product acceptance; Rowan operates the engineering runbook; Quinn handles `.openclaw` configuration handoffs when needed.

A stable front-door with an origin adapter is the durable boundary and is no harder than maintaining DNS-only manual steps once rollback is required. This design therefore rejects an interim “edit records in the console and wait” approach.

### Cutover topology

```text
clients / OpenClaw callers
          │
  stable production endpoints
          │
 cloud edge / traffic-route adapter
      ┌───┴──────────────────┐
      │ weighted/active       │ warm fallback
      ▼                       ▼
 cloud runtime            local runtime
      └──────────┬────────────┘
                 ▼
       canonical cloud PostgreSQL
       canonical cloud Redis/BullMQ
                 │
       hosted metrics/logs/traces/alerts
```

During the observation period, only one Content Scheduler worker fleet is leader/active. Both API runtimes may be warm, but route weights and worker leadership are controlled separately to prevent duplicate external side effects.

### Data-safe rollback modes

1. **Runtime rollback (normal):** route traffic back to the warm local services while they continue using canonical cloud PostgreSQL/Redis. This avoids data divergence and is the expected fast rollback.
2. **Cloud data-layer incident:** do not point local services at the stale pre-cutover database after production writes. Quiesce writes, select a recovery point from the accepted production backup/PITR procedure, restore/reconcile locally, then route only after the runbook's data go/no-go passes.
3. **Pre-write abort:** if the cutover fails before any accepted production write, the frozen local pre-cutover database may be used only after the write ledger/reconciliation proves no cloud-only writes occurred.

A new dual-write or multi-primary layer would be much riskier than this task and is explicitly not introduced.

## Implementation plan and file scope

### 1. Bind a guarded traffic-route adapter

Add or extend the foundation's provider implementation with this repo-owned interface:

- `infra/cloud/bin/traffic-route get --environment production`
- `infra/cloud/bin/traffic-route plan --manifest <path>`
- `infra/cloud/bin/traffic-route set --target <local|cloud> --weight <0..100> --run-id <id>`
- `infra/cloud/bin/traffic-route wait --expected <state> --timeout <seconds>`

The implementation may use a load balancer, edge origin pool, or provider-native weighted route. It must return previous state/version for rollback and support compare-and-set so an operator cannot overwrite a route changed by someone else. If the provider cannot do weighted traffic, it must support an atomic health-checked origin switch at the stable front-door; DNS TTL alone does not satisfy the interface.

Add:

- `infra/cloud/cutover/production-manifest.example.yaml` — required endpoints, local/cloud origin aliases, expected commit/image, route steps, observation duration, alert dashboard IDs, worker-leader target, and operator roles. No secrets.
- `scripts/cloud/cutover/common.sh` — environment/account/domain assertions, lock acquisition, immutable run ID, redaction, evidence helpers, and cleanup.

All production-changing commands require the provider account, `environment=production` label, exact endpoint allowlist, current-route version, expected commit, and typed `--confirm <run-id>`. Acquire a provider lock/concurrency token for the entire transition.

### 2. Implement fail-closed preflight and runbook gates

Add `scripts/cloud/cutover/preflight.sh` that creates a signed/hashed result bound to the run ID and refuses cutover unless:

- all three task dependencies are accepted and their evidence links are recorded;
- cloud and local deployments run the intended schema-compatible commit/image;
- cloud services, database, Redis, worker, dashboards, and alerts are green;
- local fallback services boot and pass health checks against the canonical cloud data plane;
- local worker leadership is disabled and cloud worker leadership is healthy;
- latest production backup, restore-test result, recovery point, RPO/RTO, and checksum are recorded;
- route inventory/TTL/origin state matches the manifest and no unrelated route drift exists;
- auth sessions, CORS, callback URLs, and required external integrations pass pre-cutover checks;
- synthetic authenticated probe credentials exist in the provider secret runner and are excluded from logs;
- on-call operators, communication channel, observation duration, and explicit abort thresholds are set;
- no deploy, migration, secret rotation, or competing cutover is in progress.

Add `docs/runbooks/production-cloud-cutover.md` with a timestamped checklist, roles, commands, go/no-go decision, step-by-step traffic weights, expected evidence after each step, abort conditions, runtime rollback, data-layer recovery, and final acceptance. The runbook is executable without consulting chat history.

### 3. Rehearse rollback in production-like staging

Add `scripts/cloud/cutover/rehearse.sh`:

1. capture the current staging route and deployment state;
2. direct a canary route to the cloud staging runtime;
3. run the same continuous probes used for production;
4. inject a safe cloud runtime failure (stop one API process or fail its readiness gate);
5. invoke the real route adapter rollback to the local/prodlike target;
6. verify traffic, authenticated workflows, worker leadership, and signals recover;
7. restore the initial staging route and prove cleanup/idempotence.

The rehearsal uses production-like route mechanics and manifests but refuses production account/domain IDs. A passing timestamped rehearsal result is a hard production preflight input; documentation-only review cannot satisfy AC4.

### 4. Add continuous cutover probes

Add `tests/cloud/production-cutover-probes.mjs`. It runs before, during, and after each route change and emits one redacted sample per interval for:

- all public health endpoints and TLS certificate/hostname checks;
- authenticated Tasks API read plus a bounded synthetic create/comment/archive transaction;
- authenticated Budget API `/me` plus a safe read/write/read synthetic flow chosen in the staging task;
- Content Scheduler read plus safe future-scheduled create/approve/queue-health/unapprove/remove transaction with no real publish;
- expected service version/commit headers or deployment metadata;
- latency and status-code distribution;
- hosted database/Redis/worker/queue health and active alert count through the observability API where supported.

Synthetic records use a run ID and idempotent cleanup. The probe records correlation IDs and booleans, not tokens or domain payloads. A route step cannot advance until its minimum sample count passes.

### 5. Execute progressive cutover

Add `scripts/cloud/cutover/execute.sh` with a resumable state file stored in the approved encrypted operational artifact store and mirrored as redacted JSON. The default progression is:

1. **Baseline:** local 100 / cloud 0; collect healthy probe samples.
2. **Canary:** local 99 / cloud 1 (or the smallest provider-supported canary); hold and evaluate.
3. **Partial:** local 75 / cloud 25; hold and evaluate.
4. **Majority:** local 25 / cloud 75; hold and evaluate.
5. **Cloud active:** local 0 / cloud 100; keep local deployment warm and healthy.
6. **Observation:** run probes and evaluate dashboards/alerts for the manifest duration.
7. **Acceptance pending:** preserve local fallback until Tom explicitly accepts; do not decommission automatically.

At each step the script captures old/new route version, probe results, dashboards, active alerts, DB/queue metrics, and operator decision. It uses compare-and-set and can resume only when live state matches the last durable state.

Abort immediately and invoke runtime rollback for any of:

- any required endpoint produces an unplanned failed probe during the route transition;
- authenticated workflow correctness or cleanup fails;
- HTTP 5xx/error-rate or latency breaches the approved observability threshold;
- database connectivity, saturation, replica lag, Redis, or queue signals breach thresholds;
- worker leadership is ambiguous or duplicate external side-effect risk appears;
- route state differs from the expected version;
- evidence collection is unavailable long enough that safe state cannot be established;
- an operator calls abort.

“No unplanned service interruption” is evaluated by continuous external probes across the switch. Planned canary errors caused by the explicit staging rehearsal do not apply to production; any production probe outage is an AC failure even if rollback succeeds.

### 6. Implement rollback and fallback verification

Add `scripts/cloud/cutover/rollback.sh` that:

1. records reason and current route/data/worker state;
2. validates local runtime health against the canonical cloud data plane;
3. transfers worker leadership to the safe target before/with route rollback;
4. compare-and-set routes back to local and wait for convergence;
5. runs the full probe set and confirms hosted signals recover;
6. leaves cloud deployment intact for diagnosis;
7. records whether runtime rollback is complete or data-layer recovery is required.

Add `scripts/cloud/cutover/verify-local-recovery.sh` to prove the local deployment can be rebuilt from the accepted immutable commit/config references and, in an isolated recovery exercise, boot against a restored production backup. It does not restore over the live local fallback database. This gives AC5 both a warm runtime fallback and a tested full-recovery path.

The local deployment, config references, pre-cutover snapshot, and restore tooling remain untouched until Tom's structured QA acceptance and the runbook's fallback-retirement step. Retirement/decommissioning is a later explicit operation, not part of this PR.

### 7. Workflow, evidence, and system documentation

- Add `.github/workflows/production-cloud-cutover.yml` as `workflow_dispatch` only, protected by the GitHub `production` environment, required human approval, and concurrency group `production-cutover`. It supports `plan`, `rehearse` (staging only), `execute`, `observe`, and `rollback`; production-changing jobs require the exact run-ID confirmation.
- Add `docs/infra/production-cloud-cutover-<YYYY-MM-DD>.md` containing prerequisite links, manifest hash, operators, route states/timestamps, probe summary, dashboard links, decisions, any rollback, observation result, local fallback proof, blockers, and final acceptance status. Raw redacted machine evidence remains an immutable workflow/provider artifact.
- Update the consolidated cloud system doc (expected `docs/systems/cloud-runtime.md`) with the final production topology, route ownership, rollback modes, and runbook links.
- Update relevant app/service system references only if the shipped stable endpoint or operational behavior changes; do not create per-endpoint system docs.

The scripts, rehearsal, production execution, and evidence are one task because the ACs require the real cutover. They remain reviewable and reversible as phases in one draft PR; no implementation starts before design approval.

## Data model and API contract

No product database schema or public endpoint shape changes are planned.

Operational contracts:

- **Cutover manifest:** versioned YAML with immutable deployment IDs, endpoint allowlist, route steps, observation duration, threshold references, worker leader, evidence destinations, and operator roles.
- **Route adapter:** read/plan/compare-and-set/wait operations returning route version and target weights without provider credentials.
- **Probe result:** versioned JSON with run/step/timestamp, endpoint aliases, status/latency, workflow booleans, correlation IDs, signal verdicts, cleanup status, and redacted errors.
- **Cutover state:** monotonic phases (`preflight`, `baseline`, `canary`, `partial`, `majority`, `cloud_active`, `observing`, `acceptance_pending`, `accepted`, `rolled_back`) bound to route versions and manifest hash.

If zero-downtime requires a service contract or schema change after dependency implementation is known, stop and revise this design. The cutover task must not introduce hidden dual writes or compatibility behavior during execution.

## Workflow, cron, and skill changes

- Add one manually dispatched, environment-protected production cutover workflow. No cron or automatic production cutover is allowed.
- No agent skill or Lobster workflow changes are required.
- Existing Content Scheduler BullMQ worker/reconciliation behavior is reused; orchestration controls which runtime's worker fleet is active.
- No automatic local decommission job is added.

## `.openclaw` boundary

OpenClaw remains local. The preferred design keeps callers on stable production service URLs so route changes do not require OpenClaw edits.

Current agent automation may still target `http://localhost:4001/api/v1`. During implementation Rowan must inventory OpenClaw-owned task/cron endpoint configuration without changing it. If production callers must move to the stable cloud front-door, Rowan posts `[openclaw-needed]` with:

- exact `~/.openclaw` paths/keys identified by Quinn's config inspection;
- the stable URL substitution (no token values);
- validation command/probe;
- rollback to the local URL;
- timing relative to route cutover.

Quinn applies the change and posts `[openclaw-done]`. Rowan must not edit `~/.openclaw/` or treat the cutover complete while a required handoff is unresolved. Staging rehearsal uses explicit temporary environment variables and should not require persistent OpenClaw changes.

## Test plan and acceptance-criterion verification matrix

| AC | Planned verification | Layer / evidence |
|---|---|---|
| AC1 — procedure documents prerequisites, decisions, evidence, and abort conditions | Review the versioned manifest and `docs/runbooks/production-cloud-cutover.md`; run `preflight.sh` in plan mode and prove every missing prerequisite/threshold/operator blocks. Validate manifest/result schemas and command examples. | File/schema tests + dry-run integration + direct runbook inspection. |
| AC2 — endpoints transition without unplanned interruption | Run continuous external probes before/during/after progressive route weights. Require every endpoint/workflow sample to pass and record route convergence/version. Any failed required probe makes the AC fail and triggers rollback. | Real production operational E2E; workflow artifact and redacted cutover record. Unit/component tests cannot prove edge continuity. |
| AC3 — authenticated workflows and operational signals remain healthy through observation | Execute Tasks, Budget, and safe Content Scheduler synthetic transactions continuously; monitor agreed availability/error/latency/DB/Redis/queue alerts for the manifest observation duration; require cleanup and no active blocker alerts. | Production black-box E2E + hosted observability evidence. Real X/Akahu side effects are unsafe/disproportionate; vendor integrations use non-mutating health/token checks plus their existing integration tests. |
| AC4 — rollback is executable and verified before cutover | Run `rehearse.sh` in production-like staging using the same route adapter/probes, inject a safe cloud runtime failure, execute rollback, and verify local service/workflow recovery and restored initial state. Require a fresh passing rehearsal in production preflight. | Staging operational E2E with timestamped evidence; production rollback script plan output bound to live route version. |
| AC5 — local fallback remains recoverable until acceptance | Keep local services/config/immutable build available, continuously health-check local against canonical data, test isolated boot from accepted backup, block fallback retirement until Tom's explicit acceptance, and record fallback state in every observation sample. | Operational E2E + backup restore evidence + route/status evidence + final acceptance record. |

Additional gates:

- shell/unit tests cover manifest validation, route compare-and-set, phase resume, wrong-environment refusal, redaction, and idempotent rollback;
- staging route-adapter integration tests cover all weight steps and rollback;
- existing service/app tests and deployment validation pass at the exact cutover commit;
- gitleaks and evidence scans prove no credential, DSN, session token, or domain payload is committed;
- rollback and cleanup commands succeed when safely re-run.

## Risks and mitigations

- **Data divergence after writes.** Fast rollback keeps the canonical cloud database; never silently route to a stale local DB. Data-layer rollback requires write quiescence, restore, reconciliation, and an explicit second go/no-go.
- **DNS propagation cannot guarantee continuity.** Use a stable front-door with weighted/atomic origins. Refuse cutover if the foundation only provides an uncontrolled DNS record replacement.
- **Duplicate Content Scheduler side effects.** Maintain one active worker fleet, verify leader/queue state at every phase, and abort on ambiguous leadership. Synthetic probes never reach a real publish time.
- **Sessions/callbacks differ between origins.** Preflight authenticated flows, cookie/session persistence, CORS, and external callback URLs before canary traffic.
- **Local fallback silently rots.** Continuously probe it during observation and run isolated backup-based recovery before cutover. Keep immutable build/config references and do not decommission before acceptance.
- **Route drift/concurrent operator.** Provider lock plus compare-and-set on route version; refuse resume if live state differs.
- **Observability blind spot.** Evidence availability is itself a gate. Pause/rollback if key signals disappear rather than assuming health.
- **Synthetic production writes leak or persist.** Use dedicated synthetic identities/run IDs, minimal payloads, future scheduling, and idempotent cleanup; cleanup failure is an abort condition.
- **Provider rate/weight granularity differs.** Bind the manifest to the delivered adapter. If weighted traffic is unavailable, use one atomic health-checked switch and lengthen baseline/observation; update this design before approval if that materially changes risk.

## Open questions

1. What stable production domains/endpoints and route provider are delivered by the foundation task? Bind exact aliases and provider adapter in the approved manifest.
2. What observation duration and thresholds will Tom/Quinn approve? Recommended default is 60 minutes with thresholds referenced from the observability runbook; execution fails if unset.
3. Can the local runtime securely reach cloud PostgreSQL/Redis during the fallback window? If not, the prerequisite production data task must deliver a different RPO/RTO-safe replication/restore mechanism before this design can execute.
4. Which external integrations allow non-mutating production verification? Default to credential/config and safe read-only checks; do not send an X post or trigger an Akahu sync solely for cutover evidence.
5. Which OpenClaw-owned callers still use localhost rather than stable service URLs? Quinn's config inventory determines whether an `[openclaw-needed]` handoff is required.
