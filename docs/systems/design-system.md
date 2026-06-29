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
