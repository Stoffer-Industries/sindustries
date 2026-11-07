# Contributing

## Working model

This repo uses a **spec-first** workflow for any non-trivial change, plus a strict **dev vs prodlike** split for local work.

For non-trivial code tasks:
- no product spec is required
- create or update a tech design in `docs/specs/` before implementation starts when the task changes security posture, service boundaries, data ownership, migrations, cross-service APIs, or significant internal architecture
- record the tech design path in the task
- task notes are not a substitute for a needed tech design

See [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) for the full doc taxonomy: tech designs, system docs, app specs, and their lifecycle. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for repo-level architecture principles, service boundaries, and ownership rules.

## Environment rules

### Dev is for implementation
Use the `dev` stack for active coding, inner-loop testing, and normal local iteration.

- API: `http://localhost:4000/api/v1`
- App: `http://localhost:5173`
- Postgres: `localhost:6432` (`sindustries_dev`)

Typical commands:

```bash
make up MODE=dev
make test
```

### Prodlike is for validation
Use the `prodlike` stack to validate behavior against the production-shaped local environment.

- API: `http://localhost:4001/api/v1`
- App: `http://localhost:5174`
- Postgres: `localhost:7432` (`sindustries_prodlike`)

Typical command:

```bash
make up MODE=prodlike
```

Use prodlike for final verification, smoke checks, and automation that should target the validation environment.

## NEVER rules

- **Never do implementation work directly on `main`.** Work on a branch and open a PR.
- **Never treat prodlike as your day-to-day dev environment.** Build and iterate in `dev`; validate in `prodlike`.
- **Never seed or reset prodlike casually.** `scripts/dev/reset-db.sh` intentionally blocks prodlike seeding to protect the validation dataset.
- **Never duplicate operational logic in ad-hoc commands when a repo script already exists.** Prefer `scripts/dev/*` and `make` wrappers.

## Non-trivial work

A change is non-trivial if it changes architecture, introduces/refactors modules, crosses service/app boundaries, materially changes behavior, or is more than a tiny isolated edit.

Before changing backend ownership, adding persistence, or wiring a new service/API boundary, check [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Architecture principles belong there; task notes, PR comments, and agent workflow docs may reference them but are not the canonical source.

For non-trivial work:

1. Pass a clarification gate
   - Ask questions if needed, or explicitly note why no clarification is needed.
   - Record assumptions.
2. Write or update a tech design in `docs/specs/` before implementation (see [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)).
   - The tech design must map each acceptance criterion to planned verification before coding starts.
   - User-visible/app-flow ACs should plan E2E coverage where possible; if not possible, record why and name the fallback test layer.
3. Implement in small, mergeable slices.
4. Validate with the right tests/checks and note any manual verification.
5. Capture rollback, mitigation, or follow-up notes if risk remains.

## Audit findings and follow-up tasks

Weekly repo audits are the ledger for technical findings.

- Code-garden-safe findings stay in the code-garden lane and are marked done by the code-garden PR link.
- Important findings that are not code-garden-safe should become tracked tasks during the audit when the follow-up is clear.
- Use `code` tasks for non-functional/security/refactor/migration/service-boundary work with no new product capability.
- Use `feature` tasks for new product/user capability or behavior requiring product scope.
- Use `research` tasks when the right implementation path is not known yet.
- The audit finding line should link the task while work is pending, then the implementation PR when fixed.

This keeps traceability as: `audit finding → task → tech design when needed → PR → audit marked done`.

## Validation expectations

Before opening or merging a PR, run the most relevant checks for the change.

Common commands:

```bash
make test
make test-api
make test-app
make test-website
make test-e2e
make test-all
```

`make test-all` is a local convenience target that runs `make test-api`,
`make test-website`, `make test-app` and `make test-e2e` (Tasks/Budget
APIs, website, Tasks app + e2e); it is not a full local parity with CI.
`make test` runs `make test-api`, `make test-app` and `make test-e2e`.
Mission Control, the content scheduler, GymTrack, MCP, and agent
verification run from their own workspaces or under CI (listed below).
`infra/cloud/scripts/tests/local-test-commands.test.sh` asserts that the
commands listed here are the targets the Makefile defines, that every
prerequisite of `make test-all` is listed here, and that the two
sentences above name exactly the commands the Makefile runs — so the
documented local surface cannot drift away from the executable one.

CI currently covers:
- `services/tasks-api` unit + DB integration tests (`tasks-api-tests`), plus a ratcheting TypeScript compiler gate (`typecheck:gate`, see below)
- `services/budget-api` unit tests (`budget-api-unit` job also runs `packages/budget-domain` test + typecheck and `apps/budget-mobile` typecheck), a ratcheting TypeScript compiler gate (`typecheck:gate`, see below), plus DB integration tests (`budget-api-db-integration` job runs the ownership-contract suite against real Postgres; previously ran with mocked Prisma — see W38 audit F4 for the historical gap)
- `services/content-scheduler-api` vitest (unit) (`content-scheduler-api-tests`), a ratcheting TypeScript compiler gate (`typecheck:gate`, see below), plus `content-scheduler-api-db-integration` (real Postgres; proves the thread-publish claim/journal atomicity the unit suite could not exercise while Prisma was mocked — see W42 audit F2)
- `services/gymtrack-mcp` tests (`gymtrack-mcp-tests`)
- `apps/tasks` unit/component tests + Playwright e2e (UI + API + DB) (`tasks-app-tests`, `tasks-app-e2e`)
- `apps/website` unit tests + build (`website-app-tests`)
- `apps/mission-control` tests (`mission-control-tests`)
- `apps/gymtrack` tests (`gymtrack-tests`)
- Python workflow tests (`python-workflow-tests`; `agents/workflows/` Python packages) + `cto-craft-tweet-drafts-tests`
- Rust workflow tests + clippy (`feature-task-workflow-tests`, `feature-task-clippy`; `agents/workflows/feature-task`)
- Ash verifier tests (`ash-tests`)
- OpenTelemetry Node package unit tests (`otel-node-tests`)
- Design system sync (`design-system-sync`)
- `frontend-design-system-lint` (the frontend `@shadcn/lint` design-system lint wiring and its unit tests)
- `no-absolute-paths-lint` (the repo lint that fails on hard-coded absolute paths such as `~/` or `/Users/<name>/`; its scanned roots and opt-outs are documented under *Path-lint scope* below)
- `typecheck-gate-tests` (self-test for `scripts/typecheck-gate.mjs`, the tool the three service gates above run)
- `infra-cloud-bootstrap-staging-tests` (the `infra/cloud` contract-test suite, all under `infra/cloud/scripts/tests/`: `bootstrap-staging.test.sh`, `retired-staging-apps.test.sh`, `fly-toml-context.test.sh`, `package-json-no-pnpm-pin.test.sh`, `mission-control-deploy-fixtures.test.sh`, `fly-deploy-trigger-paths.test.sh`, `ci-deployment-gates.test.sh`, `local-test-commands.test.sh`, `no-absolute-paths-scope.test.sh`, `budget-mobile-ota-inputs.test.sh` and `ci-job-script-inventory.test.sh`)
- `health-probe-tests` (health-probe unit tests plus the observability contract tests, all under `infra/cloud/scripts/tests/`: `observability-provisioning.test.sh` — the observability provisioning contract — and `observability-bootstrap.test.sh` — the bootstrap / evidence / failure-inject contract)
- `gh-with-agent-token-tests` (per-agent GitHub identity shim, `infra/cloud/bin` deploy/status/rollback contracts, cloud staging workflow and failure-drill harnesses, stable-hostname verification harness, the workflow shell-syntax contract test `tests/cloud/tests/check-workflow-shell-syntax.test.mjs` — every `run:` block in every workflow is parsed by bash, so a shell syntax error in a deploy step fails on the PR that introduced it — and the Vercel production promotion scope contract test `tests/cloud/tests/check-vercel-production-promotion-scope.test.mjs`, which asserts that the production promotion resolves the candidate in the explicit `$VERCEL_ORG_ID` team scope rather than the token's default scope)
- `gog-cli-tests` (the `agents/lib` gog CLI wrapper shim and its direct-egress behaviour)
- `gitleaks` secret scan (advisory-only — see W38 audit F1 for the unenforced-server-side gap)
- `changes` (detect deployment changes — computes which deployable surfaces a PR touches; a required input to the `merge-gate` job)
- `eas-update-production` (mobile OTA publishing; the job's display name is `EAS update on main`)

Every job listed above except `eas-update-production` is an input to the
`merge-gate` job in `.github/workflows/ci.yml`, which gates the deployment
jobs. `eas-update-production` is itself a deployment job: it runs *after* the
gate passes (`needs: [changes, merge-gate]`).

Each entry above names its job id so the inventory can be checked against
`merge-gate.needs` mechanically. `infra/cloud/scripts/tests/ci-deployment-gates.test.sh`
asserts that every merge-gate input is listed here and that no listed id is
missing from `ci.yml`, so a new or renamed required job has to be documented
in the same change that adds or renames it. The same test asserts the
converse as well: a job id named here that the gate does not require is
reported too — `merge-gate` itself and `eas-update-production` (the one
deployment job that runs after the gate) are the only exceptions — so the
sentence above cannot drift away from the executable gate.

Those exception ids are the only ones the check exempts, and the test
asserts that this paragraph and the check exempt exactly the same ids, so
neither can drift away from the other.

The contract tests the CI jobs run are listed by file name in the inventory
above. `infra/cloud/scripts/tests/ci-job-script-inventory.test.sh` asserts
those lists against the jobs' own run steps, in both directions and for every
job that runs a contract test, so a contract test added to a job has to be
documented in the same change, and a documented contract test that the job
does not run is reported rather than assumed.

The same test also guards the contract-test directory itself: every
`*.test.sh` file in `infra/cloud/scripts/tests/` must be run by some CI job
in `.github/workflows/ci.yml`, and every script a job runs from that
directory must exist. A contract test that no job executes asserts nothing,
so adding one without wiring it into CI fails the gate instead of silently
never running.

The same test now holds that rule across every contract test in the
repository, not across a list of directories. A contract test here is a shell
test (`*.test.sh` or `test_*.sh`) or an mjs test (`*.test.mjs`); the test
derives the set from the working tree, so a contract test added to a
directory it has never seen is covered the moment it lands. TypeScript and
Python tests are unit tests with their own CI suites, and are out of scope
for this guard.

A contract test counts as run by CI only when a workflow step actually runs
it: as a `bash <file>` or `node --test <file>` argument, as a glob one of
those runners expands (`node --test scripts/*.test.mjs`), or through an npm
script whose command runs one — `npm test --workspace @sindustries/design-tokens`
runs `packages/design-tokens/scripts/pen-document.test.mjs` and
`packages/design-tokens/scripts/pen-refs.test.mjs` without either path
appearing in a run step. A file a workflow only mentions — a shellcheck
target, for example — is linted, not run, and does not count.

The contract tests that no workflow runs are recorded under *Contract tests
not run by CI* below. The test asserts that record against the files on
disk, against the workflows' run steps, and against the recorded list in
both directions, so it cannot grow silently, and so a contract test that
later gets wired into CI is reported as a stale record rather than left
behind.

Cross-package / domain checks (now invoked by `budget-api-unit`):
- `packages/budget-domain` test + typecheck scripts (`packages/budget-domain/package.json`)
- `apps/budget-mobile` typecheck (`apps/budget-mobile/package.json`)

Closed: see `docs/repo-audits/2026-W38.md` F4 and PR #673.

### Contract tests not run by CI

These contract tests exist on disk but no CI workflow executes them, so they
assert nothing in the merge gate. They are listed here so the gap stays
visible, and so a new contract test that no job runs fails the gate instead
of joining them silently.

- `agents/skills/dev/pr-open/tests/test_assert_opener_identity.sh` — the PR opener identity guard; no CI workflow runs it
- `scripts/cloud/database/tests/common.test.sh` — the cloud database shared-helper checks; no CI workflow runs it
- `scripts/cloud/database/tests/manifest-constraints.test.sh` — the cloud database manifest-constraints check; no CI workflow runs it
- `scripts/cloud/database/tests/restore-result-dir.test.sh` — the cloud database restore-result-directory check; no CI workflow runs it
- `scripts/cloud/database/tests/schema-presence.test.sh` — the cloud database schema-presence check; no CI workflow runs it
- `scripts/ops/tests/sync-agent-definitions.test.sh` — the agent-definition sync check; no CI workflow runs it
- `scripts/test/build-tailwind-theme.test.mjs` — the Tailwind theme build check; no CI job runs it
- `scripts/test/check-no-legacy-approval-marker.test.mjs` — the legacy approval-marker check; no CI job runs it
- `tests/cloud/tests/check-cors-origin-matrix.test.mjs` — the stable-hostname CORS matrix check (task 5cb4a8fe slice 2); no CI job runs it
- `tests/cloud/tests/check-deploy-workflow-stable-hostname.test.mjs` — the deploy-workflow hostname check (task 5cb4a8fe slice 3); no CI job runs it
- `tests/cloud/tests/check-stable-hostname-matrix.test.mjs` — the stable-hostname matrix check (task 5cb4a8fe slice 1); no CI job runs it
- `tests/cloud/tests/check-stable-url-fallbacks.test.mjs` — the provider-URL fallback check (task 5cb4a8fe slice 4); no CI job runs it
- `tests/cloud/tests/check-vercel-env-matrix.test.mjs` — the Vercel environment matrix check (task 5cb4a8fe slice 5); no CI job runs it
- `tests/cloud/tests/staging-db-migration-failure-drill.test.sh` — the staging database migration failure drill; it needs a live database, so it runs from the root `test:cloud-db` script rather than from CI

### Backend TypeScript compiler gate

`services/{tasks-api,budget-api,content-scheduler-api}` each carry a committed `typecheck-baseline.json` that CI compares the current `tsc --noEmit` output against (`npm run typecheck:gate --workspace services/<name>`). The gate can only shrink debt or stay flat — it fails on either a rising diagnostic count or a new/grown diagnostic that the baseline doesn't already cover, even when the total stays the same. See `docs/specs/backend-typecheck-gate-tech-design.md` for the full rationale.

- **Check locally before pushing:** `npm run typecheck:gate --workspace services/<name>` (needs `npm run prisma:generate --workspace services/<name>` first).
- **Pay down debt:** fix diagnostics, then regenerate that service's baseline deliberately — `npm run typecheck:baseline --workspace services/<name>` — and commit the diff. Never hand-edit `typecheck-baseline.json`; the regenerate command is the only way it should change, so the PR diff is always a real measurement.
- **Never suppress to pass:** `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, or enabling `strict` wholesale are all out of scope for this gate — see Decision 6 of the tech design. If a diagnostic can't be fixed yet, it stays in the baseline as counted, visible debt.
- A TypeScript version bump can shift diagnostics; the gate hard-fails on a `tscVersion` mismatch between the baseline and the `tsc` actually run, forcing a deliberate baseline regenerate in the same PR as the bump.
- The gate validates that `totalDiagnostics` equals the sum of the committed fingerprint counts and that the service's `typecheck` script still invokes `tsc --noEmit`; malformed metadata cannot silently weaken it.
- Exit codes: `0` = within baseline/baseline written, `1` = ratchet or baseline violation, `2` = invocation/toolchain/environment failure (including missing generated Prisma clients or a TypeScript version mismatch).

### Path-lint scope

The `no-absolute-paths-lint` job runs `scripts/check-no-absolute-paths.mjs`,
which scans a fixed set of roots and skips a fixed set of paths. Both lists
live in the script, and both are documented here so a contributor can tell
what the lint actually covers.
`infra/cloud/scripts/tests/no-absolute-paths-scope.test.sh` asserts that both
lists below match the script's own configuration in both directions, that
every opt-out sits under a scanned root, and that the CI step invokes the lint
with the documented roots. The documented scope therefore cannot drift away
from the executable one.

Scanned roots: `apps`, `services`, `packages`, `agents/workflows`, `agents/lib`.

Opted out of the scan: `agents/workflows/feature-task/src` — the Rust workflow
monolith, whose test fixtures and log strings ship hard-coded paths.

## System spec maintenance

`docs/systems/` contains durable system specs that describe how shipped features work. These must stay in sync with the code.

**Every commit that changes observable system behaviour must update the relevant `docs/systems/<file>.md`** — or include a `[no-system-spec-change] <reason>` justification in the PR body or task comment explaining why no update is needed.

What counts as observable system behaviour: state transitions, gate logic, comment tag contracts, API response shapes, agent orchestration protocols, cron schedules, and permission boundaries.

What does not require a system spec update: internal refactors with no externally visible behaviour change, test-only changes, documentation-only changes, and build/tooling changes.

If no `docs/systems/` file yet covers the area you're changing, create one. Use `agents/skills/dev/system-spec/SKILL.md` as a guide.

**This rule applies to agents and humans equally.** Failing to update the system spec when shipping behaviour changes is a DoD violation.

## Pull request standards

1. Code review feedback belongs on the GitHub PR.
2. Task acceptance criteria belong to the task.
3. Each PR must reference the task.
4. Each PR must make it easy to trace the implementation scope it represents.
5. Each PR must state which ACs it covers and which ACs remain outside that PR, if any.
6. The PR summary must include the ACs relevant to that PR.
7. Tom should not review code until all required checks are passing.
8. Every AC covered by that PR needs at least one E2E test, unless explicitly marked not possible with a reason.
9. If the PR changes user-visible behaviour in an app, `apps/<app>/SPEC.md` must be updated to reflect it.
10. The PR should be assigned to **`Stoff81`** for review once ready.

## Commit message standard

Use a simple conventional format:

`type(scope): short summary`

Examples:
- `feat(tasks): add tag filter to header`
- `fix(tasks): restore scroll position after save`
- `docs(contributing): clarify review requirements`

Preferred types:
- `feat`
- `fix`
- `docs`
- `refactor`
- `test`
- `chore`

Commits should be meaningful, reviewable slices.
Avoid vague messages like `wip`, `misc`, `fix`, or `stuff`.

## Repo conventions

- `apps/` for user-facing runnable app surfaces
- `services/` for backend APIs, workers, and processes
- `packages/` for shared libraries, types, and config
- `infra/` for deployment/runtime/infrastructure config
- `docs/` for architecture principles, system docs, specs, and decision records
