# Cloud Staging Validation — evidence record template

**Status:** Template for task `2850c5ac-252e-404a-863b-b83755b2f618` AC4 evidence.
**Copy this file to `docs/infra/cloud-staging-validation-YYYY-MM-DD.md` after a successful
(or end-of-drill) run of `.github/workflows/cloud-staging-validate.yml`.**
**Replace every `<...>` placeholder with the validated run output; keep the section
ordering stable so weekly retros can diff records line-by-line.**

Each dated evidence record is the durable, redactable artefact that satisfies AC4
("staging validation evidence and any production blockers are recorded and clearly
distinguishable from accepted limitations"). The validate workflow emits a JSON
result that this document mirrors into prose; run-time evidence is uploaded as a
workflow artifact so the JSON itself is never lost.

**Superseded shape (verified against `origin/main` on 2026-11-21).** The header row
for a "staging URL override" workflow input, the `PASS_WITH_LIMITATIONS` verdict
vocabulary, the example `result.json` block, and the AC evidence keys below all
described a shape the validate workflow and the harness do not produce. The
workflow's `workflow_dispatch` inputs are exactly `intent_commit`,
`run_failure_drill` and `max_duration_seconds` — there is no staging-URL override —
and the staging URLs come from the `staging` GitHub environment variables
(`STAGING_TASKS_API_URL`, `STAGING_BUDGET_API_URL`, `STAGING_SCHEDULER_API_URL`),
which are bound to the stable hostnames in `infra/cloud/hostname-matrix.json`. The
harness emits `verdict` as `pass` or `fail` (the schema constrains it to those two
values) and emits `checks` as an ordered array of `{name, status, startedAt,
endedAt}` entries, not as an object keyed by `health.*` / `workflows.*` /
`failureDrill`. The rows and the block below now match the live contract, so an
operator copying this file records the artifact the schema validator actually
checks. The superseded wording is recorded in the `docs/repo-audits/2026-W46.md`
finding so the history stays readable.

---

## Header

| Field | Value |
| --- | --- |
| Run date (UTC) | `<YYYY-MM-DD>` |
| Run date (NZST) | `<YYYY-MM-DD NZST>` |
| Workflow run | `<https://github.com/Stoffer-Industries/sindustries/actions/runs/<id>>` |
| Commit image | `<short SHA> @ <full SHA>` (Fly image tag) |
| Branch | `<branch that produced the image>` |
| Validate workflow input — `intent_commit` | `<commit SHA the run intends to validate (blank = HEAD)>` |
| Validate workflow input — `run_failure_drill` | `<true | false>` |
| Validate workflow input — `max_duration_seconds` | `<seconds>` |
| Staging URLs exercised (from the `staging` environment vars `STAGING_TASKS_API_URL` / `STAGING_BUDGET_API_URL` / `STAGING_SCHEDULER_API_URL`) | `<https://tasks-api.staging.sindustries.co.nz> / <https://budget-api.staging.sindustries.co.nz> / <https://content-scheduler-api.staging.sindustries.co.nz>` |
| Operator (Tom or Quinn) | `<name>` |
| Verdict (harness `result.json`) | `<pass | fail>` |
| Cleanup status | `<ok=true | ok=false, reason=...>` |

## Result JSON summary

Paste the harness's emitted `artifacts/staging-workflows.json` (uploaded as a
workflow artifact), collapsed to key fields. The shape below is the shape
`tests/cloud/staging-validation.schema.json` validates, so the record and the
schema stay diffable:

```json
{
  "schemaVersion": 1,
  "runId": "<staging-validate-<timestamp>>",
  "intentCommit": "<full SHA>",
  "environment": { "id": "<redacted>", "provider": "fly.io" },
  "startedAt": "<ISO 8601>",
  "endedAt": "<ISO 8601>",
  "services": {
    "tasksApi":         { "url": "https://tasks-api.staging.sindustries.co.nz",         "version": "<full SHA>", "matchesIntent": true },
    "budgetApi":        { "url": "https://budget-api.staging.sindustries.co.nz",        "version": "<full SHA>", "matchesIntent": true },
    "contentScheduler": { "url": "https://content-scheduler-api.staging.sindustries.co.nz", "version": "<full SHA>", "matchesIntent": true }
  },
  "checks": [
    { "name": "tasks.health",    "status": "pass", "startedAt": "<ISO 8601>", "endedAt": "<ISO 8601>" },
    { "name": "budget.health",   "status": "pass", "startedAt": "<ISO 8601>", "endedAt": "<ISO 8601>" },
    { "name": "scheduler.health", "status": "pass", "startedAt": "<ISO 8601>", "endedAt": "<ISO 8601>" }
  ],
  "cleanup": { "ok": true, "operations": [ { "name": "tasks.archive", "ok": true, "error": null } ] },
  "productionBlockers": [],
  "acceptedLimitations": [],
  "verdict": "<pass | fail>"
}
```

## AC-by-AC coverage

Tick each AC when the corresponding evidence above and the cite / image / log line
attest it. Always link the source directly under the entry, not as a footnote.

- [ ] **AC1 — staging starts with production-like configuration and passes service health checks**
  - Evidence: `services.tasksApi`, `services.budgetApi`, `services.contentScheduler` (`url` / `version` / `matchesIntent`), and the `tasks.health` / `budget.health` / `scheduler.health` entries in `checks[]`
  - Source: workflow job log `<link>`, Fly release `<version>`
- [ ] **AC2 — representative authenticated Tasks API, Budget API, and Content Scheduler workflows complete**
  - Evidence: the `tasks.*`, `budget.*` and `scheduler.*` entries in `checks[]`
  - Source: workflow job log `<link>`, harness stdout captured in artifact `<link>`
- [ ] **AC3 — intentional failure has useful logging, alerting, and recovery**
  - Evidence: the `failure_drill.*` entries in `checks[]` (from `artifacts/staging-failure-drill.json`)
  - Source: alerting provider page `<link>`, drill log `<link>`, worker restart line `<log-line>`
- [ ] **AC4 — evidence is recorded with separated blockers / limitations**
  - Evidence: this document, schema-validated `result.json`
  - Source: this file's commit + PR

## Production blockers

> **Hard rule.** The harness emits exactly two verdicts — `pass` or `fail` — and it emits
> `productionBlockers` as an empty array; there is no third verdict value to flip to.
> A run passes only when every check is `pass` (or an explicit `skip`), `cleanup.ok` is
> `true`, and every service's `matchesIntent` is `true`. A boundary that is pre-accepted
> belongs in `acceptedLimitations`, which does not by itself change the verdict; a genuine
> blocker is recorded below and fails the run.

| # | Blocker | Owner | Discovered | Mitigation / follow-up task |
| - | --- | --- | --- | --- |
| 1 | `<description>` | `<Quinn | Tom | Rowan>` | `<YYYY-MM-DD>` | `<task id or PR #>` |

## Accepted limitations

| # | Limitation | Owner | Rationale | Follow-up task |
| - | --- | --- | --- | --- |
| 1 | `<description>` | `<Quinn | Tom | Rowan>` | `<why this is acceptable for staging but not production>` | `<task id>` |

## Cleanup record

Detail what the harness removed after the run finished (synthetic users, sessions,
scheduled items). Listed in the workflow result but restated here for operator scan:

- Synthetic users revoked: `<count>` (sample IDs: `staging-smoke+<uuid>@sindustries.invalid`).
- Scheduled items removed: `<count>` (sample IDs from `content-scheduler`).
- Token files unlinked: `<mode 0600 token files written by mint>`.

## Refs

- Design: `docs/specs/cloud-staging-environment-tech-design.md` (AC verification matrix)
- Workflow: `.github/workflows/cloud-staging-validate.yml`
- Harness: `tests/cloud/staging-workflows.mjs`
- Drill: `tests/cloud/staging-failure-drill.sh`
- Schema: `tests/cloud/staging-validation.schema.json`
- Operator handover: `docs/systems/cloud-platform.md`
- Task: `2850c5ac-252e-404a-863b-b83755b2f618`
