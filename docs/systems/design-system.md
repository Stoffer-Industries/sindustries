# Design System

**Type:** System reference
**Last updated:** 2026-06-30
**Owner:** Rowan (maintenance) · Tom (token decisions)
**Repos:** `Stoffer-Industries/sindustries`
**Packages:** `@sindustries/design-tokens`, `@sindustries/ui`

---

## Purpose

A single source of truth for visual design across all Sindustries surfaces — web apps, React Native, and Pencil design files. Tokens are defined once and emitted to CSS, TypeScript, and Pencil formats in a single build step.

---

## Architecture

```
packages/design-tokens/
  tokens.json              ← EDIT HERE — all token values
  specimen-layout.json     ← section order for web + Pencil specimens
  scripts/build-tokens.mjs ← emits all outputs
      │
      ├── src/tokens.ts         TypeScript export (React Native + Node)
      ├── styles.css            CSS custom properties (web)
      ├── pen-tokens.json       Pencil variable payload
      └── design-systems.pen   Pencil UI kit (variables + specimens)

packages/ui/
  src/react/               React components
    index.jsx              Barrel export
    base.css               Base styles (always applied)
    kit-pulse.css          Pulse kit (tasks app aesthetic)
    kit-brand.css          Brand kit (website aesthetic)
  src/specimen/generated/  Auto-generated web specimen manifest
  src/native/              React Native components
  component-catalog.json   Component registry + demo groups + Pencil names
```

**Golden rule:** only edit `tokens.json`, `specimen-layout.json`, and `component-catalog.json`. Everything under `src/tokens.ts`, `styles.css`, `pen-tokens.json`, `design-systems.pen`, and `src/specimen/generated/` is generated — commit the outputs but do not hand-edit them.

---

## Token structure

```
core.color.<group>.<variant>        → --si-color-<group>-<variant>  (CSS)
semantic.modes.light.<camelKey>     → --si-color-<kebab>            (themed CSS)
semantic.modes.dark.<camelKey>      → --si-color-<kebab>            (themed CSS)
core.space.*                        → --si-space-*
core.radius.*                       → --si-radius-*
semantic.font.*                     → --si-font-*
semantic.shadow.*                   → --si-shadow-*
budget.color.* / budget.space.*     → --si-budget-* (React Native: budget export)
```

Mode-aware aliases live in `semantic.modes.{light,dark}` and must have matching keys in both modes. Use `"{path.to.token}"` references to keep derived values in sync.

---

## Style kits (packs)

Components share one markup/class contract. Kits are alternative visual languages layered on top:

| Kit | File | Activation | Used by |
|---|---|---|---|
| *(base)* | `base.css` | Always on | All surfaces |
| `pulse` | `kit-pulse.css` | `tone="display"` / `tone="pulse"` on Button/Badge; `variant="pulse"` on Card | `apps/tasks` |
| `brand` | `kit-brand.css` | `data-si-pack="brand"` on `<html>` | `apps/website` |

To add a kit: create `kit-<name>.css`, add a `packs.<name>` entry per component in `component-catalog.json`, add a page with `"pack": "<name>"` to `specimen-layout.json`, rebuild.

---

## Consumers

| Consumer | Import | Kit |
|---|---|---|
| `apps/website` | `@sindustries/ui/react/styles.css` + React components | brand |
| `apps/budget-mobile` | `@sindustries/design-tokens/tokens` | n/a (React Native tokens) |
| `apps/tasks` | `@sindustries/ui/specimen` (design system preview route) | pulse |
| `docs/designs/budgeting/main.pen` | `design-systems.pen` library | n/a |

---

## Build

```bash
npm run build --workspace @sindustries/design-tokens
```

Overwrites: `styles.css`, `src/tokens.ts`, `pen-tokens.json`, `design-systems.pen`, `src/specimen/generated/*`. Commit generated files alongside source changes.

**CI sync check:**
```bash
npm run check:design-sync
```
Validates `component-catalog.json` ↔ React exports, rebuilds, and fails if generated outputs have drifted from source.

---

## Pencil (design files)

- **`design-systems.pen`** — UI kit: hand-authored components (`vtHps` frame) + generated token specimens (`siSpecRoot`, `siReactSpecPulse`, `siReactSpecBrand`). Mark as a Pencil library.
- **`pen-tokens.json`** — same data as JSON for tooling and CI checks.
- Build injects `variables`/`themes` into `design-systems.pen` on every run.

**Safe to hand-edit:** component layout inside `vtHps`. **Do not hand-edit:** `siSpecRoot`, `siReactSpec*` frames, root `variables`/`themes`.

**Linking components into specimens:** add `penRef` on demo entries in `component-catalog.json` → `specimenGroups`. Build copies refs from `vtHps` into the correct specimen frame.

---

## Runbook notes

**New token:** edit `tokens.json` → `npm run build` → commit generated outputs. New keys auto-appear in CSS, TS, and Pencil.

**New component:** add to `packages/ui/src/react/`, register in `component-catalog.json`, add demo to `specimen-layout.json`, rebuild.

**Pencil drift:** if `design-systems.pen` has nested library imports or stale generated frames, run `npm run sync:design-systems-pen` from repo root.

**Budgeting pen file:** sync with `npm run sync:budgeting-pen` — strips duplicates and updates the library import.

---

## Related

- `packages/design-tokens/README.md` — full build and token authoring guide
- `packages/design-tokens/tokens.json` — token source
- `packages/ui/component-catalog.json` — component registry
- `docs/designs/brand-spec.md` — brand decisions

---

## Design-system linting

**Status:** ACTIVE (rules enabled, baseline triage documented below). Installed by task [`da86ccd8`](https://github.com/Stoffer-Industries/sindustries/commit/da86ccd8) (dormant smoke-test wiring) and activated by task [`7986eb43-dc85-4512-b76a-1cfecefd8be7`](https://github.com/Stoffer-Industries/sindustries/blob/task-7986eb43/docs/specs/...) ("Adopt Tailwind v4 in `@sindustries/ui` — enables `@shadcn/lint` rules"). Slice 4 of `7986eb43` wired the rules at warn level so the baseline triage could capture offences without blocking CI; this section (slice 5) promotes the zero-offence rules to error and documents the Accepted baseline for the rest. Task `02c5475c` ("Harden CI merge and deployment gates") will close the gap once the kit CSS retirement task reduces the Accepted baseline to zero.

**Lint command:** `npm run lint:design-system` (wrapper at `scripts/check-design-system-lint.mjs`).

**Scope:** the wrapper runs Oxlint with `@shadcn/lint` against the web/React frontend surfaces — `apps/{website,tasks,mission-control,gymtrack}/src/**` + `packages/ui/src/react/**` — and the unit tests in `scripts/test/check-design-system-lint.test.mjs`. Exit 0 = clean, 1 = shadcn rule offences (CI-blocking at error level), 2 = config / IO error.

**Pinned versions:** `oxlint@1.83.0`, `@shadcn/lint@0.1.0`. Pinned (not ranged) per the install plan — `@shadcn/lint` is fast-moving upstream and rule semantics can change between minor versions. Bump deliberately; do not auto-upgrade.

**Active rule policy.** Six rules ship in `@shadcn/lint@0.1.0`; this project enables all six. Severity in `.oxlintrc.json`:

| Rule                          | Severity | Baseline (slice 5) | Rationale                                                                                                          |
| ----------------------------- | -------- | ------------------: | ------------------------------------------------------------------------------------------------------------------ |
| `shadcn/no-raw-colors`        | `error`  |                   0 | Zero offences on the slice-5 baseline. Agents that introduce raw Tailwind palette colors break the token contract. |
| `shadcn/no-arbitrary-values`  | `error`  |                   0 | The single slice-5 offence (`transition-[border-color,box-shadow,transform]`) is fixed in slice 5; new arbitrary values violate the token scale. |
| `shadcn/no-restyle`           | `warn`   |                  41 | Accepted baseline — see below.                                                                                      |
| `shadcn/no-inline-styles`     | `warn`   |                  23 | Accepted baseline — see below.                                                                                     |
| `shadcn/no-unknown-classes`   | `warn`   |                 685 | Accepted baseline — see below.                                                                                     |
| `shadcn/require-static-classes` | `warn`  |                   3 | Accepted baseline — see below.                                                                                     |

Total baseline: 753 offences across the 5 rules at warn. The error-level rules (`no-raw-colors`, `no-arbitrary-values`) gate the merge gate on first offence.

### Accepted baseline (slice 5)

Each Accepted-baseline entry has three parts: **scope** (where the offences live), **rationale** (why the offence is accepted rather than fixed now), and **path-to-zero** (the work that retires the baseline and promotes the rule to `error`).

**`shadcn/no-unknown-classes` — 685 offences across 50+ files.** **Scope:** kit-CSS and BEM/legacy classes that are not Tailwind utilities — `bookmarks-tab__*` in `apps/mission-control/src/tabs/`, `si-*` and `is-*` in `packages/ui/src/react/index.jsx`, `approvals-avatar`/`content-scheduler-*`/`task-editor-*`/`workout-*` in app-level component files. **Rationale:** slice 3 of task `7986eb43` deliberately retained BEM/legacy classes additively in `@sindustries/ui` so the existing kit CSS (`base.css`, `kit-pulse.css`, `kit-brand.css`) keeps matching while consumers migrate incrementally. Kit-CSS contracts in apps live alongside the components that use them. Lifting the BEM classes into Tailwind `@utility` declarations would require touching every app's kit CSS — that is the kit CSS retirement task, out of scope for `7986eb43`. **Path-to-zero:** kit CSS retirement task (`docs/specs/` not yet created) collapses `base.css`/`kit-pulse.css`/`kit-brand.css` into Tailwind `@utility` declarations or per-component variants and removes the additive BEM class emissions. Once that lands, `no-unknown-classes` becomes 0 and promotes to `error`.

**`shadcn/no-restyle` — 41 offences.** **Scope:** BEM/legacy classes applied directly to `@sindustries/ui` components — `<Card className="content-scheduler-composer">`, `<Avatar className="approvals-avatar is-approved is-revoked is-pending">`, `<Field className="task-editor-title-field">`, etc. **Rationale:** these are app-level contracts layering additional visual rules on top of the base component, used to differentiate per-tab/per-page layouts. The `shadcn/no-restyle` rule cannot statically recognize this as a per-component contract because the contract lives in the app, not the component. Per-`overrides`-per-file would suppress each occurrence but the rule's `contracts` API requires per-component rules in the component definition, which is outside the slice-5 scope. **Path-to-zero:** kit CSS retirement task migrates these contracts into either component variants or app-level `@utility` declarations; once each occurrence becomes a recognized Tailwind utility, `no-restyle` promotes to `error`.

**`shadcn/no-inline-styles` — 23 offences.** **Scope:** dynamic visual state in `BookmarksKpiRow`, `BookmarksStatesOverTimeChart`, `tasks/App` (editor grid), and similar feature components — `style={{ color: STATUS_COLOR_VAR[status] }}`, `style={{ gridColumn: '1 / -1' }}`, `style={{ left: hovered.x + 14, top: hovered.y - 10 }}`. **Rationale:** the rule's own error message ("use CSS custom properties for dynamic values") is exactly what most of these offences already do — the values are `var(--si-color-text, #111)` or `STATUS_COLOR_VAR[status]` (a CSS custom property map). The rule flags inline-style usage itself rather than raw values. The chart's `left`/`top` are genuinely dynamic (mouse-following tooltip positioning) and have no class-equivalent path under Tailwind. **Path-to-zero:** chart tooltip positioning moves to a CSS `transform: translate(...)` so the dynamic value is still inline but the rule's contract is met (inline `transform` is the conventional Tailwind-friendly dynamic positioning pattern, but the rule still flags it). Alternatively, per-`overrides` exclusion for `BookmarksStatesOverTimeChart.jsx` + per-feature-page rework for the others. The grid-column cases are fixable in-place.

**`shadcn/require-static-classes` — 3 offences.** **Scope:** `<Avatar className={\`approvals-avatar${isApproved ? ' is-approved' : ''}...\`}>` in `apps/tasks/src/components/ApprovalsSection.jsx:290`, `<Card className={\`content-scheduler-row${published ? ' content-scheduler-row--published' : ''}\`}>` in `apps/mission-control/src/tabs/SchedulerItemCard.jsx:76`, `<Toast className={\`toast toast-${toast.type}\`}>` in `apps/tasks/src/components/ToastStack.jsx:7`. **Rationale:** the rule's contract requires static class strings; ternary-built classNames can't be statically analyzed for the @sindustries/ui component grammar. **Path-to-zero:** migrate each occurrence to a `cn(approvalsAvatarClass({ state }))` call once the component library grows variant helpers for these state axes (or per-`overrides` exclusion with a `// shadcn-lint-disable-next-line` comment until then). Three occurrences, focused follow-up.

### Files added by task `da86ccd8` (dormant install)

- `.oxlintrc.json` — registers the `@shadcn/lint` jsPlugin, six rule entries, `settings.shadcn.ui`.
- `components.json` — points the linter at `packages/ui/src/react` for component discovery and `packages/design-tokens/styles.css` for theme tokens.
- `scripts/check-design-system-lint.mjs` — wrapper that runs oxlint with the plugin loaded and surfaces an active-state banner with per-rule offence counts.
- `scripts/test/check-design-system-lint.test.mjs` — unit tests for the wrapper exit-code behaviour against stubbed configs.
- `package.json` — adds `lint:design-system` script and pins `oxlint` + `@shadcn/lint` as devDependencies.
- `.github/workflows/ci.yml` — adds the `frontend-design-system-lint` job (smoke test + unit tests) and wires it into the `merge-gate`.

### Files changed by task `7986eb43` (activation)

- `.oxlintrc.json` — slice 4 renamed `settings.shadcn-lint` → `settings.shadcn` (the key `@shadcn/lint` 0.1.0 actually reads) and registered all six rules at warn; slice 5 promotes `no-raw-colors` and `no-arbitrary-values` to `error` (zero offences after the slice-5 fix).
- `packages/ui/src/react/index.jsx` — slice 5 replaces `transition-[border-color,box-shadow,transform]` with `transition` on the interactive Card variant (covers the same properties under Tailwind's default transition set, with no arbitrary value).
- `scripts/check-design-system-lint.mjs` — slice 4 banner switched from "dormant" to "ACTIVE lint pass"; slice 5 adds the per-rule offence count line and Accepted-baseline pointer.
- `scripts/test/check-design-system-lint.test.mjs` — slice 4 added active-state assertions (`settings.shadcn` present, `settings.shadcn-lint` absent); slice 5 does not change tests because the wrapper's exit-code behaviour is unchanged.

**Where rule policy lives:** this page is the single source of truth for visual design, so rule policy fits here. If the rule set grows past ~10 rules, the rule-specific doc moves to `docs/specs/shadcn-lint-rules.md` and this page keeps the high-level pointer. The slice-5 baseline lands all six rules on this page.

**How to run locally:** `npm run lint:design-system`. CI runs the same command plus the unit tests in `scripts/test/check-design-system-lint.test.mjs` (wired into `npm run test:lint` and the `frontend-design-system-lint` job).

**Contributor / agent guidance for resolving violations:** violations should be triaged against the design-system token and component sources (`packages/design-tokens/tokens.json`, `packages/ui/src/react/`). An offence of `no-restyle` means the component is using ad-hoc Tailwind classes instead of `@sindustries/ui` component variants; fix by switching to the canonical component + variant. An offence of `no-raw-colors` means the code path is using a raw Tailwind palette color instead of a token; fix by adopting the named token (e.g. `text-cta-primary` via the Tailwind theme bridge). An offence of `no-arbitrary-values` means the code is hardcoding an off-scale value; fix by adopting the standard Tailwind utility or moving the value into the design tokens. An offence of `no-inline-styles` means the component is using a JSX `style={{...}}` block; fix by moving the dynamic value into a CSS custom property (the rule's own recommended pattern — many of the Accepted-baseline occurrences already do this and await either a rule refinement or a per-`overrides` exclusion) or by adopting a Tailwind class. An offence of `no-unknown-classes` means the class is not in the Tailwind-generated stylesheet; fix by switching to a Tailwind utility, by adding an `@utility` declaration in `packages/design-tokens/styles.css`, or by moving the contract to a kit CSS class that the kit CSS retirement task will retire. An offence of `require-static-classes` means the className is built dynamically; fix by using a static className or a `cn()`/`cva()` helper. When in doubt, default to the canonical component + token; do not paper over with inline styles.

