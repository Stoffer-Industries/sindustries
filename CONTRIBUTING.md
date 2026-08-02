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
- **Never check out a branch in the shared `codebases/sindustries` working tree.** This one checkout (the canonical path every agent's tooling reads from directly, e.g. sync scripts, TOOLS.md references) must always stay on `main`. For branch work, create an isolated worktree instead: `git worktree add ../../workspaces/<agent>/sindustries-<task> -b <branch>`. A `post-checkout` guardrail hook (`scripts/git-hooks/post-checkout`, installed via `scripts/git-hooks/install.sh` / `make bootstrap`) auto-reverts this checkout back to `main` if it drifts, but don't rely on it — use a worktree from the start.
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
make test-e2e
```

CI currently covers:
- `services/tasks-api` unit + DB integration tests
- `apps/tasks` unit/component tests
- `apps/tasks` Playwright e2e
- `apps/website` unit tests + build

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
