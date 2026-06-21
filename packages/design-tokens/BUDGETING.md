# Budgeting Mobile Token Decisions

Phase 1 source: `docs/designs/budgeting/main.pen` (Pencil JSON, imports `../../../packages/design-tokens/design-systems.pen`).

## Namespace Decision

Budgeting uses a distinct dark mobile palette instead of the current brand/web semantic modes. The budget app shell (`#1f1f23`), row/card stack (`#25252a`, `#28282e`, `#2a2a2f`), iOS overlays, chart fills, and category colors are not just light/dark variants of existing `semantic.modes` keys.

Decision: add a dedicated `budget` namespace in `tokens.json` and expose it from `@sindustries/design-tokens/tokens` as `budget`. The build also emits `--si-budget-*` CSS variables and `$si-budget-*` Pencil variables so the mobile app and Pencil files can share the same source without changing the existing web-facing semantic contract.

## Extracted Budgeting Values

Unique hex colors found in `main.pen`:

`#000000`, `#00000000`, `#00000066`, `#00000080`, `#0a84ff`, `#10b981`, `#10b98155`, `#111827`, `#16161a`, `#193326`, `#1f1f23`, `#202027`, `#202a38`, `#25252a`, `#28282e`, `#2a2a2f`, `#2c2c2e`, `#34343a`, `#3a1618`, `#45c073`, `#45c07300`, `#45c07340`, `#4a9fd8`, `#54545899`, `#60a5fa`, `#60a5fa33`, `#6d5dfb`, `#77777e`, `#92929a`, `#92929a55`, `#a78bfa`, `#a8a8ae`, `#a8a8ae55`, `#b7b7bd`, `#d7d7dc`, `#ebebf599`, `#f4f4f5`, `#f59e0b`, `#f87171`, `#f8717155`, `#ff453a`, `#ffffff`, `#ffffff05`, `#ffffff0c`, `#ffffff10`, `#ffffff12`, `#ffffff14`, `#ffffff18`, `#ffffff22`.

Unique `cornerRadius` values found:

`3`, `4`, `7`, `8`, `12`, `13`, `14`, `15`, `16`, `18`, `20`, `22`, `23`, `24`, `26`, `34`, `36`.

Unique `gap` / `padding` values found:

`0`, `3`, `4`, `5`, `6`, `8`, `10`, `12`, `13`, `14`, `16`, `18`, `20`, `21`, `22`, `24`.

## Color Alignment

Surface colors:

- `#1f1f23` -> `budget.color.surface.app`
- `#28282e` -> `budget.color.surface.card`
- `#25252a` -> `budget.color.surface.row`
- `#2a2a2f` -> `budget.color.surface.elevated`
- `#202027` -> `budget.color.surface.inset`
- `#202a38` -> `budget.color.surface.info`
- `#34343a` -> `budget.color.surface.strong`
- `#2c2c2e` -> `budget.color.surface.modal`
- `#f4f4f5` -> `budget.color.surface.control`

Text colors:

- `#ffffff` -> `budget.color.text.primary`
- `#b7b7bd` -> `budget.color.text.secondary`
- `#92929a` -> `budget.color.text.muted`
- `#a8a8ae` -> `budget.color.text.subtle`
- `#77777e` -> `budget.color.text.disabled`
- `#16161a` -> `budget.color.text.inverse`

Accent/status colors:

- `#45c073` -> `budget.color.status.income`
- `#10b981` -> `budget.color.status.success`
- `#f87171` -> `budget.color.status.danger`
- `#0a84ff` -> `budget.color.status.iosInfo`
- `#ff453a` -> `budget.color.status.iosDanger`

Chart colors:

- `#45c073`, `#45c07340`, `#45c07300` -> income line/fill tokens
- `#60a5fa`, `#60a5fa33` -> blue chart/fill tokens
- `#10b98155`, `#f8717155` -> selected/danger translucent chart tokens

Category colors:

- `#10b981` -> groceries
- `#60a5fa` -> subscriptions
- `#f59e0b` -> transport
- `#a78bfa` -> dining
- `#92929a` -> other

The remaining alpha whites/blacks are mapped as budget border and overlay tokens so React Native components do not need raw literal colors for strokes, scrims, and pressed states.
