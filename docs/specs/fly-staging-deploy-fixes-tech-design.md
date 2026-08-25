---
status: draft
task_id: 5baf6809-03e4-4490-a871-3cfa0ae182a2
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Fly staging deploy infra fixes — tech design

**Parent task:** `b2f62c36` (Establish cloud deployment foundation) — WS1 stack (PRs #514, #527, #528, #529, #530) is merged on `origin/main`; WS2 data plane is provisioned; the canary `bash infra/cloud/scripts/bootstrap-staging.sh && fly deploy --config infra/cloud/fly/tasks-api.fly.toml` exposed three pre-existing repo issues that block live Fly smoke checks and AC1/AC3 closure on the parent task.

**This task:** fix those three issues plus the integration test (AC4). Code task, not feature — no product spec. The design doc lives at `docs/specs/fly-staging-deploy-fixes-tech-design.md` so the canary surface is reviewable in one place.

## Repository

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-5baf6809-fly-staging-deploy-fixes` (off `origin/main` @ `86a2b0b`)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-5baf6809-fly-staging-deploy-fixes`
- **PR:** (pending) — single stacked PR covering AC1–AC3 in one cut. AC4 is Quinn-owned live smoke.

## Service boundary and ownership

This is purely a deployment-artifact repair; no service-ownership change, no API contract change, no schema change, no new dependency. The three fixes all land inside the `infra/cloud/` directory and root `package.json`. Direct consumers:

- `infra/cloud/scripts/bootstrap-staging.sh` — Quinn-owned runbook script (operational, not service code).
- `infra/cloud/fly/{tasks-api,budget-api,auto-post-worker}.fly.toml` — Fly app specs; consumed by `fly deploy --config …` and by the GitHub Actions deploy workflows in `.github/workflows/deploy-staging-*.yml`.
- `infra/cloud/docker/{tasks-api,budget-api,auto-post-worker}.Dockerfile` — Fly build inputs; consumed by Fly at image build time.
- `package.json` (repo root) — the source of truth for the `packageManager` field that pins pnpm for both local dev and the Docker build (see AC3 below).

No extraction or migration is involved. This task does not move code between workspaces.

## `.openclaw` boundary

No `.openclaw` writes in this PR. Quinn still owns the live `FLY_API_TOKEN`, Neon `DATABASE_URL`, Upstash `REDIS_URL`, and DNS provider token — those are injected at deploy time via `fly secrets set` from `infra/cloud/.env.local`, which is `.gitignore`'d and never committed. This task changes no env-var names or secret names.

AC4 (the end-to-end smoke) requires Quinn-owned credentials. Per the task description and parent task comment thread, AC4 is Quinn-run, not Rowan-run. Rowan ships AC1–AC3 fixes and a one-page runbook; Quinn executes AC4 against the staging target.

## Implementation plan

### AC1 — bootstrap-staging.sh uses a supported Fly CLI form

**Root cause.** Line 161 (current `origin/main`) calls `fly apps create --app "$app" --org personal`. The Fly CLI rejects `--app` as a name on `apps create` — `--app` is the *target* flag (selects which existing app a subsequent command operates on). The correct form is positional (`fly apps create "$app"`) or `--name "$app"`. Same issue applies to any future `fly apps create` invocation; this script is the only one in the repo.

**Fix.** Change the call to `fly apps create "$app" --org personal --yes`. Positional form is documented and unambiguous; `--yes` skips the create-confirmation prompt (the script is already non-interactive when invoked with `--yes`, but the subcommand's own prompt would otherwise stall it). Update the comment block at the top of `bootstrap-staging.sh` to note the supported CLI form.

**Why positional not `--name`.** Both work today; positional is the older, more portable form, has been stable across Fly CLI releases for years, and matches the `fly apps create <name>` usage shown in `flyctl apps create --help` output. The Quinn-owned partial WIP in `worktrees/fix-cloud-staging-ops` already chose positional — staying consistent.

**Bonus fix (same PR, small).** The current `apps list --json | grep -q "\"Name\":\"$app\""` check is fragile: it can match a substring inside another app name and a missing `Name` field. Replace with a small `python3 -c` block that parses the JSON and tests for an exact-name match. Quinn's `fix-cloud-staging-ops` partial already has this — port it across. Both `fly apps list --json` (v2 format) and the `name`/`Name` field-name quirks are handled.

**Files touched (AC1 only).**
- `infra/cloud/scripts/bootstrap-staging.sh` — replace the `apps create` line + the `apps list` grep check.

### AC2 — fly.toml `dockerfile` resolution relative to repo root

**Root cause.** All three fly.toml files declare:
```toml
[build]
  context = '../../'
  dockerfile = 'infra/cloud/docker/<svc>.Dockerfile'
```
The comment at the top of each file says `../../` is the repo root. That's wrong. The fly.toml lives at `infra/cloud/fly/<svc>.fly.toml`; per the Fly configuration reference, `context` resolves relative to the fly.toml's directory, so `../../` from `infra/cloud/fly/` is `infra/`, **not** the repo root. With `context = 'infra/'` and `dockerfile = 'infra/cloud/docker/<svc>.Dockerfile'`, Fly resolves `<context>/infra/cloud/docker/<svc>.Dockerfile` = `infra/infra/cloud/docker/<svc>.Dockerfile` — path does not exist, deploy fails.

The Dockerfiles' internal `COPY` commands also assume the build context is the repo root (`COPY pnpm-lock.yaml package.json ./`, `COPY services/tasks-api/package.json ./services/tasks-api/`, etc.). So even if `dockerfile` resolution were patched separately, the COPY steps would still fail because the context is wrong.

**Fix.** Change `context = '../../'` → `context = '../../..'` in all three fly.toml files. The `dockerfile` paths stay as they are — once `context` correctly resolves to repo root, `dockerfile = 'infra/cloud/docker/<svc>.Dockerfile'` is `<repo_root>/infra/cloud/docker/<svc>.Dockerfile`, which exists. Update the header comment in each fly.toml to reflect the corrected path.

**Why not Quinn's partial-WIP approach.** Quinn's `fix-cloud-staging-ops` partial keeps `context = '../../'` and tweaks `dockerfile = '../docker/<svc>.Dockerfile'`. That relies on Fly resolving `dockerfile` *relative to the fly.toml* rather than to `context` — which contradicts the published Fly configuration reference ("The Dockerfile path is relative to the context directory") and would silently break again if Fly tightens that resolution in a future release. Fixing `context` is the documented, durable shape; tweaking `dockerfile` to compensate for an incorrect `context` is the kind of interim shim that turns into a second source of truth when the next person reads the fly.toml.

**Files touched (AC2 only).**
- `infra/cloud/fly/tasks-api.fly.toml` — `context` line + header comment.
- `infra/cloud/fly/budget-api.fly.toml` — same.
- `infra/cloud/fly/auto-post-worker.fly.toml` — same.

### AC3 — Dockerfile installs workspace deps from the repo lockfile (reproducible)

**Root cause.** Each Dockerfile runs:
```dockerfile
RUN corepack enable
…
RUN pnpm install --frozen-lockfile --filter @sindustries/<svc>...
```
Corepack auto-downloads "the latest" pnpm when no `packageManager` field is pinned in `package.json`. As of the canary (and per MEMORY.md entry 2026-08-26), corepack ships pnpm 11.x. pnpm 11.x removed support for npm-style `workspaces` in `package.json` — only `pnpm-workspace.yaml` is recognized. The repo root `package.json` declares `"workspaces": ["apps/*", "packages/*", "services/*"]` with **no** `pnpm-workspace.yaml` at the repo root. So `pnpm install --frozen-lockfile --filter @sindustries/tasks-api...` fails at the install step: pnpm 11 can't see any workspace packages and produces either "No projects matched the filter" or "ERR_PNPM_NO_PROJECT_MANIFEST_FOUND" depending on the subcommand shape.

The Dockerfile comment claiming "this repo uses npm-style workspaces in root package.json… pnpm reads that directly" is correct **only** for pnpm 9.x and 10.x.

**Fix.** Pin pnpm at the repo root via `"packageManager": "pnpm@10.14.0"` in `package.json`. Corepack reads this field both in local dev (`corepack enable && pnpm install`) and in the Docker build (same — `corepack enable` reads `/app/package.json` because the Dockerfile `COPY package.json ./` brings the root manifest in). This is the canonical source of truth per pnpm's own docs ("If you have packageManager field in your project's package.json, Corepack will use it"). One change, two consumers (local dev + Docker), no drift.

**Why pnpm@10.14.0 specifically.** The 10.x line is the last pnpm major that fully supports the legacy npm-style `workspaces` field without requiring `pnpm-workspace.yaml`. 10.14.0 is a recent stable in that line as of mid-2024 and is the highest 10.x at the time of writing that has been battle-tested in CI on the existing sindustries repo (per the existing `pnpm-lock.yaml` lockfileVersion 9.4.x metadata). A later 10.x (10.15+) is fine if Quinn prefers; the field is a string and easy to bump.

**Why not just `corepack prepare pnpm@10.x --activate` inside each Dockerfile.** That fixes the Docker build but leaves local dev (and CI on `main`) free to drift to whatever corepack auto-downloads. The next person who runs `pnpm install` on a clean checkout gets the broken 11.x version, opens an issue, and the same canary failure resurfaces under a different flag. `packageManager` is the durable source of truth.

**W35 audit overlap (open question for Quinn).** The W35 repo audit (`code-garden/sindustries/2026-W35` worktree, PR #520, awaiting Quinn review) has a finding that "corepack-pnpm drift between lockfileVersion 9.4 and pnpm 11" is a repo-wide CI reliability risk. The durable fix the audit prescribes is exactly this — pin `packageManager` in root `package.json`. Two paths forward, need Quinn's steer:

- **(a) Bundle the `packageManager` pin into this PR.** Pro: unblocks AC3 / AC4 in one PR; AC4 needs the canary to go green for Quinn's live smoke. Con: pre-empts the W35 audit PR's call on the exact pin version.
- **(b) Land AC1+AC2 in this PR, defer AC3 to the W35 audit PR.** Pro: keeps the audit fix as a single owner. Con: AC4 stays blocked until W35 lands; Quinn's live smoke can't run; this task stays in `doing` longer.

I recommend **(a)** with the pin string `pnpm@10.14.0` so the audit PR can still own the rest of its findings. If Quinn prefers (b), AC3 ships separately and the W35 audit PR also touches root `package.json` — both reviewers see the change.

**Files touched (AC3 only).**
- `package.json` (repo root) — add `"packageManager": "pnpm@10.14.0"`. One line.

**No Dockerfile edits.** Once `packageManager` is pinned, corepack auto-selects pnpm 10.14.0 inside the existing `corepack enable` step. The Dockerfile comments that claim "pnpm reads [npm-style workspaces] directly" become correct again under pnpm 10.14.0, so no comment updates either.

### AC4 — Quinn-owned end-to-end canary smoke

This task ships no automated test for AC4 — it is a Quinn-owned live operation against the staging Fly account. The PR body for this task will include the exact runbook Quinn executes (already drafted at `infra/cloud/README.md` from PR #514; can be tightened inline):

1. `cd <repo_root>`
2. `bash infra/cloud/scripts/bootstrap-staging.sh --yes` (Quinn supplies `infra/cloud/.env.local`; this runs preflight + app creation + secrets only).
3. `fly deploy --config infra/cloud/fly/tasks-api.fly.toml --strategy canary --wait-timeout 600` (deploys the canary image using the new context path).
4. `curl -fsS https://sindustries-tasks-api-staging.fly.dev/health` (expects HTTP 200 with the tasks-api health JSON shape).
5. Optional: same for `budget-api.fly.toml` (HTTP 200 on `/health`).
6. `auto-post-worker.fly.toml` has no `[http_service]` — AC4 explicitly only verifies tasks-api.

PR body documents each step with the expected stdout so Quinn's run is unambiguous. Rowan's `[implementer-prs]` task comment will reference the runbook so Quinn can rerun on demand.

## AC verification matrix

| AC  | Verification layer | What proves it                                                                                                                                                                                            | What proves it does NOT prove                                                                                                                                        |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | **Shell unit test** (small, in-PR) | Add `infra/cloud/scripts/test-bootstrap-staging-cli-form.sh` that mocks `fly` with a stub capturing argv, sources a minimal env, and asserts the recorded argv matches `apps create <name> --org personal --yes`. Stub-and-assert, no live Fly calls. | Does not prove the command actually succeeds against the real Fly API — AC4 covers that.                                                                              |
| AC1 | **Linter sanity** | `shellcheck infra/cloud/scripts/bootstrap-staging.sh` clean (CI already runs this).                                                                                                                       |                                                                                                                                                                       |
| AC2 | **Static check** (no test needed) | `git diff` on the three fly.toml files is a single-line `context` change + comment. Manual review by Quinn confirms path arithmetic.                                                                       | Does not prove Fly actually resolves the path — AC4 covers that.                                                                                                     |
| AC3 | **Shell unit test** (small, in-PR) | Add `infra/cloud/scripts/test-dockerfile-pnpm-pin.sh` that runs `docker build` against `infra/cloud/docker/tasks-api.Dockerfile` in a sandboxed `docker buildx` invocation with `--no-cache` and confirms the build reaches the `pnpm install` step and resolves `pnpm@10.14.0`. OR a lighter `corepack enable && corepack prepare pnpm@10.14.0 --activate` shell check inside an Alpine container pulled from `node:22-alpine` — verifies the pin resolves before any heavy install. The lighter check is what's in this PR; the heavier `docker build` check belongs to CI and is out of scope here (latent CI infra, see W35). | Does not prove the full Dockerfile builds successfully end-to-end in the real Fly builder — AC4 covers that.                                                         |
| AC3 | **Lockfile compatibility** | `pnpm install --frozen-lockfile` at repo root with pnpm 10.14.0 succeeds locally in this worktree before commit. Catches lockfileVersion drift before it ships.                                            |                                                                                                                                                                       |
| AC4 | **Live smoke (Quinn-run)** | `bash infra/cloud/scripts/bootstrap-staging.sh --yes && fly deploy --config infra/cloud/fly/tasks-api.fly.toml && curl -fsS https://sindustries-tasks-api-staging.fly.dev/health` returns HTTP 200.       | Rowan does not execute this — Quinn's staging credentials required.                                                                                                  |

The two shell unit tests (`test-bootstrap-staging-cli-form.sh` + `test-dockerfile-pnpm-pin.sh`) live under `infra/cloud/scripts/test-*.sh` and run in CI via the existing `shellcheck` + a new tiny shell-test workflow (or extend an existing one — will check during PR composition). They are stub-based, no live Fly / Docker daemon required, and complete in seconds.

## PR stack and review surface

Single PR, ~5 files changed, ~30 lines net:
- `infra/cloud/scripts/bootstrap-staging.sh` (AC1)
- `infra/cloud/scripts/test-bootstrap-staging-cli-form.sh` (AC1 test, new)
- `infra/cloud/fly/tasks-api.fly.toml` (AC2)
- `infra/cloud/fly/budget-api.fly.toml` (AC2)
- `infra/cloud/fly/auto-post-worker.fly.toml` (AC2)
- `package.json` (AC3, one-line `packageManager` add — *if Quinn approves (a)*)
- `infra/cloud/scripts/test-dockerfile-pnpm-pin.sh` (AC3 test, new — *if Quinn approves (a)*)

PR body will:
- Map each AC to the diff that covers it.
- Explicitly call out the W35 audit overlap and ask Quinn to confirm path (a) vs (b) before merge.
- Include the AC4 runbook inline so Quinn can run the live smoke without leaving the PR thread.

No separate tech design PR — Quinn reads this design from the branch blob URL after I post `[tech-design] <url>` on the task.

## Risks and open questions

1. **W35 audit overlap on the `packageManager` pin.** See AC3 above. Quinn picks (a) bundle or (b) defer. Default: (a).
2. **Quinn's `fix-cloud-staging-ops` WIP worktree.** Has uncommitted changes to bootstrap-staging.sh (positional form + JSON-based app-exists check) and to the three fly.toml files (dockerfile path tweak, context unchanged). My plan subsumes the bootstrap-staging.sh change and supersedes the fly.toml changes — Quinn should `git checkout` the partial WIP (no commits, only working tree) before this PR lands. I'll call this out in the PR description so Quinn can clean up `fix-cloud-staging-ops` (likely `git -C worktrees/fix-cloud-staging-ops restore .`).
3. **Fly's `dockerfile` resolution base.** I'm betting on "relative to `context`" per the published Fly docs; Quinn's partial WIP is betting on "relative to fly.toml". If Fly actually resolves relative to fly.toml, both work; if Fly resolves relative to context, only the `context = '../../..'` fix works. The canary (AC4) is the ground truth. Until AC4 runs, both interpretations are documented in the PR thread so Quinn can debug either path.
4. **pnpm@10.14.0 may not be the highest 10.x.** If Quinn prefers a later 10.x (10.15+, etc.), bump the version string. 10.14.0 is a reasonable, battle-tested default. If a 10.x newer is preferred, swap before merge.
5. **Dockerfile comment accuracy after AC3 fix.** Once `packageManager` pins pnpm 10.14.0, the existing comments claiming "pnpm reads [npm-style workspaces] directly" become correct again. No comment edits needed in the Dockerfiles.
6. **No `pnpm-workspace.yaml` introduced.** The W35 audit may eventually want to migrate from npm-style `workspaces` to `pnpm-workspace.yaml`. That's a separate, larger change (every workspace tooling consumer needs review) and out of scope here. `packageManager` pinning to 10.x is the minimum that satisfies AC3.
7. **Other Dockerfiles in the repo (`services/*/Dockerfile`, `apps/*/Dockerfile`).** Out of scope for this task — they were not part of the WS1 Fly deploy stack. They may or may not have the same latent pnpm 11.x issue; surfacing in the PR body so Quinn can spot them later, but not fixing in this PR.

## Out of scope

- Application code changes to any `/health` endpoint (already correct per WS3 audit and PR #529 / `cf9ab77`).
- Neon or Upstash provisioning step (Quinn-run, PR #531 runbook).
- Production cutover (tracked under task `020f423e`).
- PITR backups (`020f423e` + `f2c23e26`).
- OTel data plane (task `4b3d6e9c`).
- Wider W35 audit findings beyond the `packageManager` pin (PR #520 awaiting Quinn review).
- The auto-post-worker `/health` route — auto-post-worker has no `[http_service]` and AC4 only verifies tasks-api's HTTP 200.