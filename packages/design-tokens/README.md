# `@sindustries/design-tokens`

Single source of truth for design tokens used across **web**, **React Native**, and **Pencil** (design files).

## How it fits together

```text
tokens.json   ← EDIT HERE (values)
     │
     ▼ npm run build
     ├── styles.css              CSS custom properties (web)
     ├── src/tokens.ts           TypeScript object (React Native / Node)
     ├── pen-tokens.json         Pencil variable payload (tooling / MCP)
     └── design-systems.pen      UI kit: variables + generated specimen + hand-authored components (Pencil **library**; no nested `imports`)
```

`scripts/build-tokens.mjs` auto-emits every key it finds in `tokens.json`:

- `core.color.<group>.<variant>` → `--si-color-<group>-<variant>` + Pencil var.
- `semantic.modes.{light,dark}.<camelKey>` → `--si-color-<kebab>` (themed) + Pencil themed var + `colors.<camelKey>` / `colorsLight.<camelKey>` in TS.
- `core.space.*` / `core.radius.*` / `semantic.font.*` / `semantic.shadow.*` → corresponding `--si-space-*` / `--si-radius-*` / `--si-font-*` / `--si-shadow-*` vars.

You only need to touch `build-tokens.mjs` if you want a **renamed/grouped accessor** in the TS export (e.g. `colors.labels.green` aliasing `colors.labelGreen`) or want a token to **appear in the Pencil specimen swatches** — see `swatches` / `labelSwatches` arrays in `buildPencilSpecimenDocumentChildren`.

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
   - Pencil: add a row to `swatches` / `labelSwatches` in `scripts/build-tokens.mjs` → `buildPencilSpecimenDocumentChildren`.
   - Web: `apps/tasks/src/pages/TokensPage.jsx` (`TOKEN_SWATCH_ROWS` / `TOKEN_LABELS`).
   - Mobile: `apps/budget-mobile/src/screens/TokenSpecimenScreen.tsx` (`swatches` / `labelSwatches`).

## Consumers

| Consumer | Import | Usage |
|----------|--------|-------|
| `apps/website` | `@sindustries/design-tokens/styles.css` | `var(--si-color-bg-canvas)` in CSS |
| `apps/budget-mobile` | `@sindustries/design-tokens/tokens` | `import { colors, space, radius } from '…'` |
| `docs/designs/budgeting/main.pen` | `imports.ui` → `design-systems.pen` | Components (`ui:…` refs) + `$si-color-*` / `$si-radius-*` on art (variables live in the same library) |
| `packages/design-tokens/design-systems.pen` | *(none)* | Hand-edited components + generated token specimen; **do not** add `imports` — build injects `variables` / `themes` |

## Pencil notes

- **`design-systems.pen`** — UI components + merged variables + generated token specimen. Use **`$si-color-*`**, **`$si-radius-*`**, etc. No nested library import so this file can be marked as a **Pencil library**.
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

Run `npm run build --workspace @sindustries/design-tokens` in CI after changes to `tokens.json` or `scripts/build-tokens.mjs`, and fail if `git diff` reports unstaged changes to `styles.css`, `src/tokens.ts`, `pen-tokens.json`, or **`design-systems.pen`** (variable section / imports/specimen).
