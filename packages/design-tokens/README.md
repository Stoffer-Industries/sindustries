# `@sindustries/design-tokens`

Single source of truth for design tokens used across **web**, **React Native**, and **Pencil** (design files).

## How it fits together

```text
tokens.json              ← EDIT HERE (token values)
specimen-layout.json     ← section order for pen + web specimens
packages/ui/component-catalog.json  ← React components per pack
     │
     ▼ npm run build
     ├── styles.css              CSS custom properties (web)
     ├── src/tokens.ts           TypeScript object (React Native / Node)
     ├── pen-tokens.json         Pencil variable payload (tooling / MCP)
     ├── design-systems.pen      UI kit: variables + generated specimens + hand-authored components
     └── packages/ui/src/specimen/generated/*   web specimen manifest (consumed by /design-system)
```

`scripts/build-tokens.mjs` auto-emits every key it finds in `tokens.json`:

- `core.color.<group>.<variant>` → `--si-color-<group>-<variant>` + Pencil var.
- `semantic.modes.{light,dark}.<camelKey>` → `--si-color-<kebab>` (themed) + Pencil themed var + `colors.<camelKey>` / `colorsLight.<camelKey>` in TS.
- `core.space.*` / `core.radius.*` / `semantic.font.*` / `semantic.shadow.*` → corresponding `--si-space-*` / `--si-radius-*` / `--si-font-*` / `--si-shadow-*` vars.

You only need to touch `build-tokens.mjs` if you want a **renamed/grouped accessor** in the TS export (e.g. `colors.labels.green` aliasing `colors.labelGreen`).

**Specimen layout** is driven by `specimen-layout.json` (token + React page sections) and `packages/ui/component-catalog.json` (component registry, demo groups, pen names). Edit those files, then rebuild — do not hand-edit generated pen specimen frames or `packages/ui/src/specimen/generated/*`.

**Surface stack** (`semantic.surfaceStack` in `tokens.json`) lists nesting background keys: `bgCanvas`, `bgSection`, `bgSurface`. Section chrome uses `bgSectionHeader`; form fields use `bgField`. Build emits `[data-si-surface="bgCanvas"]` (etc.) utilities that point at the matching `--si-color-bg-*` vars.

Build:

```sh
npm run build --workspace @sindustries/design-tokens
# or from this package
npm run build
```

That overwrites `styles.css`, `src/tokens.ts`, `pen-tokens.json`, and keeps `design-systems.pen` library-ready by removing nested imports, merging `themes` + `variables`, and refreshing its generated token specimen. Commit generated files alongside token changes.

## Adding or changing a token

1. **Edit `tokens.json`.**
   - Primitives go under `core` (e.g. `core.color.brand.500`).
   - Mode-aware aliases go under `semantic.modes.light` and `semantic.modes.dark` (keys must match in both).
   - Use `"{path.to.other.token}"` references so derived values stay in sync.

2. **Run `npm run build`** and commit the regenerated outputs. New keys flow into `styles.css`, `pen-tokens.json`, `src/tokens.ts`, and **into `design-systems.pen` variables + generated specimen** automatically.

3. **(Optional) feature it in a specimen** if you want the new token visible in the design preview:
   - Add swatch rows to `specimen-layout.json` → `swatches`.
   - Rebuild; token swatches appear in `design-systems.pen` (`siSpecRoot`) and `/design-system`.

## Consumers

| Consumer | Import | Usage |
|----------|--------|-------|
| `apps/website` | `@sindustries/ui/react/styles.css` | `<Button>` / `<Card>` / `<Badge>` with the **brand** kit (`data-si-pack="brand"` + `data-si-theme="light"` on `<html>`) |
| `apps/budget-mobile` | `@sindustries/design-tokens/tokens` | `import { colors, space, radius } from '…'` |
| `apps/tasks` | `@sindustries/ui/specimen` | `/design-system` mirrors pen layout (tokens + Pulse React) |
| `docs/designs/budgeting/main.pen` | `imports.ui` → `design-systems.pen` | Components (`ui:…` refs) + `$si-color-*` / `$si-radius-*` on art |
| `packages/design-tokens/design-systems.pen` | *(none)* | Hand-edited components + generated specimens; build injects `variables` / `themes` |

## Generated pen specimens

| Frame id | Source | Contents |
|----------|--------|----------|
| `siSpecRoot` | `specimen-layout.json` + `tokens.json` | Color, type, space, radius swatches |
| `siReactSpecPulse` | `component-catalog.json` | Pulse React demos + code catalog (paths to `@sindustries/ui/react`) |
| `siReactSpecBrand` | `component-catalog.json` | Brand-kit React demos (pill CTAs, chips, editorial cards) + code catalog |

### Style kits (packs)

Components in `@sindustries/ui` share one markup/class contract; **kits** are alternative visual languages over it (CSS in `packages/ui/src/react/`):

| Kit | File | Activation | Used by |
|-----|------|------------|---------|
| *(base)* | `base.css` | always on | specimen defaults |
| `pulse` | `kit-pulse.css` | per component: `tone="display"` / `tone="pulse"` (Button, Badge), `variant="pulse"` (Card) | `apps/tasks` |
| `brand` | `kit-brand.css` | by context: `data-si-pack="brand"` on a shell element (usually `<html>`) | `apps/website` |

To add a kit: create `kit-<name>.css` (import it from `styles.css`), add a `packs.<name>` entry per component plus `specimenGroups` with `"pack": "<name>"` in `component-catalog.json`, and add a page with `"pack": "<name>"` (optional `"theme"`) to `specimen-layout.json`. Rebuild — the web specimen page and a `siReactSpec*` pen frame are generated automatically.

Legacy shadcn components under frame `vtHps` are hand-authored archive — not part of the sync target.

### What the build overwrites in `design-systems.pen`

| Zone | Safe to hand-edit layout / children? | What rebuild does |
|------|--------------------------------------|---------------------|
| `siSpecRoot`, `siReactSpecPulse` (and any `siReactSpec*` frame) | **No** — specimen content is regenerated | Replaces frame **children** from `specimen-layout.json` + `component-catalog.json`. Preserves only position/size (`x`, `y`, `width`, `height`) and theme on the frame shell. |
| `vtHps` (design system components) | **Yes** — move, group, duplicate components freely | Does **not** reorder or replace component children. Only strips accidental generated-specimen frames if they ended up inside `vtHps`, and sets `vtHps.theme.Mode` to `Light`. |
| Component refs / art anywhere else in the file | **Yes** | String normalize (`$si:si-` → `$si-`), empty `theme: {}` cleanup |
| Root `variables` / `themes` | **No** (values) | Replaced from `tokens.json` each build |

**Linking `vtHps` components into specimen sections:** add `penRef` on each demo in `component-catalog.json` → `specimenGroups` (see the Buttons group). Rebuild copies refs from `vtHps` into `siReactSpecPulse` on every build. Optional `penComponentId` on a component entry is used in the code catalog row.

## Pencil notes

- **`design-systems.pen`** — UI components + merged variables + generated specimens (`siSpecRoot`, `siReactSpecPulse`). Use **`$si-color-*`**, **`$si-radius-*`**, etc. No nested library import so this file can be marked as a **Pencil library**.
- **`pen-tokens.json`** — same variable data as JSON for tooling (Pencil MCP `set_variables`, CI checks, etc.).
- Repo-root scripts (not run by this package's build):
  - `npm run sync:budgeting-pen` — set `docs/designs/budgeting/main.pen` `imports.ui` → `design-systems.pen`, strip duplicate root `variables`, remove legacy frame `q4Jkj` if present.
  - `npm run sync:design-systems-pen` — run the design-token build so `design-systems.pen` has no nested imports and carries current variables, themes, and generated specimen content.

## Package exports

| Path | Description |
|------|-------------|
| `@sindustries/design-tokens/styles.css` | Global CSS variables + base element styles |
| `@sindustries/design-tokens/tokens` | Generated `tokens` object and `colors` / `colorsLight` / `fonts` / `space` / `radius` / `platform` exports |
| `@sindustries/design-tokens/tokens.json` | Raw source JSON |
| `@sindustries/design-tokens/pen-tokens.json` | Generated Pencil variables (JSON mirror) |
| `@sindustries/design-tokens/design-systems.pen` | UI components + merged variables (library-ready) |

## CI

Run `npm run build --workspace @sindustries/design-tokens` after changes to token or specimen sources, and fail if generated outputs drift. From repo root:

```sh
npm run check:design-sync
```

This validates `component-catalog.json` ↔ React exports, rebuilds, and checks `styles.css`, `src/tokens.ts`, `pen-tokens.json`, `design-systems.pen`, and `packages/ui/src/specimen/generated/*`.
