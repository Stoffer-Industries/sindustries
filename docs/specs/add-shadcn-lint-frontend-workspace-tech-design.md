---
status: draft
task_id: da86ccd8-80b6-4447-b7e1-a9a915440d1a
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech design — Add @shadcn/lint to the frontend workspace (task `da86ccd8`)

> **Status:** Draft. Quinn review requested.
> **Date:** 2026-09-15
> **Author:** Rowan (Staff Engineer)
> **Source of truth:** task `da86ccd8-80b6-4447-b7e1-a9a915440d1a` on the Tasks API.

## Intent and scope

Add `@shadcn/lint` as a foundation for design-system-aware linting on SIndustries web/React frontend surfaces, so future web UI changes by agents and humans are checked against the canonical `@sindustries/ui` components and `@sindustries/design-tokens`. Scope covers the Vite/React web apps and the shared React UI package; React Native (budget-mobile) is out of scope per the task description.

This task is the wiring step. **Rule enablement is a separate follow-up** — see OQ1.

## Delivery metadata

- **Task:** `da86ccd8-80b6-4447-b7e1-a9a915440d1a` — Add `@shadcn/lint` to the frontend workspace
- **Branch:** `task-da86ccd8-shadcn-lint-frontend`
- **Worktree:** `workspace/worktrees/task-da86ccd8-shadcn-lint-frontend`
- **Repository:** `Stoffer-Industries/sindustries`

## Constraint — the Tailwind vs. BEM/CSS-Custom-Properties mismatch (read first)

`@shadcn/lint` (per the upstream README) is "an agent-first linter for **Tailwind design systems**." Every rule that ships today — `no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-unknown-classes`, `require-static-classes`, `no-leaked-tailwind-classes` — operates on **Tailwind class strings** in `className` props (and equivalent attributes documented in `docs/how-it-works.md`). Theme tokens are read from Tailwind v4's `@theme` / `@theme inline` blocks; components are recognised via `components.json` and the `cn`/`cx`/`cva`/`tv`/`twMerge`/`twJoin` family of helper calls.

**SIndustries frontend does not use Tailwind today.** Verified across the repo on 2026-09-15:

- No `tailwind.config.*` / `postcss.config.*` / `@tailwindcss` references in `apps/`, `packages/`, `services/`, or `agents/`.
- `@sindustries/ui` ships a **BEM-style** CSS architecture: `si-button`, `si-button--primary`, `--si-color-cta-primary` (CSS custom properties), with style "kits" (`kit-pulse.css`, `kit-brand.css`) layered on top via `@import`.
- React Native (`packages/ui/src/native/`) and web React (`packages/ui/src/react/`) both consume `@sindustries/design-tokens` directly — web via CSS variables, RN via the generated `tokens.ts`. The "design token" surface the task description asks the linter to enforce is the **CSS-variable / BEM** surface, not a Tailwind theme.

**Consequence:** if I install `@shadcn/lint` today with its current rule set, every rule reports zero violations — not because the design system is being followed, but because the rules have nothing to look at. AC3 ("maps to documented SIndustries design-system policies") and AC4 ("existing baseline violations … resolved or explicitly documented") cannot be honestly satisfied in the current stack. They would silently pass against a non-functional setup, which is exactly the false-signal the task author did not want.

The task description's framing ("checked against the canonical @sindustries/ui components and design tokens") is the *intent* — but the *implementation pathway* through `@shadcn/lint` as it exists today requires Tailwind v4 to do anything observable. Two reasonable paths exist:

- **(A) Adopt Tailwind v4 in `packages/ui` (and the apps that consume it).** Substantial: convert BEM CSS to Tailwind utilities / configuration, regenerate per-component class strings, re-skin the kits. Worth doing as a separate, scoped initiative — not as a hidden side-effect of this task.
- **(B) Install `@shadcn/lint` dormant now, surface the constraint, defer rule enablement.** Lighter-touch: this PR wires the plugin, sets up the lint command, runs the (empty) lint pass in CI as a smoke test, and tracks Tailwind adoption as a separate follow-up task that owns the rule enablement.

**This design proposes (B).** OQ1 asks Quinn to confirm before implementation.

If Quinn prefers (A), the right move is to close this task as `won't do — scope covered by the Tailwind-adoption initiative` and route the design-system-enforcement intent into the larger effort. If Quinn prefers a different direction entirely (different linter, different surface), this tech design needs to be re-shaped.

## Ownership boundary

This is an **API/CLI-tooling boundary** change at the repo level — no new service, no new database, no new cron. The boundary question is: where does `@shadcn/lint`'s configuration live?

- **Linter runtime + plugin:** owned by `package.json` at the repo root (workspace) for Oxlint; `@shadcn/lint` exposes both ESLint and Oxlint plugins. The repo currently has **neither** ESLint nor Oxlint installed — verified by grep across `apps/*/package.json`, `packages/*/package.json`, `services/*/package.json`, root `package.json`. Per `@shadcn/lint`'s own SETUP.md: "If neither [ESLint nor Oxlint] are present, set up Oxlint."
- **Lint config:** root `.oxlintrc.json` + `@shadcn/lint`'s `components.json` analogue, pointing at `packages/ui/src/react` for component discovery and `packages/design-tokens/styles.css` for theme tokens. Note that the SIndustries design tokens are not declared in a `@theme` block — they are plain CSS custom properties in `packages/design-tokens/styles.css`. `@shadcn/lint` will not pick these up as theme tokens until they are bridged (likely via a `@theme inline { --color-*: var(--si-color-*); }` shim, which is also part of the Tailwind-adoption path).
- **Lint script + CI hook:** root `package.json` adds a `lint:design-system` script. `.github/workflows/ci.yml` adds a `frontend-design-system-lint` job that runs the script on every PR. This job is wired to **fail on configuration errors** (misconfigured plugin, broken component discovery) and **pass with zero violations by default** until rules are enabled — i.e. a smoke test for the wiring, not an enforcement pass.
- **Documentation of rules:** lives in this repo (`docs/systems/design-system.md` gains a "Design-system linting" section). The follow-up Tailwind-adoption task will own the rule enablement, baseline violation triage, and contributor guidance.

No new service, no new database, no new cross-app contract. No `apps/<app>/SPEC.md` change. The `docs/systems/design-system.md` update is the only system-spec touchpoint.

## `.openclaw` boundary notes

- **None.** All changes live in `Stoffer-Industries/sindustries` (this repo). No agent-side wiring, no skill changes, no cron changes, no `.openclaw/` writes.

## Implementation plan

### File/module scope (relative to repo root)

1. **New: `.oxlintrc.json`** (root) — registers `@shadcn/lint`'s Oxlint plugin via `jsPlugins`. Imports the project's parser config; does **not** enable any rule preset (per `@shadcn/lint`'s SETUP guidance — "Do not add rule presets, enable new rules, or add rule overrides" in the setup phase).
2. **New: `components.json`** (root, or under `packages/ui/`) — points the linter at `packages/ui/src/react` for component discovery. Mirrors the layout documented in `@shadcn/lint`'s "How it works" page.
3. **New: `scripts/check-design-system-lint.mjs`** — thin wrapper that runs `oxlint` against `apps/{website,tasks,mission-control,gymtrack}/src/**/*.{ts,tsx}` and `packages/ui/src/react/**/*.{jsx,tsx}`, prints a config-load summary, and exits non-zero on configuration errors. Mirrors the pattern of `scripts/check-no-absolute-paths.mjs` so the script is auditable and self-contained.
4. **New: `scripts/test/check-design-system-lint.test.mjs`** — asserts the wrapper exits 0 on the current tree (zero-violations smoke test) and exits non-zero if the plugin is misconfigured (e.g. by stubbing a temp config). Mirrors `scripts/test/check-no-absolute-paths.test.mjs`.
5. **Modified: root `package.json`** — adds:
   - `devDependencies`: `oxlint` (latest stable), `@shadcn/lint` (latest stable).
   - `scripts.lint:design-system`: `node scripts/check-design-system-lint.mjs`.
   - `scripts.test:lint`: extend the existing `test:lint` chain to include `node scripts/test/check-design-system-lint.test.mjs`. (Verify ordering — current chain is `[check-no-absolute-paths, check-no-legacy-approval-marker]`; append the new one.)
6. **Modified: `.github/workflows/ci.yml`** — add a new job `frontend-design-system-lint` that runs `npm run lint:design-system`. Wire it into the existing `merge gate` job's required-checks list alongside `no-absolute-paths-lint`, `infra-cloud-bootstrap-staging-tests`, etc.
7. **Modified: `docs/systems/design-system.md`** — append a "Design-system linting" section documenting:
   - The lint command (`npm run lint:design-system`) and what it currently covers.
   - The dormant-rules gap (Tailwind prerequisite; see OQ1).
   - The follow-up task that will own rule enablement (created post-approval).
   - Where rule policy is maintained (initially this doc; later a dedicated `docs/specs/shadcn-lint-rules.md` once rules exist).
8. **Modified: `apps/{website,tasks,mission-control,gymtrack}/SPEC.md`** — verify whether any of these describes a behaviour this task adds (it doesn't — this is infra-only); per `DoD.md`, no update needed if behaviour is unchanged.
9. **Not modified:** `apps/budget-mobile/**` (React Native, out of scope), `services/**` (backend), `agents/**` (agent code), `infra/**`.

### Linter setup choices (with rationale)

- **Oxlint vs. ESLint:** per `@shadcn/lint`'s SETUP guidance ("If neither [ESLint nor Oxlint] are present, set up Oxlint"). Oxlint is faster, has TypeScript/JSX support out of the box, and is the setup path the linter's own docs recommend when neither is present. ESLint is a viable alternative; switching later is a config-file change, not a structural one. (Quinn can flag a preference in OQ2.)
- **Component discovery root:** `packages/ui/src/react`. This is the canonical React component surface per `docs/systems/design-system.md`. React Native components live under `packages/ui/src/native/` and are out of scope. The barrel `packages/ui/src/react/index.jsx` is the entry point; `@shadcn/lint` follows re-exports back to defining files.
- **Theme tokens:** `packages/design-tokens/styles.css` is the emitted CSS-custom-properties stylesheet. `@shadcn/lint` will not treat this as a Tailwind theme until the tokens are bridged — flagged as a follow-up, not a blocker for the install.
- **Scope of files linted:** web frontend source trees (the four Vite/React apps plus the `packages/ui/src/react` surface). Excludes generated directories (`packages/ui/src/specimen/generated/`, build outputs), test fixtures, and `node_modules/`. Mirrors the `SKIP_DIRS` convention used by `scripts/check-no-absolute-paths.mjs`.

## Data model and API contract changes

None. This task does not touch the database, services, or HTTP surface. The linter reads source code; it does not persist anything or expose anything.

## Workflow, cron, and skill changes

- **Workflow:** `.github/workflows/ci.yml` gains one job and one wire-up line into the merge gate. No cron, no scheduled run.
- **Cron:** none.
- **Skill:** none. No agent-side behaviour change. Linting runs in CI and locally via `npm run lint:design-system`; humans and agents invoke it like any other script.

## Test plan (AC-by-AC verification matrix)

| AC | What it asks | Verification | Status |
|---|---|---|---|
| AC1 | `@shadcn/lint` installed and registered with the existing linter without removing or weakening existing parser/rule/ignore/workspace settings. | (1) `package.json` shows `@shadcn/lint` and `oxlint` as devDependencies. (2) `.oxlintrc.json` registers the plugin via `jsPlugins`. (3) `npm run lint:design-system` loads the config without errors. (4) `scripts/check-no-absolute-paths.mjs` and `scripts/check-no-legacy-approval-marker.mjs` continue to pass unchanged — confirms no existing rule/ignore regression. (5) `package.json` `workspaces` field is unchanged. | **Implementable in this PR** |
| AC2 | Repeatable lint command covers relevant web frontend surfaces and shared React UI code; runs through local and CI quality-check workflow. | (1) `npm run lint:design-system` exists at the repo root and runs the wrapper. (2) Wrapper exits 0 on current tree (zero violations / config load OK). (3) New `frontend-design-system-lint` CI job runs the same command on PRs and on `main` pushes. (4) Job wired into the merge gate (fails the gate if the script exits non-zero). | **Implementable in this PR** |
| AC3 | Initial `@shadcn/lint` rule set is enabled for the actual frontend stack and maps to documented SIndustries design-system policies (canonical components, variants, tokens, not ad-hoc styling). | This AC is the load-bearing one against OQ1. **Cannot be implemented in current main without Tailwind v4 adoption in `@sindustries/ui`.** Each rule (`no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-unknown-classes`, etc.) requires Tailwind class strings or `@theme` blocks to operate on. Without them, "enabling" the rule set produces zero findings — a false-positive-free result that proves nothing. **Recommended:** re-scope AC3 against the dormant-install path. Implementation here adds a `shadcn.lint.disabled` config comment in `.oxlintrc.json` documenting that rule enablement is deferred pending Tailwind adoption (tracked as a separate follow-up task). The follow-up owns AC3 in full once Tailwind is adopted. | **Blocked by OQ1** |
| AC4 | Existing baseline violations in the covered scope are resolved or explicitly documented with rationale and follow-up ownership, and contributor/agent guidance explains how to run the check and where its design-system rules are maintained. | (1) `docs/systems/design-system.md` "Design-system linting" section documents: the lint command, the dormant-rules gap, the follow-up task owner, and where rule policy will be maintained. (2) `CONTRIBUTING.md` (or equivalent — verify which file covers agent/contributor onboarding) gains a one-line pointer to the lint command. (3) Baseline-violation triage is *not* in scope here (zero rules = zero violations to triage); the follow-up task owns baseline triage once rules are enabled. | **Partly implementable in this PR** (docs yes, baseline triage deferred to follow-up) |

### E2E / unit / integration coverage

- Unit: `scripts/test/check-design-system-lint.test.mjs` exercises the wrapper exit codes (0 on clean tree, non-zero on simulated config failure).
- Integration: the `frontend-design-system-lint` CI job is the integration coverage — it runs the wrapper in a clean checkout against the live `@shadcn/lint` plugin.
- E2E: none. This is infra-only; no user-facing flow is added or changed.

## Risks and open questions

### OQ1 (load-bearing — blocks AC3)

**Is the install-dormant path (B) the right call, or should this task wait for / drive Tailwind v4 adoption in `@sindustries/ui`?**

Three reasonable answers:

- **(i) Install dormant now** — this PR wires the plugin, runs the smoke-test CI job, and tracks Tailwind adoption as a separate follow-up task that owns AC3 + the rule enablement. AC3 here is re-scoped to "document the dormant state and the prerequisite for rule enablement." **Recommended.** Aligns with the cadence rule for incremental delivery and lets the smaller, lower-risk slice land while the Tailwind work scopes up.
- **(ii) Defer this task entirely** — close as `won't do — scope covered by the Tailwind-adoption initiative`, route the design-system-enforcement intent into that effort. Cleanest if the Tailwind work is imminent.
- **(iii) Scope this task to drive Tailwind adoption in this PR** — turns this into a multi-PR initiative (BEM → Tailwind conversion, kit refactor, regression sweep). Out of scope for "Add @shadcn/lint" as written; would need the task description re-shaped by Quinn/Tom.

### OQ2

**Oxlint vs. ESLint preference?** `@shadcn/lint` supports both; the SETUP docs recommend Oxlint when neither is present. Oxlint is the default proposal here; flag a preference if you want ESLint instead (slight ergonomic differences, both fine).

### OQ3

**Where should rule policy live once rules are enabled?** Options: section in `docs/systems/design-system.md` (current proposal — fits the system's "single source of truth for visual design" mandate), or a dedicated `docs/specs/shadcn-lint-rules.md` (cleaner if the rule set grows). Default proposal: section in `design-system.md` until the rule set exceeds ~10 rules.

### Risks

- **False sense of coverage.** A green `frontend-design-system-lint` job with no rules enabled is indistinguishable from a green job that has rules and the codebase is clean. This is exactly the failure mode the constraint surfaces. Mitigation: the CI job name and the lint command's banner explicitly say "smoke test — rules not enabled, see docs/systems/design-system.md"; the docs page makes the dormant state unmissable. Still — this risk is the reason OQ1 is load-bearing.
- **Workspace deps growth.** Adding `oxlint` + `@shadcn/lint` to the root devDependencies grows the install. Both are lightweight; combined install impact is small but non-zero. Acceptable; not a blocker.
- **`@shadcn/lint` is a fast-moving upstream.** Versions can change rule semantics. Pin to a specific version in `package.json`, not a range, and document the version in `docs/systems/design-system.md`.

## Out of scope (explicit)

- Tailwind v4 adoption in `@sindustries/ui` (separate initiative, owns AC3 in full).
- Rule enablement, baseline violation triage, contributor/agent guidance for resolving violations (follow-up task).
- React Native (`apps/budget-mobile/**`, `packages/ui/src/native/**`) — out of scope per task description.
- Backend services, agent code, infra scripts — not affected.
- A web UI for the linter, a CLI dashboard, or any developer-tooling beyond `npm run lint:design-system`.

## Acceptance criteria (planned implementation, post-Quinn approval)

Assuming OQ1 = (i):

- **AC1:** `.oxlintrc.json` registers `@shadcn/lint` via `jsPlugins`; root `package.json` adds `oxlint` + `@shadcn/lint` as devDependencies (pinned); `workspaces` field unchanged; existing `no-absolute-paths` and `no-legacy-approval-marker` lints continue to pass unchanged.
- **AC2:** `npm run lint:design-system` runs `scripts/check-design-system-lint.mjs` across `apps/{website,tasks,mission-control,gymtrack}/src/**` and `packages/ui/src/react/**`; new `frontend-design-system-lint` CI job runs the same command and is wired into the merge gate.
- **AC3 (re-scoped):** `.oxlintrc.json` includes a `// rules-not-enabled` comment block documenting that no `@shadcn/lint` rules are active in this PR, the Tailwind v4 prerequisite, and the follow-up task short-id that owns rule enablement. AC3 in its original form is satisfied in the follow-up task.
- **AC4 (re-scoped):** `docs/systems/design-system.md` gains a "Design-system linting" section; a new follow-up task is created (code task, no tech-design required per its trivial scope) with description: "Enable `@shadcn/lint` rules + baseline triage after Tailwind v4 lands in `@sindustries/ui`. Owns AC3 (original form) and AC4 violation triage. Tracked under the Tailwind-adoption initiative." The follow-up is referenced from this tech design and from the new `docs/systems/design-system.md` section.

Assuming OQ1 = (ii) or (iii), the implementation here is wrong; this tech design is replaced or substantially re-shaped.

## Definition of done

- [ ] Quinn `tech_design` approval received via the structured approval on this task.
- [ ] OQ1 answered; tech design updated (or replaced) accordingly.
- [ ] Implementation PR opened (draft, no assignee per HEARTBEAT.md pre-publish check) with: `.oxlintrc.json`, `components.json`, `scripts/check-design-system-lint.mjs`, `scripts/test/check-design-system-lint.test.mjs`, `package.json` (lint script + devDependencies), `.github/workflows/ci.yml` (new job + merge-gate wire-up), `docs/systems/design-system.md` (new section).
- [ ] `## System Spec` section in the implementation PR body pointing at `docs/systems/design-system.md` "Design-system linting" section.
- [ ] Pre-publish check runs: assign `rowanstoffer`, request reviewers `quinnstoffer` (blocking) and `Stoff81` (visibility).
- [ ] Post `[implementer-prs] <url>` once draft → ready-for-review.
- [ ] Local + CI green; merge after Quinn PR approval.
- [ ] Follow-up task created if OQ1 = (i), referenced from `docs/systems/design-system.md`.
