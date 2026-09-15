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

---

## Header

| Field | Value |
| --- | --- |
| Run date (UTC) | `<YYYY-MM-DD>` |
| Run date (NZST) | `<YYYY-MM-DD NZST>` |
| Workflow run | `<https://github.com/Stoffer-Industries/sindustries/actions/runs/<id>>` |
| Commit image | `<short SHA> @ <full SHA>` (Fly image tag) |
| Branch | `<branch that produced the image>` |
| Validate workflow input — staging URL override | `<URL or empty for default *.fly.dev>` |
| Operator (Tom or Quinn) | `<name>` |
| Verdict | `<PASS | PASS_WITH_LIMITATIONS | FAIL>` |
| Cleanup status | `<ok=true | ok=false, reason=...>` |

## Result JSON summary

Paste the validate workflow's emitted `result.json` after the schema-validator step,
collapsed to key fields:

```json
{
  "verdict": "<PASS | PASS_WITH_LIMITATIONS | FAIL>",
  "productionBlockers": [],
  "acceptedLimitations": [],
  "checks": {
    "deploy": { "ok": true, "app": "...", "version": 0, "machines": 0, "elapsedMs": 0 },
    "health.tasksApi":  { "ok": true, "statusCode": 200, "elapsedMs": 0 },
    "health.budgetApi": { "ok": true, "statusCode": 200, "elapsedMs": 0 },
    "health.worker":    { "ok": true, "logLine": "...", "elapsedMs": 0 },
    "workflows.tasksApi":  { "ok": true, "stepsOk": ["create", "read", "patch", "archive"], "elapsedMs": 0 },
    "workflows.budgetApi": { "ok": true, "stepsOk": ["me"], "elapsedMs": 0 },
    "workflows.contentScheduler": { "ok": true, "stepsOk": ["create", "approve", "healthBullmq", "unapprove", "remove"], "elapsedMs": 0 },
    "failureDrill": { "ok": true, "alertFired": true, "alertResolvedMs": 0 },
    "schemaValidate": { "ok": true, "errors": [] },
    "cleanup": { "ok": true, "removedUsers": 0, "removedItems": 0, "errors": [] }
  }
}
```

## AC-by-AC coverage

Tick each AC when the corresponding evidence above and the cite / image / log line
attest it. Always link the source directly under the entry, not as a footnote.

- [ ] **AC1 — staging starts with production-like configuration and passes service health checks**
  - Evidence: `health.tasksApi`, `health.budgetApi`, `health.worker`, `deploy.version`
  - Source: workflow job log `<link>`, Fly release `<version>`
- [ ] **AC2 — representative authenticated Tasks API, Budget API, and Content Scheduler workflows complete**
  - Evidence: `workflows.tasksApi`, `workflows.budgetApi`, `workflows.contentScheduler`
  - Source: workflow job log `<link>`, harness stdout captured in artifact `<link>`
- [ ] **AC3 — intentional failure has useful logging, alerting, and recovery**
  - Evidence: `failureDrill`
  - Source: alerting provider page `<link>`, drill log `<link>`, worker restart line `<log-line>`
- [ ] **AC4 — evidence is recorded with separated blockers / limitations**
  - Evidence: this document, schema-validated `result.json`
  - Source: this file's commit + PR

## Production blockers

> **Hard rule.** A pass (`verdict == PASS`) requires `productionBlockers == []`. A non-empty
> list flips the verdict to `PASS_WITH_LIMITATIONS` if the items are pre-accepted, or `FAIL`
> if they block the cutover task `020f423e`.

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
