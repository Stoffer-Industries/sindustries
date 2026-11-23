---
status: draft
task_id: 3c004590-3e4e-4832-81be-de3236adae72
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Platform provisioner approval-credential actor merge — tech design

## Product intent

There is no separate brain product spec for this corrective code task. The task record is the product intent: a routine merge to `main` must not turn healthy production agent writes into `401 AUTH_REQUIRED` responses. The production platform provisioner currently converts one GitHub Environment token into a one-entry credential array and overwrites each live Fly credential secret. The durable result must instead be a complete, least-privilege, repository-checked credential set assembled from GitHub Environment secrets, with a deployment-time proof that every expected token authenticates as its intended actor.

Product spec: **n/a**.

## Delivery metadata

- **Task:** `3c004590-3e4e-4832-81be-de3236adae72`
- **Title:** Make the platform provisioner MERGE approval-credential actors instead of replacing them (next main merge silently breaks every agent write on production)
- **Repository:** `Stoffer-Industries/sindustries`
- **Branch:** `task-3c004590-platform-provisioner-merge-actors`
- **Worktree:** `/Volumes/WD1/worktrees/rowan/rowan-task-3c004590-provisioner-merge-actors`

## Current failure and required next-merge behaviour

`infra/cloud/platform/platform-provision-secrets.mjs` reads one Tasks token and one Content Scheduler token, calls `buildServiceCredentials`, and writes two one-actor arrays through `flyctl secrets set`. `infra/cloud/platform/platform-environments.mjs` separately hard-codes the validation actor. `.github/workflows/deploy-production-platform.yml` is called by `ci.yml` on every push to `main`; with production provisioning enabled, an unrelated merge therefore replaces both complete live arrays without producing a deploy error.

After this change, the first merge to `main` behaves as follows:

1. The workflow reads the existing platform-validation tokens plus two new full operator-credential JSON secrets from the protected `production` GitHub Environment.
2. Before any Fly mutation, the provisioner parses and validates both operator arrays, checks their exact service-specific actor and approval-type contracts, merges in `production-cloud-validate`, rejects actor/token collisions, and serializes the result in manifest order.
3. If either new Environment secret is absent, empty, malformed, missing an expected actor, contains an unknown actor, or carries a forbidden approval grant, the job fails **before** `flyctl secrets set`; the currently working live secrets remain untouched.
4. With valid inputs, the provisioner sets complete arrays: Tasks receives `production-cloud-validate` plus the nine currently registered agent/service actors; Content Scheduler receives `production-cloud-validate`, `Ivy`, and `tasks_app_browser` only.
5. The canary deploy completes, then a live authenticated verifier presents every configured token to its service and requires the service to report the intended actor. A mismatch or `401` fails the deployment workflow loudly.
6. A second run produces byte-identical JSON and the same actor set. Repeated provisioning is therefore idempotent.

Fly does not expose secret values, only names and digests. Consequently, an actor added only by hand to a live Fly secret cannot be read and merged. That is intentional: AC2 forbids live-only registration. “Preserve” means every actor in the authoritative GitHub Environment credential arrays survives every deploy; unrecorded live actors are drift and must not be perpetuated.

## Ownership-boundary check

### Natural source of truth

This is a **workflow/deployment credential boundary**, not Tasks domain data, Content Scheduler domain data, UI state, or database state.

- The protected GitHub Environment owns secret **values**. It is the only CI-readable durable source and already owns the production platform's other secret inputs.
- `infra/cloud/platform/platform-environments.mjs` owns the non-secret deployment **contract**: target secret, input source names, deterministic actor order, and allowed `approvalTypes` per actor for each service and environment.
- The provisioner owns parsing, exact-set validation, deterministic merge, and Fly mutation.
- Each service owns authentication of its own credential at runtime. A small authenticated identity endpoint provides proof without creating domain state.

The manifest is preferred over an interim workflow-local actor list or a live-secret merge shim. The workflow cannot read live Fly values, and duplicating actor assumptions in YAML would recreate the drift this task fixes. The shared provisioner is already the durable boundary used by staging, production, CI, and operator bootstrap paths.

The touched custom provisioner is a future Terraform candidate under `docs/ARCHITECTURE.md`, but migrating Fly/GitHub secret management to Terraform is disproportionate to this urgent credential-loss correction and would not remove the need for runtime authentication proof. No interim shim is introduced.

### Service-specific least privilege

Do **not** copy the Tasks actor set into Content Scheduler. The expected sets are deliberately service-specific:

- **Tasks API:** `production-cloud-validate`, `Quinn`, `Rowan`, `Ivy`, `Lox`, `Ash`, `feature_task_lobster`, `bookmark_lobster`, `Lobster`, `brain_spec_reconciler`.
- **Content Scheduler API:** `production-cloud-validate`, `Ivy`, `tasks_app_browser`.

The task's phrase “missing from either service's credential set” is implemented as “missing from the set declared for that service.” Registering all Tasks actors on Content Scheduler would widen production write access without a caller requirement. The contract also checks approval grants: Tasks actors keep only their existing allowed `approvalTypes` (`Quinn: tech_design`, `Ash: qa_agent`, `brain_spec_reconciler: spec`, all other listed actors empty); Content Scheduler entries retain the service's existing empty/`any` shape as explicitly declared in the manifest. No merge operation unions permissions.

## Implementation plan and file scope

### 1. Make the environment manifest the single non-secret credential contract

Update `infra/cloud/platform/platform-environments.mjs`:

- Replace `sourceNames.tasksApprovalToken`, `sourceNames.schedulerApprovalToken`, and the separate `approvalActors` object with one `approvalCredentials` contract per service.
- Each contract names the Fly target secret, platform-token source, full operator-array source, platform actor and approval types, and ordered expected operator actors with exact allowed approval types.
- Add production operator sources such as `PRODUCTION_TASKS_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS` and `PRODUCTION_CONTENT_SCHEDULER_API_OPERATOR_APPROVAL_SERVICE_CREDENTIALS`; add staging equivalents so the shared provisioner has one shape in both environments.
- Extend `assertEnvironmentManifest` and `requiredSourceNames` to validate and require these fields generically. Reject duplicate actors, duplicate source names, an operator list containing the platform actor, unknown approval types, and an empty expected set.
- Keep actor names and scopes in this manifest only. The workflow and provisioner iterate/project this contract rather than restating actor lists.

### 2. Parse, validate, and merge instead of replacing

Update `infra/cloud/platform/platform-provision-secrets.mjs`:

- Replace the one-entry `buildServiceCredentials(token, actor, types)` path with shared helpers that parse a credential-array source, validate token/actor/`approvalTypes` shape, and merge the generated platform entry with configured operator entries.
- Require token length at least 16, non-empty exact actor names, unique actors, unique tokens, and exact equality between each actor's configured `approvalTypes` and the manifest contract. Reject unknown actors rather than silently granting a new writer.
- Serialize in manifest order with stable object key order. The helper is a pure function: applying it to the same inputs twice returns the same bytes.
- Build both target secrets by iterating `environment.approvalCredentials`; remove actor overrides from `buildPlatformSecretPayload` so no caller can bypass the manifest contract.
- Complete all credential validation and `assertEnvironmentValues` checks before `ensureApp` or `applySecrets`. Never print raw arrays, tokens, or derived `NAME=value` arguments.
- Keep the existing direct, detached Fly write and secret-name read-back. The new runtime verifier supplies the value-level proof Fly cannot provide.

### 3. Add non-mutating runtime identity proof

Update `services/tasks-api/src/app.ts` and `services/content-scheduler-api/src/app.ts` (with focused route/middleware tests):

- Add `GET /api/v1/auth/principal`, explicitly protected by each service's existing `requireAuthenticatedUser` middleware even though GET routes are otherwise public.
- Return only `{ actor, kind }` for the authenticated credential. Return the existing uniform `401 AUTH_REQUIRED` response for an absent or wrong token.
- Do not expose token material, configured actors, approval types, or a credential-list endpoint. The caller can learn only the identity of the token it already possesses.

Add `infra/cloud/platform/verify-platform-approval-credentials.mjs` and unit tests:

- Read the same environment manifest and source values as the provisioner, invoke the same parse/merge helper, and call each service's manifest-owned base URL with each credential.
- Require HTTP 200 and an exact actor match for every expected entry, including the platform actor. Redact response/transport diagnostics through the existing redactor; log actor names and service names only.
- Bound requests with a timeout and aggregate failures so one bad actor cannot hide another.

### 4. Wire fail-closed deployment and regression guards

Update `.github/workflows/deploy-production-platform.yml` and `.github/workflows/deploy-staging-platform.yml`:

- Pass the two full operator credential arrays from their protected GitHub Environments alongside the platform-validation tokens.
- Run the live verifier after the canary deploy and ordinary health smokes. A broken actor set makes the deployment job red on the same merge that introduced it.
- Keep GitHub masking intact and never echo the JSON values.

Extend `tests/cloud/scripts/check-production-deploy-contract.mjs` and `tests/cloud/tests/check-production-deploy-contract.test.mjs`:

- Assert the workflow passes every manifest-declared credential source, uses the shared provisioner, and runs the live verifier after deploy.
- Add mutation sentinels proving the check goes red if the operator-array source is removed/replaced with a single token, the verifier step is removed or moved before deployment, or a manifest-required actor is removed.

Extend `infra/cloud/platform/tests/platform-provision-secrets.test.mjs`, `platform-provision-secrets-cli.test.mjs`, and `platform-environments.test.mjs` with the merge, exact-set, malformed/empty/wrong-array, idempotence, no-log, and source-projection cases. These tests are the direct regression guard against reintroducing replacement semantics.

### 5. Update durable operations documentation

Update `docs/systems/cloud-platform.md` and `docs/runbooks/production-cloud-cutover.md` in the implementation PR:

- Name the production GitHub Environment as value owner and the environment manifest as actor/scope contract owner.
- Document the actor add/remove procedure: update the service's full Environment JSON secret and the manifest contract in one reviewed change, run local fake-fixture tests, then rely on the production workflow's pre-write and live checks.
- State that direct `flyctl secrets set` edits are unsupported and will be replaced.
- Add the `401 AUTH_REQUIRED` runbook: inspect the latest production platform workflow, verify the manifest actor membership and Environment source presence without printing values, run the live verifier through the protected workflow, rotate only the affected actor token when needed, and never paste a token into task comments or logs.

No new system doc is created; this extends the existing cloud-platform system boundary.

## Data model and API contract changes

- **Database:** none. No Prisma schema or migration changes.
- **Tasks API:** new authenticated, read-only `GET /api/v1/auth/principal` response `{ "actor": string, "kind": "service" | "session" }`.
- **Content Scheduler API:** the same endpoint and response contract.
- **Environment contract:** two full operator credential JSON sources per environment are added; existing single-token sources remain narrowly scoped to the platform validation actors.
- **Credential JSON:** remains `[{ token, actor, approvalTypes }]`; no service parser migration is required.
- **Security contract:** actor membership and approval grants must exactly match the manifest. Unknown actors, duplicate actors/tokens, missing actors, malformed entries, and scope widening fail before Fly mutation.

## Workflow, cron, skill, and `.openclaw` boundary

- **Workflow:** both platform deploy workflows receive the complete operator sources and production gains a post-deploy live actor verifier. `ci.yml` continues to invoke the production workflow on `main`; no trigger broadening is needed.
- **Cron:** no changes.
- **Skills/agent definitions:** no changes. Existing callers continue using their actor-scoped tokens.
- **`.openclaw` boundary:** no repository implementation may edit `.openclaw`. Before the implementation merges, Quinn must copy the already-issued actor tokens from the protected operator credential store into the two new GitHub `production` Environment JSON secrets (and staging equivalents if staging is kept at parity), preserving separate tokens per service. This is an operator action, not a committed file change. If it is not complete, the next workflow fails before touching Fly.
- **Credential rotation:** update only the affected actor's entry in the GitHub Environment secret; do not change actor membership or permissions unless the manifest changes in the same reviewed delivery.

## Test plan

This is deployment/security work rather than a browser flow, so Playwright E2E is disproportionate and would not exercise protected GitHub Environment secrets or Fly. The strongest practical layers are pure unit/CLI integration tests, a static workflow mutation guard in CI, service integration tests for the identity endpoint, and the real post-deploy production verifier.

| AC | Planned verification | Layer | Why this proves the criterion |
| --- | --- | --- | --- |
| AC1 | Pure merge tests preserve platform plus operator actors, reject collisions, and produce byte-identical output on two runs; CLI integration inspects the actual `flyctl secrets set` payload actor sets. | unit + integration | Exercises merge semantics and idempotence on the real provisioning path without touching Fly. |
| AC2 | Manifest/source-projection tests require full operator JSON sources; production workflow contract test requires every source; manual protected-Environment preflight confirms the new secrets exist before merge. | file + integration + manual | Proves CI, not an operator-local file/live edit, supplies the complete durable values. The manual part cannot safely read secret values in ordinary CI. |
| AC3 | Parser tests cover empty, malformed, missing, extra, duplicate, wrong actor and widened-scope values; service endpoint integration tests cover correct/wrong tokens; post-deploy verifier authenticates every expected live token; workflow mutation tests require that verifier after deploy. | unit + integration + production e2e | The production verifier is the value-level E2E proof that Fly/runtime loaded each intended credential; static and unit guards prevent a replacement regression reaching Fly. |
| AC4 | Manifest tests prove the provisioner and workflow projection derive actors/sources from `approvalCredentials`; mutation sentinel removes/changes a manifest actor and requires CI failure until all projections agree. | unit + file | Prevents hand-duplicated shape/actor assumptions in `buildServiceCredentials`, workflow YAML, or a second actor list. |
| AC5 | Documentation assertions/review verify both required existing docs name ownership, add/remove, and `401` recovery procedures. | file + manual | Operational prose has no meaningful runtime E2E; file presence/content checks plus review are proportionate. |

### Additional security assertions

- No test/log snapshot contains a token or full credential JSON.
- A valid actor with an unexpected approval type is rejected; merge never unions grants.
- A Tasks token fails against Content Scheduler and vice versa in service integration fixtures.
- The identity endpoint cannot be called anonymously and cannot enumerate credentials.
- A failed validation makes zero Fly process calls.

## Open questions and risks

1. **Operator prerequisite (blocking implementation merge):** Quinn must populate the new protected GitHub Environment arrays before the implementation lands. The designed failure mode is safe (red workflow, no Fly write), but the deployment will not complete without this action.
2. **AC3 wording:** this design uses service-specific required actor sets to preserve least privilege. If “missing from either service” is intended to require every Tasks actor on Content Scheduler too, Quinn should flag that to Tom rather than approve: it conflicts with the instruction not to widen who can write and with the observed Content Scheduler caller set (`Ivy`, `tasks_app_browser`).
3. **Existing live token provenance:** the full arrays must be built from the tokens already distributed to callers. Generating replacements without updating callers would make the live verifier correctly fail and would create avoidable rotation work.
4. **First-deploy ordering:** the new principal endpoint exists only after the canary carrying this change starts. Therefore value-level verification runs after deploy; all input membership/scope checks still run before the secret write. The workflow contract test must preserve this order.
5. **Secret size:** the Tasks JSON array is comfortably below Fly/GitHub secret limits today, but tests should assert a reasonable maximum and fail with a diagnostic rather than relying on provider truncation.
6. **Availability during secret set:** `flyctl secrets set --detach` restarts the current Machine before the canary. The complete merged credentials are valid for the old and new service code, so this introduces no schema compatibility window; ordinary health checks and the post-deploy verifier remain the release gate.
7. **Case sensitivity:** actor names are security identities and remain exact/case-sensitive. Normalizing names could merge two principals or misattribute audit events.

