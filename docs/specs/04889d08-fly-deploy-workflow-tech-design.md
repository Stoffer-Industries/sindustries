---
status: draft
task_id: 04889d08-aca5-47d6-a9bc-db17a114ebfc
product_spec: brain/tasks/specs/in-progress/sindustries-cloud-migration.md (referenced from audit; the immediate product framing lives in docs/repo-audits/2026-W37.md finding T2.1)
shipped_pr: null
shipped_date: null
---

# Fly deploy workflow parity for mission-control + tasks-app (task 04889d08)

## Product intent

Close the audit gap recorded in `docs/repo-audits/2026-W37.md` finding T2.1
([Medium] *New Fly HTTP apps have no CI deploy workflow*). Two Fly staging apps
— `sindustries-mission-control-staging` and `sindustries-tasks-app-staging` —
currently ship with `fly.toml` + Dockerfile + a manual deploy procedure
documented inline in `docs/systems/mission-control.md`, while the three sibling
services (`auto-post-worker`, `budget-api`, `tasks-api`) auto-deploy via
`.github/workflows/deploy-staging-*.yml`. The inconsistency invites drift
(merged mission-control / tasks-app changes don't reach staging without a
human `fly deploy`).

The audit accepts either path to close the gap:

- **(a)** add `deploy-staging-mission-control.yml` and `deploy-staging-tasks-app.yml` mirroring `deploy-staging-tasks-api.yml`, **or**
- **(b)** record an explicit "manual-only deploy" note in `docs/systems/mission-control.md` naming the two apps and the rationale for first-rollout manual deployment.

The task description flags **Open Question 1** in the audit as a precondition:
Quinn must decide which path to take before implementation begins.

## Task ID, branch, worktree, repo

- Task: `04889d08-aca5-47d6-a9bc-db17a114ebfc` (short: `04889d08`)
- Branch: `feat/04889d08-fly-deploy-tech-design` (this design is committed here; the implementation branch will be cut from `origin/main` once Quinn picks a path and approves the design)
- Worktree: `codebases/sindustries/workspace/worktrees/feat-04889d08`
- Repo: `Stoffer-Industries/sindustries`

## Service boundary / data ownership

This is an infrastructure change, not a feature change. No service boundary
moves; no data ownership changes. The decision space is purely about how
changes to `apps/mission-control/` and `apps/tasks-app/` reach the staging Fly
surface — CI-driven (a) or human-driven (b).

`.openclaw` boundary notes: none. The work is contained in this repo. The
`FLY_API_TOKEN` secret registration that path (a) requires is owned by Quinn
(per PR #508 precedent for the sibling workflows); Rowan references it by
name only.

## Decision Required (Open Question 1)

The audit's **Open Question 1** — *should mission-control + tasks-app auto-deploy
via `deploy-staging-*.yml` like the sibling services, or is manual-via-runbook
deliberate for the first rollout?* — is the single precondition that gates
this task. The implementation plan below covers both branches; Quinn's
approval of this design implicitly confirms the recommended branch
unless she redirects in the approval thread.

### Recommendation — branch (b): explicit "manual-only" note

**Recommendation:** document the manual-only deploy decision in
`docs/systems/mission-control.md` (branch b). Reasoning:

1. **First-rollout stability.** Mission Control is a new iframe-embed shell
   (see ADR in `docs/systems/mission-control.md`); tasks-app's staging
   surface is the first time this nginx-served SPA pattern runs on Fly.
   Both apps need a small number of manual deploys during the first
   rollout so the human driving them can react to Fly-machine quirks
   (region-allocation surprises, cold-start timing, build-context
   surprises) without a CI log to triage.
2. **The deploy procedure is already documented.** PR #583 retired the
   standalone `infra/runbooks/mission-control-staging.md` file and folded
   the operational procedure (deploy steps, DNS handover, smoke checks,
   health-check contract, revert procedure) inline into
   `docs/systems/mission-control.md`. Branch (b) is essentially a one- or
   two-sentence note that records the deliberate decision and points
   readers at the inline procedure; it does not require new
   documentation authoring.
3. **Reversibility.** Both branches are reversible. Branch (a) (add CI
   workflows) and branch (b) (delete the "manual-only" note + add CI
   workflows) have the same downstream cost; the difference is only the
   timing of that work. The audit explicitly accepts the manual-only
   path as the lighter-weight option for first rollout (S effort vs S–M).
4. **No new secrets, no new infra surface.** Branch (a) requires `FLY_API_TOKEN`
   to be present in the repo secrets for two additional workflows
   (already present, so this is a non-issue) **and** it requires
   Quinn to manually run the first deploy to seed the Fly machine state
   regardless, because the workflows use canary-deploy which assumes a
   healthy baseline. The first rollout will be manual even with branch
   (a) in place, so the "auto-deploy" benefit is deferred to rollout+1.
5. **Tasks-app drift signal.** The W37 audit noted tasks-app's
   `tasks-app.fly.toml` is the same shape as mission-control's; both are
   first-rollout. Pairing them under a single deliberate-manual policy
   avoids accidentally half-automating one and not the other.

If Quinn prefers branch (a) (auto-deploy parity with siblings), the
plan in §Branch A below is the concrete shape; the AC-by-AC matrix in
§Verification matrix covers both branches.

## Implementation plan

### Branch B — manual-only documentation (recommended)

**Files touched (this branch):**

- `docs/systems/mission-control.md` — append a new short subsection
  ("## Staging deploy posture (manual-only, first rollout)") that:
  - Names the two affected Fly apps (`sindustries-mission-control-staging`,
    `sindustries-tasks-app-staging`).
  - States deploy is manual-via-runbook for first rollout and links to
    the inline deploy procedure earlier in the doc (line 193 + the
    `Operational artefacts` block).
  - Names the trigger to revisit this decision (production cutover
    task `020f423e`, or after the first 5 successful manual deploys
    per app — whichever lands first).
  - Cross-references this tech design and the audit finding.
- `docs/repo-audits/2026-W37.md` — close out the T2.1 finding by
  adding a line under the existing `➡️ tracked-code-task` marker that
  records the chosen path (per AC4). The current text is
  "`➡️ tracked-code-task` (T2.1) — though it may be intentional for the
  first rollout; see Open Questions." Add: "Closed via task 04889d08
  branch (b) on YYYY-MM-DD."

**No code changes. No Dockerfile changes. No fly.toml changes. No
`.github/workflows/` changes.**

The PR is docs-only. Follow the standard docs PR flow
(title prefix `docs(audit):` is for audit-ledger updates; for this
systems-doc edit, use `docs(systems): record manual-only deploy
posture for mission-control + tasks-app`). After merge, task
`04889d08` advances to `doing` → implementation (one commit landing
the doc edit + the audit update) → `acceptance`.

### Branch A — add CI deploy workflows (alternate)

If Quinn prefers auto-deploy parity:

**Files added (this branch):**

- `.github/workflows/deploy-staging-mission-control.yml` — mirror
  `deploy-staging-tasks-api.yml` with these substitutions:
  - `FLY_APP = sindustries-mission-control-staging`
  - `FLY_CONFIG = infra/cloud/fly/mission-control.fly.toml`
  - Path filter:
    - `apps/mission-control/**`
    - `infra/cloud/docker/mission-control.Dockerfile`
    - `infra/cloud/docker/spa-nginx.conf` (shared by both apps)
    - `infra/cloud/fly/mission-control.fly.toml`
    - `infra/cloud/env/mission-control.env.example`
    - `infra/cloud/**` (general infra changes)
    - `package.json`, `pnpm-lock.yaml` (workspace changes)
    - `.github/workflows/deploy-staging-mission-control.yml`
  - Header comment: cite PR #508 (Quinn-approved tasks-api template)
    and PR #583 (manual runbook retirement) as the design lineage.
  - Smoke check: `https://sindustries-mission-control-staging.fly.dev/healthz`
    — mission-control mounts the nginx-served SPA which serves
    `spa-nginx.conf`'s `/healthz` endpoint (not `/health` like the
    tasks-api Node service). Confirm against
    `infra/cloud/docker/spa-nginx.conf` before merging; if `/healthz`
    isn't exposed there, add it as a separate code change.
- `.github/workflows/deploy-staging-tasks-app.yml` — same shape,
  with:
  - `FLY_APP = sindustries-tasks-app-staging`
  - `FLY_CONFIG = infra/cloud/fly/tasks-app.fly.toml`
  - Path filter:
    - `apps/tasks-app/**`
    - `infra/cloud/docker/tasks-app.Dockerfile`
    - `infra/cloud/docker/spa-nginx.conf`
    - `infra/cloud/fly/tasks-app.fly.toml`
    - `infra/cloud/env/tasks-app.env.example`
    - `infra/cloud/**`
    - `package.json`, `pnpm-lock.yaml`
    - `.github/workflows/deploy-staging-tasks-app.yml`
  - Smoke check: `https://sindustries-tasks-app-staging.fly.dev/healthz`
    (same SPA nginx).

**Files touched:**

- `docs/repo-audits/2026-W37.md` — close out T2.1 with
  "Closed via task 04889d08 branch (a) on YYYY-MM-DD, see PR #N."

**Pre-merge checks for branch A:**

- Confirm `FLY_API_TOKEN` is registered as a repo secret (Quinn-owned;
  Rowan references by name only).
- Confirm the canary baseline exists for both Fly apps (a successful
  manual `fly deploy` must have landed first; the workflows use
  `--strategy canary` which assumes a healthy baseline). The first
  deploy per app is therefore manual even on branch (a).
- Confirm `/healthz` is exposed by `infra/cloud/docker/spa-nginx.conf`.
  If not, this requires a separate small nginx config change (not in
  scope of this task; flag in the PR description and follow up).

## Data model / API contract changes

None. Neither branch changes data shape, API routes, or request/response
contracts. Both branches are infrastructure-shape changes only.

## Workflow / cron / skill changes

None. No OpenClaw workflows, automations, or skills change. The
`FLY_API_TOKEN` secret registration that branch (a) uses is a Quinn-owned
repo secret (per PR #508 precedent); Rowan references it by name only.

## Test plan / AC verification matrix

| AC | Branch A — CI workflows | Branch B — docs note (recommended) | E2E / smoke layer |
|----|-------------------------|------------------------------------|--------------------|
| **AC1** *(paths added or manual-only decision documented)* | `.github/workflows/deploy-staging-mission-control.yml` + `.github/workflows/deploy-staging-tasks-app.yml` exist, mirror `deploy-staging-tasks-api.yml` shape (Fly auth via repo secret, `workflow_dispatch` + push-to-main triggers, `sindustries-mission-control-staging` / `sindustries-tasks-app-staging` apps). | `docs/systems/mission-control.md` carries an explicit "manual-only deploy" note naming the two apps and the first-rollout rationale; the inline deploy procedure is already documented at line 193. | File-level (PR diff). |
| **AC2** *(end-to-end exercise of the chosen path)* | After merge, push to main exercises the canary deploy; capture `fly releases` output and `curl https://sindustries-mission-control-staging.fly.dev/healthz` (and the equivalent tasks-app URL) showing the new bundle hash; attach to a follow-up task comment. | After merge, run one manual `fly deploy` per app following the inline procedure; capture `fly releases` output and the staging URL response; attach to a task comment. | Manual / smoke (`fly releases` + `curl /healthz`). |
| **AC3** *(CI green for existing test jobs)* | `.github/workflows/ci.yml` continues to pass `mission-control tests` and `tasks app tests` after the change. (No test job matrix changes; the new workflows are deploy-only and run on `push` to main / `workflow_dispatch`, not on PR.) | `.github/workflows/ci.yml` continues to pass `mission-control tests` and `tasks app tests` — verified by the docs PR's required CI run. | Automated CI (`mission-control tests`, `tasks app tests`). |
| **AC4** *(audit T2.1 finding closed)* | `docs/repo-audits/2026-W37.md` T2.1 line is updated to "Closed via task 04889d08 branch (a) on YYYY-MM-DD, see PR #N." | `docs/repo-audits/2026-W37.md` T2.1 line is updated to "Closed via task 04889d08 branch (b) on YYYY-MM-DD." | File-level (PR diff). |

**E2E coverage rationale:** AC2 is inherently a manual smoke check
(either `gh actions run` + `curl` for branch A, or `fly deploy` + `curl`
for branch B); the test matrix records this explicitly. AC3 is
satisfied by the existing CI test jobs — no new test code is added by
either branch.

## Open questions and risks

- **Open Question 1 — branch selection.** This design's recommendation
  is branch (b). Quinn's approval of this design confirms the choice
  unless she redirects.
- **Open Question 1 (audit) is still technically open at design-write
  time.** If Quinn has not yet recorded a decision on Open Question 1
  in the audit, this tech design is the formal record of that decision
  (per the recommendation in §Decision Required).
- **Branch A nginx healthcheck.** If branch (a) is chosen, confirm
  `/healthz` is exposed in `infra/cloud/docker/spa-nginx.conf` *before*
  landing the workflows; if it's not, the smoke check step in the
  workflow fails on first run. The nginx config check is a one-line
  follow-up if missing.
- **Reversibility.** Both branches are reversible with low cost.
  Re-opening branch (b) later is a separate task (add the workflows +
  remove the "manual-only" note); re-opening branch (a) later is just
  deleting the two workflows.
- **Out of scope.** Production deploy for either app (task `020f423e`)
  is a separate workstream and inherits the same posture — staging
  shape here, production shape deferred to that task.

## Related

- `docs/repo-audits/2026-W37.md` — finding T2.1 + Open Question 1.
- `docs/systems/mission-control.md` — ADR + inline deploy procedure
  (line 193 anchor for branch B's note).
- `.github/workflows/deploy-staging-tasks-api.yml` — Quinn-approved
  template for branch A.
- `.github/workflows/deploy-staging-budget-api.yml`,
  `.github/workflows/deploy-staging-auto-post-worker.yml` — sibling
  mirrors confirming the template shape.
- `infra/cloud/fly/mission-control.fly.toml`,
  `infra/cloud/fly/tasks-app.fly.toml` — deploy targets.
- `infra/cloud/docker/spa-nginx.conf` — shared nginx config for the
  SPA healthcheck (branch A pre-check).
- Task `04889d08` — `Add deploy workflows (or document manual-deploy
  decision) for mission-control + tasks-app Fly staging apps`.
- Task `020f423e` — `Execute production cloud cutover with rollback
  verification` (downstream of this task).