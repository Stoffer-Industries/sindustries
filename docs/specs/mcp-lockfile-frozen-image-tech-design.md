---
status: draft
task_id: a858ffce-fb68-45c2-8c2c-fb930b0b48e2
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Freeze GymTrack MCP image dependency graph — tech design

**Parent task:** `a858ffce-fb68-45c2-8c2c-fb930b0b48e2` (Build GymTrack MCP from the tested npm lockfile), tracked from audit `docs/repo-audits/2026-W38.md` finding **F3 — MCP production image resolves an untested dependency graph**. Tranche **T4** of the W38 audit's "Milestone 2 — High-leverage delivery correctness."

This is a code task (not a feature task): no product spec, no user-visible behavior change, no schema change. The change is a Dockerfile rewrite plus a small CI verification step. Sibling task `2b66ae79` (Align Fly deployment triggers with npm build inputs — T3) lands first so the `paths:` contract under `.github/workflows/gymtrack-mcp-deploy.yml` matches what this Dockerfile actually consumes; this task then freezes the Dockerfile install so the released image and the CI-tested graph agree.

## Repository

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-a858ffce-mcp-lockfile` (off `origin/main` @ `95094488`)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-a858ffce-mcp-lockfile`
- **PR:** (pending — to be opened after Quinn approves this design)

## Service boundary and ownership

No service-ownership change, no API contract change, no schema change, no new runtime dependency. The fix is one Dockerfile rewrite plus a small verification step in CI. Direct consumers:

- `services/gymtrack-mcp/Dockerfile` — currently installs the MCP service's runtime deps via `npm install --omit=dev --legacy-peer-deps` with no lockfile (`services/gymtrack-mcp/Dockerfile:7`); replaced with a multi-stage build that consumes the root `package-lock.json`.
- `.github/workflows/gymtrack-mcp-deploy.yml` — already runs `npm ci` at the workspace root before deploying (`.github/workflows/gymtrack-mcp-deploy.yml:45`), so CI is the canonical "tested graph" this Dockerfile must converge on.
- `package-lock.json` (root) — the lockfile that pins every workspace's resolved versions; the Dockerfile now copies this directly.

No code path outside `services/gymtrack-mcp/Dockerfile` changes. No local workspace is consumed at runtime — the MCP service only depends on `express` and `@supabase/supabase-js` (`services/gymtrack-mcp/package.json:14–17`), so the image's runtime imports are unaffected by workspace graph layout.

## `.openclaw` boundary

None. This change is entirely within the `sindustries` repo. No `~/.openclaw/`, cron, or skill changes.

## Source of truth (ownership boundary check)

The natural source of truth for "what version of every dep is installed in the MCP production image" is the **root `package-lock.json`** — the same lockfile CI's `npm ci` already consumes (`.github/workflows/gymtrack-mcp-deploy.yml:45`). Today's Dockerfile bypasses that source of truth by running `npm install` against the npm registry with no lockfile, which means a registry-side resolution at image build time can drift from CI's resolved graph.

The durable boundary is therefore: **the Dockerfile must `npm ci` against the root lockfile**, not resolve from the registry. Anything that requires registry resolution at build time is a regression of this finding.

There is no useful interim shim here: copying only the service's `package.json` with no lockfile is the failure mode that produced F3. The fix is the durable shape.

## Implementation plan

### File/module scope

Single-file primary change plus a small CI verification step:

1. **`services/gymtrack-mcp/Dockerfile`** — rewrite as a multi-stage build:
   - **Stage 1 (`deps`)**: copy `package.json` + `package-lock.json` from the workspace root, copy `services/gymtrack-mcp/package.json` into the same tree, then `npm ci --omit=dev --legacy-peer-deps`. The `--legacy-peer-deps` flag is preserved because `npm 10`'s peer-set resolver still crashes with `edgesOut` on parts of this graph (comment at the existing `RUN npm install` line at `services/gymtrack-mcp/Dockerfile:5`); the same flag continues to apply under `npm ci` for that reason. The lockfile pins versions exactly, so the resolver outcome is now reproducible.
   - **Stage 2 (`runtime`)**: copy `node_modules` from the `deps` stage, copy `services/gymtrack-mcp/src` to `/app/src`, copy `apps/gymtrack/server/agentData.js` to `/apps/gymtrack/server/agentData.js` (preserving the existing absolute path that matches `mcpTools.js`'s `../../../apps/gymtrack/server/agentData.js` import — `services/gymtrack-mcp/src/mcpTools.js:10`). Set `NODE_ENV=production`, expose `8787`, `CMD ["node", "src/server.js"]`.

   The image will install all workspace `dependencies` (not just MCP's) because `npm ci` at the root walks the whole workspace graph. This is a deliberate trade-off documented below — the alternative (copying a synthetic package.json that doesn't declare workspaces) breaks `npm ci`'s lockfile/package.json consistency check.

2. **`.github/workflows/gymtrack-mcp-deploy.yml`** — add a post-`docker build` verification step (a third step in the existing `deploy` job, between "Deploy (canary)" and the existing `/health` smoke check):
   - Build the image to a local tag (`docker build -t gymtrack-mcp:ci-validate -f services/gymtrack-mcp/Dockerfile .`).
   - Run `docker run --rm gymtrack-mcp:ci-validate sh -c 'npm ls --omit=dev --depth=0 --json'` and assert that the resolved versions of `express` and `@supabase/supabase-js` match the values in `package-lock.json` for those packages.
   - Run the existing MCP test contract against the same image (`docker run --rm -v "$PWD:/repo" -w /repo node:22-alpine sh -c '...'` — or extract the test files into a sibling stage).
   - Fail the deploy job on any drift, missing package, or `invalid: true` from `npm ls`.

   This is the verification surface for AC2.

   Alternative considered and rejected: post-build `docker run` `node src/server.js` headlessly to run the Vitest suite inside the image. Rejected because the existing tests already run in CI against the lockfile install (`.github/workflows/gymtrack-mcp-deploy.yml:48`), and adding a duplicate test runner inside the image adds maintenance without a clean win.

### Trade-offs

- **Image size increases.** Running `npm ci` at the workspace root installs every workspace's `dependencies`, not just MCP's. The MCP runtime only uses `express` and `@supabase/supabase-js` from `node_modules`; the rest are dead weight. The honest alternatives are (a) a custom filtered lockfile regenerated per MCP dep change — adds maintenance, drifts from CI's view, and (b) `npm prune --omit=dev` after install — brittle and platform-dependent. We accept the size hit to keep the build graph exactly equal to CI's. The exact delta can be measured post-merge and a follow-up can trim if it becomes material.
- **`--legacy-peer-deps` is preserved.** This is a known workaround for the workspace's peer-set resolver crash and is unrelated to the lockfile fix. Removing it is a separate change that should land with the dependency remediation workstream (`37f4d7d2`), not here.

## Data model / API contract / schema changes

None.

## Workflow / cron / skill changes

None — the only workflow change is the new verification step inside `.github/workflows/gymtrack-mcp-deploy.yml`, which is part of this implementation rather than a separate scheduling change.

## Test plan and AC verification matrix

AC1: *MCP Docker build uses the root package-lock.json with a frozen npm install and preserves the agentData.js import path.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `services/gymtrack-mcp/Dockerfile` contains `COPY package-lock.json` from the workspace root and `RUN npm ci` (no `npm install` in the final image) | file | PR review |
| `agentData.js` line preserved at `/apps/gymtrack/server/agentData.js` and `services/gymtrack-mcp/src/mcpTools.js:10` import resolves at runtime inside the image | unit + manual smoke (existing `/health` and OAuth discovery checks) | PR review + CI |
| Image build succeeds on `origin/main` HEAD and produces no `WARN`/`ERR` from `npm ci` | CI | CI |
| Existing MCP test contract (`npm test --workspace @sindustries/gymtrack-mcp`) passes against the image's installed graph — verified by adding a CI step that runs the Vitest suite against the image's `node_modules` (see AC2 below) | CI | CI |

AC2: *A clean image build passes the MCP test/smoke contract and records installed direct dependency versions matching the lockfile; no unpinned npm install remains.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `npm ls --omit=dev --depth=0 --json` inside the built image reports the exact versions of `express` and `@supabase/supabase-js` declared in `package-lock.json` for those packages, and contains no `"invalid": true` entries | CI (new step in `.github/workflows/gymtrack-mcp-deploy.yml`) | CI |
| `grep -R "npm install" services/gymtrack-mcp/Dockerfile` returns nothing (only `npm ci` is permitted) | CI lint | CI |
| Vitest suite for `@sindustries/gymtrack-mcp` runs against the image's installed graph (extract a tarball of `node_modules` from the built image, then `npm test --workspace @sindustries/gymtrack-mcp` against that tree in a sibling image, OR rebuild the test stage from the same lockfile and run the same `npm ci`) — exact mechanism chosen in implementation | CI | CI |
| Image build is reproducible: rebuilding from the same commit and lockfile produces byte-identical installed versions for direct deps (compare `npm ls` JSON output across two consecutive builds) | CI (idempotent build check) | CI |
| Existing `/health` and `/.well-known/oauth-authorization-server` smoke checks (already in `.github/workflows/gymtrack-mcp-deploy.yml`) continue to pass against the canary deploy | E2E smoke (existing) | CI |

E2E coverage note: the ACs are build/CI contracts, not user-visible behavior. An E2E test for "the deployed image installs the same versions as CI" is exactly the new CI step above — it would not exercise additional user flows beyond what the existing `/health` + OAuth discovery smoke checks already cover. Lower-level fallback (`unit`/`integration`) does not apply because there is no unit to test here; the verification *is* the CI step.

## Open questions and risks

- **Open question:** does `npm ci --omit=dev --legacy-peer-deps` succeed when the lockfile declares workspace entries that are present in the local `apps/`, `packages/`, `services/` source trees copied into the builder stage? My current assumption is yes (npm resolves workspace deps from the filesystem during `npm ci`), but if it fails, the fallback is to copy all three workspace trees into the builder stage and re-verify. Implementation should confirm during the first CI run; if the build fails, the second-attempt fix is mechanical.
- **Open question:** will the image's node_modules size increase cause Fly's deployment context to approach any limits? Implementation will measure the resulting image size; if it materially exceeds the current ~200MB, a follow-up can trim via `npm prune --omit=dev --workspace=services/gymtrack-mcp` after install. Documenting the trade-off above rather than fixing it pre-emptively because the durable boundary is "install equals CI" and a prune layer would re-introduce drift.
- **Risk (medium):** `--legacy-peer-deps` continues to be required because of the existing `edgesOut` crash in npm 10. A future npm upgrade may make this flag unneeded; if/when npm upgrades (tracked separately under task `37f4d7d2`), revisit and remove it. Out of scope here.
- **Risk (low):** the new CI verification step adds ~1–2 minutes to the deploy workflow. Acceptable because it runs after the canary deploy, not before, so it does not block the existing `/health` smoke check or the deploy itself.

## Coordination with sibling task `2b66ae79`

Task `2b66ae79` (Align Fly deployment triggers with npm build inputs) changes `.github/workflows/gymtrack-mcp-deploy.yml` `paths:` to include `package-lock.json` and `package.json`. Both tasks touch the same workflow file in adjacent regions. Sequence:

1. Land `2b66ae79` first (it is already Quinn-approved and the path-filter change is mechanical).
2. Land this task second — its CI verification step goes between the canary deploy and the existing smoke check in the same job.

If the two PRs are open simultaneously, this PR's diff is `services/gymtrack-mcp/Dockerfile` plus the appended CI step; the `paths:` change from `2b66ae79` is already on `main` by the time this lands, so no merge conflict.
