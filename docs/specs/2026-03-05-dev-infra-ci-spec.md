# Dev Infra + CI Spec (Tasks App / Sindustries)

## Status
Draft for Tom sign-off

## Owner
Quinn (orchestration) / Rowan (implementation)

## Source Context
- Stack familiarity: Docker, Colima, Kubernetes, Tilt.
- Current pain: high local boilerplate to run multiple services + Postgres.
- Near-term CI goal: run current tests on GitHub runners without spinning full infra.
- Long-term goal: cloud-deployable, container-first path.
- This is considered M5 of `task-one-pager.md`

---

## 1) Problem Statement
Running and validating the repo locally currently requires too much manual setup and service orchestration overhead. This slows feature work and makes verification fragile.

At the same time, CI should provide immediate stability checks using the tests that already pass today, without prematurely introducing full integration infra complexity.

We need a practical dev-infra baseline that is easy now, scales with repo growth, and preserves a clean path to cloud deployment later.

---

## 2) Goals
1. Reduce local startup/verification boilerplate to a small, repeatable command set.
2. Keep fast inner-loop dev experience (hot reload + easy logs).
3. Establish CI checks for current test suites on GitHub runners.
4. Keep architecture cloud-ready via container discipline, without overbuilding deployment today.
5. Keep one shared Postgres instance for repo dev by default, with clear service boundaries.

---

## 3) Non-Goals (for this phase)
- Production deployment automation.
- Blue/green or canary rollout strategies.
- Full local Kubernetes parity for every dev workflow.
- Multi-region database or advanced infra hardening.

---

## 4) Proposed Architecture (Phase 1)
### 4.1 Local dev runtime model (hybrid)
- Postgres runs in Docker (via Colima).
- App/API processes run on host for fast rebuild/reload.
- Tilt acts as orchestration UX (status, logs, file watch triggers, startup ordering).

### 4.2 Data model boundary
- Single Postgres server for whole repo (dev default).
- Each service owns its schema/migration boundary.
- Explicit rule: no cross-service table ownership.

### 4.3 Why this model
- Minimizes local friction while preserving container-first infra path.
- Avoids Docker file-watch performance pitfalls for JS inner loop.
- Keeps room to shift services into containers/k8s incrementally.

---

## 5) CI Strategy (Phase 1)
### 5.1 Required PR checks
Run current tests directly on GitHub runners:
- `services/tasks-api`: unit/integration tests currently in repo.
- `apps/tasks`: component tests.
- `apps/tasks`: Playwright happy-path test (current mocked/network-stub style).

### 5.2 CI principles
- Fast feedback first.
- Avoid full infra spin-up for current suite.
- Add DB-backed integration lane later once those tests exist.

---

## 6) Implementation Scope for Rowan
### 6.1 Infra/dev files to add
- `infra/docker-compose.dev.yml`
  - Postgres service + persistent volume + healthcheck.
- `infra/tilt/Tiltfile`
  - Docker compose resource for Postgres.
  - local_resource for `services/tasks-api` dev process.
  - local_resource for `apps/tasks` dev process.
  - startup dependency ordering (db -> api -> app).
- `scripts/dev/up.sh`
  - start colima if needed, then `tilt up`.
- `scripts/dev/down.sh`
  - `tilt down` (+ optional compose cleanup).
- `scripts/dev/reset-db.sh`
  - drop/recreate service schemas + rerun migrations/seeds.

### 6.2 CI files to add/update
- `.github/workflows/ci.yml`
  - jobs for tasks-api tests, tasks app tests, tasks app e2e.
  - install playwright browser in CI.
  - cache dependencies where practical.

### 6.3 Repo docs to update (required)
- `README.md` **must be updated** as part of this task to reflect:
  - hybrid local dev model,
  - single Postgres + schema boundaries,
  - Tilt orchestration role,
  - CI scope and phased evolution.

### 6.4 Make
- `Makefile` aliases that call `scripts/dev/*.sh` only.
- If added, no duplicated logic; scripts remain source of truth.

---

## 7) Acceptance Criteria
1. A new developer can run dev stack with one command path and see app+api+db healthy.
2. Dev loop supports code change iteration without manual multi-terminal orchestration.
3. CI runs current tests on GitHub runners and reports clearly on PRs.
4. `README.md` is updated and accurate to implemented model.
5. Postgres shared-instance policy + schema ownership constraints are documented.
6. No production deployment complexity is introduced in this phase.

---

## 8) Risks / Tradeoffs
- Hybrid local model is not full prod parity; accepted for speed.
- Tilt introduces a small learning curve; offset by lower daily cognitive load.
- Single Postgres instance can lead to coupling if schema ownership discipline is weak.

Mitigation:
- Document ownership rules in architecture + service docs.
- Add lint/checklist item for migration/schema boundaries in PR template later.

---

## 9) Phasing
### Phase A (now)
- Implement local infra orchestration + CI for current tests.
- Update architecture docs.

### Phase B (later)
- Add container image build/publish.
- Add optional DB-backed CI integration lane.
- Add baseline k8s manifests/helm skeleton for cloud path.

---

## 10) Tasking Note for Rowan
When assigning this work, Quinn must include this spec path explicitly as source of truth:
- `docs/specs/2026-03-05-dev-infra-ci-spec.md`
