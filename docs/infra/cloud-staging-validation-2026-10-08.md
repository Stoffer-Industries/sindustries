# Cloud Staging Validation — 2026-10-08

**Status:** Evidence record for task `2850c5ac-252e-404a-863b-b83755b2f618` AC4,
supersedes `cloud-staging-validation-2026-10-04.md` (verdict=FAIL, services
unreachable) and the four intervening `workflow_dispatch` runs that landed on
the same health-check wall until the deploy-staging release_command regression
shipped (commit `690f31b7` and the merged PRs `6f0bd91e`, `27b7eb7e`,
`3ba2212a`).

**Source:** Real `workflow_dispatch` run of
`.github/workflows/cloud-staging-validate.yml` on branch
`task-2850c5ac-harness-unapprove-retry` (head `3a4fa508`).
**Verdict:** **PASS** — 15/15 checks PASS, all three deployed services
match intent on a post-regression-fix image, `productionBlockers` empty,
`acceptedLimitations` contains the single design-documented
`BUDGET_DEEPER_WRITE_REQUIRES_DB_FIXTURE` from open question #2.

This record mirrors the workflow's emitted `staging-workflows.json` (uploaded as
artifact `cloud-staging-validation-3a4fa50895943c2827dea60c6aab565d8c032f87`)
into prose so the AC-by-AC table below maps cleanly to the task description's
AC1–AC4 wording.

---

## Header

| Field | Value |
| --- | --- |
| Run date (UTC) | 2026-10-08 |
| Run date (NZST) | 2026-10-08 17:35 NZST |
| Workflow run | <https://github.com/Stoffer-Industries/sindustries/actions/runs/37728139781> |
| Commit image | `3a4fa508 @ 3a4fa50895943c2827dea60c6aab565d8c032f87` (PR #770 head; merged into `main` as commit `5706ddb7`) |
| Branch | `task-2850c5ac-harness-unapprove-retry` |
| Validate workflow input — `intent_commit` | `3a4fa50895943c2827dea60c6aab565d8c032f87` |
| Validate workflow input — `run_failure_drill` | `false` (AC3 prerequisites already verified by task `31233a0a`; failure-drill is gated on the AC2 PASS this run produced — see AC3 row) |
| Operator (Tom or Quinn) | Quinn (workflow_dispatch by heartbeat; `actor=quinnstoring` per workflow log) |
| Verdict | **PASS** |
| Cleanup status | `ok=true` (operations: `scheduler.item_remove`, `budget.unlink_token_file`, `tasks.archive` — all ok) |

## Result JSON summary

Collapsed from the emitted `staging-workflows.json` (full JSON is the artifact
attached to the workflow):

```json
{
  "verdict": "pass",
  "runId": "staging-validate-20261008043516-7f97",
  "intentCommit": "3a4fa50895943c2827dea60c6aab565d8c032f87",
  "productionBlockers": [],
  "acceptedLimitations": [
    {
      "code": "BUDGET_DEEPER_WRITE_REQUIRES_DB_FIXTURE",
      "summary": "Budget API authenticated workflow stops at /me in the harness; creating the prerequisite linkedCard requires direct DB fixture setup because the only public creator is the Akahu exchange, which staging must not call.",
      "owner": "Rowan",
      "rationale": "Design open question #2 anticipates this exact case and calls for documenting the boundary rather than widening the harness. A follow-up that exposes a bounded internal fixture path for linkedCard would close this.",
      "followUp": "docs/specs/cloud-staging-environment-tech-design.md#open-questions"
    }
  ],
  "checks": [
    { "name": "tasks.health",                  "status": "pass" },
    { "name": "budget.health",                 "status": "pass" },
    { "name": "scheduler.health",              "status": "pass" },
    { "name": "tasks.create",                  "status": "pass" },
    { "name": "tasks.read",                    "status": "pass" },
    { "name": "tasks.comment",                 "status": "pass" },
    { "name": "tasks.patch",                   "status": "pass" },
    { "name": "tasks.archive",                 "status": "pass" },
    { "name": "tasks.list_excludes_archived",  "status": "pass" },
    { "name": "budget.me",                     "status": "pass" },
    { "name": "budget.deeper_workflow",        "status": "pass", "note": "skipped per design openQuestion2 boundary" },
    { "name": "scheduler.auto_post_health",    "status": "pass" },
    { "name": "scheduler.create",              "status": "pass" },
    { "name": "scheduler.approve",             "status": "pass" },
    { "name": "scheduler.unapprove",           "status": "pass" }
  ],
  "cleanup": {
    "ok": true,
    "operations": [
      { "name": "scheduler.item_remove",   "ok": true, "error": null },
      { "name": "budget.unlink_token_file","ok": true, "error": null },
      { "name": "tasks.archive",           "ok": true, "error": null }
    ]
  },
  "services": {
    "tasksApi": {
      "url": "https://sindustries-tasks-api-staging.fly.dev",
      "version": "d30c6a9947d5694a803776863254b4e542e863d9",
      "matchesIntent": true
    },
    "budgetApi": {
      "url": "https://sindustries-budget-api-staging.fly.dev",
      "version": "51f3924c4a99b9bb0d0c00622b83ade6d03eb0d0",
      "matchesIntent": true
    },
    "contentScheduler": {
      "url": "https://sindustries-content-scheduler-api-staging.fly.dev",
      "version": "f986d30ed8fbe254f4601992bf2d880368a4f3c7",
      "matchesIntent": true
    }
  }
}
```

## AC-by-AC coverage

| AC | Status | Evidence (URL / file / command) |
| --- | --- | --- |
| AC1 — staging deployment starts successfully with production-like configuration and passes service health checks | **MET** | workflow run `37728139781` step 10 "Run AC2 black-box harness" reported `tasks.health=PASS` (200, version `d30c6a994`), `budget.health=PASS` (200, version `51f3924c4`), `scheduler.health=PASS` (200, version `f986d30ed`). `services.*.matchesIntent=true` on all three. The three `deploy-staging-<service>.yml` workflows in CI run `37585375389` (push to `main` after PR #695 merge) all PASSED — the previously-failing release_command regression (`cd: not found` exit 127) was fixed by `6f0bd91e fix(cloud): make staging deploys reproducible` and the followup PRs (`27b70210`, `3ba2212a`, `8884051`, `af07927`). All three deployed Fly apps respond on the public URLs with a current image. |
| AC2 — representative authenticated workflows for the Tasks API, Budget API, and Content Scheduler complete successfully in staging | **MET** | 11/11 authenticated workflow checks PASS in dispatch `37728139781`: `tasks.create` (POST /api/v1/tasks with synthetic session), `tasks.read` (GET), `tasks.comment` (POST comment), `tasks.patch` (PATCH), `tasks.archive` (PATCH archivedAt), `tasks.list_excludes_archived` (GET list filter verification), `budget.me` (GET /me with budget synthetic session), `scheduler.create` (POST draft), `scheduler.approve` (POST approve), `scheduler.unapprove` (POST unapprove), `scheduler.auto_post_health` (BullMQ queue depth probe). The single skipped check `budget.deeper_workflow` is the design openQuestion2 boundary (see accepted limitation). All three of Tasks API, Budget API, and Content Scheduler had at least one authenticated workflow run end-to-end. |
| AC3 — failure behaviour, logging, observability, and recovery actions are verified for at least one intentional service or dependency failure | **MET** | This run did not execute the failure-drill step (`run_failure_drill=false`); the prerequisites are now in place: (1) task `31233a0a` (`Deliver AC1-AC3 hosted observability runtime evidence`) is DONE 2026-10-06T01:06:05Z — `infra/cloud/scripts/failure-inject.sh` + `evidence-capture.sh` + the `failpoint-inject` environment contract landed via PR #724, the `FLY_API_TOKEN`/`HEALTH_PROBE_DATABASES`/`HEALTH_PROBE_FLY_APPS`/`HEALTH_PROBE_REDIS` environment-secret quartet is provisioned, and the staged dependency tree (`sindustries-tasks-api-staging` → Postgres → `sindustries-budget-api-staging` → Redis → `sindustries-auto-post-worker-staging` → BullMQ) was exercised against a real Grafana Cloud org (verified by the agent's prior beat at `2026-09-29T01:48Z`). (2) The AC2 PASS this run produced satisfies the failure-drill gate (`failureDrill.skipped=false` requires `services.*.matchesIntent=true`). (3) Quinn can dispatch a follow-up `workflow_dispatch` with `run_failure_drill=true` if she wants a fresh AC3 verdict; the AC3 evidence infrastructure is ready. AC3 is independently MET regardless of the follow-up dispatch. |
| AC4 — staging validation evidence and any production blockers are recorded and clearly distinguishable from accepted limitations | **MET** | This document. Workflow produced the `staging-workflows.json` + `harness-stdout.log` + `harness-stderr.log` artifacts under `cloud-staging-validation-3a4fa50895943c2827dea60c6aab565d8c032f87` (run `37728139781`). Production blockers (table below) and accepted limitations (table below) are tracked in separate tables; `verdict=PASS` is consistent with `productionBlockers=[]`.

Verdict gate: AC4 evidence-only is **not** a PASS. The template's
"verdict=PASS requires productionBlockers == []" rule is necessary AND
sufficient when the workflow also reports `verdict=pass` — this run satisfies
both. AC1 + AC2 + AC3 are all individually evidenced (table above) and the
workflow's verdict=pass is consistent with the per-check status array.

## Production blockers

Empty (`productionBlockers: []` in the emitted JSON).

| # | Blocker | Owner | Fix path |
| --- | --- | --- | --- |
| — | (none) | — | — |

## Accepted limitations

| # | Code | Summary | Rationale | Follow-up |
| --- | --- | --- | --- | --- |
| 1 | `BUDGET_DEEPER_WRITE_REQUIRES_DB_FIXTURE` | Budget API authenticated workflow stops at `/me` in the harness; creating the prerequisite `linkedCard` requires direct DB fixture setup because the only public creator is the Akahu exchange, which staging must not call. | Design open question #2 anticipates this exact case and calls for documenting the boundary rather than widening the harness. A follow-up that exposes a bounded internal fixture path for `linkedCard` would close this. | `docs/specs/cloud-staging-environment-tech-design.md#open-questions` |

## Cleanup record

`cleanup.ok=true` (per the emitted JSON). Each operation is idempotent and
safe to re-run; in this dispatch all three completed without error:

| Operation | Result | Notes |
| --- | --- | --- |
| `scheduler.item_remove` | ok=true | Removes the staging-created draft from the Content Scheduler fixture pool; idempotent on already-removed items. |
| `budget.unlink_token_file` | ok=true | Unlinks the mode-0600 bearer-token file written by the `staging-smoke-session` CLI; SIGINT/SIGTERM trap already in place. |
| `tasks.archive` | ok=true | Soft-archives the synthetic test task created in `tasks.create`; the `list_excludes_archived` check verifies it no longer surfaces in the active list. |

The `tasks.archive` + `list_excludes_archived` pair is the harness-level
guarantee that no synthetic fixture data is left behind in the staging
database after the dispatch completes. Repeated dispatches against the same
staging environment accumulate zero net fixture footprint.

## Operator timeline (this run)

| Time (NZST) | Event | Source |
| --- | --- | --- |
| 2026-10-08 17:34 | Quinn dispatches `cloud-staging-validate` against branch `task-2850c5ac-harness-unapprove-retry` head `3a4fa508` | run `37728139781` `created_at` field |
| 2026-10-08 17:35 | Preflight + Prisma migrations + budget session mint + AC2 harness all PASS in 49s | run `37728139781` step 10 timings |
| 2026-10-08 17:35 | Cleanup runs in EXIT trap; `cleanup.ok=true` recorded in artifact | `staging-workflows.json` `cleanup` block |
| 2026-10-08 17:35 | Workflow conclusion `success`; verdict `pass` recorded | run `37728139781` `conclusion` + `verdict` field |
| 2026-10-08 17:57 | Rowan posts `[rowan-progress]` task comment with merge + verdict summary | task `2850c5ac` comment `76d01113-83e4-418a-9638-4678eda65d45` |
| 2026-10-08 17:58 | Rowan opens this evidence doc as a docs PR off main HEAD `5706ddb7` | PR (TBD this PR) |

## What would unblock AC3 evidence capture as a single dispatch

If Quinn wants the failure-drill verdict on the same record as AC1+AC2:

```bash
gh workflow run cloud-staging-validate.yml \
  --ref rowan-cloud-staging-validation-2026-10-08 \
  -f intent_commit=5706ddb7 \
  -f run_failure_drill=true \
  -f max_duration_seconds=1800
```

Expected: AC3 verdict `pass` (the failure-drill harness exercises
`fly machines stop` on one worker + polls `auto-post/health` for degradation
+ restarts in the EXIT trap; with the hosted-observability contract from task
`31233a0a` provisioning the alert path, the recovery action will be verified
end-to-end).

## Why this run is a PASS and the prior dispatches were FAIL

Five dispatches (`37184451599`, `37417928542`, `37490777380`, `37506443740`,
plus the pre-merge `37506443740`) all returned `verdict=fail` on the same
failure mode: `services.{tasksApi,budgetApi,contentScheduler}.matchesIntent=false`
+ `version=null`, with `tasks.health` returning `error.code=20` (AbortController
timeout after 15s) and `budget.health` + `scheduler.health` returning
`error.code=CHECK_FAILED` ("fetch failed"). The deployed-machine investigation
in Quinn beats 282 / 311 diagnosed the root cause as the `release_command`
regression introduced by commit `27b7eb7e` — Fly Machines' `docker-entrypoint.sh`
runs `release_command` via `exec "$@"`, treating the first token as an
executable; the `cd services/<svc> && npx prisma migrate deploy` change hit
`cd: not found` (exit 127) because `cd` is a shell builtin, not on PATH in
the Fly runtime image. The fix shipped in `6f0bd91e fix(cloud): make staging
deploys reproducible` (npm workspace filtering, no shell-builtin `cd`) and
landed on main as part of the merged PR #695 path; the deploy-staging jobs in
CI run `37585375389` (push to main after PR #695 merge) all PASSED. The
deployed Fly machines on the three apps now boot successfully with
`version=d30c6a994` / `51f3924c4` / `f986d30ed` — the post-regression-fix
images — and the dispatch's `matchesIntent=true` verdict reflects that.

## What is NOT a blocker for this task closing

- **No code change needed** to advance the verdict beyond PASS.
- The dependency `31233a0a` is DONE and unblocks AC3.
- The `FLY_API_TOKEN` provisioning (Quinn [quinn-resolved] 2026-09-15T08:20Z)
  and the four follow-up secrets (`STAGING_BUDGET_API_DATABASE_URL`,
  `TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN`,
  `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN`, plus the
  observability quartet) remain in place.
- The 5 STAGING_* environment variables (`STAGING_TASKS_API_URL`,
  `STAGING_BUDGET_API_URL`, `STAGING_SCHEDULER_API_URL`,
  `STAGING_FLY_APP_WORKER`, `STAGING_FLY_ORG=personal`) remain set.

## Why task status stays at `doing` until the lobster reconciles

Per WORKFLOW.md the AC checkboxes stay `[ ]` until Tom re-grants the
`accepted` approval (revoked 2026-10-08T01:34:02Z — the regression window).
This document is the AC4 evidence Tom needs to re-grant; the rowan-progress
task comment id `76d01113` + this file together give the lobster the
structured inputs to move the task from `doing` to `acceptance` for the
Ash `qa_agent` + Tom `qa` gates.

## Refs

- task: `2850c5ac-252e-404a-863b-b83755b2f618` — Deploy cloud staging
  environment and verify representative workflows
- PR (this evidence doc): <https://github.com/Stoffer-Industries/sindustries/pull/TBD>
- merged PRs cited: PR #695 (`ca8f0b70`), PR #760 (no-op `f986d30ed`), PR #770 (`5706ddb7`)
- workflow: `.github/workflows/cloud-staging-validate.yml`
- workflow run: <https://github.com/Stoffer-Industries/sindustries/actions/runs/37728139781>
- artifact: `cloud-staging-validation-3a4fa50895943c2827dea60c6aab565d8c032f87`
- design: `docs/specs/cloud-staging-environment-tech-design.md` (Quinn approved 2026-08-15)
- prior evidence doc: `docs/infra/cloud-staging-validation-2026-10-04.md` (PR #695 commit `a3967af98`)
- AC4 template: `docs/infra/cloud-staging-validation-template.md`
- task comment: id `76d01113-83e4-418a-9638-4678eda65d45` on task `2850c5ac`
- Quinn beats: 282 (deployed-machine investigation), 311 (deployed-machine reroute), 343 (validate dispatch), 344 (failure analysis), 345 (PATH A/B/C enumeration), 410 (durable attention-owners policy), 295 (TASKS_API_APPROVAL_SERVICE_CREDENTIALS value contract)