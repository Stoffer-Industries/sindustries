---
status: shipped
task_id: 37622d4f-f62c-4000-b65f-1dfb2f15bdf2
product_spec: n/a
shipped_pr: 925
shipped_date: 2026-11-07
---

# Fix Vercel prebuilt target mismatch

## Product intent

Restore the website staging deployment path so a production-configured candidate can be built, deployed, aliased to `staging.sindustries.co.nz`, smoke-tested, and later promoted without rebuilding. The change must make build and deploy consume one target decision so their Vercel environments cannot drift.

## Delivery metadata

- Task: `37622d4f-f62c-4000-b65f-1dfb2f15bdf2` — Fix Vercel prebuilt target mismatch in website staging deploy
- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-37622d4f-vercel-target`
- Worktree: a local git worktree of the implementation branch (operator-specific path, intentionally not recorded here)
- Product spec: n/a; the task description is the accepted behavioural contract

## Service boundary and data ownership

This is a GitHub Actions/Vercel deployment-workflow contract. The natural source of truth is `.github/workflows/website-deploy.yml`, not application state, an API, or a database. The reusable workflow already owns the `production-candidate` input; the implementation will derive one Vercel target from that input once at job scope and reuse it for pull, build, and deploy.

The direct consumer is `.github/workflows/ci.yml`, which calls this reusable workflow for staging and production. The implementation does not need to change that caller or the reusable workflow's input/output contract.

This is the durable boundary. An application-local shim would duplicate deployment metadata and would not prevent future workflow drift. There is no temporary placement, extraction, or migration step: the durable workflow-level solution is about as easy as an interim one and can ship in one mergeable change.

## `.openclaw` boundary

No `.openclaw` configuration changes are required. Vercel credentials, the project link, and the existing staging/production domains remain environment-owned secrets/configuration outside the repository. The implementation will not read, copy, or commit those values.

The production-domain safeguard is implemented with the Vercel CLI's `--skip-domain` flag, so it does not depend on changing the Vercel project's Auto-assign Custom Production Domains setting.

## Current failure

For a main push, `production-candidate` is true. The workflow runs `vercel build --prod`, producing production-targeted `.vercel/output`, then runs `vercel deploy --prebuilt` without a production target. Vercel treats the deploy as preview and rejects the target mismatch before aliasing or smoke testing.

## Verified Vercel semantics

The workflow pins `vercel@54.2.0`; the implementation must be designed against that version rather than an assumed newer CLI.

- `vercel pull` selects environment variables with `--environment=production|preview`.
- `vercel build` and `vercel deploy` both accept `--target=production|preview`; the CLI normalizes that value to the same target used by prebuilt output validation.
- `vercel deploy --prebuilt` requires the deploy target to equal the target recorded in `.vercel/output`; otherwise the CLI fails before upload.
- A production deploy auto-assigns the project's custom production domains by default. `--skip-domain` disables that automatic assignment and is accepted only with a production target.
- A production deployment created with `--skip-domain` is Vercel's staged-production pattern: it can later be assigned to production with `vercel promote`, which the existing production job already performs.

The combination `--target=production --skip-domain` is therefore required for a production-configured staging candidate. A plain production deploy would move `www.sindustries.co.nz` onto every staging candidate before smoke testing and explicit promotion.

Evidence:

- [Vercel Environments](https://vercel.com/docs/deployments/environments) — production deployments update production domains by default; staged production deployments can be verified before promotion.
- [Vercel: Promoting Deployments](https://vercel.com/docs/deployments/promoting-a-deployment) — a staged production deployment can later be promoted without rebuilding.
- [Vercel CLI `deploy` option definition at `vercel@54.2.0`](https://github.com/vercel/vercel/blob/vercel%4054.2.0/packages/cli/src/commands/deploy/command.ts#L89-L95) — `--skip-domain` disables automatic production-domain aliasing and permits later promotion.
- [Vercel CLI target validation at `vercel@54.2.0`](https://github.com/vercel/vercel/blob/vercel%4054.2.0/packages/cli/src/commands/deploy/index.ts#L1143-L1155) — `--skip-domain` is valid only when the resolved target is `production`.
- [Vercel CLI prebuilt-target comparison at `vercel@54.2.0`](https://github.com/vercel/vercel/blob/vercel%4054.2.0/packages/cli/src/commands/deploy/index.ts#L1242-L1257) — the deploy target must equal the target recorded in prebuilt output.

## Implementation plan

### 1. Resolve one target at job scope

In `.github/workflows/website-deploy.yml`, derive a single non-empty `VERCEL_TARGET` from `production-candidate` (`production` or `preview`) in the job environment:

```yaml
VERCEL_TARGET: ${{ inputs.production-candidate && 'production' || 'preview' }}
```

Pull, build, and deploy must all consume this value; `production-candidate` must not appear in any later step.

### 2. Use the shared target for every Vercel phase

- Pull production/preview environment variables with `vercel pull --yes --environment="$VERCEL_TARGET"`.
- Build prebuilt output with `vercel build --target="$VERCEL_TARGET"`.
- Deploy prebuilt output with `vercel deploy --prebuilt --target="$VERCEL_TARGET"`.

The production deploy must additionally pass `--skip-domain`. That safeguard is bound to the already-resolved `VERCEL_TARGET`; it is not a second target decision and must not read `production-candidate` again. Use a shell array so no empty flag or unquoted fragment can be passed to the CLI.

```bash
deploy_args=(--prebuilt --target="$VERCEL_TARGET")
if [ "$VERCEL_TARGET" = production ]; then
  deploy_args+=(--skip-domain)
fi
DEPLOY_URL=$(vercel deploy "${deploy_args[@]}" --token="$VERCEL_TOKEN")
```

### 3. Preserve candidate delivery and promotion

Keep the existing `vercel alias set "$DEPLOY_URL" "$STAGING_DOMAIN"` operation, candidate URL output, job summary, and candidate smoke check. Keep the production job's `vercel promote` and explicit `www.sindustries.co.nz` alias unchanged. The staging job must not assign the production custom domain.

### 4. Add a focused static contract and regression test

Add:

- `tests/cloud/scripts/check-vercel-deploy-target.mjs` — reads the reusable workflow and asserts that pull, build, and deploy consume the same shared target, that build/deploy no longer evaluate `production-candidate` independently, and that the production deploy path includes `--skip-domain`.
- `tests/cloud/tests/check-vercel-deploy-target.test.mjs` — exercises the checker against synthetic good and mutated workflows so each important assertion can demonstrably fail.
- `tests/cloud/package.json` — add the matching `check:vercel-deploy-target` and `test:vercel-deploy-target` scripts, following the existing cloud-check convention.

The checker should assert semantic anchors and shared-variable use rather than exact full step bodies, to avoid coupling the guard to harmless YAML formatting changes.

### 5. Wire the regression test into CI

Run the new test by its explicit file path in the existing `gh-with-agent-token-tests` CI job, alongside the current cloud staging workflow tests. The repository-wide contract-test orphan guard must see the explicit CI runner argument, so the test cannot silently join the "not run by CI" ledger. No `CONTRIBUTING.md` not-run entry is needed for a test that is actually run.

### File and module scope

- `.github/workflows/website-deploy.yml` — shared target derivation and the three Vercel phase commands.
- `.github/workflows/ci.yml` — explicit CI execution of the new regression test.
- `tests/cloud/scripts/check-vercel-deploy-target.mjs` — reusable static checker.
- `tests/cloud/tests/check-vercel-deploy-target.test.mjs` — checker regression tests using synthetic workflow fixtures.
- `tests/cloud/package.json` — local check/test entry points.

No application, API, database, migration, or shared-package files are in scope.

## Data model and API contracts

No application data model or HTTP API changes. The reusable workflow input contract remains compatible: `production-candidate: boolean` continues to select production configuration for a promotable staging candidate, and `candidate-url` plus `deployment_url` retain their current meaning. The internal `VERCEL_TARGET` value is a workflow-scope implementation detail.

## Workflow, cron, and skill changes

- GitHub Actions: update the reusable website deploy workflow and run the new static regression test in CI.
- Cron: none.
- Skills/OpenClaw: none.

## Verification plan

| Acceptance criterion | Verification |
| --- | --- |
| AC1: The `website staging` deploy job completes successfully on a main push that touches `apps/website/**`, `package.json`, or `package-lock.json` — the Vercel prebuilt target always matches the environment the output was built for. | The static checker validates the single target-resolution expression and proves that pull, build, and deploy all consume its result. After merge, the main workflow run that triggers the website path is the final live proof that build, deploy, alias, and smoke check complete successfully. |
| AC2: Build and deploy derive the Vercel target from one shared input, so the two steps cannot diverge (the fix is not a per-step copy of the `production-candidate` conditional). | The static test fails if build and deploy stop consuming the same shared target or if either step reintroduces an independent `production-candidate` conditional. |
| AC3: The deployed candidate is aliased to `staging.sindustries.co.nz` and the post-deploy smoke check passes against the candidate URL. | Static assertions retain the staging alias, candidate output, and smoke-check dependency on the candidate URL; the successful main workflow run verifies live behaviour. |
| AC4: A repo-level static check or test asserts the build step and the deploy step use the same Vercel target, so the mismatch cannot regress silently. | Run the new Node checker test locally and in the explicit CI job; mutated synthetic fixtures prove that target divergence, removal of `--skip-domain`, and reintroduction of per-step conditionals fail the guard. |

E2E browser coverage is disproportionate because the failure occurs before an application URL exists and depends on Vercel credentials. The appropriate automated layer is a repository static workflow test, followed by the existing live deploy, alias, and smoke steps on main.

## Risks and mitigations

- **Production traffic could move before promotion.** `vercel deploy --target=production` auto-assigns custom production domains by default. Pair the production target with `--skip-domain`, assert that flag in the static check, and leave domain assignment to the existing explicit production promotion job.
- **Shell quoting could turn an absent flag into a literal argument.** Always use the single non-empty `VERCEL_TARGET`; construct deploy arguments in a shell array rather than interpolating a flag string.
- **Build and deploy could drift again.** Both must consume the same job-scope target; the static check rejects independent target decisions in those steps.
- **A static parser can become coupled to formatting.** Assert semantic anchors and shared-variable use rather than exact full step bodies, and exercise the checker with synthetic fixtures.
- **A test can exist without asserting anything.** Run the new test through an explicit CI runner argument so the repository-wide orphan guard treats it as executed.

## Open questions

None. The task, the pinned Vercel CLI contract, and the existing build-once/promote-later workflow define the intended production-candidate behaviour.
