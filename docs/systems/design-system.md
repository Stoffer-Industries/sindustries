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

**Status:** DORMANT (smoke-test wiring only — rules not enabled). Owned by follow-up task [`7986eb43-dc85-4512-b76a-1cfecefd8be7`](https://github.com/Stoffer-Industries/sindustries/blob/task-7986eb43/docs/specs/...) ("Adopt Tailwind v4 in `@sindustries/ui` — enables `@shadcn/lint` rules"). Task `da86ccd8` shipped the install, plugin registration, lint command, and CI smoke-test job; AC3 (active rules + rule-policy mapping) is explicitly deferred to the follow-up.

**Lint command:** `npm run lint:design-system` (wrapper at `scripts/check-design-system-lint.mjs`).

**What it covers today:** the wrapper asserts the `@shadcn/lint` Oxlint plugin loads cleanly against the configured web/React frontend surfaces (`apps/{website,tasks,mission-control,gymtrack}/src/**` + `packages/ui/src/react/**`). It exits 0 when the plugin loads and reports no offences, 1 when oxlint reports offences (unexpected in the dormant install), and 2 on configuration or IO errors.

**Why dormant:** `@shadcn/lint` ships Tailwind-class-string rules (`no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `no-unknown-classes`, `require-static-classes`, `no-leaked-tailwind-classes`) and reads theme tokens from Tailwind v4 `@theme` / `@theme inline` blocks. SIndustries frontend uses BEM-style CSS with `@sindustries/design-tokens` via CSS custom properties — no Tailwind anywhere on `main` (verified 2026-09-15 across `apps/`, `packages/`, `services/`, `agents/`). Enabling rules before Tailwind v4 lands in `@sindustries/ui` produces zero findings — a false-signal that proves nothing. A green `frontend-design-system-lint` job today is **indistinguishable from** a green job with rules enabled and a clean codebase; the CI job name, the wrapper banner, and this section collectively make the dormant state unmissable.

**Pinned versions:** `oxlint@1.83.0`, `@shadcn/lint@0.1.0`. Pinned (not ranged) per the install plan — `@shadcn/lint` is fast-moving upstream and rule semantics can change between minor versions. Bump deliberately; do not auto-upgrade.

**Files added by the dormant install (task `da86ccd8`):**

- `.oxlintrc.json` — registers the `@shadcn/lint` jsPlugin, `rulesEnabled: false`.
- `components.json` — points the linter at `packages/ui/src/react` for component discovery and `packages/design-tokens/styles.css` for theme tokens.
- `scripts/check-design-system-lint.mjs` — wrapper that runs oxlint with the plugin loaded and surfaces a clear dormant-state banner.
- `scripts/test/check-design-system-lint.test.mjs` — unit tests for the wrapper exit-code behaviour against stubbed configs.
- `package.json` — adds `lint:design-system` script and pins `oxlint` + `@shadcn/lint` as devDependencies.
- `.github/workflows/ci.yml` — adds the `frontend-design-system-lint` job (smoke test + unit tests) and wires it into the `merge-gate`.

**Where rule policy will live once enabled:** initially a new "Active rule policy" subsection of this page (per Quinn OQ3 — `docs/systems/design-system.md` is the single source of truth for visual design, so rule policy fits here). If the rule set grows past ~10 rules, the rule-specific doc moves to `docs/specs/shadcn-lint-rules.md` and this page keeps the high-level pointer. The dormant-install PR does not create `docs/specs/shadcn-lint-rules.md` — that's the follow-up's call once rules exist.

**How to run locally:** `npm run lint:design-system`. CI runs the same command plus the unit tests in `scripts/test/check-design-system-lint.test.mjs` (wired into `npm run test:lint` and the `frontend-design-system-lint` job).

**Contributor / agent guidance for resolving violations (forward-looking — not active yet):** when follow-up `7986eb43` lands and rules are enabled, violations should be triaged against the design-system token and component sources (`packages/design-tokens/tokens.json`, `packages/ui/src/react/`). An offence of `no-restyle` means the component is using ad-hoc Tailwind classes instead of `@sindustries/ui` component variants; fix by switching to the canonical component + variant. An offence of `no-raw-colors` or `no-arbitrary-values` means the code path is bypassing the design tokens; fix by adopting the named token (e.g. `text-cta-primary` after the Tailwind theme bridge lands). When in doubt, default to the canonical component + token; do not paper over with inline styles.

