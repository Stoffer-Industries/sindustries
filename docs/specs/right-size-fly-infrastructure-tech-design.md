---
status: draft
task_id: 2de2673e-58e1-4eff-86c3-625fb9ba5cb8
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Right-size Fly infrastructure — tech design

## Product intent

There is no linked product spec. The task is the source of product intent:

> Right-size the remaining Fly.io infrastructure to reduce monthly spend, while preserving production reliability and proving whether the organisation can approach Fly's free tier.

Inventory the whole Fly organisation; remove only demonstrably stale Machines; test the production health probe at 256 MB and consolidated production platform at 1 GB; reconcile static egress with real allowlists/dependencies; and replace estimates with live before/after topology and billing evidence.

> Production remains available throughout; no production deploy, restart, resize or IP deallocation occurs without an explicit pre-change read-back, rollback path and post-change health verification.

Task `39b79a40`, not this task, owns staging on-demand behaviour and removal of staging probes. This task may inventory staging and add environment guards but must not implement that work.

## Task and repository context

| Item | Value |
| --- | --- |
| Task | `2de2673e-58e1-4eff-86c3-625fb9ba5cb8` — “💻 Right-size Fly infrastructure” |
| Type / priority / owner | code / urgent / Rowan |
| Tags | `rowan`, `fly`, `cost-reduction`, `infrastructure` |
| Branch | `task-2de2673e-right-size-fly-infra` |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-2de2673e-right-size-fly` |
| Repos | `Stoffer-Industries/sindustries` (implementation); `Stoffer-Industries/workspace` (product specs; none linked) |
| Design | `docs/specs/right-size-fly-infrastructure-tech-design.md` |

Current topology is declared by `infra/cloud/platform/platform-environments.mjs`, `infra/cloud/fly/platform.fly.toml`, its production overlay, `infra/cloud/observability/health-probe/fly.toml`, its production overlay, and `services/gymtrack-mcp/fly.toml`. Production inherits 2 GB (platform) and 512 MB (probe) from staging-default shared configs.

## Service boundary and data ownership

This is an **infrastructure/workflow domain** owned by `infra/cloud/`, not product data for `tasks-api`, an application database, or a new service. Fly owns live app, Machine, release, egress and billing state. The repo owns desired topology, guarded operator workflow, redacted evidence and rollback.

Direct consumers are `.github/workflows/deploy-production-platform.yml`, `.github/workflows/deploy-production-health-probe.yml`, `infra/cloud/scripts/capture-production-provisioning-state.mjs`, `tests/cloud/scripts/check-production-provisioning-state.mjs`, and operators using `infra/cloud/README.md`, `docs/systems/cloud-platform.md` and `docs/runbooks/platform-consolidation-rollback.md`. Production APIs, worker, probe and GymTrack MCP are affected runtimes but consume no new API.

No backend/database is appropriate: this is a bounded provider-control-plane transaction. Evidence is append-only JSON/Markdown or a CI artifact. Candidate configs/raw captures are generated outside source control; accepted sizes are promoted into production overlays. There is no temporary placement to extract.

## Ownership boundary check

The natural source of truth is the **workflow/OpenClaw boundary backed by declarative infrastructure**.

- Shared topology remains in shared Fly configs; environment facts remain in `platform-environments.mjs`.
- Proven production sizes become narrow `[[vm]]` overrides in production overlays.
- Live inventory/billing remain Fly-owned and are timestamped evidence, not a second mutable inventory.
- A guarded Node CLI is necessary because Fly has no repo-local declarative resource for orphan-Machine deletion or egress deallocation. It derives expected topology from manifests and refuses changed pre-reads.

Extend `infra/cloud/platform/render-fly-config.mjs` to permit only `memory` and `memory_mb` in exactly one `[[vm]]` overlay block. CPU, process groups, build, deploy strategy, checks and release command remain shared. This is the durable boundary; duplicating production configs is rejected.

## `.openclaw` and operator boundary

No `.openclaw` config, cron or skill change. Outside-repo operator work:

1. Quinn supplies the existing Fly credential without committing it and runs read-only inventory; Tom confirms invoice/plan facts unavailable by API.
2. Quinn schedules a production window, confirms no deploy is active, records release/Machine IDs, config, restarts/OOMs, egress fingerprints and health, and records rollback before mutation.
3. Quinn executes one exact target at a time. No bulk mutation mode.
4. Quinn verifies `/__status`, three API health routes, representative authenticated read/reversible write, queue enqueue/consume, probe `/healthz` and `/metrics`, Machine events and memory headroom. Failure triggers rollback.
5. Egress deletion also requires dependency-owner confirmation and evidence no active allowlist contains its fingerprint. External dashboards/allowlists remain operator actions.
6. Tom decides whether support, external billing controls or required add-ons make “near free tier” acceptable.

Credentials stay in the protected GitHub `production` Environment or operator environment. Store only names, counts, sizes, timestamps, necessary provider IDs and one-way IP fingerprints—never tokens, raw IPs, secret values or production request bodies.

## Implementation plan

### Guarded inventory and mutations

Add `infra/cloud/scripts/right-size-fly.mjs`:

- `inventory --out <dir>`: enumerate all organisation apps/Machines, releases, states, sizes, process groups, config versions, timestamps, restart/OOM events when exposed, egress counts/regions/fingerprints, extensions and billing lines. Compare active manifests; retired per-service TOMLs are not active topology.
- `candidate-config --surface platform|health-probe --memory-mb <n>`: render production and prove only VM memory differs.
- `preflight`: refuse stale evidence, concurrent releases, unknown Machines, unhealthy routes, config drift or missing rollback.
- `delete-machine` / `deallocate-egress`: one exact object, preflight and confirmation nonce. Refuse declared started runtime Machines; refuse allowlisted/unowned egress.
- `verify`: append post-health/topology/events/memory. Unreadable is never empty.

Put provider parsing/redaction in `infra/cloud/platform/fly-right-sizing.mjs` and tests in `infra/cloud/platform/tests/fly-right-sizing.test.mjs`. Reuse `infra/cloud/platform/egress-allowlist-facts.mjs` and Machines API patterns from the existing production capture.

### Production sizing after evidence passes

Extend renderer/tests for the narrow VM override; negative tests reject CPU override, duplicate VM tables, extra topology keys and inconsistent memory.

Do **not** commit target sizes before trials pass:

- probe: canary-deploy generated 256 MB config; observe startup, two production Fly-probe cycles and one hourly DB-probe cycle; verify health, metrics, telemetry, restarts and headroom;
- platform: canary-deploy generated 1 GB config; run representative read/write and queue load; observe every supervisor child, Fly checks, restarts/OOMs and headroom.

On pass, add override to `infra/cloud/observability/health-probe/fly.production.overlay.toml` or `infra/cloud/fly/platform.production.overlay.toml`. On failure, rollback and record retaining 512 MB or 2 GB. Staging sizes do not change.

### Runbook, evidence and docs

Add `docs/runbooks/fly-right-sizing.md` and `docs/infra/fly-right-sizing-evidence-template.md`. Each mutation records `preRead -> decision -> action -> postRead -> rollback`; retaining a resource is valid.

Extend `infra/cloud/scripts/capture-production-provisioning-state.mjs` only for VM config identity and billing/topology summary, preserving redaction. Extend `tests/cloud/scripts/check-production-provisioning-state.mjs`, both existing test files and `tests/cloud/fixtures/production-provisioning-state.example.json` so live captures match accepted sizes/counts/egress.

Update `infra/cloud/README.md`. On ship update `docs/systems/cloud-platform.md` with accepted topology, before/after cost, free-tier result and paid-resource owners; update `docs/systems/observability.md` only if probe size changes.

### Reconciliation

Compare every organisation app with active topology, but mutate individually. Remove stopped/canary Machines only with app/release, creation reason, lack of routing and preserved declared count documented. Production runtime Machines are never cleanup candidates.

Record every egress allocation's before/after fingerprints and owner/dependency. The current system doc calls abandoned Neon-allowlist egress a cleanup candidate; that is a hypothesis, not deletion authority.

Reconcile invoice/usage with Machine shape, egress, Fly-managed `sindustries-production` Upstash and support/organisation charges. Report compute eligibility separately from total-account eligibility.

## Data model and API contract changes

No product API, Prisma schema, migration or user-facing change. Internal versioned evidence:

```json
{
  "schemaVersion": 1,
  "capturedAt": "<ISO-8601>",
  "organisation": "<name>",
  "apps": [{
    "name": "<app>",
    "declared": true,
    "machines": [{
      "id": "<provider-id>",
      "state": "started",
      "release": "<version>",
      "processGroup": "platform",
      "memoryMb": 2048,
      "classification": "declared-runtime|canary|stale|unknown",
      "evidence": ["<reason>"]
    }],
    "egress": {
      "fingerprints": ["<sha256-prefix>"],
      "owners": ["<dependency-owner>"],
      "decision": "retain|deallocate|unresolved"
    }
  }],
  "change": { "target": "<exact-object>", "preRead": {}, "rollback": {}, "action": {}, "postRead": {} },
  "billing": {
    "period": "<provider-period>",
    "beforeMonthly": "<amount-or-unavailable>",
    "afterMonthly": "<amount-or-projection>",
    "freeTierEligible": false,
    "blockers": ["<managed-extension/support/egress/etc>"]
  }
}
```

Provider IDs exist only to prove assessed targets. Raw IPs/tokens/secrets are prohibited. Unknown schema versions fail closed.

## Workflow, cron and skill changes

- Production deploy workflows still deploy only rendered committed configs; no automatic resize trigger.
- CLI is manual in a protected window, never a normal-push action.
- CI runs new offline guard and extended renderer/provisioning tests.
- No cron, skill, task-workflow, Tasks API state or `.openclaw` change.
- Task `39b79a40` remains sole owner of staging on-demand/probe work.

## Test plan and AC verification matrix

No browser UI exists. Playwright E2E cannot exercise Machines, billing, OOMs, egress or allowlists. Use offline guard tests, mocked provider integration, and controlled live validation.

| AC | Layer | Evidence |
| --- | --- | --- |
| AC1 — inventory/delete safety | unit + mocked integration + manual provider | Active/stopped/stale-canary/unknown/unreadable fixtures; mutations reject declared/started runtime and bulk targets; before/after inventories and per-object records. |
| AC2 — probe 256 MB | file + unit + controlled canary/manual | Semantic diff; startup, health/metrics, two Fly cycles, one DB cycle, telemetry, restart/OOM/headroom and rollback; final overlay or retain-512 decision. |
| AC3 — platform 1 GB | file + unit + controlled integration/manual | Diff; `/__status`; cutover thresholds, authenticated read/reversible write, enqueue-to-consume, Fly events/headroom and rollback; final overlay or retain-2-GB decision. |
| AC4 — egress audit | unit + mocked integration + manual external validation | Fingerprint comparison via `egress-allowlist-facts.mjs`; unknown fails closed; owners, before/after fingerprints and connectivity. |
| AC5 — topology/billing/free tier | file + mocked integration + manual billing | Manifest-vs-live apps/counts/shapes/egress; invoice separates compute, Upstash, support and egress; unreadable stays unknown. |
| AC6 — availability/guards/recovery | unit + integration + controlled manual | Reject implicit environment, target mismatch, stale pre-read, missing rollback and concurrent release; negative staging/production tests; pre/action/post/rollback evidence. |

Minimum offline suite:

```text
node --test infra/cloud/platform/tests/fly-right-sizing.test.mjs
node --test infra/cloud/platform/tests/render-fly-config.test.mjs
node --test tests/cloud/tests/capture-production-provisioning-state.test.mjs
node --test tests/cloud/tests/check-production-provisioning-state.test.mjs
bash infra/cloud/scripts/tests/fly-toml-context.test.sh
```

## Open questions and risks

### Needs Tom decision

1. **Free-tier success:** compute within free allowances, or total invoice zero/near-zero after Upstash/support/egress? Report both; Tom chooses.
2. **Headroom:** proposed pass is no OOM/restart, peak working set ≤80% under representative load, stable latency/error. Tom must accept/replace before trials.
3. **Representative write:** choose a reversible write/queue job with no external post or customer-visible finance mutation.

### BLOCKING until operator evidence exists

1. Repo cannot prove current organisation inventory, egress, invoice, memory peaks or external allowlists. Capture live read-only evidence before classification/mutation.
2. Do not deallocate egress until dependency owners confirm absence from allowlists and reallocate/update/verify rollback is recorded.

### Noted risks

1. One platform Machine is shared fate; idle RSS cannot validate 1 GB.
2. Stopped/canary may be rollback material; state is not staleness proof.
3. Billing lags; distinguish invoice, projected run-rate and allowance.
4. VM overlay support weakens anti-forking unless narrowly and negatively tested.
5. Reallocated egress may differ, requiring external allowlist changes.
6. Shared defaults mean direct VM edits resize both environments; only production overlays carry passed decisions.
