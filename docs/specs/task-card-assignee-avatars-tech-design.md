---
status: draft
task_id: 332a9fc5-2e29-494e-a819-02d20e0c793a
product_spec: brain/tasks/specs/in-progress/task-card-assignee-avatars-2026-07-16.md
shipped_pr: null
shipped_date: null
---

# Agent avatars on task cards — tech design

## Links

- Product spec: `brain/tasks/specs/in-progress/task-card-assignee-avatars-2026-07-16.md`
- Task: `332a9fc5-2e29-494e-a819-02d20e0c793a` (`🔧 Agent avatars on task cards in Tasks app`)
- Tasks API record: `http://localhost:4001/api/v1/tasks/332a9fc5-2e29-494e-a819-02d20e0c793a`
- Existing avatar usage in tasks app: `apps/tasks/src/components/TaskCardSummary.jsx` (renders `<Avatar>` from `@sindustries/ui/react` with the assignee first letter as `children`)
- Existing first-letter helper: `apps/tasks/src/utils/helpers.js::assigneeInitial()`
- Existing agent avatar PNGs (runtime workspace):
  - `~/.openclaw/workspace/quinn.png`
  - `~/.openclaw/workspace/agents/ivy/ivy.png`
  - `~/.openclaw/workspace/agents/lox/lox.png`
  - `~/.openclaw/workspace/agents/rowan/rowan.png`
  - **Tom: not present** — see Open Questions §Q1
- `Avatar` UI component: `packages/ui/src/react/index.jsx::Avatar({ children, className, ...props })` — currently renders `children` inside `<span className="si-avatar">`, no `src` support
- App-level behaviour contract: `apps/tasks/SPEC.md`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-332a9fc5-task-card-assignee-avatars`
- Worktree: `~/workspaces/rowan/sindustries` (current)
- No secondary repos. Code lands entirely in `apps/tasks/` (frontend); static assets go under `apps/tasks/public/avatars/`. No tasks-api, agents, infra, or workspace-repo changes.

## Product intent (from approved product spec, restated)

Task cards display an assignee avatar image when one is set. When no avatar is set, the card falls back to today's first-letter behaviour. A small shared user model maps an assignee id to a display name and an optional avatar and is intentionally minimal so it can grow without changing call sites. v1 ships records for all five team members (Quinn, Ivy, Lox, Rowan, Tom) with their avatars sourced from the existing agent folder PNGs.

Approved by Tom (per task description).

## Acceptance criteria recap

- **AC1** — Task cards show the assignee's avatar image when one is set.
- **AC2** — Task cards fall back to today's first-letter rendering when no avatar is set or the user isn't known.
- **AC3** — Task cards show the assignee's display name (e.g. "Quinn") instead of the raw id, when the user is known.
- **AC4** — A shared user model exists that maps an assignee id to a display name and an optional avatar image.
- **AC5** — v1 records exist for Quinn, Ivy, Lox, Rowan, Tom.
- **AC6** — v1 ships with all avatars set. PNGs can be found in the agent folders (Quinn, Ivy, Lox, Rowan) at the runtime workspace paths above.
- **AC7** — Existing tests still pass.

## `.openclaw` boundary

- **No `~/.openclaw/` writes.** All assets in `apps/tasks/public/avatars/` are committed to the repo (this is a one-way copy of the runtime-Workspace PNGs into the repo).
- **No new secrets, tokens, or API routes.**
- **No cron / agent / lobster changes.**
- **No `packages/ui/` change.** We reuse `Avatar` from `@sindustries/ui/react` by passing an `<img>` element in `children`. This avoids a cross-package diff for what is a one-app-renderer concern (see Open Questions §Q2 for a future cleanup).

## Out of scope (deliberately)

- A "user detail" or profile screen for each assignee. The model is intentionally minimal — record lookup only.
- Roles, permissions, or authentication on the user record. Out of scope for v1.
- Migrating `task.assignee` from a free-form string to a typed user FK. The spec's Non-Goals section explicitly keeps it a string for v1.
- Adding avatar upload UI or back-end. Avatars in v1 are static PNGs bundled with the app; uploading is a follow-up.
- Avatar-related ops like caching, retina variants, or LQIP placeholders. Out of scope — Vite's `public/` resolution is fine at this scale.
- Cross-app exposure of the user model. This stays inside `apps/tasks/` for v1. A shared `packages/users/` extraction is a follow-up if Mission Control / Content Scheduler ever need it.
- Adding interactive actions on the avatar (click-to-filter, hover card). Visual element only.

## Implementation plan

### File / module scope

#### 1. Shared user model — `apps/tasks/src/users.js` *(new)*

A single source of truth for assignee → display name + avatar. Plain ES module (matches the rest of `apps/tasks/src/` style — no TypeScript surface change for the app).

```
// apps/tasks/src/users.js
const QUINN_AVATAR = '/avatars/quinn.png';
const IVY_AVATAR = '/avatars/ivy.png';
const LOX_AVATAR = '/avatars/lox.png';
const ROWAN_AVATAR = '/avatars/rowan.png';
const TOM_AVATAR = '/avatars/tom.png'; // see Open Questions §Q1

export const USERS = {
  Quinn:  { id: 'Quinn',  name: 'Quinn',  avatar: QUINN_AVATAR },
  Ivy:    { id: 'Ivy',    name: 'Ivy',    avatar: IVY_AVATAR },
  Lox:    { id: 'Lox',    name: 'Lox',    avatar: LOX_AVATAR },
  Rowan:  { id: 'Rowan',  name: 'Rowan',  avatar: ROWAN_AVATAR },
  Tom:    { id: 'Tom',    name: 'Tom',    avatar: TOM_AVATAR },
};
// Normalize to lowercase-id map so we don't punish case-insensitive input.
const USERS_BY_ID = Object.fromEntries(
  Object.values(USERS).map((u) => [u.id.toLowerCase(), u])
);

export function getUser(assigneeId) {
  if (typeof assigneeId !== 'string') return null;
  const key = assigneeId.trim().toLowerCase();
  return key && USERS_BY_ID[key] ? USERS_BY_ID[key] : null;
}
```

Key contract:
- `USERS` keyed by display name for human readability; `USERS_BY_ID` derived once at module load for O(1) case-insensitive lookup.
- `getUser(assigneeId)` returns `null` for unknown ids, empty strings, non-strings, or whitespace. Callers must treat `null` as "fall back to raw id and first letter".
- Avatar paths are repo-relative (`/avatars/<id>.png`) so Vite serves them straight out of `apps/tasks/public/` under whatever `BASE_URL` the app is hosted at. No `import` of binary assets — keeps the model JS, not a Vite-graph concern.
- Model is intentionally minimal: `{ id, name, avatar? }` (`avatar` is required-keyed in v1 per AC6). Future fields (handle, role, etc.) extend the shape without changing call sites.

#### 2. Static avatar assets — `apps/tasks/public/avatars/` *(new directory, 4 PNGs)*

Copy the four existing PNGs from the runtime workspace into the repo. **Tom's PNG is missing at the moment** — see Open Questions §Q1. We'll copy:

```
apps/tasks/public/avatars/quinn.png   <- ~/.openclaw/workspace/quinn.png
apps/tasks/public/avatars/ivy.png     <- ~/.openclaw/workspace/agents/ivy/ivy.png
apps/tasks/public/avatars/lox.png     <- ~/.openclaw/workspace/agents/lox/lox.png
apps/tasks/public/avatars/rowan.png   <- ~/.openclaw/workspace/agents/rowan/rowan.png
apps/tasks/public/avatars/tom.png     <- SEE OPEN QUESTION §Q1 (do not commit yet)
```

Resolution in the model is `/avatars/<id>.png` so:
- Dev (`vite serve`): resolved against `BASE_URL` (default `/`), so `/avatars/quinn.png` hits the dev server, which serves from `apps/tasks/public/avatars/quinn.png`.
- Prod build (`vite build`): Vite copies `public/` to `dist/` verbatim, so the URL still resolves.

#### 3. `TaskCardSummary` integration — `apps/tasks/src/components/TaskCardSummary.jsx` *(modified)*

Today the component renders an `<Avatar>` with the first letter as `children`. New behaviour: consult `getUser()`, render an `<img>` when the user exists *and* has an `avatar` that successfully resolves, otherwise fall back to the first letter. The display name surfaces through `aria-label` and the title text. Approximate diff:

```diff
 import { Avatar, Badge } from '@sindustries/ui/react';
-import { assigneeInitial } from '../utils/helpers.js';
+import { assigneeInitial } from '../utils/helpers.js';
+import { getUser } from '../users.js';
 ...
-      {assignee ? (
-        <Avatar aria-label={`Assignee ${task.assignee}`}>
-          {assignee}
-        </Avatar>
-      ) : null}
+      {task.assignee ? (
+        <Avatar
+          aria-label={`Assignee ${user?.name ?? task.assignee}`}
+          title={user?.name ?? task.assignee}
+        >
+          {user?.avatar ? (
+            <img
+              src={user.avatar}
+              alt=""
+              width={24}
+              height={24}
+              className="task-card-avatar-img"
+            />
+          ) : (
+            assignee
+          )}
+        </Avatar>
+      ) : null}
```

Notes:
- `user` is computed once: `const user = getUser(task.assignee);` near the top of the render. Falls back to `null` when the assignee id is unknown, so AC3 ("show the assignee's display name... when the user is known") reads naturally: the aria-label uses `user.name` when known, raw id otherwise.
- The `<img>` `alt=""` is intentional: the surrounding `<Avatar>` already provides the meaningful label via `aria-label`. A nested non-empty `alt` would cause double announcements.
- `width`/`height` attributes present to avoid CLS during image decode.
- No change to the existing assignee-first-letter helper or its tests.

#### 4. Tests — `apps/tasks/src/users.test.js` *(new)* and `TaskCardSummary.test.jsx` *(extended)*

- **`apps/tasks/src/users.test.js`** — Vitest unit tests:
  - `USERS` exposes five records with the expected ids, names, and avatar paths.
  - `getUser('Quinn')` returns the Quinn record.
  - `getUser('quinn')`, `getUser('  Quinn  ')` all return the same record (case+whitespace tolerant).
  - `getUser('NotAnAgent')`, `getUser('')`, `getUser(null)`, `getUser(undefined)` all return `null`.

- **`apps/tasks/src/components/TaskCardSummary.test.jsx`** — extend existing suite:
  - **Renders the avatar image** when `task.assignee` is a known id (e.g. `Quinn`) and the image asset resolves to a 200 — verified via stubbed `<img>` `onload`. Easiest implementation: render the component with no stub, assert that the `<img>` is present with `src="/avatars/quinn.png"` and `alt=""`.
  - **Falls back to first letter** when the assignee id is unknown (e.g. `Random Person`) — `<img>` not rendered, the letter `R` is the Avatar's child.
  - **aria-label uses display name** when known (`"Assignee Quinn"`), raw id otherwise (`"Assignee Random Person"`).
  - **Existing copy-task-id test still passes** (regression on AC7).

The existing `helpers.test.js` (which covers `assigneeInitial`) is left untouched.

#### 5. Documentation

- **`apps/tasks/SPEC.md`** *(modified)* — Add an item under the relevant flow noting the assignee avatar behaviour:
  - In Flow 2 ("View and edit a task"), under the existing card-rendering description: "Task cards show an assignee avatar image when one is set; otherwise they fall back to the first letter. The assignee label and `aria-label` show the display name (e.g. 'Quinn') when the user is known, the raw id otherwise."
  - Add a row to "E2e coverage" linking the existing card-rendering e2e to this behaviour. (If no e2e currently renders a card with a known assignee, add a `test/e2e/task-avatar.spec.js` covering the visible-image and letter-fallback cases — see Test plan §E2E.)
- **`docs/systems/`** — no change. There's no cross-cutting system doc for "users" yet; the model is app-local. If Mission Control or Content Scheduler adopts it later, we can add a system doc — out of scope here.

### Data model summary

A single new module `apps/tasks/src/users.js` exporting a frozen-ish `USERS` record and a `getUser(assigneeId)` lookup. No changes to `task` data shape, `tasks-api` payload, JSONL export, or anything persisted. The PNGs are static assets — no runtime data fetch.

### Cross-context coordination

- **App-level only.** No IPC, no HTTP, no websocket, no tasks-api change.
- **Build system:** Vite's default `public/` handling means no `vite.config.js` change required.
- **No package boundary change.** The `Avatar` UI component is reused as-is; the image is passed via `children`. (A future UI package extension to accept `src` is parked — see Open Questions §Q2.)

### Workflow / cron / skill changes

- **Cron:** none.
- **Skill:** none. Existing `tasks-create` skill is unaffected (assignee remains a free-form string).
- **Lobster:** none.

### Design system usage

- `<Avatar>` from `@sindustries/ui/react` is the only UI primitive used here. Sized via the existing `.si-avatar` class — no visual style changes are introduced. The `<img>` inside it inherits the `.task-card-avatar-img` CSS class so future styling can target it without re-styling the wrapper.
- A small CSS rule is added to `apps/tasks/src/styles/components.css` to ensure the `<img>` fills the `.si-avatar` circle (rounded-corner, object-fit cover). Minimal, scoped to the new class.

### Service boundary notes

- **Domain owner:** the tasks app (frontend). The user model is a frontend concern for v1; no back-end storage.
- **Why not in `packages/users/`:** the spec is a list of static assignee records. Putting a 5-row file in a shared package would be premature; Mission Control and Content Scheduler can lift the module later if they need the same records. A short extraction checklist lives in Open Questions §Q3.
- **Extraction / migration plan:** if/when 2+ apps need the records, lift `apps/tasks/src/users.js` verbatim to `packages/users/src/index.js`, swap imports, and add a tiny package README. Not done in this PR.

## Test plan

- **Unit (Vitest, `apps/tasks`):**
  - `users.test.js` (new) — record shape, lookup behaviour (case+whitespace tolerance, null-safety).
  - `TaskCardSummary.test.jsx` (extended) — image rendering, first-letter fallback, aria-label with display name vs raw id, copy-task-id regression.
  - `helpers.test.js` — unchanged, must still pass.
  - **Run target:** `npm --workspace apps/tasks run test` (existing) or `cd apps/tasks && npx vitest run`.
- **Static asset check:** `npm --workspace apps/tasks run build` succeeds with the four PNGs in `dist/avatars/`. (Vite default behaviour; verified once.)
- **E2E (Playwright, `apps/tasks/test/e2e/`):** if no e2e currently visits a rendered task card with a real assignee id, add `task-avatar.spec.js`:
  - Visit the tasks app, find a card with `assignee: "Quinn"`, assert the rendered `<img>` has `src` ending in `/avatars/quinn.png`.
  - Find a card with an unknown assignee (any unrecognised string), assert no `<img>` is rendered and the avatar's text content is the uppercase first letter.
  - Assert the assignee label text shows `Quinn`, not the raw id, for known ids.
  - **If** the existing e2e suite already exercises the card list and exposes assignee ids, extend it instead of adding a new file.
- **Manual smoke:**
  1. `cd apps/tasks && npm run dev` → open a board/column with mixed assignees: known (Quinn/Ivy/Lox/Rowan), known without avatar (Tom — see §Q1), unknown.
  2. Confirm: avatars show as rounded images for the 4 PNG-backed ids; Tom shows a first letter `T` if §Q1 path A, or an image if §Q1 path B; unrecognised ids show their first letter.
  3. Hover an avatar; confirm `title` shows the display name (e.g. `Quinn`).
  4. Confirm screen-reader announces `Assignee Quinn` (not `Assignee quinn` or `Assignee quinnstoffer`).
- **CI:** `apps/tasks` test and build workflows green (existing surfaces).

## AC verification matrix

| AC | Strategy | New tests |
|---|---|---|
| AC1 | `<img>` rendered inside `<Avatar>` when `getUser` returns a record with `avatar`. | `TaskCardSummary.test.jsx` image path |
| AC2 | `<img>` not rendered when user is unknown or `avatar` is unset; first letter from `assigneeInitial` is the child. | `TaskCardSummary.test.jsx` fallback paths; manual smoke for Tom |
| AC3 | aria-label and `title` use `user.name` when known; raw `task.assignee` otherwise. | `TaskCardSummary.test.jsx` aria-label cases |
| AC4 | `apps/tasks/src/users.js` exports `USERS` and `getUser`. | `users.test.js` record shape + lookup |
| AC5 | Five entries in `USERS` (Quinn, Ivy, Lox, Rowan, Tom). | `users.test.js` "five records" case |
| AC6 | Four PNGs shipped under `apps/tasks/public/avatars/`, referenced from `USERS`. Tom's PNG subject to §Q1. | Static asset check + manual smoke |
| AC7 | Existing `TaskCardSummary.test.jsx` copy-task-id test still passes; `helpers.test.js` unchanged and green. | Existing CI; regression on this PR's test run |

## Open questions / risks

- **Q1 — Tom avatar PNG source.** The runtime workspace has PNGs for Quinn, Ivy, Lox, Rowan but not Tom: `ls ~/.openclaw/workspace/tom/` shows an agent config dir but no `tom.png` or equivalent. AC6 says "v1 ships with all avatars set. These can be found in the agent folders as pngs", so we need Tom's png before the task can ship with all five images shipped. **Proposed paths (Quinn pick):**
  - **(A) Defer Tom's PNG to a follow-up:** ship the 4 PNG-backed avatars now, leave Tom's record with `avatar: '/avatars/tom.png'` returning a 404 in dev (the `<img>` will fail silently — fallback path takes over). AC6 is partially satisfied. A 30-line follow-up PR adds the PNG once Quinn/Tom drops it into `~/.openclaw/workspace/tom/tom.png` and we copy it in.
  - **(B) Block on the PNG:** Tom drops a PNG before this task ships. Cleaner AC6, slower.
  - **Default in this design doc: (A), but flag the choice in the `[tech-design]` comment** — Quinn can choose (B) at approval and we'll add the copy step.
- **Q2 — Avatar UI package extension (parking lot).** Today `<Avatar>` only takes `children`. Passing an `<img>` works fine for v1. A nicer contract is to extend `Avatar` to accept `src` + `alt` and own the rendering decision (e.g. transparent onerror fallback to children). **Decision: out of scope for this PR** — touches `packages/ui/` and the specimen page; not worth a cross-package diff for a single consumer. Parking lot item.
- **Q3 — Cross-app extraction (parking lot).** If Mission Control or Content Scheduler ever need the same records, extract `apps/tasks/src/users.js` to `packages/users/src/index.js` and import. Done in a one-line PR per consumer.
- **Q4 — Case sensitivity of assignee id.** `task.assignee` is a free-form string in v1. Today the codebase stores it as whatever the editor/creator typed (often the display name `Quinn`). We normalize to lowercase for lookup, but if someone stores `Quinn Stoffer` (a full name), it will not match. **Mitigation:** the spec keeps `task.assignee` as a free-form string. Long-term the cleaner fix is a FK migration (already parked in the spec's Non-Goals).
- **Q5 — Image-onerror fallback.** If a known user points at a missing PNG (Tom during Q1 path A), the `<img>` will fail silently and the user will see a broken-image icon instead of the letter. Two mitigations:
  - Add an `onError` handler that swaps the `<img>` out for the first letter. ~5 lines of component code.
  - Lean on the browser default broken-image styling. ~0 lines but visible to Tom.
  - **Recommendation:** add the `onError` handler — small, mechanical, makes the fallback reliable. Implementing it now in this design doc; cost is one extra test case.
- **Q6 — Accessibility (alt text + role).** The `<img>` is decorative inside an element with `aria-label`; setting `alt=""` is correct. The wrapping `<span class="si-avatar">` is implicitly a `role="img"` candidate when it carries an aria-label — but that's a UI package decision (Q2). For v1, the wrapper remains a `<span>`. If Mission Control users complain we can promote it in a follow-up.

## Companion doc updates

- `apps/tasks/SPEC.md` — add avatar behaviour under Flow 2 / view-and-edit and add an E2E coverage row.
- `docs/systems/` — none.
- `docs/ARCHITECTURE.md` — none (no new domain).
- `packages/ui/README.md` — none (no change to the UI package).

## Later todos (parking lot)

- Extend `packages/ui/react::Avatar` with `src`/`alt`/`onError` props (Q2).
- Extract `apps/tasks/src/users.js` to `packages/users/src/index.js` once a second app needs it (Q3).
- Mission Control or Content Scheduler adopting the same avatar records (Q3 downstream).
- Migrate `task.assignee` from a free-form string to a typed user FK (out of scope per spec Non-Goals; revisit when authorship data grows).
- Replace static PNGs with `pkg.asset()` / CDN-backed avatars once uploads are a thing. Not even on the v2 roadmap yet.
- Display-name localisation (full names alongside first-name display) once the team grows.
