---
status: draft
task_id: 332a9fc5-2e29-494e-a819-02d20e0c793a
product_spec: /Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/task-card-assignee-avatars-2026-07-16.md
shipped_pr: null
shipped_date: null
---

# Tech Design — Agent avatars on task cards

## Product spec link

- Product spec: `/Users/quinnstoffer/.openclaw/workspace/brain/tasks/specs/open/task-card-assignee-avatars-2026-07-16.md`
- Product intent: task cards should show an assignee avatar when configured, keep the current first-letter fallback, and display known assignees by display name instead of raw id. The user model is intentionally minimal and should grow without changing task-card call sites.

## Task and repo

- Task ID: `332a9fc5-2e29-494e-a819-02d20e0c793a`
- Task title: `🔧 Agent avatars on task cards in Tasks app`
- Branch: `task-332a9fc5-agent-avatars-on-task-cards`
- Worktree: `~/workspaces/rowan/sindustries-task-332a9fc5-agent-avatars-on-task-cards`
- Repository: `Stoffer-Industries/sindustries`

## Service boundary and data ownership

- Domain owner for this v1 is the Tasks app UI. `task.assignee` remains a free-form Tasks API string; no API or database migration is needed.
- The shared user model should live in the Tasks app source for now because only the Tasks app consumes it and the records are display metadata, not task state.
- Keep lookup code isolated behind helper functions so a future shared package, API-backed user service, or agent profile system can replace the in-app registry without changing `TaskCardSummary`.
- Direct consumers in this task: task cards, assignee dropdown/filter labels where useful, and tests. Do not introduce profile pages, auth, roles, or permissions.

## `.openclaw` boundary notes

- No secrets or external services are needed.
- Avatar source assets named in the product spec are outside the repo under `.openclaw` workspace agent folders. Implementation may read/copy those PNGs into repo-owned static assets, but must not mutate `.openclaw` paths.
- If a required source avatar is missing, do not invent replacement art; leave a clear implementation blocker or ask Tom/Quinn for the missing file.

## Implementation plan

1. Add a minimal shared assignee/user registry in `apps/tasks/src/users/assignees.js`.
   - Export `ASSIGNEE_USERS`, `ASSIGNEE_OPTIONS`, `findAssigneeUser(assignee)`, and `assigneeDisplayName(assignee)`.
   - Normalize ids case-insensitively and trim whitespace, while preserving the existing free-form `task.assignee` contract.
2. Move reserved assignee options out of `apps/tasks/src/utils/constants.js` or re-export them from the new registry.
   - Update `App.jsx`, `TaskEditor.jsx`, and any tests that import `ASSIGNEE_OPTIONS` to use the registry-backed export.
3. Add repo-owned static avatar assets under `apps/tasks/public/avatars/`.
   - Suggested filenames: `quinn.png`, `ivy.png`, `lox.png`, `rowan.png`, `tom.png`.
   - Registry `avatarSrc` values should be root-relative Vite public paths such as `/avatars/quinn.png`.
4. Extend the shared React `Avatar` primitive in `packages/ui/src/react/index.jsx` and `packages/ui/src/react/base.css`.
   - Add optional `src` and `alt` props.
   - If `src` is provided, render an image inside the existing `.si-avatar` shell; otherwise render children exactly as today.
   - Preserve the existing fallback text styling and existing public API.
5. Update `apps/tasks/src/components/TaskCardSummary.jsx`.
   - Resolve `task.assignee` through `findAssigneeUser`.
   - Render `<Avatar src={user.avatarSrc} alt={user.displayName}>` when a known user has an avatar.
   - Render the current first-letter fallback for unknown users or known users without `avatarSrc`.
   - Use known `displayName` in the avatar aria-label/title and any visible assignee text on the card.
6. Update user-visible app docs at implementation ship time.
   - `apps/tasks/SPEC.md` should mention task cards render known assignee display names and avatars with initial fallback.
   - No durable `docs/systems/` update is expected unless implementation creates a cross-cutting user model outside `apps/tasks`.

## Data model changes

The new app-local model is static metadata, not persisted task data:

```js
export const ASSIGNEE_USERS = [
  { id: 'quinn', displayName: 'Quinn', avatarSrc: '/avatars/quinn.png' },
  { id: 'ivy', displayName: 'Ivy', avatarSrc: '/avatars/ivy.png' },
  { id: 'lox', displayName: 'Lox', avatarSrc: '/avatars/lox.png' },
  { id: 'rowan', displayName: 'Rowan', avatarSrc: '/avatars/rowan.png' },
  { id: 'tom', displayName: 'Tom', avatarSrc: '/avatars/tom.png' }
];
```

- `id`: stable lowercase lookup key, derived from current reserved assignee names.
- `displayName`: human-readable label for cards, dropdowns, filters, and aria labels.
- `avatarSrc`: optional string; missing/null means use first-letter fallback.
- `task.assignee` remains unchanged and may still contain unknown free-form strings.

## Workflow, cron, and skill changes

- No workflow, cron, or skill changes.
- No Tasks API contract changes.

## Test plan

| AC | Verification |
| --- | --- |
| AC1: task cards show avatar image when one is set | Component test in `TaskCardSummary.test.jsx` with a Quinn task asserts an avatar image is rendered with accessible name/alt; E2E assertion can be added to `assignee-dropdown.spec.js` or `happy-path.spec.js` if selectors remain stable. |
| AC2: fallback to current first-letter rendering | Component tests for unknown assignee and known user with `avatarSrc: null` assert the existing initial is visible and no broken image is rendered. |
| AC3: display known assignee name instead of raw id | Component test passes lowercase/raw `quinn` and asserts accessible label/title uses `Quinn`; dropdown/filter tests continue to assert display labels. |
| AC4: shared user model maps id to display name and optional avatar | Unit tests for `findAssigneeUser`, normalization, and `assigneeDisplayName`; file-level review confirms consumers use the registry. |
| AC5: v1 records for Quinn, Ivy, Lox, Rowan, Tom | Unit test asserts the registry contains exactly/at least these ids and display names. |
| AC6: v1 ships with all avatars set | Unit/file test asserts each v1 record has a non-empty `avatarSrc`; E2E or build smoke confirms static files resolve from `apps/tasks/public/avatars`. |
| AC7: existing tests still pass | Run `npm test` or the repo's app-specific Tasks test command plus affected Playwright specs if practical. |

## Open questions and risks

- The Tasks API description currently says v1 ships with avatars unset, but the Tom-approved product spec says all avatars are set. Implementation should follow the product spec unless Quinn flags drift.
- I found Quinn, Ivy, Lox, and Rowan PNGs in `.openclaw` workspace paths, but did not find a Tom PNG during design. Tom's avatar asset location may need confirmation before implementation can satisfy AC6.
- Static `/avatars/*.png` paths assume the Tasks app is served from the Vite root. If it is later mounted under a subpath, switch to imported assets or `import.meta.env.BASE_URL` handling.
- Extending the shared `Avatar` primitive is low risk, but needs regression coverage so existing text avatars and specimen pages keep working.
