---
status: draft
task_id: fb1240c0-f605-4e0f-bf0d-91b2e3bbb68a
product_spec: brain/tasks/specs/open/production-environment-provisioning-2026-11-05.md
shipped_pr: null
shipped_date: null
---

# Production Environment Provisioning — tech design

## 1. Product intent and task boundary

The approved product spec asks for the production destination to exist and be reachable **before** production data is migrated or traffic is cut over. It deliberately reuses the consolidated Fly packaging proven in staging: one application Machine, with `tasks-api`, `budget-api`, `content-scheduler-api`, and the queue-bound `auto-post-worker` as separate child processes.

This task provisions the destination only. It does not migrate data, move production traffic, or change application business logic.

- **Task:** `fb1240c0-f605-4e0f-bf0d-91b2e3bbb68a` — “💻 Provision the production environment (Fly apps, Neon branch, Cloudflare DNS, secrets)”
- **Task type:** `code`
- **Product spec:** `brain/tasks/specs/open/production-environment-provisioning-2026-11-05.md` (workspace repo, approved by Tom)
- **Predecessors:** Fly staging consolidation (`219fb673`), stable-hostname activation (`5cb4a8fe`), hosted observability (`31233a0a`)
- **Successors:** production data migration and restore (`f2c23e26`), then production cutover and rollback (`020f423e`)

### Assumptions and non-goals

No clarification is needed before drafting because the approved product spec fixes the outcome and explicitly requires the staging consolidation pattern. The implementation details below are derived from the shipped staging topology and existing runtime contracts.

Out of scope:

- moving or reconciling production data;
- changing production traffic, apex routing, or Vercel deployments;
- business-logic or application-code changes;
- creating another permanent service to own provisioning state.

## 2. Repository, branch, and worktree

| Item | Value |
|---|---|
| Repository | `Stoffer-Industries/sindustries` |
| Branch | `task-fb1240c0-production-environment-provisioning` |
| Worktree | `/Volumes/WD1/worktrees/rowan/task-fb1240c0-production-environment-provisioning` |
| Canonical checkout | `/Users/quinnstoffer/.openclaw/workspace/codebases/sindustries` stays clean on `main` |
| Design document | `docs/specs/production-environment-provisioning-tech-design.md` |

The task/PR dedupe guard found no open PR or remote `task-fb1240c0-*` branch. This branch is therefore the single implementation branch for the task.

## 3. Current state and constraints

### 3.1 The proven staging topology

The staging consolidation shipped one Fly app, `sindustries-platform-staging`, with one Machine and four child processes:

- `tasks-api` on loopback port `4001`;
- `budget-api` on loopback port `4002`;
- `content-scheduler-api` on loopback port `4003`;
- `auto-post-worker` with no listener.

One nginx router owns external port `443` and dispatches by `Host`; the supervisor owns the child lifecycle. `infra/cloud/platform/platform-services.mjs` is the single registry for child commands, ports, required app-level sources, and the mapping from app-level `PLATFORM_*` sources to each child’s existing environment contract.

Production must reuse this packaging rather than reviving the retired one-app-per-service staging topology. The durable production artifact should therefore be a **production variant of the same platform contract**, not four new service apps.

### 3.2 Current repository gaps

The repository currently has production destination names in `infra/cloud/hostname-matrix.json`, but the deploy and bootstrap artifacts are staging-specific:

- `infra/cloud/fly/platform.fly.toml` hard-codes `sindustries-platform-staging` and staging CORS/base-URL values;
- `infra/cloud/platform/platform-services.mjs` exports the staging app name;
- `infra/cloud/platform/platform-provision-secrets.mjs` reads `STAGING_*` GitHub Environment secret names and derives one Neon database’s three schemas;
- `.github/workflows/deploy-staging-platform.yml` deploys the staging app;
- `infra/cloud/scripts/bootstrap-staging.sh` is explicitly staging-only and refuses app-name overrides;
- the health-probe Fly config is staging-only and uses daily `DB_PROBE_INTERVAL_SECONDS` / `FLY_APP_PROBE_INTERVAL_SECONDS` values.

The product-spec requirement to populate **every** production runtime value means the current staging provisioner cannot simply be called with different environment variables: it also must preserve non-colliding service secrets, derive production schemas safely, and prove that no staging URL or placeholder was copied into production.

### 3.3 Platform constraints

- Fly app secrets are app-scoped. The supervisor’s `PLATFORM_<CHILD>_<VARIABLE>` indirection is therefore required when children need different values for the same child-facing variable.
- Fly process groups each receive their own Machine. The production cost/shared-fate behavior requires one process group containing a supervisor, not four Fly process groups.
- Fly exposes one external service per port. The single nginx router remains necessary for the three public API hostnames.
- Neon branches are data copies, not network isolation. “Restricted to production services” therefore requires an access policy enforced by Neon/branch/role controls plus a connection policy; merely naming a branch `production` is insufficient.
- Fly spend limits are a billing control, not a `fly.toml` property. The repository can prove the operator command/API and capture read-back evidence, but the limit itself is an account-side action.

## 4. Target architecture and ownership boundary

### 4.1 Target topology

```text
Cloudflare production DNS
  ├─ tasks-api.sindustries.co.nz ───────┐
  ├─ budget-api.sindustries.co.nz ──────┼─> sindustries-platform-production
  └─ content-scheduler-api.sindustries… ┘      one Machine / one process group
                                                ├─ nginx :8080 (Host router)
                                                ├─ supervisor :8081
                                                ├─ tasks-api :4001
                                                ├─ budget-api :4002
                                                ├─ content-scheduler-api :4003
                                                └─ auto-post-worker (no listener)

health-probe.sindustries.co.nz ───────────────> sindustries-health-probe-production
Neon production branch ──────────────────────> production platform + production health probe
```

The exact Fly app names are a proposal for Quinn’s review: `sindustries-platform-production` and `sindustries-health-probe-production`. They must be recorded in the hostname matrix and workflow contracts when the implementation begins.

### 4.2 Natural source of truth

The natural source of truth is the **workflow/deployment boundary** (`infra/cloud/**` plus `.github/workflows/**`), not an application API or a new database table.

- `infra/cloud/hostname-matrix.json` owns the stable production hostnames and Fly app names.
- `infra/cloud/platform/platform-services.mjs` owns child topology and secret-to-child mapping.
- A production configuration/environment manifest owns the production source names and non-secret values.
- The platform provisioner owns the one mapping from environment sources to Fly secret names.
- The production bootstrap script owns the idempotent local provisioning sequence.
- The Tasks API remains the task/workflow source of truth; this task adds no task domain data.

There is no interim shim. A staging-only script plus a copied production script would create two provisioning contracts and drift. The implementation should parameterize the existing platform contract by environment, with explicit fail-closed production/staging separation.

### 4.3 Direct consumers

- Mission Control and Tasks app consume the production API base URLs through the existing Vercel environment matrix.
- `tasks-api` and the auto-post worker consume the production content-scheduler base URL.
- the production health probe consumes the production database, Fly app health, and Redis targets;
- GitHub Actions consumes masked environment secrets and deploys the destination;
- operators consume Fly, Neon, Cloudflare, and Vercel control planes directly.

## 5. Implementation plan

The work is split into mergeable slices. Each slice leaves the repository consistent; live provisioning occurs only after the contracts and operator surfaces are reviewed.

### Slice A — environment-parameterized platform contract

Refactor the platform registry/provisioner so one implementation supports explicit environments without weakening staging:

1. Replace the hard-coded staging app/export with an explicit environment manifest (`staging` / `production`) containing:
   - Fly app names;
   - stable hostname/API base URLs;
   - CORS origins;
   - GitHub Environment secret source names;
   - Neon schema names and expected environment label.
2. Keep `PLATFORM_*` child secret names identical across environments. The child-facing contract is stable; only the source values and non-secret destinations vary.
3. Add fail-closed guards:
   - production refuses staging source names;
   - production rejects known staging/dev hostnames and placeholder values;
   - production rejects a source whose embedded environment label is not `production` where the provider exposes one;
   - missing required production sources fail before any Fly mutation.
4. Keep the existing `platform-services.mjs`, supervisor, router, migration chain, and redaction module as the shared implementation.

Expected files:

- `infra/cloud/platform/platform-environments.mjs` (new source-of-truth manifest);
- `infra/cloud/platform/platform-services.mjs`;
- `infra/cloud/platform/platform-provision-secrets.mjs`;
- `infra/cloud/platform/tests/**` (expanded contract tests).

### Slice B — production Fly and bootstrap artifacts

1. Add a production platform Fly config that uses the same image, supervisor, router, migration chain, and one-process-group shape as staging. Prefer a small environment overlay over a full duplicate of `platform.fly.toml`; the shared file must remain the default and the overlay must contain only environment-owned names/values.
2. Add a production health-probe Fly config with the production app name and a two-minute Fly-app cadence.
3. Generalize `infra/cloud/scripts/bootstrap-staging.sh` into an environment-aware bootstrap (or add a thin production entry point over one shared implementation). The production path must:
   - create the consolidated production app only if absent;
   - never create retired per-service apps;
   - register production secrets through the shared provisioner;
   - run migrations only when explicitly requested;
   - deploy only when explicitly requested;
   - remain idempotent.
4. Add an operator-facing production source contract listing exact secret names, owners, rotation, and placeholders only.

Expected files:

- `infra/cloud/fly/platform.production.fly.toml` or an environment overlay;
- `infra/cloud/observability/health-probe/fly.production.toml` or an overlay;
- `infra/cloud/scripts/bootstrap-production.sh` (thin entry point over shared implementation);
- `infra/cloud/env/bootstrap-production.env.example` and the production platform/health-probe source contracts;
- `infra/cloud/README.md`.

### Slice C — CI deploy workflow and drift checks

1. Add `.github/workflows/deploy-production-platform.yml`:
   - `environment: production`;
   - masked `FLY_API_TOKEN` fail-fast preflight;
   - explicit deploy opt-in before the first production deploy;
   - secret provisioning before the canary deploy;
   - canary deployment with the pinned Fly CLI;
   - smoke checks against each production API hostname;
   - worker-startup evidence from the same production Machine;
   - no raw secret values in logs.
2. Add or generalize a production health-probe deploy workflow.
3. Extend static checks to enforce:
   - production app names and hostnames agree across the hostname matrix, Fly configs, workflows, and environment manifest;
   - production source contracts contain no staging hostnames;
   - the production platform remains one app/one process group;
   - health-probe production cadence is tighter than the staging daily cadence;
   - the production deploy workflow uses the `production` GitHub Environment and a masked Fly credential.
4. Wire the new contract tests into CI.

Expected files:

- `.github/workflows/deploy-production-platform.yml`;
- `.github/workflows/deploy-production-health-probe.yml`;
- `tests/cloud/scripts/check-*.mjs` (new/extended drift checks);
- `infra/cloud/scripts/tests/**` and `infra/cloud/platform/tests/**`.

### Slice D — live provisioning and operator evidence

After the repository contract is approved, the operator executes the production setup in this order:

1. Create a dedicated Neon production project/branch and service roles.
2. Restrict Neon connectivity to the production platform and production health probe, and prove staging/dev roles cannot connect to production.
3. Create `sindustries-platform-production` and `sindustries-health-probe-production` through the bootstrap path.
4. Populate the GitHub `production` Environment with all masked source secrets.
5. Register Fly secrets, run migrations, and deploy the platform canary.
6. Set the Fly organization/app spend limit and capture read-back evidence **before** the health probe or any public hostname is enabled.
7. Configure and deploy the production health probe against production targets with the tightened cadence.
8. Create only the production API DNS records and Fly certificates. Do not move the apex or any frontend production traffic in this task.
9. Run black-box smoke checks and capture redacted evidence.

Expected live evidence:

- Fly app/release/machine inventory for the consolidated production app;
- Neon branch/role/connectivity proof with secrets omitted;
- Fly secret-name inventory and digest read-back, not values;
- spend-limit read-back;
- HTTPS health responses for all three API hostnames;
- health-probe target/cadence read-back and one successful production probe interval.

### Slice E — durable documentation

Update the existing durable surfaces rather than creating a parallel runbook system:

- `docs/systems/cloud-platform.md`: production topology, ownership, shared-fate warning, spend limit, and credential boundary;
- `docs/cloud/production-blockers.md`: replace stale one-app-per-service production assumptions with the consolidated topology and current blocker statuses;
- `infra/cloud/README.md`: production bootstrap/deploy/rollback index;
- `docs/specs/production-environment-provisioning-tech-design.md`: mark shipped when the implementation PR merges.

No app `SPEC.md` changes are required because this task does not change user-visible application behavior.

## 6. Data model, API, workflow, and secret contracts

### 6.1 Data model and public API

No database schema or public API changes. The platform uses the existing service-owned schemas and environment-variable contracts.

The production Neon branch contains the same three logical schema names as staging (`tasks_api`, `budget_api`, `content_scheduler`) unless Quinn chooses separate production databases per service. The implementation must not silently assume that choice; the production environment manifest records the selected topology.

### 6.2 Secret contract

The source contract remains the existing `services/<service>/.env.example` set plus `infra/cloud/env/*.env.example`. The production implementation must:

- enumerate every production-required source name;
- map only colliding values through `PLATFORM_*` names;
- preserve non-colliding service values unchanged;
- keep values out of source control, logs, task comments, PR bodies, and evidence files;
- fail closed when a required value is missing or still contains a staging/dev marker;
- avoid deriving the production content-scheduler DSN from a staging DSN.

The durable source-of-record for mapping is the platform provisioner; production and staging use that implementation with different explicit manifests.

### 6.3 Workflow and operator boundaries

- **Rowan:** repository contracts, deploy workflow, checks, tests, and durable docs.
- **Quinn:** operator execution using the approved Fly/Neon/Cloudflare credentials and captured evidence.
- **Tom:** only the Fly organization billing action if the current account does not let Quinn set the spend limit.

No `.openclaw` file is the source of truth for this work. Any `.openclaw` runbook update is a convenience handoff only and must point to the repository-owned contract.

## 7. Test plan and acceptance-criterion verification matrix

No user-visible app flow changes, so browser E2E is not proportionate. The relevant surface is infrastructure behavior, verified with unit/contract tests plus live infrastructure probes.

| AC | Verification | Layer |
|---|---|---|
| AC1 — consolidated production Fly app exists, deploys, and health-checks | `fly app list`/release/machine read-back proves one production platform app and one Machine; supervisor status proves four expected children; HTTPS `/health` passes for tasks, budget, and content scheduler; worker startup line is observed in that app’s logs | live Fly integration + workflow smoke + supervisor unit contract |
| AC2 — production Neon branch exists, is separate, and is restricted | Neon project/branch read-back names a production branch; role grants prove only production roles can connect; staging/dev connection attempts fail; production services pass `SELECT 1`; no production DSN appears in staging/dev source contracts | live Neon integration + config contract |
| AC3 — production Cloudflare DNS points at the new app without affecting staging/dev | Cloudflare read-back shows only the three production API records changed; `dig` from two resolvers resolves each to the production app; HTTPS/cert validation succeeds; staging API hostnames retain their prior targets and remain healthy | live Cloudflare/DNS/TLS integration |
| AC4 — every production contract value is populated securely | production source inventory is complete; Fly secret-name inventory contains every required mapped/pass-through name; `fly secrets list` shows names/digests only; redacted output scan finds no secret value; a boot/health probe proves missing required config fails closed | contract test + live Fly secret/metadata inspection + service boot check |
| AC5 — Fly spend limit is set before real traffic | Fly billing/limit read-back shows a non-zero monthly limit on the correct org/app scope, captured before DNS/public health probe activation; workflow chronology proves the limit step precedes public exposure | live Fly billing evidence + workflow ordering contract |
| AC6 — production health probe targets production and uses tighter cadence | production probe Fly config and deployed env show production API/DB/Redis targets; `FLY_APP_PROBE_INTERVAL_SECONDS=120` and `DB_PROBE_INTERVAL_SECONDS=3600`; one live interval emits successful production metrics; no staging target appears | config contract + live Fly/Grafana probe evidence |

### Repository test commands

The implementation will add equivalent commands for the new surfaces, including:

```bash
node --test infra/cloud/platform/tests/*.test.mjs
node --test tests/cloud/tests/*.test.mjs
bash infra/cloud/scripts/tests/*.test.sh
```

The production deploy workflow itself is the final integration test. It must not be replaced by a local mock for AC1–AC6.

## 8. Rollback and failure containment

This task provisions a new destination; it does not move traffic. Therefore rollback is primarily “do not expose or stop using the new destination”:

1. Before DNS/public exposure, failure means leave the production app stopped/unexposed and correct the contract before retrying.
2. After API DNS records are created but before traffic cutover, remove only the three records created by this task. Staging/dev records are not touched.
3. Never destroy the production app, Neon branch, or role configuration automatically. Preserve them for diagnosis and the successor task.
4. Migrations are forward-only and run against an empty production branch. If they fail, fix the branch/schema before retrying; do not delete evidence.
5. The Fly spend limit stays in place even if deployment fails.

## 9. Open questions and risks

### Open questions for Quinn’s design review

1. **Production database topology:** one Neon production project/branch with three schemas (the staging-proven shape), or separate production projects/branches per service? Recommendation: one production project with three schemas for the first cut because it mirrors staging and is materially cheaper; service ownership remains represented by schemas and credentials. The durable migration model can split later without changing app code.
2. **Connectivity restriction:** which Neon access-control mechanism is available on the production plan (IP allowlist, private networking, role/IP rules, or a combination)? The implementation must use the strongest mechanism the account supports and record its read-back, not infer isolation from branch naming.
3. **Production app naming:** approve `sindustries-platform-production` and `sindustries-health-probe-production`, or use a different naming convention.
4. **Production health-probe cadence:** the task names both cadence variables but does not prescribe exact values. Recommendation: Fly app targets every 120 seconds and database probes hourly, matching the existing comments’ direction while avoiding a continuously-awake Neon compute endpoint.
5. **Spend-limit ownership:** confirm whether Quinn can set the org-level Fly limit or whether Tom must perform that account/billing action.

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Accidentally copying staging URLs or credentials into production | Critical | explicit environment manifest; fail-closed host/placeholder checks; no fallback between environments; secret-value redaction; redacted evidence |
| Accidentally creating four production apps and reviving the retired topology | High | one consolidated app name; bootstrap refuses per-service app names; hostname matrix and CI checks assert one platform app |
| Two Fly health targets or one shared DB cause cross-environment impact | High | production database/project and Cloudflare records are separate; staging read-back is required before and after DNS work |
| Shared-fate outage in production | High | accepted explicitly; one canary deployment; all four child health states visible in supervisor status; app-wide rollback documented; no traffic cutover in this task |
| Worker double-consumption | Critical | production queue/Redis is distinct; the production worker exists only inside the consolidated app; no retired production worker app is created; startup and queue identity are read back |
| Fly spend limit absent or on the wrong scope | High | billing read-back is a hard AC5 gate before DNS/public probe activation; workflow ordering test makes it non-skippable |
| Health probe keeps Neon compute awake | Medium | hourly DB cadence and 120-second Fly-app cadence; document the cost/liveness trade-off |
| Missing production secret blocks boot after DNS exposure | High | complete secret inventory, fail-closed boot, canary deploy and smoke checks before DNS |
| Migration is run against the wrong database | Critical | environment-labelled DSNs, schema rewrite contract, branch/host read-back, and a production-branch `SELECT`/migration-table check before public exposure |

## 10. Related documents

- `brain/tasks/specs/open/production-environment-provisioning-2026-11-05.md` — approved product spec
- `brain/tasks/specs/in-progress/fly-staging-service-consolidation-2026-11-05.md` — staging topology precedent
- `brain/tasks/specs/done/production-runtime-configuration.md` — runtime configuration contract
- `brain/tasks/specs/in-progress/production-data-migration-restore.md` — successor data task
- `brain/tasks/specs/open/production-cloud-cutover-rollback.md` — successor traffic task
- `docs/specs/fly-staging-service-consolidation-tech-design.md` — approved shared-fate and supervisor design
- `docs/specs/cloud-readiness-production-runtime-configuration-tech-design.md` — runtime secret contract
- `docs/systems/cloud-platform.md` — durable platform topology and credential boundary
- `infra/cloud/hostname-matrix.json` — stable hostname/app mapping
- `infra/cloud/platform/platform-services.mjs` — child topology and secret mapping
