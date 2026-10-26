---
status: draft
task_id: 876114be-4bac-495c-a414-02ed9b5c205d
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Backend TypeScript Compiler Gate (Tasks, Budget, Scheduler) — Tech Design

## Links

- Task: `876114be-4bac-495c-a414-02ed9b5c205d` (💻 "Add a ratcheting TypeScript compiler gate for the Tasks, Budget and Scheduler APIs")
- Task API detail: `http://localhost:4001/api/v1/tasks/876114be-4bac-495c-a414-02ed9b5c205d`
- Research task (complete): `fbe5aa19-aec0-47f3-8c5c-9fdeedccfc3c` — baseline investigation
- Research deliverable: `brain/research/w43-backend-typecheck-baseline.md` (private workspace repo, not committed to `sindustries`)
- Audit ledger: `docs/repo-audits/2026-W44.md` F5 (line 83) — already carries `➡️ Tracked by task 876114be (…)`; the audit-ledger edit is **not** part of this task
- Prior finding: `docs/repo-audits/2026-W43.md` F5 (carried forward)

## Scope

- Repository: `Stoffer-Industries/sindustries`
- Branch: `task-876114be-backend-typecheck-gate`
- Worktree: `/Volumes/WD1/worktrees/rowan/task-876114be-backend-typecheck-gate`
- Primary surfaces:
  - `services/{tasks-api,budget-api,content-scheduler-api}/tsconfig.json` — compiler/runtime alignment (AC1)
  - `services/{tasks-api,budget-api,content-scheduler-api}/package.json` — `typecheck` script (AC2)
  - `services/{tasks-api,budget-api,content-scheduler-api}/typecheck-baseline.json` — committed per-service baseline (AC3, AC5)
  - `scripts/typecheck-gate.mjs` — shared comparison tool: run / compare / regenerate (AC3)
  - `scripts/test/typecheck-gate.test.mjs` — gate self-test incl. the intentional-type-error fixture (AC3)
  - `.github/workflows/ci.yml` — gate step in three existing service jobs + one new self-test job (AC2, AC3)
  - `services/tasks-api/src/lib/qaEvidenceAttestation.ts`, `services/tasks-api/src/config/requiredApprovals.ts`, `services/tasks-api/test/{taskAttentionOwners,workflowGatesRouteLayer}.test.ts` — the three latent defects (AC4)
- No `.openclaw` runtime change, no API route, no database table/migration, no shared package, no new GitHub Actions permissions.
- No user-visible app behaviour changes → no `apps/*/SPEC.md` change is required by this task (see "App spec" below).

## Problem Summary

`tasks-api`, `budget-api` and `content-scheduler-api` run under `tsx` (esbuild) with **no compiler gate anywhere**. `services/tasks-api/package.json` has no `typecheck` script; the only compiler invocations in CI are `packages/budget-domain` and `apps/budget-mobile` (`ci.yml:536-540`). Type errors therefore reach `main` unnoticed, and `vitest` does not typecheck (no service has a `typecheck` block in its vitest config).

The naive fix — add `tsc --noEmit` to CI — fails every build, because **107 of the 186 current diagnostics are a compiler/runtime mismatch, not defects**. The three services declare `"type": "module"` and `moduleResolution: NodeNext` (which demands explicit `.js` extensions), while the runtime is `tsx`, which resolves extensionless *and* `.ts`-suffixed relative imports. The compiler is modelling a runtime these services do not use.

Measured at `main` = `6c33d383`, 2026-10-26, `tsc` 5.9.3, Prisma clients generated, repo root `node_modules/.bin/tsc`:

| Service | as-configured (NodeNext) | with `module: esnext` + `moduleResolution: bundler` |
| --- | --- | --- |
| `tasks-api` | 80 | 60 |
| `budget-api` | 83 | **0** |
| `content-scheduler-api` | 23 | 19 |
| **total** | **186** | **79** |

(Reproduced with CLI overrides only — no file was edited to produce these numbers. Raw output: `/tmp/rowan-tc-w44/*.base.txt`, `/tmp/rowan-tc-w44/*.bundler.txt`.)

The 107-diagnostic gap is entirely `TS2835`. After alignment the remaining 79 are real:

| Service | Count | Codes (after alignment) |
| --- | --- | --- |
| `tasks-api` | 60 | TS2339 ×29, TS2554 ×10, TS2538 ×8, TS2363 ×3, TS2362 ×3, TS2345 ×2, TS2304 ×2, TS2739 ×1, TS2322 ×1, TS1117 ×1 |
| `budget-api` | 0 | — |
| `content-scheduler-api` | 19 | TS2339 ×11, TS2345 ×8 |

Three of those 79 are **latent defects the test suite cannot see**, and they are the most valuable output of the whole exercise:

1. `services/tasks-api/src/lib/qaEvidenceAttestation.ts:112-113` — `AttestationVerdict` and `QaAttestation` exist only in JSDoc. The attestation shape that gates QA approvals has **no compiler-checked contract at all**.
2. `services/tasks-api/src/config/requiredApprovals.ts:225` — `parseRequiredApprovalsYaml` is declared to return `RequiredApprovalsConfig` but returns an object missing `path`/`hash`. The declared type lies about the runtime shape; four test call sites use the exported function directly.
3. `services/tasks-api/src/lib/…` → `mapTask(task, options)` declares `options` as required, but the implementation tolerates `undefined` (`options?.requiredApprovalTypes ?? []`). Ten test call sites omit it, so `workflowGates` is **always empty** in those tests — the attention-owner tests never exercise the workflow-gate path they appear to cover.

## Product intent

No end-user feature is in scope. The product intent is delivery safety: make it impossible for a type error to enter `main` unnoticed in the three backend API services, without pretending the existing debt is already paid. The gate must be **honest** (it must not be satisfiable by suppressing diagnostics) and it must be **ratcheting** (the debt may shrink, never grow).

## Decision 1 — Align the compiler with the runtime before any gate exists

**Decision:** change two keys in each of the three service `tsconfig.json` files:

```diff
-    "module": "NodeNext",
-    "moduleResolution": "NodeNext",
+    "module": "ESNext",
+    "moduleResolution": "bundler",
```

Measured effect: 186 → 79 with **zero source edits**; `budget-api` → 0.

Rejected alternatives:

- **Rewrite imports to `.js` extensions** (the NodeNext-correct style): 133 distinct specifiers across three services, and it would fight the 139 existing `.ts`-suffixed imports that only `tsx` can load. The runtime is `tsx`; the compiler should model the runtime, not an aspirational future build.
- **A separate `tsconfig.typecheck.json`**: keeps the editor showing 107 phantom errors and creates two configs to drift.
- **Gate against the current config and fix all 186**: mixes a compiler-semantics change with a large source change; the diff becomes unreviewable and neither change can be attributed if something breaks. Research risk #2.

**Coupling to state explicitly:** `moduleResolution: bundler` is runtime-coupled to `tsx`. It removes the check that would catch a future move to compiled `node dist/*.js` output. The service already depends on `tsx` semantics in 139 places, so this does not create the hazard — it stops hiding it. The tsconfig will carry a comment recording that the setting is coupled to the `tsx` runtime, and any future move to a compiled runtime must revisit it in the same PR.

## Decision 2 — The gate is a committed per-service baseline plus a shared comparison tool

**Decision:** one shared, stateless tool + one committed baseline file per service.

```
scripts/typecheck-gate.mjs                       # shared tool: --service <svc> [--write-baseline]
services/tasks-api/typecheck-baseline.json       # committed baseline (per service)
services/budget-api/typecheck-baseline.json
services/content-scheduler-api/typecheck-baseline.json
```

Baseline shape (JSON, deterministic, sorted, diff-friendly):

```json
{
  "service": "tasks-api",
  "generatedAt": "2026-10-26",
  "generatedBy": "npm run typecheck:baseline --workspace services/tasks-api",
  "tscVersion": "5.9.3",
  "totalDiagnostics": 47,
  "fingerprints": {
    "src/routes/tasks.ts:TS2339:Property 'x' does not exist on type '{}'": 16
  }
}
```

Rules the tool enforces (all must hold for the gate to pass):

- **R1 — count ratchet:** current diagnostic total ≤ baseline `totalDiagnostics`.
- **R2 — no new fingerprint:** every current fingerprint must exist in the baseline, and its current count must be ≤ its baseline count. A fingerprint present now but absent from the baseline is a **hard failure** even if R1 passes.
- **R3 — baseline presence:** a missing or unparseable baseline file is a hard failure. Deleting the baseline must not silently disable the gate.
- **R4 — toolchain pinning:** the recorded `tscVersion` must match the `tsc` actually used, otherwise the run fails with a "regenerate the baseline deliberately" message. The services declare `typescript: ^5.8.2`, so a lockfile bump can move diagnostics; that must be a reviewed act.

Rejected alternatives:

- **Bare count only** (`total ≤ baseline`): gameable — fix one error, introduce another, count unchanged. AC5 forbids suppression; a count-only gate is suppression-adjacent because it permits a swap. R2 closes that hole.
- **Per-code lock** (e.g. "no TS2339 allowed at all"): brittle — the research explicitly rejects it, and it punishes unrelated fixes.
- **`|| true`**: global suppression with extra steps; the count would drift upward forever with no signal.
- **Baseline auto-rewritten by CI**: a CI job that rewrites its own baseline is indistinguishable from no gate. The tool never writes the baseline in gate mode; `--write-baseline` is a local, deliberate, human-initiated act whose diff is reviewed in the PR.

**Fingerprint granularity:** `<repo-relative-path>:<TS code>:<normalized message>`. Path + code alone would miss a same-file/same-code swap; including the message catches it. Line and column numbers are deliberately excluded — they churn on every unrelated edit above the error and would make the baseline unusable. The known limit, stated honestly: two diagnostics with the identical path, code and message text are indistinguishable to the tool; R1 still catches net growth.

## Decision 3 — CI runs the service's own `typecheck` script through the gate wrapper

AC2 requires each service to expose a `typecheck` script that runs `tsc --noEmit`, and CI to run it after `prisma:generate`. AC3 requires the gate to tolerate the existing baseline while failing on growth. Those two only reconcile if CI runs the compiler through the comparison tool, because plain `tsc --noEmit` exits non-zero whenever any diagnostic exists.

**Decision:**

- Each service's `package.json` gains:
  ```json
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "typecheck:baseline": "node ../../scripts/typecheck-gate.mjs --service tasks-api --write-baseline"
  ```
- The gate tool **invokes the service's `typecheck` script** (`npm run typecheck --workspace services/<svc>`) as a child process, parses its diagnostics, and applies R1–R4. One source of truth for the compiler invocation: the `typecheck` script defines it, the tool consumes it, CI runs the tool.
- CI step in each of the three service jobs, placed **immediately after** the existing `Generate Prisma client` step:
  ```yaml
  - name: Typecheck gate (tasks-api)
    run: npm run typecheck:gate --workspace services/tasks-api
  ```
  where `typecheck:gate` is `node ../../scripts/typecheck-gate.mjs --service tasks-api`.

`prisma:generate` ordering is already correct in all three jobs (`ci.yml`: `tasks-api-tests` → "Generate Prisma client", `content-scheduler-api-tests` → "Generate Prisma client", `budget-api-unit` → "Generate Prisma client"), so AC2's ordering requirement needs no CI restructuring — only a new step.

**Failure-mode handling in the tool (no silent fallbacks):**

| Condition | Behaviour |
| --- | --- |
| `tsc` exits non-zero, ≥1 diagnostic parsed | Normal case — apply R1/R2, exit 0 if within baseline |
| `tsc` exits non-zero, 0 diagnostics parsed | Hard fail: "tsc failed without emitting diagnostics" (bad tsconfig, missing binary) |
| Diagnostics contain `TS2305`, `TS2307`, or `TS2614` for `@prisma/client`, or `TS2307` for `generated/prisma` | Hard fail with a pointed hint: run `npm run prisma:generate` before the gate |
| Baseline file missing / unparseable | Hard fail (R3) |
| `tscVersion` mismatch | Hard fail (R4) with "regenerate deliberately" |

## Decision 4 — CI placement: existing jobs for the gates, one new job for the gate's own tests

- The three service gates are steps inside the **existing** jobs `tasks-api-tests`, `content-scheduler-api-tests` and `budget-api-unit`. All three are already listed in `merge-gate.needs` (`ci.yml`), so **no new required job, no merge-gate wiring change, and no branch-protection change** are needed for the gates themselves.
- The gate's own self-test (including the AC3 fixture) needs a home that is not a service job. A new CI job `typecheck-gate-tests` is added (`checkout` → `setup-node` → `npm ci` → `node --test scripts/test/typecheck-gate.test.mjs`) and **is** added to `merge-gate.needs`, because `infra/cloud/scripts/tests/ci-deployment-gates.test.sh` derives the required job set from `ci.yml` — a verifier job that is not in `merge-gate.needs` fails that contract test. Adding the job and the `needs` entry together keeps the two in sync.

## Decision 5 — The three latent defects are fixed in this task, not baselined as debt

AC4 permits "resolved or explicitly recorded as accepted debt". **Decision: fix all three.** They are small (13 diagnostics), they are the compiler's highest-value output, and two of them are contract lies rather than typing nits.

1. **`qaEvidenceAttestation.ts`** — define `AttestationVerdict` and `QaAttestation` as real exported types in the module that owns the attestation contract, and import them. The QA-gating attestation shape becomes compiler-checked for the first time.
2. **`requiredApprovals.ts:225`** — correct the declared return type of `parseRequiredApprovalsYaml` to the shape it actually returns (`path`/`hash` are added by the loader afterwards), or split the type so the loader returns `RequiredApprovalsConfig` and the parser returns the pre-hash shape. The exported contract stops lying; the four direct test call sites keep working.
3. **`mapTask(task, options)`** — pass `mapTaskOptionsFor(task)` at the ten test call sites (`taskAttentionOwners.test.ts` ×7, `workflowGatesRouteLayer.test.ts` ×3) rather than making `options` optional. Making it optional would silence the compiler while leaving `workflowGates` permanently empty in those tests; fixing the call sites restores the workflow-gate coverage the tests appear to provide.

Projected baseline after alignment + these three fixes: **66** (79 − 13): `tasks-api` 47, `budget-api` 0, `content-scheduler-api` 19.

## Decision 6 — `strict` stays off; nothing is suppressed

AC5 is explicit: `strict` is not enabled wholesale and no diagnostic is suppressed to make the gate pass. This design holds that line:

- `strict` stays `false` in all three services. Enabling it wholesale measures 369 diagnostics (research AC1 matrix); `noImplicitAny` alone adds 166 `TS7006`. That is a separate, sequenced workstream, not a side effect of adding a gate.
- No `@ts-ignore` / `@ts-expect-error` / `// @ts-nocheck` is added anywhere. The gate compares diagnostics, so a suppression is indistinguishable from a fix in the count — which is exactly why the baseline diff is reviewed.
- `skipLibCheck: true` stays. Third-party declaration errors are explicitly **out of the gate's scope**, and the baseline records that boundary so nobody assumes dependency types are covered.
- `noEmit: true` and `allowImportingTsExtensions: true` stay — both are required by the `tsx` execution model and by `moduleResolution: bundler`.

## Decision 7 — The committed baseline documents counts before and after

AC5 requires the committed baseline to document the counts before and after. The baseline file records:

- `totalDiagnostics` for the aligned state, and the PR body states the full progression: **186 (as-configured) → 79 (after compiler/runtime alignment, no source edits) → 66 (after the three latent-defect fixes)**.
- The research's before/after matrix is quoted in the PR description (not the AC checklist, which stays out of non-implementation artifacts).

## Service boundary and ownership

- **Source of truth:** each service owns its own `tsconfig.json` and its own `typecheck-baseline.json` — service-local, colocated with the code it describes. The shared tool in `scripts/` is **stateless**: it reads a service's config and baseline and writes nothing. There is no duplicated metadata and no second source of truth; the baseline is the only record of accepted debt and it lives with the service that owns the debt.
- **No new service, route, table, migration, queue, cron, worker or external integration.** No domain data moves. The gate adds no runtime dependency on any service.
- **Direct consumers:** CI (`.github/workflows/ci.yml`) and developers running `npm run typecheck:gate --workspace services/<svc>` locally. No app or service consumes the baseline at runtime.
- **Why not a shared package:** a shared `packages/typecheck-gate` npm package would add a publish/build surface and a version-skew risk for a script that only CI runs. The repo's existing convention for repo-wide tooling is root `scripts/*.mjs` (`check-migration-prefixes.sh`, `check-no-absolute-paths.mjs`), and this follows it.
- **Temporary placement / migration plan:** none — the placement is the durable one.

## `.openclaw` boundary

None. This work touches only the `sindustries` repo. It requires no agent runtime config, no OpenClaw permission change, and no workflow/skill change. The gate is enforced by GitHub Actions, not by an agent heartbeat.

## Data model / API contract changes

None. No route, request/response shape, event, or persisted record changes. The only new structured artefact is the per-service baseline JSON, which is build metadata, not domain data.

## Implementation plan

**Slice 1 — align the compiler (AC1).** Edit three `tsconfig.json` files (2 keys each + the runtime-coupling comment). Re-measure all three services; assert 186 → 79 and `budget-api` → 0, with `git diff --stat` showing zero changes under `services/*/src` and `services/*/test`.

**Slice 2 — script + tool + baselines (AC2, AC3, AC5).**
1. `scripts/typecheck-gate.mjs` — child-process runner, diagnostic parser, R1–R4 comparison, `--write-baseline` mode.
2. `scripts/test/typecheck-gate.test.mjs` — node:test suite (see Test Plan).
3. `services/<svc>/package.json` — add `typecheck`, `typecheck:gate`, `typecheck:baseline` scripts.
4. Generate the three baseline files with `--write-baseline`; commit them.

**Slice 3 — fix the three latent defects (AC4).** `qaEvidenceAttestation.ts`, `requiredApprovals.ts`, and the ten `mapTask` test call sites. Re-measure; expect 79 → 66. Regenerate the `tasks-api` baseline.

**Slice 4 — wire CI (AC2, AC3).** Add the gate step to the three service jobs after `prisma:generate`; add the `typecheck-gate-tests` job and its `merge-gate.needs` entry.

**Slice 5 — docs.** Update `docs/systems/` if a system doc describes the backend build/CI contract; add a short "how to run the gate / how to pay down debt" section to `CONTRIBUTING.md` (the repo already documents CI expectations there). No app `SPEC.md` change — no user-visible behaviour changes.

## Test plan — AC verification matrix

| AC | Verification | Layer |
| --- | --- | --- |
| AC1 | Before/after measurement per service: `tsc --noEmit -p services/<svc>/tsconfig.json` with generated Prisma clients. Assert totals 186 → ≤79 after the tsconfig change alone, `budget-api` = 0, and `git diff --name-only` shows **no** changes under any `src/` or `test/` directory in slice 1 | manual measurement (reproducible command), recorded in the PR body |
| AC2 | `npm run typecheck --workspace services/<svc>` runs `tsc --noEmit`; `ci.yml` shows the gate step immediately after "Generate Prisma client" in all three jobs | CI config + shell assertion in the self-test |
| AC3 | (a) **Fixture:** `scripts/test/typecheck-gate.test.mjs` creates a temp project with one intentional type error, generates its baseline (0 diagnostics), adds the error, and asserts the gate exits non-zero with the error named. (b) **Ratchet:** baseline with 1 fingerprint, current set has it plus one more ⇒ gate exits non-zero; current total above baseline ⇒ non-zero; current set equals baseline ⇒ exit 0. (c) **Environment guards:** a real installed-but-ungenerated `@prisma/client` declaration stub produces the expected pointed failure; inconsistent baseline totals and non-tsc scripts fail closed. | node:test (unit + temp-dir integration) |
| AC4 | Each of the three defects fixed; diagnostics for `qaEvidenceAttestation.ts` (TS2304 ×2), `requiredApprovals.ts` (TS2739) and the ten `TS2554` call sites gone from the `tasks-api` output; the attention-owner/workflow-gate tests still pass with `workflowGates` populated (assert a non-empty `workflowGates` in at least one of the previously-empty call sites) | compiler output + existing vitest suites + one strengthened assertion |
| AC5 | `strict` unchanged (`false`) in all three tsconfigs; `git diff` shows no `@ts-ignore`/`@ts-expect-error`/`ts-nocheck` added; baseline file records `totalDiagnostics` and the PR body documents 186 → 79 → 66 | diff review + `git grep` assertion in the self-test |
| Process | This document committed on `task-876114be-backend-typecheck-gate`; `[tech-design]` comment posted; Quinn's structured `tech_design` approval recorded **before** any implementation slice starts | task API read-back |

**E2E coverage:** not applicable — no user-visible app flow changes. The fallback layers are the compiler output itself, the node:test gate self-test, and the existing service vitest suites.

## App spec

No `apps/*/SPEC.md` update: this task changes no user-visible behaviour in any app. The closest user-facing surface (Mission Control) sees no change to task or budget data shapes.

## Open questions / risks

1. **Risk — `moduleResolution: bundler` is runtime-coupled.** Mitigation: comment in the tsconfig, recorded in this design, and a follow-up obligation if any service ever moves off `tsx`. The comment also records the resolution-condition difference (`bundler` implies TypeScript's `import`/`types` conditions; `tsx`/esbuild on Node resolves with `node`/`import`/`default`), so a future dependency whose `exports` map branches on a `node` condition is a visible follow-up trigger. This is the single change most likely to surprise a future reader.
2. **Risk — the baseline is only valid with generated Prisma clients.** Mitigation: CI orders `prisma:generate` before the gate; the tool hard-fails with a pointed hint for both installed-but-ungenerated bare `@prisma/client` shapes (`TS2305`/`TS2614`) and missing relative generated clients (`TS2307`). Mitigation #2: the tool also fails on a `tscVersion` mismatch, so a TypeScript lockfile bump forces a deliberate baseline review.
3. **Risk — a count-plus-fingerprint ratchet can still be gamed in principle.** Mitigation: R2 catches the realistic swap (new fingerprint or a higher per-fingerprint count); R1 catches net growth; the limit (identical path + code + message) is stated above rather than glossed. This is a guard rail, not a substitute for review — the design does not pretend otherwise.
4. **Risk — diagnostic churn from unrelated edits.** Paths are normalised relative to the service, line/column numbers are excluded, and compiler-rendered object/model bodies are collapsed before fingerprinting so ordinary edits, invocation CWD, and Prisma property-order rendering do not invalidate the baseline. Other message-text churn (for example from a TypeScript upgrade) still invalidates it deliberately, with R4 forcing review.
5. **Open question for Quinn — the TS2339 cluster.** The remaining `tasks-api` debt after this task is dominated by 29 `TS2339` in `src/routes/tasks.ts` (16), `src/routes/featureTaskAnalytics.ts` (11) and `src/routes/taskAttentionOwners.ts` (2) — inferred `{}` accumulator types. The research recommends closing that cluster **before** enabling `strictNullChecks`. This task deliberately does not do it: it is a separate, reviewable slice. Raising the sequencing so the next task is scoped deliberately rather than discovered later.
6. **Open question for Quinn — `content-scheduler-api`'s 11 `TS2339` are compiler artifacts, not bugs.** They are discriminated-union narrowings that only fail because `strictNullChecks` is off; enabling `strictNullChecks` for that service alone drops them to 0 (and adds 0 new ones per the research matrix: `bundler` + `strictNullChecks` = 11). That is a tempting one-key change — but it changes nullability semantics for the whole service and is therefore **not** bundled into this task. Flagging it as a candidate follow-up with its own design.
7. **Assumption stated explicitly:** no clarification needed on scope because the task description fixes the ACs, the research fixes the measurement, and the audit finding fixes the ledger linkage. The only genuinely open judgment calls are items 5 and 6 above, both of which are recorded rather than silently decided.
