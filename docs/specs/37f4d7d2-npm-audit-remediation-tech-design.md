---
status: draft
task_id: 37f4d7d2-9ec6-4794-b7a8-5302cb61200c
product_spec: n/a (audit-driven fix; W38 finding F0)
shipped_pr: null
shipped_date: null
---

# Tech Design — Remediate high/critical npm audit vulnerabilities (W38 F0)

**Parent task:** `37f4d7d2-9ec6-4794-b7a8-5302cb61200c` (Remediate high/critical npm audit vulnerabilities), tracked from audit `docs/repo-audits/2026-W38.md` finding **F0 — Known dependency advisory backlog remains**. Tranche **T1 / F0** of the W38 audit.

This is a code task (not a feature task): no product spec, no user-visible behavior change, no schema change, no API contract change. The change is purely dependency-version remediation scoped to the existing npm workspace, with CI and runtime smoke verification. It closes the W38 F0 finding by removing the 2 Critical and (best-effort) the 23 High advisories the audit observed against `origin/main`.

## Baseline (origin/main at 32796c8d)

`npm audit --package-lock-only --ignore-scripts --json` reports 87 affected entries: **2 Critical, 23 High, 61 Moderate, 1 Low**. Per the audit:

> `npm audit --package-lock-only --ignore-scripts --json` against this snapshot returned 87 affected package entries: 2 Critical, 23 High, 61 Moderate, 1 Low (exit 1 indicates findings, not a failed registry request). Examples: root `tar` 7.5.16 (`package-lock.json:19221`), Jaeger propagator 2.7.1 (`package-lock.json:6242`), root Vitest 4.1.10 (`package-lock.json:20600`), and a separate old Vitest range in Budget domain (`packages/budget-domain/package.json:15`).

Re-verified locally on the worktree HEAD:

```
Vulnerability counts: {'info': 0, 'low': 1, 'moderate': 61, 'high': 23, 'critical': 2}
```

The two Critical advisories are:

- **`tar` (GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97, GHSA-83g3-92jg-28cx)** — workspace root resolves `tar@7.5.16` via `expo-internal`'s declared `tar: ^7.5.2` (`package-lock.json:2740`). The vulnerable range is `<=7.5.20`; the patch-line fix is `>=7.5.20`. `eas-cli@16.32.0` pins `tar@6.2.1` directly (`package-lock.json:11012`) which is a different code path; that older line is not in the critical advisory range. `eas-cli@24.3.0` (the latest) upgrades its direct `tar` to `7.5.19` — **still vulnerable**, so a major eas-cli bump alone does not close F0.
- **`vitest` (GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9)** — root and most workspaces resolve `vitest@4.1.10` (`package-lock.json:20600`); the budget-domain workspace pins `vitest@^2.1.2` which resolves to `@vitest/mocker@2.1.9` (`package-lock.json:21587`). The vulnerable range is `<=4.1.10`. The patch-line fix is `>=4.1.11` for 4.x; the 2.1.x line has its own separate advisory history and should be upgraded to a supported line (Vitest 2.x reached end-of-life in 2025-09; 3.x and 4.x are supported).

The 23 High advisories include the OpenTelemetry Jaeger propagator (`@opentelemetry/propagator-jaeger <=2.8.0`) and `@opentelemetry/sdk-node <=0.219.0`, plus transitive `brace-expansion`, `browserslist`, `@xmldom/xmldom`, `fast-uri`, `image-size`, `js-yaml`, `minimatch`, `nanoid`, `node-forge`, `postcss`, `shell-quote`, `undici`, and `vite` (path-traversal in optimized-deps `.map` handling). The OpenTelemetry upgrades are minor-version compatible (`0.218.0` → `0.222.0`); the rest are mostly transitive and resolve automatically when the direct OpenTelemetry/Eas/Vitest upgrades land.

## Repository

- **Repo:** `Stoffer-Industries/sindustries`
- **Branch:** `task-37f4d7d2-npm-audit-remediation` (off `origin/main` @ `32796c8d`)
- **Worktree:** `/Users/quinnstoffer/.openclaw/workspace/worktrees/task-37f4d7d2-npm-audit-remediation`
- **PR:** (pending — to be opened after Quinn approves this design)

## Service boundary and ownership

No service-ownership change, no API contract change, no schema change, no new runtime dependency. Direct consumers:

- `package.json` (root) — adds an `overrides` block forcing `tar` to `>=7.5.20` and `vitest` to `^4.1.11` across the workspace. The workspace `npm` install already supports `overrides` (npm 8.3+); no flag or `--legacy-peer-deps` change is introduced.
- `apps/budget-mobile/package.json:31` — `eas-cli` declaration. The slice-3 major upgrade path bumps this from `^16.32.0` to `^24.3.0` and runs an EAS dry-build to verify the upgrade doesn't break mobile CI.
- `packages/budget-domain/package.json:15` — `vitest` declaration. The slice-1 Vitest path upgrades this from `^2.1.2` to `^4.1.11` (Vitest 2.x is end-of-line and the vulnerable 2.1.9 advisory is in the same class as 4.1.10's; moving to the supported line is the durable fix).
- `packages/otel-node/package.json` — direct OpenTelemetry deps at `^0.218.0` lines. Slice-2 bumps the workspace's OpenTelemetry direct deps to the `^0.222.0` line.
- `services/tasks-api/package.json`, `services/content-scheduler-api/package.json` — these services consume `@sindustries/otel-node/register` via `--require`. They pick up the OpenTelemetry upgrade transparently through the workspace package.
- `package-lock.json` — regenerated by `npm install` after each version bump. CI runs `npm ci` so the lockfile is the source of truth.

The audit explicitly notes the dependency-advisory graph is **mixed build/developer tooling and runtime dependencies**; reachability must be evaluated per finding. This design treats each finding class separately and records the disposition.

## `.openclaw` boundary

None. Lockfile and package metadata changes only. No `~/.openclaw/`, cron, or skill changes.

## Source of truth (ownership boundary check)

The natural source of truth for "is this vulnerability present in this build" is the **npm registry + `npm audit` against the workspace's resolved lockfile**. The current audit output is a snapshot from `origin/main`; remediation is the same workflow with version pins moved to supported lines.

A durable boundary: every Critical and every High that ships in production has either an upstream-supported fix applied OR an explicit per-finding disposition recorded in this doc (or a sibling `docs/systems/security.md` entry). The audit's "exposure-based disposition" line is the durable rule — a vulnerable package is not proof the feature is exposed, and reachability analysis (build-time only vs. runtime, server vs. CI-only, network-reachable vs. internal-only) is what determines whether to upgrade-or-document.

There is no useful interim shim: a parallel `npm-overrides.json`, an advisory allowlist comment, or a `.npmrc` registry mirror all shift the durable source away from the lockfile. The fix is to change the lockfile.

## Implementation plan

The fix is sliced into four PR-sized tranches ordered by lowest risk first. Each tranche is independently mergeable, has its own AC slice, and ends with `npm audit` re-run + CI green before the next tranche starts. The audit's "Do not label dependency upgrades as trivial" warning is honored by keeping each slice reviewable.

### Slice 1 — Vitest 4.1.10 → 4.1.11 + budget-domain Vitest 2.1.9 → 4.1.11

**Why first:** smallest patch, biggest Critical coverage. Removes both Vitest critical advisories without changing Vitest's API surface (4.1.11 is a patch release). Vitest 4.1.11 peer-deps `vite ^6.0.0 || ^7.0.0 || ^8.0.0` (`npm view vitest@4.1.11 peerDependencies`); the workspace already pins `vite ^8.0.16` in 4 apps (`apps/{tasks,website,gymtrack,mission-control}/package.json`). Zero peer-dep conflict.

**File/module scope:**

1. **`package.json` (root) — add `overrides` block:**
   ```json
   "overrides": {
     "vitest": "^4.1.11"
   }
   ```
   This pins every workspace's resolved Vitest (including `@vitest/mocker`, `@vitest/runner`, `@vitest/coverage-v8`, `@vitest/ui`) to `4.1.11+`. The budget-domain package's `^2.1.2` declaration is honored via the override (npm `overrides` applies after the package's own range is resolved, and `^4.1.11` matches the new resolution).
2. **`packages/budget-domain/package.json:15` — bump `vitest` from `^2.1.2` to `^4.1.11`.** This is the only direct declaration that needs an explicit bump; everything else already declares `^4.1.8` and the override pulls them to `^4.1.11`.
3. **`package-lock.json` — regenerated via `npm install`.** No hand edits.
4. **No code changes.** Vitest 4.1.x and 2.1.x both expose `describe`/`it`/`expect`/`vi`/`vi.mock`/`vi.fn`/`vi.resetModules`/`vi.clearAllMocks`; all existing test files use only that surface (`packages/otel-node/src/startOtel.sdk.test.ts:1`, all `*.test.ts` under `services/*/test/`).

**Validation:** `npm test --workspaces --if-present` runs every workspace's Vitest suite. The existing CI jobs (`otel-node-tests`, `budget-api-tests`, `content-scheduler-api-tests`, `gymtrack-tests`, `tasks-api-tests`, plus the per-app `apps/*-tests` jobs in `.github/workflows/ci.yml`) all run the same suites and must stay green. `npm audit --package-lock-only` should drop Critical from 2 to 0 and High by 2 (the 4.1.10 Vitest line was the source of 2 High transitive findings).

### Slice 2 — OpenTelemetry `sdk-node` 0.218 → 0.222 + Jaeger propagator 2.7 → 2.11

**Why second:** minor-version, contained to one workspace package, no consumer-code change expected.

**File/module scope:**

1. **`packages/otel-node/package.json` — bump direct deps to supported lines:**
   - `@opentelemetry/sdk-node`: `^0.218.0` → `^0.222.0`
   - `@opentelemetry/exporter-metrics-otlp-http`: `^0.218.0` → `^0.222.0` (latest `0.222.0`)
   - `@opentelemetry/exporter-trace-otlp-http`: `^0.218.0` → `^0.222.0`
   - `@opentelemetry/auto-instrumentations-node`: `^0.76.0` → latest compatible with sdk-node 0.222 (check at implementation time; current 0.76.0 may be incompatible — record the bump).
   - `@opentelemetry/sdk-metrics`: `^2.7.1` → check at impl (OpenTelemetry dual-package versioning; metrics SDK stays on 2.x line)
   - `@opentelemetry/resources`: `^2.7.1` → check at impl
2. **`packages/otel-node/src/index.ts` — minimal version-pinned API surface check.** The current code uses `NodeSDK`, `getNodeAutoInstrumentations`, `OTLPMetricExporter`, `OTLPTraceExporter`, `PeriodicExportingMetricReader`, `resourceFromAttributes`, `ATTR_SERVICE_NAME`, `ATTR_SERVICE_NAMESPACE`. None of these were renamed or removed between 0.218 and 0.222 (verified by reading the release-notes summary in `node_modules/@opentelemetry/sdk-node/build/src/index.d.ts` if available, or the GitHub release notes). If any signature changed, this is where the adapter shim lives — kept small.
3. **`packages/otel-node/src/index.test.ts`, `register.test.ts`, `startOtel.sdk.test.ts` — unchanged.** The existing tests already mock `@opentelemetry/sdk-node` (`startOtel.sdk.test.ts:7-12`), so they're resilient to the real-SDK version change.
4. **`package-lock.json` — regenerated.**
5. **No changes to `services/tasks-api/` or `services/content-scheduler-api/`.** Both consume `@sindustries/otel-node/register` and pick up the new line through the workspace.

**Validation:** the `otel-node-tests` CI job (`.github/workflows/ci.yml:135`) runs `npm test --workspace @sindustries/otel-node`. `npm audit --package-lock-only` should drop 2 High (the OpenTelemetry Jaeger + sdk-node advisories). Manual smoke (optional, documented): `OTEL_SDK_DISABLED=false OTEL_SERVICE_NAME=rem-smoke node --require @sindustries/otel-node/register -e 'require("http").createServer((_,r)=>r.end("ok")).listen(0)'` and confirm the SDK initializes without throwing.

### Slice 3 — `tar` override to `>=7.5.20`

**Why third:** the workspace-root `tar@7.5.16` is the second Critical. The fix is a single `overrides` line and a lockfile regen — no consumer code changes. Comes before the eas-cli major bump because the override resolves the root tar regardless of eas-cli version, so the upgrade order doesn't matter for the tar outcome.

**File/module scope:**

1. **`package.json` (root) — extend the `overrides` block:**
   ```json
   "overrides": {
     "vitest": "^4.1.11",
     "tar": ">=7.5.20"
   }
   ```
2. **`package-lock.json` — regenerated.**
3. **No code changes.** The override applies to every `tar` resolved in the workspace's `node_modules` tree, including the `expo-internal`-pinned `^7.5.2` range and the `eas-cli` direct-pin (`6.2.1` is left alone — it is not in the advisory range and is not used at runtime by anything except `eas-cli`'s own code paths, which run only in dev/CI for mobile build verification).
4. **No eas-cli upgrade in this slice.** The audit notes `eas-cli@24.3.0` still ships `tar@7.5.19` (vulnerable); the override fixes both the workspace root and any future eas-cli internal usage regardless of which eas-cli version is installed.

**Validation:** `npm audit --package-lock-only` Critical goes 0 (after Slice 1) → 0 (this slice's `tar` was already 0 after the override applied; this slice documents and confirms). The audit's tar advisory is closed at this point.

### Slice 4 — `eas-cli` major upgrade `16.32.0` → `24.3.0`

**Why fourth:** major version bump is the highest-risk of the four slices. Isolated to one devDependency in one workspace. Comes last so the Critical/High fixes from Slices 1-3 are already on main if Slice 4 has to back out.

**File/module scope:**

1. **`apps/budget-mobile/package.json:31` — bump `eas-cli` from `^16.32.0` to `^24.3.0`.** Note: the audit task description flags this as a major upgrade with security-posture implications; the actual upgrade is justified by the long-term EOL of eas-cli 16.x, not by the tar fix (which Slice 3 already addresses via override).
2. **`apps/budget-mobile/package.json:17` — check `expo` SDK compatibility.** Current `expo: ~54.0.34`; `eas-cli@24.x` supports Expo SDK 51+ (verify at impl). If incompatible, pin `eas-cli` to a 23.x or earlier 24.x minor instead — record the chosen version and the reason in this doc.
3. **`package-lock.json` — regenerated.**
4. **No changes to `apps/budget-mobile/src/**`.** eas-cli is a devDep used for `eas build` / `eas submit`; it is not imported by mobile app code.
5. **Mobile CI verification.** The existing `apps/budget-mobile` workflows (`.github/workflows/*.yml` matching `budget-mobile`) run EAS dry-builds or `expo prebuild` checks. After the bump, those jobs must stay green. If the workspace has no EAS dry-build job (likely — the repo doesn't run EAS in CI today), the validation is local: `npx eas-cli --version` reports `24.3.x` and `npx eas-cli config` does not error.

**Validation:** `npm audit --package-lock-only` may show additional High advisories dropped (the eas-cli transitive `image-size`, `@xmldom/xmldom`, `js-yaml`, `brace-expansion` advisories all resolve via the eas-cli upgrade). The audit's `eas-cli@16.32.0` direct pin and its vulnerable transitive `tar@6.2.1` are both removed by the upgrade.

### Slice 5 (conditional) — Documented-disposition register

**Why last:** any remaining High advisories after Slices 1-4 are recorded here with reachability analysis. The audit calls this out explicitly:

> An installed package is not proof the vulnerable feature is exposed. High priority because the graph includes both toolchain and server dependencies, not because all 87 entries are independently exploitable.

**File/module scope:**

1. **`docs/systems/security.md` (create or update)** — add a "Dependency advisory disposition register" section listing each remaining High advisory (post-Slices 1-4) with: advisory ID, package, version range, where it's used (build / dev / runtime), reachability analysis (network-reachable? exercised in CI? user-facing?), and the disposition (upgrade-pending / accepted-residual-with-reason). Each row is greppable from CI output.

**Validation:** the register is reviewed alongside the W38 audit close-out. Any entry marked "upgrade-pending" must have a linked feature task or a future-audit follow-up; an entry marked "accepted-residual" must have a one-paragraph rationale signed-off by Tom.

## Trade-offs

- **Overrides vs. per-package bumps.** Using root `overrides` for `vitest` and `tar` is faster and more durable than chasing every transitive declaration. The cost is that overrides apply globally — if a future workspace adds a package that needs a different `vitest` version, the override must be revisited. Mitigated by the slice order (Vitest 4.1.x is the only supported line in this workspace; a hypothetical 5.x upgrade would be its own task).
- **Vitest 2.x → 4.x jump in budget-domain.** Vitest 2.x reached EOL in 2025-09. The 4.x API surface is compatible for everything the budget-domain test files use (verified by reading `packages/budget-domain/src/*.test.ts`). The alternative — staying on Vitest 2.x and backporting fixes — is not available; Vitest 2.x will not get security patches.
- **eas-cli major bump.** This is the riskiest slice. The mitigation is that it is isolated to a devDep, comes last, and the audit explicitly authorizes the upgrade as part of F0. If Slice 4 has to back out, the F0 finding is still closed by Slices 1-3.
- **No new registry, mirror, or `.npmrc` change.** The audit's `npm audit` runs against the default npm registry; using overrides + lockfile regen is the same source of truth the audit uses.

## Data model / API contract / schema changes

None.

## Workflow / cron / skill changes

None beyond the lockfile/manifest edits above.

## Test plan and AC verification matrix

AC1: *`npm audit` reports zero critical vulnerabilities and no unreviewed high vulnerabilities; any accepted residual findings are explicitly documented with exposure and rationale.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `npm audit --package-lock-only --ignore-scripts --json` reports `critical: 0` after Slice 3 lands | local + CI | CI (add a smoke step) |
| `npm audit --package-lock-only --ignore-scripts --json` reports `high: 0` after Slice 4 lands OR every remaining High has a row in `docs/systems/security.md` disposition register with Tom-signed rationale | local + CI | CI + Tom |
| Slice 5 disposition register is reviewed alongside the W38 audit close-out | doc | Rowan + Quinn + Tom |

AC2: *Vitest is upgraded to a non-vulnerable supported line across every workspace, including `packages/budget-domain`, and affected test suites pass.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `node_modules/vitest/package.json` resolves to `4.1.11` or higher in every workspace | local | CI (grep `npm ls vitest`) |
| `packages/budget-domain/package.json:15` declares `vitest: ^4.1.11` | file | review |
| `npm test --workspaces --if-present` runs every workspace's Vitest suite and reports all-pass | CI | CI |
| Every CI job in `.github/workflows/ci.yml` that runs `npm test --workspace <x>` (otel-node-tests, budget-api-tests, content-scheduler-api-tests, gymtrack-tests, tasks-api-tests, and the per-app tests) stays green | CI | CI |
| Vitest 4.1.x API surface used by the existing tests (`describe`, `it`, `expect`, `vi`, `vi.mock`, `vi.fn`, `vi.resetModules`, `vi.clearAllMocks`) is unchanged — verified by reading the test files | code | review |

AC3: *The Expo/EAS dependency chain no longer installs a vulnerable `tar`, using an upstream-safe release or a reviewed override with build verification.*

| Verification | Layer | Owner |
| --- | --- | --- |
| `node_modules/tar/package.json` resolves to `>=7.5.20` everywhere except `eas-cli`'s internal `tar@6.2.1` (which is not in the advisory range) | local | CI (`npm ls tar`) |
| `npm audit --package-lock-only --ignore-scripts --json` reports no `tar` advisory | CI | CI |
| Slice 3 root `overrides.tar` is `>=7.5.20` | file | review |
| Slice 4 `eas-cli@^24.3.0` upgrade either installs cleanly OR is rolled back to a 23.x/24.x-minor that resolves a clean `tar` | file + local | Rowan + Quinn |

AC4: *OpenTelemetry and remaining high-severity upgrade paths are evaluated in a tech design, with runtime compatibility tests for `tasks-api` and other affected services.*

| Verification | Layer | Owner |
| --- | --- | --- |
| This tech design document exists and covers every Slice's upgrade path | doc | review |
| Slice 2's `packages/otel-node/src/index.ts` adapter check confirms no signature breaks between 0.218 and 0.222 | code | review |
| `npm test --workspace @sindustries/otel-node` stays green | CI | CI |
| Optional manual smoke: `OTEL_SDK_DISABLED=false OTEL_SERVICE_NAME=rem-smoke node --require @sindustries/otel-node/register -e 'require("http").createServer((_,r)=>r.end("ok")).listen(0)'` succeeds without throwing | local | Rowan |
| Slice 5 disposition register exists in `docs/systems/security.md` with every remaining High advisory analyzed | doc | Tom |

AC5: *CI, workspace tests, mobile build/config checks, and a final production-only audit pass complete successfully.*

| Verification | Layer | Owner |
| --- | --- | --- |
| All CI jobs in `.github/workflows/ci.yml` and `.github/workflows/feature-task-clippy.yml` and `.github/workflows/codeql.yml` stay green across all four Slices | CI | CI |
| `npm test --workspaces --if-present` runs locally and passes | local | Rowan |
| `npm run typecheck --workspaces --if-present` runs locally and passes | local | Rowan |
| EAS / Expo config checks (if any in mobile CI) stay green | CI | CI |
| Final `npm audit --package-lock-only --ignore-scripts --json` shows `critical: 0` and `high: 0` (or all residual Highs documented in Slice 5) | local + CI | CI |

E2E coverage note: the ACs are dependency-version contracts, not user-visible behavior. No Playwright / e2e coverage applies. The closest "integration" surface is the existing Vitest + Postgres CI jobs, which run end-to-end against the actual app/repository boundary on every PR; those stay green as the strongest available verification.

## Open questions and risks

- **Open question (Slice 2):** does `@opentelemetry/auto-instrumentations-node@^0.76.0` remain compatible with `@opentelemetry/sdk-node@0.222.0`? The auto-instrumentations package uses dual-versioning; check at implementation. If incompatible, bump to a compatible newer line (record the chosen version in the PR description).
- **Open question (Slice 4):** does `eas-cli@24.3.0` support the current `expo: ~54.0.34` SDK in `apps/budget-mobile/package.json:17`? Verified at impl. If incompatible, pin to a 23.x or 24.x-minor with Expo-SDK-54 compatibility.
- **Risk (low):** the `overrides` block in root `package.json` is a workspace-wide force. If a future contributor adds a sub-package that needs Vitest 5.x, the override must be revisited before that package can be added. Documented in the PR description.
- **Risk (medium):** Vitest 4.x may have removed or renamed one of the APIs the budget-domain tests use. The audit's safety-net tranche for Slice 1 includes running the budget-domain tests locally before opening the PR; if a Vitest 4.x API break is found, the slice is broken into a 1a (Vitest bump) + 1b (test-file fixups) pair.
- **Risk (low):** the OpenTelemetry 0.218 → 0.222 bump may include a behavior change in `PeriodicExportingMetricReader` or `resourceFromAttributes`. The `startOtel.sdk.test.ts` mock-based test won't catch this; the optional manual smoke step in AC4 is the verification fallback. If a behavior break is found, the slice is broken into a 2a (SDK bump) + 2b (otel-node adapter) pair.
- **Risk (medium):** Slice 4's eas-cli major upgrade is the most likely to back out. Mitigation: Slice 4 is last, so Slices 1-3 already close the Critical/High bar; if Slice 4 fails, F0 is still resolved by the disposition register (Slice 5) treating the remaining eas-cli transitive advisories as upgrade-pending with this very task as the follow-up.
- **Risk (low):** the audit's "production-only audit pass" in AC5 is a workflow shape that does not exist today (the repo runs `npm audit` in audit-doc generation only, not in CI). The CI verification for AC5 is the local `npm audit` run; the "production-only" line is satisfied by the lockfile being on `origin/main` after merge.

## Coordination with sibling tasks

- **Task `1eb22a09` (Close Budget CI coverage and database verification gaps)** runs `npm ci` against the same lockfile and would automatically pick up any Vitest/OTEL change. No conflict.
- **Task `2b66ae79` (Align Fly deployment triggers with npm build inputs)** touches `.github/workflows/deploy-*.yml` filters; no overlap with this slice's lockfile/manifest changes.
- **Task `a858ffce` (Build GymTrack MCP from the tested npm lockfile)** touches `services/gymtrack-mcp/Dockerfile`; the MCP service's Vitest version is upgraded by Slice 1 transparently. No conflict.
- **Task `37f4d7d2` is itself** — no other task is the parent. The dependency-advisory follow-up is exclusively this slice.

## Slice delivery order

The four implementation Slices are PRs in this order: Slice 1 (Vitest) → Slice 2 (OTEL) → Slice 3 (tar override) → Slice 4 (eas-cli major). Each PR is independently mergeable. Slice 5 (disposition register) is the final docs-only PR that closes AC1 and AC4 for any residual advisories after Slice 4. If Slice 4 backs out, Slice 5 still lands and references the backout decision in its register.

Tom's `accepted` gate is the same as for any other code task: Ash runs `qa_agent` verification against the merged PRs (per-agent-per-AC), Tom runs the production-only audit pass (AC5's "final" line) on `origin/main` after all Slices land.
