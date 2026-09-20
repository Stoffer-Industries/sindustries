---
status: draft
task_id: 7986eb43-dc85-4512-b76a-1cfecefd8be7
product_spec: n/a
shipped_pr: null
shipped_date: null
---

# Tech design — Adopt Tailwind v4 in `@sindustries/ui` (task `7986eb43`)

> **Status:** Draft. Quinn review requested.
> **Date:** 2026-09-16
> **Author:** Rowan (Staff Engineer)
> **Source of truth:** task `7986eb43-dc85-4512-b76a-1cfecefd8be7` on the Tasks API.

## Intent and scope

Activate the dormant `@shadcn/lint` install from task `da86ccd8` (PR #686 merged 2026-09-14) by adopting Tailwind v4 across the web frontend. Specifically: install Tailwind v4 in `@sindustries/ui` and the four consuming Vite/React apps, bridge `@sindustries/design-tokens` into Tailwind's `@theme inline` block, migrate the React components from BEM class strings (`si-button`, `si-button--primary`) to Tailwind utilities + `cn`/`cva` variants, then promote the dormant lint rules to active and triage the baseline. Closes the constraint surfaced in `da86ccd8`'s tech design.

**Scope:**

- `@sindustries/ui` — Tailwind v4 install, `@theme inline` token bridge, all 17 React components migrated from BEM to Tailwind utilities + `cn` / `cva`. Visual surface preserved (snapshot / visual-diff). Component props (variant/tone/size) preserved so consuming apps do not change call sites.
- `apps/{website,tasks,mission-control,gymtrack}` — Tailwind v4 + `@tailwindcss/vite` plugin wired into each `vite.config.js`. App-level CSS (currently plain CSS with `var(--si-color-*)` references) continues to work via the same custom-property indirection.
- `@shadcn/lint` — `rulesEnabled: true` in `.oxlintrc.json`, baseline violation surfaced and triaged.
- `@sindustries/design-tokens` — **no schema change.** The build pipeline stays the single source of truth; Tailwind *consumes* via `@theme inline` references, never defines.

**Out of scope** (this task is not a Tailwind migration of arbitrary ad-hoc styling; it's a controlled conversion of the canonical UI surface):

- `apps/budget-mobile/**`, `packages/ui/src/native/**` — React Native, consumes `tokens.ts` directly. Out of scope per task description.
- App-level ad-hoc styling (e.g. `apps/website/src/components/scroll-linked-card-stack/ScrollLinkedCardStack.css`, `apps/tasks/src/components/*`) — left alone; apps keep their bespoke CSS. The lint pass flags *new* violations against the canonical surface; it does not require the whole app to be Tailwind. (OQ3 below.)
- Pencil `design-systems.pen` kit internals — the kit uses Pencil's native variable system, not Tailwind. We verify the regenerated kit round-trips against the same tokens (AC6), but Pencil tokens themselves are not migrated to `@theme`.
- ESLint adoption — `@shadcn/lint` Oxlint plugin only; ESLint is not in scope.

## Delivery metadata

- **Task:** `7986eb43-dc85-4512-b76a-1cfecefd8be7` — Adopt Tailwind v4 in `@sindustries/ui` — enables `@shadcn/lint` rules (follow-up to `da86ccd8`)
- **Branch:** `task-7986eb43-tailwind-v4-sindustries-ui`
- **Worktree:** `workspace/worktrees/task-7986eb43-tailwind-v4-sindustries-ui`
- **Repository:** `Stoffer-Industries/sindustries`

## Constraint — read first

Three hard constraints bind this design:

1. **`@sindustries/design-tokens` build pipeline stays the source of truth.** `tokens.json` → `styles.css` (CSS custom properties), `tokens.ts` (RN), `pen-tokens.json`, `design-systems.pen`. Tailwind v4 must consume from this pipeline (via `@theme inline { --color-cta-primary: var(--si-color-cta-primary); }`), not define its own. Otherwise the design system forks into two sources of truth and the lint rules enforce whichever Tailwind sees.
2. **Component props must not change.** `apps/**` calls `<Button variant="primary">`, `<Card variant="default">`, etc. The migration changes *how* those variants render (utility classes) but not the *shape*. Visual diff + snapshot tests are the safety net, not prop-rename refactors.
3. **React Native surface unchanged.** `packages/ui/src/native/**` ships its own component set using `tokens.ts` directly. Tailwind v4 is web-only; the RN path is not touched.

## Approach — phased implementation

The work decomposes into six ordered slices. Each slice is independently mergeable in principle, but for review-size economy this design proposes shipping them as one PR (the dormancy cycle + rule activation + visual regression tests together). The slices are also the AC mapping below.

### Slice 1 — Install Tailwind v4 + `@tailwindcss/vite`

- Add to root `package.json` `devDependencies` (pinned): `tailwindcss@4.3.x`, `@tailwindcss/vite@4.3.x`.
- Add `@tailwindcss/vite` plugin to each of the four app `vite.config.js` files: `apps/{website,tasks,mission-control,gymtrack}/vite.config.js`.
- No CSS yet — just the plugin install. Verify each app's existing build (`npm run build`) still passes (no behavioural change yet).

### Slice 2 — `@theme inline` token bridge in `packages/ui/src/react/`

- Add a new file `packages/ui/src/react/tailwind-theme.css` that:
  1. `@import "tailwindcss";`
  2. `@import "@sindustries/design-tokens/styles.css";`
  3. Declares `@theme inline { ... }` re-exporting each design token as a Tailwind theme variable, e.g. `--color-cta-primary: var(--si-color-cta-primary);`, `--color-bone-50: var(--si-color-bone-50);`, `--font-ui: var(--si-font-ui);`, `--space-1: var(--si-space-1);`, etc.
- Auto-generate the `@theme inline` block from `packages/design-tokens/styles.css` via a small `scripts/build-tailwind-theme.mjs` helper. The generator reads the CSS, parses `--si-*` declarations, and emits `--color-*`, `--space-*`, `--font-*`, `--radius-*`, `--shadow-*` Tailwind aliases. The output is committed (mirrors the existing generated-files policy for `styles.css` and `tokens.ts`).
- Update `packages/ui/src/react/styles.css` to `@import "./tailwind-theme.css";` so consumers get Tailwind + tokens in one import.
- Verify: a sample `bg-cta-primary text-bone-50 font-ui` utility class in a specimen route resolves to the right token values (visual-diff the existing specimens before/after).

### Slice 3 — Component migration (`@sindustries/ui` only)

Migrate each of the 17 components in `packages/ui/src/react/index.jsx` from BEM (`si-button`, `si-button--primary`) to Tailwind utilities + `cn` + `cva` (class-variance-authority). Migration strategy:

- Use `cva` (already in tree via `@shadcn/lint`'s dependency `cn@0.2.6`) to declare each variant/tone combo as a `cva()` factory, e.g.:
  ```js
  const buttonVariants = cva(
    'inline-flex items-center justify-center font-ui rounded-full uppercase ...', // base
    {
      variants: {
        variant: { primary: 'bg-cta-primary ...', secondary: 'bg-bg-field ...' },
        tone: { display: 'font-display rounded-none ...', pulse: 'font-display rounded-none ...' }
      },
      defaultVariants: { variant: 'secondary' }
    }
  );
  ```
- Replace `base.css` / `kit-pulse.css` / `kit-brand.css` with the migrated utility classes embedded in the `cva()` definitions. Keep `kit-brand.css` as a small overrides file for the `[data-si-pack='brand']` context shim if the brand restyling does not fit cleanly into `cva()` variants — verified at component-migration time.
- Visual-diff safety net: existing `packages/ui/src/react/index.test.jsx` (185 lines, covers Button + Badge + Card + Input) continues to pass; add new snapshot tests covering the variant matrix per component (primary/secondary/outline/ghost/destructive/nav/filter × size sm/md/lg × tone default/display/pulse).
- Specimen pages under `packages/ui/src/specimen/` continue to render correctly (visual diff against the existing specimen shell).

### Slice 4 — Rule enablement + baseline triage

- Flip `.oxlintrc.json` `settings."shadcn-lint".rulesEnabled` from `false` to `true`.
- Run the `lint:design-system` script against the new Tailwind surface. Expect:
  - Some baseline violations against the migrated components (e.g. `no-restyle` catching inline overrides, `no-raw-colors` catching any `bg-[#hex]` that slipped in).
  - Some violations against `apps/**` call sites using raw class strings instead of `@sindustries/ui` components.
- Triage each violation into one of:
  - **Fix in this PR** — clear canonical violation (e.g. inline style override, raw color in a UI consumer).
  - **Document and accept** — known limitation with rationale (e.g. a one-off marketing-page section that intentionally diverges). Recorded in `docs/systems/design-system.md` "Design-system linting" section as an "Accepted baseline" list, each with a follow-up task ID if non-trivial.
  - **False positive** — file an upstream `@shadcn/lint` issue, disable the specific rule via `.oxlintrc.json` overrides with a comment, link to the upstream issue.
- The `frontend-design-system-lint` CI job promoted from "smoke test (no rules)" to "enforcement (rules on, real violations surface)".

### Slice 5 — Update `docs/systems/design-system.md`

- Update the "Design-system linting" section from DORMANT to ACTIVE.
- Replace the dormant-state banner with the active-rule summary.
- Add "Accepted baseline" list if any documented-accept entries exist.
- Add "Adding a component" guide (Tailwind utility + `cva` pattern) so future component additions follow the migrated shape.
- Add "Migrating an existing component" guide for any future BEM-removal work in `apps/**`.

### Slice 6 — Pencil kit round-trip verification

- `npm run build --workspace @sindustries/design-tokens` (rebuilds `design-systems.pen`).
- Open the kit in Pencil; verify the regenerated kit's variables resolve to the same hex values as before. The Pencil kit uses its own variable format (`pen-tokens.json`), not Tailwind tokens, so this is the same regen-as-before verification that already runs in `npm run check:design-sync`. No new test required beyond the existing CI check continuing to pass.

## Ownership boundary

This is a **CSS-architecture refactor + lint activation** at the repo level. No new service, no new database, no new cron, no new cross-app contract. Boundary questions:

- **Linter runtime + plugin:** unchanged from `da86ccd8`'s dormant install. Oxlint 1.83.0 stays the linter.
- **Lint config:** root `.oxlintrc.json` (existing) flips `rulesEnabled: true` and gains per-rule overrides for any false-positive triage. `components.json` (existing) stays as-is — its `components: "@sindustries/ui"` and `tokensStylesheet: "packages/design-tokens/styles.css"` paths remain correct.
- **Design tokens:** `@sindustries/design-tokens` stays the source of truth. The new `scripts/build-tailwind-theme.mjs` reads its output (the generated `styles.css`) and emits the `@theme inline` block — same pattern as the existing `scripts/build-tokens.mjs`. No new ownership claim.
- **App-level CSS:** apps continue to author their own bespoke CSS. Tailwind is opt-in per-file (utility classes only appear where a `@sindustries/ui` component is rendered; app-level layouts and bespoke sections stay as plain CSS). The lint pass enforces the UI surface; app-level files are scanned but flagged violations there are *triaged*, not auto-fixed.
- **React Native:** unchanged. Native components stay on `tokens.ts`. Tailwind does not run on RN. The lint pass excludes `packages/ui/src/native/**`.
- **System spec:** `docs/systems/design-system.md` is the only spec touched.

## `.openclaw` boundary notes

- **None.** All changes live in `Stoffer-Industries/sindustries`. No agent-side wiring, no skill changes, no cron changes, no `.openclaw/` writes.

## File/module scope (relative to repo root)

**New files:**

1. `packages/ui/src/react/tailwind-theme.css` — the `@theme inline` block + Tailwind import + token import. Generated; not hand-edited.
2. `scripts/build-tailwind-theme.mjs` — generator that reads `packages/design-tokens/styles.css` and emits `tailwind-theme.css`. Mirrors `packages/design-tokens/scripts/build-tokens.mjs`'s pattern.
3. `scripts/test/build-tailwind-theme.test.mjs` — unit tests for the generator (parses a fixture CSS file, asserts the `@theme inline` output contains expected entries, fails loudly on malformed CSS).
4. `packages/ui/src/react/__snapshots__/*.snap` — vitest snapshot files for the migrated components. Generated by `vitest run -u` on first run.
5. `packages/ui/src/react/index.migration.test.jsx` — additional variant-matrix coverage for the migrated `cva()` definitions (each variant × size × tone).

**Modified files:**

6. `package.json` (root) — adds `tailwindcss@4.3.x` + `@tailwindcss/vite@4.3.x` (pinned) to `devDependencies`. `cva` may also need a top-level pin if not transitively pulled by `@shadcn/lint`.
7. `apps/{website,tasks,mission-control,gymtrack}/vite.config.js` — add `tailwindcss()` plugin from `@tailwindcss/vite`. Order: before `react()`.
8. `apps/{website,tasks,mission-control,gymtrack}/package.json` — add `tailwindcss` + `@tailwindcss/vite` to devDependencies (or rely on workspace hoist; verify which path is least surprising).
9. `packages/ui/src/react/index.jsx` — convert `className={cx('si-button', ...)}` blocks to `className={buttonVariants({ variant, tone, size, className })}`. Component props unchanged.
10. `packages/ui/src/react/styles.css` — add `@import "./tailwind-theme.css";` after the existing imports.
11. `packages/ui/src/react/base.css` — **deleted** if all rules are absorbed into `cva()`; or **kept as a thin layer** for selectors that don't fit `cva()` (e.g. `:hover`, `:focus-visible` pseudo-state rules). Decision made per component during migration.
13. `packages/ui/src/react/kit-pulse.css`, `kit-brand.css` — same fate as `base.css`. Most rules migrate into `cva()` tone variants. Brand kit's `[data-si-pack='brand']` shell overrides likely remain as a small CSS layer.
14. `.oxlintrc.json` — flip `rulesEnabled: true`. Add per-rule overrides for any false-positive triage entries from slice 4.
15. `docs/systems/design-system.md` — promote "Design-system linting" from DORMANT to ACTIVE. Add "Accepted baseline" list if needed. Add the two contributor guides.
16. `.github/workflows/ci.yml` — the existing `frontend-design-system-lint` job becomes enforcement; may need a label rename + comment.
18. `CONTRIBUTING.md` — one-line pointer to the active lint command (mirrors what the dormant install added).

**Not modified:** `packages/ui/src/native/**`, `apps/budget-mobile/**`, `services/**`, `agents/**`, `infra/**`, `packages/design-tokens/tokens.json` (the source of truth), `packages/design-tokens/styles.css` (the generated output — only read by the new generator).

## Test plan (AC-by-AC verification matrix)

| AC | What it asks | Verification | Status |
|---|---|---|---|
| AC1 | Tailwind v4 installed at repo root and configured for `@sindustries/ui` + each Vite/React app. PostCSS / Vite plugin wiring committed. | (1) `package.json` `devDependencies` shows pinned `tailwindcss` + `@tailwindcss/vite`. (2) Each of the four app `vite.config.js` files imports `tailwindcss()` from `@tailwindcss/vite` and registers it in `plugins` before `react()`. (3) `apps/{website,tasks,mission-control,gymtrack}/package.json` either pins the deps or relies on workspace hoist (verify which path). (4) Each app builds green (`npm run build`) and serves green (`npm run dev`). | **Implementable in this PR** |
| AC2 | `@sindustries/design-tokens` bridged into Tailwind v4 `@theme inline` block that re-exports every CSS custom property as a Tailwind theme token. The `@sindustries/design-tokens` build pipeline remains the single source of truth. | (1) `packages/ui/src/react/tailwind-theme.css` exists and contains an `@import "tailwindcss"` plus an `@theme inline` block. (2) `packages/ui/src/react/tailwind-theme.css` is generated by `scripts/build-tailwind-theme.mjs`, not hand-edited (`.gitattributes` or similar marker; generator script in repo). (3) Generator reads `packages/design-tokens/styles.css`; a fixture-style unit test confirms the generator emits expected entries (e.g. `--color-cta-primary: var(--si-color-cta-primary)`). (4) Specimen render with `bg-cta-primary` and `text-bone-50` utility classes produces the expected hex values via a visual-diff snapshot test. (5) `packages/design-tokens` build pipeline (existing `npm run check:design-sync`) continues to pass — confirms the Tailwind layer reads from, not writes to, the design tokens pipeline. | **Implementable in this PR** |
| AC3 | `@sindustries/ui` React components migrated from BEM class strings to Tailwind utility classes / `cn` / `cva`. Each component's visual surface preserved. React Native component surface unchanged. | (1) Each of the 17 React components in `packages/ui/src/react/index.jsx` uses `cva()` (or `cn` + utility composition) instead of `cx()` over BEM strings. (2) Component prop shape unchanged: `Button({ variant, tone, size, ... })` accepts the same values; call sites in `apps/**` are not touched. (3) Visual surface preserved: snapshot tests in `packages/ui/src/react/__snapshots__/` cover the variant matrix per component; manual specimen review confirms parity with the pre-migration visual state. (4) `packages/ui/src/native/**` is byte-identical to `origin/main` (verified via `git diff origin/main -- packages/ui/src/native`). | **Implementable in this PR** |
| AC4 | Dormant `@shadcn/lint` install promoted to active rules; `.oxlintrc.json` enables the rule set; `scripts/check-design-system-lint.mjs` surfaces violations; `frontend-design-system-lint` CI job rewired to fail on real rule violations. | (1) `.oxlintrc.json` `settings."shadcn-lint".rulesEnabled: true`. (3) Running `npm run lint:design-system` exits non-zero when a known violation is introduced (positive test) and exits zero on the current tree post-triage (negative test). (4) `.github/workflows/ci.yml` `frontend-design-system-lint` job runs the active script and fails the merge gate on real violations. | **Implementable in this PR** |
| AC5 | Baseline violations surfaced, triaged, and either fixed or explicitly documented with rationale + follow-up ownership. `docs/systems/design-system.md` updated to point at live rule policy. | (1) A baseline run of the active lint produces a violation list. (2) Each violation is recorded in `docs/systems/design-system.md` "Design-system linting → Accepted baseline" subsection with one of [fixed-in-this-PR / accepted-with-rationale-and-followup / false-positive-disabled-with-upstream-link]. (3) Any accepted-with-rationale items have a Tasks API task ID referenced. (4) The "Design-system linting" section's status banner changes from DORMANT to ACTIVE. | **Implementable in this PR** |
| AC6 | Existing design tokens CI sync continues to pass; Pencil UI kit regenerated against new token surface round-trips cleanly. | (1) `npm run check:design-sync` exits zero (existing CI check; no change to its surface). (2) `npm run build --workspace @sindustries/design-tokens` produces `design-systems.pen`; manual inspection (or an automated diff check) confirms the kit's variables resolve to the same hex values as the pre-migration build. (3) The Pencil kit opens in Pencil without errors. (4) `apps/designs/budgeting/main.pen` (consumes `design-systems.pen` library) opens without errors. | **Implementable in this PR** |

### E2E / unit / integration coverage

- Unit: `scripts/test/build-tailwind-theme.test.mjs` exercises the generator. New `packages/ui/src/react/index.migration.test.jsx` covers variant-matrix parity. Existing `scripts/test/check-design-system-lint.test.mjs` extends with stubbed-rule tests.
- Integration: `frontend-design-system-lint` CI job runs the active lint on every PR and on `main` pushes; the merge gate fails on real violations.
- E2E: each of the four apps' existing e2e test scripts (`apps/tasks` has `test:e2e`, `apps/gymtrack` has `test:e2e`) continue to pass — visual surface preserved at the app level. The brand kit's web render (`apps/website`) is the highest-stakes visual surface; manual review by Tom or Quinn before merge.

## Risks

- **Visual-regression blast radius.** Converting 17 components × multiple variants × multiple tones is large surface area for visual change. Mitigation: vitest snapshots per component-variant-tone before/after, manual specimen review, and `apps/{website,tasks}/test:e2e` smoke. Still — this is the largest risk. Pre-publish review by Quinn on the brand kit (`apps/website`) is the gating step.
- **Tailwind v4 + Oxlint + shadcn fast-moving upstream.** Same risk as `da86ccd8`: rule semantics and Tailwind v4 plugin behaviour can shift between minor versions. Pin `tailwindcss`, `@tailwindcss/vite`, `oxlint`, `@shadcn/lint` exactly. Document pinned versions in `docs/systems/design-system.md`.
- **`@theme inline` shim complexity.** Bridging ~150 CSS custom properties into Tailwind tokens is mechanical but error-prone. Mitigation: `build-tailwind-theme.mjs` is a small generator with unit tests; the `@sindustries/design-tokens` build pipeline's golden-file tests catch any drift in the source CSS.
- **`apps/**` baseline violations are unbounded.** Tailwind adoption at the package level does not touch app-level files. If app-level ad-hoc styling is widespread, the active lint pass could surface hundreds of violations. Mitigation: the triage step (slice 4) is bounded to documented-accept entries; the lint pass enforces the canonical UI surface, not arbitrary app-level CSS. App-level violations are recorded but not auto-fixed.
- **Single-PR size.** This is a large PR — install + generator + 17 components + visual tests + rule activation + docs. Mitigation: each slice is independently testable, so partial-review feedback can land without re-cutting the PR. If the review burden proves excessive, splitting into two PRs (`tailwind-install + token-bridge + AC1/AC2/AC6` then `component-migration + rule-activation + AC3/AC4/AC5`) is a fallback. The fallback adds review-size friction in exchange for a smaller blast radius if something regresses.

## Open questions

### OQ1 (load-bearing — affects slice 4 scope)

**Which `@shadcn/lint` rules do we enable in this PR?**

The rule set as shipped includes `no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-unknown-classes`, `require-static-classes`, `no-leaked-tailwind-classes`. Three reasonable answers:

- **(i) All six at once.** Maximum enforcement, maximum baseline-violation triage work, highest signal-to-noise in CI. Recommended if the app-level baseline is small (<20 violations).
- **(ii) Phased — start with `no-restyle` + `no-raw-colors` + `no-unknown-classes`** (the highest-signal three that don't require the full cva-migration to be meaningful). Defer `no-arbitrary-values` + `require-static-classes` + `no-leaked-tailwind-classes` to a follow-up PR. Recommended if the app-level baseline is large or if Quinn prefers incremental rule activation.
- **(iii) Per-component activation** — enable a rule only after its component has been migrated. Slower to ship the first activated rule but avoids cross-component noise.

### OQ2

**Visual-regression tooling — vitest snapshots, or a real visual-diff tool (Chromatic / Playwright snapshots)?** Vitest snapshots catch class-string changes but not pixel-level differences. For brand-kit surface preservation, a pixel-diff may be necessary. Recommendation: start with vitest snapshots + manual specimen review; if brand regressions slip past, add a visual-diff step in CI as a follow-up.

### OQ3

**App-level coverage scope** — does the lint pass scan `apps/**` and surface violations there too, or only the canonical UI surface (`packages/ui/src/react/**`)? The current dormant install scans `apps/{website,tasks,mission-control,gymtrack}/src/**` + `packages/ui/src/react/**`. If app-level scanning produces excessive noise in the active rule pass, the recommended fallback is to narrow the scope to `packages/ui/src/react/**` only and rely on a separate `apps/**` style guide (out of scope for this task) for app-level enforcement.

## Out of scope (explicit)

- ESLint adoption (`@shadcn/lint` Oxlint only).
- Tailwind adoption in `apps/**` (apps keep bespoke CSS; only `@sindustries/ui` consumers see Tailwind utilities).
- Tailwind for React Native (`packages/ui/src/native/**` is web-Tailwind-blind).
- Pencil kit internals (`design-systems.pen` regenerates against the same tokens, but Pencil variables are not converted to `@theme`).
- A web UI for the linter, a CLI dashboard, or any developer-tooling beyond `npm run lint:design-system`.
- App-level ad-hoc styling migration to Tailwind (follow-up initiative, scoped if/when needed).

## Acceptance criteria (planned implementation, post-Quinn approval)

Assuming OQ1 = (i):

- **AC1:** `tailwindcss@4.3.x` + `@tailwindcss/vite@4.3.x` pinned in root `devDependencies`. All four app `vite.config.js` files register `tailwindcss()` from `@tailwindcss/vite` in `plugins` before `react()`. All four apps' `npm run build` exit zero.
- **AC2:** `packages/ui/src/react/tailwind-theme.css` is generated (not hand-edited) by `scripts/build-tailwind-theme.mjs`. The file imports `tailwindcss` and `@sindustries/design-tokens/styles.css`, then declares an `@theme inline` block re-exporting every CSS custom property as a Tailwind theme variable. Generator unit-tested. Specimen visual-diff snapshot verifies `bg-cta-primary` etc. resolve correctly.
- **AC3:** All 17 React components in `packages/ui/src/react/index.jsx` use `cva()` (or `cn` + utility composition). Component props unchanged. Vitest snapshot tests cover variant matrix. `packages/ui/src/native/**` byte-identical to `origin/main`.
- **AC4:** `.oxlintrc.json` `rulesEnabled: true`. `npm run lint:design-system` exits non-zero on a known violation and zero post-triage. `frontend-design-system-lint` CI job runs the active script.
- **AC5:** Baseline violation list documented in `docs/systems/design-system.md` "Design-system linting → Accepted baseline". Each entry has one of [fixed-in-this-PR / accepted-with-rationale-and-followup / false-positive-disabled-with-upstream-link]. The "Design-system linting" section status flips from DORMANT to ACTIVE.
- **AC6:** `npm run check:design-sync` exits zero. `npm run build --workspace @sindustries/design-tokens` regenerates `design-systems.pen`; manual review (or automated diff) confirms variable values match pre-migration state.

Assuming OQ1 = (ii), AC4 is split into two sub-ACs (`AC4a` for the initial rule set, `AC4b` deferred to a follow-up) and AC5 narrows to the initial rule set's baseline.

## Definition of done

- [ ] Quinn `tech_design` approval received via the structured approval on this task.
- [ ] OQ1 (and OQ2/OQ3 if Quinn flags preferences) answered; design updated accordingly.
- [ ] Implementation PR opened (draft, no assignee per HEARTBEAT.md pre-publish check) with: root `package.json` + four app `vite.config.js` + four app `package.json` + `packages/ui/src/react/{index.jsx,tailwind-theme.css,styles.css}` + `scripts/{build-tailwind-theme.mjs,test/build-tailwind-theme.test.mjs}` + `packages/ui/src/react/{__snapshots__,index.migration.test.jsx}` + `.oxlintrc.json` + `docs/systems/design-system.md` + `.github/workflows/ci.yml` + `CONTRIBUTING.md`. (Plus the per-component CSS deletions/shrinks as decided during migration.)
- [ ] `## System Spec` section in the implementation PR body pointing at `docs/systems/design-system.md` "Design-system linting" section.
- [ ] Pre-publish check runs: assign `rowanstoffer`, request reviewers `quinnstoffer` (blocking) and `Stoff81` (visibility).
- [ ] Post `[implementer-prs] <url>` once draft → ready-for-review.
- [ ] Quinn first-look review on the brand-kit visual surface (`apps/website`) before merge.
- [ ] Local + CI green; merge after Quinn PR approval.
- [ ] Post-merge: `docs/systems/design-system.md` "Design-system linting" section is the canonical source of truth for active rule policy going forward; future component additions follow the `cva()` pattern documented there.