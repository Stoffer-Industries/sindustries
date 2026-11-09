# tests/cloud — cloud staging validation harness

Black-box authenticated workflow harness for the cloud staging environment
(task `2850c5ac`, `docs/specs/cloud-staging-environment-tech-design.md`
section 3). Exercises the three representative authenticated workflows
against deployed services and emits a single JSON result matching
`staging-validation.schema.json`.

## Files

- `staging-workflows.mjs` — main AC2 harness. Pure Node 22 ESM, no deps.
- `staging-validation.schema.json` — machine-readable result contract. The
  design section "Validation result contract" is the source of truth.
- `scripts/check-schema.mjs` — minimal structural validator for the result
  JSON. No `ajv` dependency — keeps the harness install-free on the
  staging runner.
- `fixtures/staging-validator-fixture.json` — reference fixture set and
  cleanup order.
- `package.json` — declares `node >=22`; no install step.

## Running the harness

The harness is invoked by the `cloud-staging-validate` workflow
(`.github/workflows/cloud-staging-validate.yml`). Local invocation needs:

```sh
node tests/cloud/staging-workflows.mjs \
  --tasks-api-url https://sindustries-platform-staging.fly.dev/tasks-api \
  --budget-api-url https://sindustries-platform-staging.fly.dev/budget-api \
  --scheduler-api-url https://sindustries-platform-staging.fly.dev/content-scheduler-api \
  --tasks-token "$TASKS_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN" \
  --scheduler-token "$CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS_TOKEN" \
  --budget-token-file /tmp/budget-smoke-bearer \
  --intent-commit "$(git rev-parse HEAD)" \
  --output /tmp/staging-validation.json
```

Each input has an environment-variable equivalent (`STAGING_TASKS_API_URL`,
etc.) for CI runners.

## Staging targets

Staging is ONE Fly app — `sindustries-platform-staging` — and the three API
surfaces are supervisor children of it, reached on the platform host at their
path prefixes (`/tasks-api`, `/budget-api`, `/content-scheduler-api`); nginx
strips the matched prefix before proxying to the loopback listener. The four
per-service staging apps (`sindustries-tasks-api-staging`,
`sindustries-budget-api-staging`, `sindustries-content-scheduler-api-staging`,
`sindustries-auto-post-worker-staging`) were destroyed in the 2026-11-07
consolidation cutover, so their `*.fly.dev` hostnames no longer serve these
APIs. `infra/cloud/hostname-matrix.json` (`stagingRoutes`) and
`infra/cloud/platform/nginx.conf` are the sources of truth for the routes;
the stable app-name hostnames (`tasks-api.staging.sindustries.co.nz` and
siblings) land with task `5cb4a8fe`.

<!-- stable-fallback: provider URL pending the stable-hostname CNAME move (task 5cb4a8fe) -->

## Bearer token sourcing

- **tasks-api**: bearer token from `TASKS_API_APPROVAL_SERVICE_CREDENTIALS`
  (the same env-var-driven identity the service authenticates with at boot).
  Pass as `--tasks-token` or `STAGING_TASKS_API_TOKEN`.
- **content-scheduler-api**: bearer token from
  `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS`. Same shape.
- **budget-api**: the harness refuses to accept bearer values on the
  command line. Instead, run
  `services/budget-api/scripts/staging-smoke-session.ts mint --staging
  --token-out /tmp/budget-smoke-bearer` ahead of the harness and pass
  `/tmp/budget-smoke-bearer` via `--budget-token-file`. The harness reads
  the token once into a local variable and unlinks the file before exit.

Both bearer tokens are redacted in harness logs, the JSON result, and any
artifact uploaded by the workflow.

## Result schema (highlights)

The full schema is in `staging-validation.schema.json`. The shape operators
most often need to read:

```jsonc
{
  "schemaVersion": 1,
  "runId": "staging-validate-20260915T215700Z-abcd1234",
  "intentCommit": "abcdef0…",
  "environment": { "id": "[REDACTED]", "provider": "fly.io" },
  "services": { "tasksApi": { "version": "v1", "matchesIntent": true }, … },
  "checks": [
    { "name": "tasks.create", "status": "pass", "startedAt": "...", "endedAt": "...", "details": {…} },
    { "name": "scheduler.auto_post_health", "status": "fail", "error": { "code": "SCHEDULER_HEALTH_ADAPTER_MISMATCH", "message": "..." } }
  ],
  "cleanup": { "ok": true, "operations": [{ "name": "tasks.archive", "ok": true, "error": null }, …] },
  "productionBlockers": [],
  "acceptedLimitations": [
    { "code": "BUDGET_DEEPER_WRITE_REQUIRES_DB_FIXTURE", "owner": "Rowan", "rationale": "...", "followUp": "..." }
  ],
  "verdict": "pass"
}
```

`verdict` is `pass` only when:

- every required service version matches `intentCommit` (when `intentCommit` is set);
- every `checks[].status` is `pass` or an explicit `skip`;
- `cleanup.ok` is `true`;
- `productionBlockers` is empty.

`acceptedLimitations` is allowed to be non-empty for a `pass` verdict —
each entry must carry an owner, a rationale, and a follow-up reference.

## Cleanup guarantees

The harness runs cleanup unconditionally before exit, in reverse
registration order:

1. `scheduler.item_remove` — soft-removes the synthetic Content Scheduler
   item the run created.
2. `tasks.archive` — soft-archives the synthetic tasks-api task (idempotent;
   `404` after first archive is treated as success).
3. `budget.unlink_token_file` — `unlink(2)`s the mode-`0600` bearer file
   the smoke-session CLI created.

If any operation fails, `cleanup.ok` flips to `false` and the verdict
becomes `fail`. The harness never aborts cleanup on a single failure; all
operations attempt regardless so partial cleanup is recorded, not lost.

## Re-running safely

The `runTag` prefix (`staging-validate-<run-id-suffix>`) is unique per run.
Re-using a `run-id` from a previous run that did not clean up will collide
on the synthetic tasks and items the harness looks up by tag. If you must
re-run with the same id, first:

```sh
node services/budget-api/scripts/staging-smoke-session.ts reconcile --staging --dry-run
```

…and remove any leftovers before re-running the harness.

## Test plan

- `node scripts/check-schema.mjs tests/cloud/fixtures/example-result.json`
  passes against a synthetic green-path result (added in a follow-up
  slice).
- Harness emits JSON when run against any reachable service set; failures
  in reachable-but-misconfigured services surface as `verdict=fail` rather
  than harness crash.
- Cleanup partial-failure path is exercised by intentionally removing the
  bearer file mid-run and asserting `cleanup.operations[].ok=false`.

## Out of scope (this file)

- **AC3 failure drill** lives in `staging-failure-drill.sh` (separate
  slice; ships after this one).
- **Workflow orchestration** lives in
  `.github/workflows/cloud-staging-validate.yml` (separate slice).
- **Runbook + AC4 evidence** lives in `docs/runbooks/cloud-staging.md` and
  `docs/infra/cloud-staging-validation-<YYYY-MM-DD>.md` (separate slice).