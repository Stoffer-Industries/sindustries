# Cloud Staging Validation — 2026-10-04

**Status:** Evidence record for task `2850c5ac-252e-404a-863b-b83755b2f618` AC4.
**Source:** Real `workflow_dispatch` run of `.github/workflows/cloud-staging-validate.yml`
on branch `task-2850c5ac-252e-404a-863b-b83755b2f618-cloud-staging-environment`
(head `7d7485825bc2a7ee4f669dd9b5ea69abac11b60d`).
**Verdict:** `FAIL` — health checks for all three deployed services timed out /
fetch-failed; AC2 harness aborted at the first probe. AC3 was skipped because
AC2 returned a non-success verdict. **No `PASS_WITH_LIMITATIONS`** — the gate
distinguishes a real pass from a services-unreachable failure, and this run is
the latter.

This record mirrors the workflow's emitted `staging-workflows.json` (uploaded as
artifact `cloud-staging-validation-7d7485825bc2a7ee4f669dd9b5ea69abac11b60d`)
into prose so the AC-by-AC table below maps cleanly to the task description's
AC1–AC4 wording.

---

## Header

| Field | Value |
| --- | --- |
| Run date (UTC) | 2026-10-04 |
| Run date (NZST) | 2026-10-04 19:57 NZST |
| Workflow run | <https://github.com/Stoffer-Industries/sindustries/actions/runs/37184451599> |
| Commit image | `7d748582 @ 7d7485825bc2a7ee4f669dd9b5ea69abac11b60d` (Fly image tag) |
| Branch | `task-2850c5ac-252e-404a-863b-b83755b2f618-cloud-staging-environment` |
| Validate workflow input — staging URL override | empty (default `*.fly.dev`) |
| Operator (Tom or Quinn) | Rowan (workflow_dispatch by heartbeat) |
| Verdict | **FAIL** |
| Cleanup status | `ok=true` (operations=[]) |

## Result JSON summary

Collapsed from the emitted `staging-workflows.json` (full JSON is the artifact
attached to the workflow):

```json
{
  "runId": "staging-validate-20261004070043-795a",
  "intentCommit": "7d7485825bc2a7ee4f669dd9b5ea69abac11b60d",
  "verdict": "fail",
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
  "checks": {
    "health.tasksApi":       { "ok": false, "statusCode": null, "elapsedMs": 15003, "error": { "code": "20",        "message": "This operation was aborted" } },
    "health.budgetApi":      { "ok": false, "statusCode": null, "elapsedMs":  5226, "error": { "code": "CHECK_FAILED", "message": "fetch failed" } },
    "health.contentScheduler":{ "ok": false, "statusCode": null, "elapsedMs":    12, "error": { "code": "CHECK_FAILED", "message": "fetch failed" } },
    "failureDrill":          { "ok": false, "skipped": true, "reason": "AC2 returned non-success; failure drill requires health.pass probe" },
    "schemaValidate":        { "ok": true, "errors": [] }
  },
  "cleanup": { "ok": true, "operations": [] },
  "services": {
    "tasksApi":        { "url": "https://sindustries-tasks-api-staging.fly.dev",        "version": null, "matchesIntent": false },
    "budgetApi":       { "url": "https://sindustries-budget-api-staging.fly.dev",       "version": null, "matchesIntent": false },
    "contentScheduler":{ "url": "https://sindustries-content-scheduler-api-staging.fly.dev", "version": null, "matchesIntent": false }
  }
}
```

## AC-by-AC coverage

| AC | Status | Evidence (URL / file / command) |
| --- | --- | --- |
| AC1 — staging deployment starts + service health checks pass | **NOT MET** | workflow run `37184451599` step 10 "Run AC2 black-box harness" failed at the first probe (`tasks.health` returned `error.code=20` AbortController timeout against `https://sindustries-tasks-api-staging.fly.dev` after 15.003s; `budget.health` and `scheduler.health` returned `fetch failed`). Preflight (steps 6–9) all passed: required env vars present (`STAGING_TASKS_API_URL` / `STAGING_BUDGET_API_URL` / `STAGING_SCHEDULER_API_URL` / `STAGING_FLY_APP_WORKER`), `FLY_API_TOKEN` provisioned, `budget-api Prisma migrations` ran (step 8 ✓), `Mint budget-api synthetic session` succeeded (step 9 ✓). Service versions returned `null` and `matchesIntent=false` for all three services — the deployed machines either never came up on the intent-commit image or are not responding on the public URLs. Operational: Quinn owns the deployed-machine health. |
| AC2 — authenticated workflows for Tasks API, Budget API, Content Scheduler complete successfully | **NOT MET** | AC2 harness aborted at the first `/health` probe (above), so no authenticated workflow ran. `cleanup.operations=[]` confirms the harness never persisted anything to clean up. |
| AC3 — failure behaviour / logging / observability / recovery verified for an intentional service failure | **NOT MET — observability-gated** | AC3 step was `SKIPPED` because AC2 returned non-success (`failureDrill.skipped=true`). Independently, the hosted-observability contract (task `31233a0a` / PR #724) has not landed against a live Grafana Cloud org yet, so even an AC3 run today could not honestly verify alert firing/resolution. Quinn's 2026-09-24T08:52Z review explicitly anticipates this: "AC3 evidence remains gated on the hosted-observability contract from task 31233a0a; the failure drill cannot be honestly verified without it." |
| AC4 — staging validation evidence recorded and clearly distinguishable from accepted limitations | **MET** | This document. Workflow produced the `staging-workflows.json` + `harness-stdout.log` + `harness-stderr.log` artifacts under `cloud-staging-validation-7d7485825bc2a7ee4f669dd9b5ea69abac11b60d`. Production blockers and accepted limitations are tracked in separate tables below. |

Verdict gate: AC4 evidence-only is **not** a PASS. The template's
"verdict=PASS requires productionBlockers == []" rule is necessary but not
sufficient — this run still produces verdict=FAIL because the AC1/AC2 health
probes failed.

## Production blockers

Empty (`productionBlockers: []` in the emitted JSON). The failures in this run
are classified as **deployed-service unreachable / service-not-responding**, not
as a code or configuration defect that would block production cutover once the
deployed machines are healthy. The fix path is operational (Quinn-owned:
restart / re-bootstrap the deployed Fly machines on the intent-commit image),
not a code change.

| # | Blocker | Owner | Fix path |
| --- | --- | --- | --- |
| — | (none) | — | — |

## Accepted limitations

| # | Code | Summary | Rationale | Follow-up |
| --- | --- | --- | --- | --- |
| 1 | `BUDGET_DEEPER_WRITE_REQUIRES_DB_FIXTURE` | Budget API authenticated workflow stops at `/me` in the harness; creating the prerequisite `linkedCard` requires direct DB fixture setup because the only public creator is the Akahu exchange, which staging must not call. | Design open question #2 anticipates this exact case and calls for documenting the boundary rather than widening the harness. A follow-up that exposes a bounded internal fixture path for `linkedCard` would close this. | `docs/specs/cloud-staging-environment-tech-design.md#open-questions` |

## Cleanup record

```json
{ "cleanup": { "ok": true, "operations": [] } }
```

The synthetic budget session minted at step 9 was revoked by step 11
("Cleanup synthetic budget session" — conclusion=success). No leftover Fly
machine state, no leftover service tokens, no leftover budget users. Harness
crash file `artifacts/harness-crash.json` was not produced (the harness
returned a structured verdict rather than crashing).

## Material change since prior status-updates

- **2026-09-17T23:03Z**: the 5 `STAGING_TASKS_API_URL` /
  `STAGING_BUDGET_API_URL` / `STAGING_SCHEDULER_API_URL` / `STAGING_FLY_APP_WORKER`
  / `STAGING_FLY_ORG` env vars landed on the staging GitHub Environment
  (Tom; previously identified as the gating set at Quinn 2026-09-15T13:48Z).
- **2026-10-04T06:57 NZST (this pass)**: re-verification of the staging GitHub
  Environment shows the 3 service-secret blockers I flagged at
  `2026-09-18T01:01Z` are now also provisioned:
  `STAGING_BUDGET_API_DATABASE_URL`,
  `TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN`,
  `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN`. Plus the
  observability-bootstrap secret quartet (`FLY_API_TOKEN` was already on the
  Environment since 2026-09-15T08:20Z; `HEALTH_PROBE_DATABASES`,
  `HEALTH_PROBE_FLY_APPS`, `HEALTH_PROBE_REDIS` are now also present, which is
  the prerequisite for the failure-inject.sh / evidence-capture.sh runbook on
  task `31233a0a`'s PR #724). Total: 4 environment variables, 6 environment
  secrets.
- **2026-10-04T19:00 NZST (this pass)**: triggered the first `cloud-staging`
  workflow_dispatch run with all env vars + all 3 service secrets present.
  Result: preflight clean; Prisma migrations + budget session mint succeed;
  AC2 harness fails because the three deployed services are unreachable
  (`tasks.health` AbortController timeout, `budget.health` and `scheduler.health`
  `fetch failed`). AC3 failure-drill skipped per its dependency on a healthy
  AC2 probe.

## What would unblock AC1/AC2

The deployed Fly machines need to respond on the public URLs with a current
image that matches the intent commit. The current deployed image does not
match (`services.*.matchesIntent=false`); the deployed machines are either
running an earlier image or are not running at all. Operational unblock candidate
(parallels the budget-api pattern Quinn beat 282 diagnosed on 2026-09-23T11:54
NZST):

1. Verify machine state: `fly status --app sindustries-tasks-api-staging`
   (repeat for `sindustries-budget-api-staging`,
   `sindustries-content-scheduler-api-staging`).
2. If machines are absent or suspended: `fly machines list` per app,
   then `fly deploy --strategy canary --wait-timeout 600` from main (PR #680's
   `deploy-staging-<service>.yml` workflow already enforces the
   `FLY_API_TOKEN`-gated preflight and the SHA-pinned `flyctl` install).
3. Re-trigger `cloud-staging-validate` (workflow_dispatch) once `services.fly.app/status` reports `Ready` and the public URL returns 200 on `/health` within the harness's 15s budget.

## What is NOT a blocker for this run

- Code side on PR #695: 20 commits ahead of `origin/main`, CI green on the
  latest run `37146411528` (2026-10-03T19:01Z). No code change needed to advance
  the verdict from FAIL → PASS once the operational unblock above is applied.
- Quinn's `FLY_API_TOKEN` provision (Beat 155 / 2026-09-15T08:20Z): still the
  only secret on the staging Environment until this pass's re-verify.
- Quinn's `STAGING_BUDGET_API_DATABASE_URL` /
  `TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` /
  `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN` provision (this
  pass): now provisioned; the workflow's preflight no longer early-returns.

## Why draft → ready is NOT being flipped

Quinn's 2026-09-24T08:52Z review posture still applies verbatim:

> "Merge posture from my 2026-09-22T21:19Z review still holds: (1) hosted-observability
> contract landing (task 31233a0a), (2) a real `cloud-staging-validate` run
> producing redacted artifacts + `docs/infra/cloud-staging-validation-<date>.md`,
> (3) the four ACs honestly checked. None are in flight."

(1) and (3) remain unresolved; (2) is now resolved by this run + this document.
The PR stays DRAFT and `[implementer-prs]` is not posted until AC1/AC2/AC3 are
honestly checked.

## Refs

- task: `2850c5ac-252e-404a-863b-b83755b2f618` — Deploy cloud staging
  environment and verify representative workflows
- PR: <https://github.com/Stoffer-Industries/sindustries/pull/695> (DRAFT,
  head `7d748582`)
- workflow: `.github/workflows/cloud-staging-validate.yml`
- workflow run: <https://github.com/Stoffer-Industries/sindustries/actions/runs/37184451599>
- artifacts: `cloud-staging-validation-7d7485825bc2a7ee4f669dd9b5ea69abac11b60d`
  (run `37184451599`)
- design: `docs/specs/cloud-staging-environment-tech-design.md`
  (Quinn approved 2026-08-15)
- prior status-updates: `70dbba1b` (2026-09-15T14:33Z), `7ed60104` +
  `7ff41a24` (2026-09-15T18:32Z), `cd419a6e` (2026-09-15T19:31Z),
  `53254fb8` (2026-09-16T01:30Z), `32d06680` (2026-09-16T13:34Z),
  `13668ae0` (2026-09-16T22:30Z), `febb465a` (2026-09-17T07:35Z),
  `c66bbd35` (2026-09-17T...), `f10c38bd`, `e175a488`, `70ba2e08` (2026-09-17),
  `...` (this comment — 2026-10-04T07:01 NZST)