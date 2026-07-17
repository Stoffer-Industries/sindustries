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
- **AC6 ships v1 with all avatars unset and no avatar image files in this task.** Implementation must not copy PNGs from `.openclaw` workspace paths into the repo; adding avatar assets is an explicit follow-up task. The path for follow-up work (read source art, commit under `apps/tasks/public/avatars/`, point `avatarSrc` at the new files) is noted here as the next-task shape, but no asset work happens in this PR.
- Even though source art exists under `.openclaw` for Quinn, Ivy, Lox, and Rowan, none of it lands in the repo in this task.

## Implementation plan

1. Add a minimal shared assignee/user registry in `apps/tasks/src/users/assignees.js`.
   - Export `ASSIGNEE_USERS`, `ASSIGNEE_OPTIONS`, `findAssigneeUser(assignee)`, and `assigneeDisplayName(assignee)`.
   - Normalize ids case-insensitively and trim whitespace, while preserving the existing free-form `task.assignee` contract.
   - **All `avatarSrc` values are `null` in v1** per AC6. The field stays on the shape so a future avatar-asset task only has to fill the path.
2. Move reserved assignee options out of `apps/tasks/src/utils/constants.js` or re-export them from the new registry.
   - Update `App.jsx`, `TaskEditor.jsx`, and any tests that import `ASSIGNEE_OPTIONS` to use the registry-backed export.
3. **(No static avatar assets added in this task.)** AC6 forbids avatar image files in v1. The next-task shape — copy source art under `apps/tasks/public/avatars/`, point `avatarSrc` at the new paths — is captured here only for continuity; no PNGs land in this PR.
4. Extend the shared React `Avatar` primitive in `packages/ui/src/react/index.jsx` and `packages/ui/src/react/base.css`.
   - Add optional `src` and `alt` props.
   - If `src` is provided, render an image inside the existing `.si-avatar` shell; otherwise render children exactly as today.
   - Preserve the existing fallback text styling and existing public API.
   - Behavior when `src` is set but the file is missing must not throw — fall back to the existing children rendering (matches the AC2 fallback path).
5. Update `apps/tasks/src/components/TaskCardSummary.jsx`.
   - Resolve `task.assignee` through `findAssigneeUser`.
   - Render `<Avatar src={user.avatarSrc} alt={user.displayName}>` when a known user has an avatar (`avatarSrc` is `null` for v1, so this branch is the future-tasks path; the current PR still exercises the prop wiring in tests).
   - Render the current first-letter fallback for unknown users **and** known users without `avatarSrc` (which is every v1 user).
   - Use known `displayName` in the avatar aria-label/title and any visible assignee text on the card.
6. Update user-visible app docs at implementation ship time.
   - `apps/tasks/SPEC.md` should mention task cards render known assignee display names and avatars with initial fallback.
   - No durable `docs/systems/` update is expected unless implementation creates a cross-cutting user model outside `apps/tasks`.

## Data model changes

The new app-local model is static metadata, not persisted task data. Per AC6, v1 ships with every `avatarSrc` set to `null` — no avatar image files land in the repo in this task:

```js
export const ASSIGNEE_USERS = [
  { id: 'quinn',  displayName: 'Quinn',  avatarSrc: null },
  { id: 'ivy',    displayName: 'Ivy',    avatarSrc: null },
  { id: 'lox',    displayName: 'Lox',    avatarSrc: null },
  { id: 'rowan',  displayName: 'Rowan',  avatarSrc: null },
  { id: 'tom',    displayName: 'Tom',    avatarSrc: null }
];
```

- `id`: stable lowercase lookup key, derived from current reserved assignee names.
- `displayName`: human-readable label for cards, dropdowns, filters, and aria labels.
- `avatarSrc`: optional string; `null`/missing means use first-letter fallback. v1 ships with all `null`. A follow-up task is expected to copy source art into `apps/tasks/public/avatars/` and fill these paths — that work is **out of scope** here.
- `task.assignee` remains unchanged and may still contain unknown free-form strings.

## Workflow, cron, and skill changes

- No workflow, cron, or skill changes.
- No Tasks API contract changes.

## Test plan

Because v1 ships with all `avatarSrc` fields `null`, AC1's "avatar image is rendered when set" path is verified via a test fixture that injects a non-null `avatarSrc` into a registry copy — the production registry stays `null`, but the rendering branch is still exercised end-to-end.

| AC | Verification |
| --- | --- |
| AC1: task cards show avatar image when one is set | Component test in `TaskCardSummary.test.jsx` uses a local registry clone where Quinn has `avatarSrc: '/avatars/__test-fixture__.png'` and asserts an `<img>` is rendered with that `src` and the user's `displayName` as alt text. A second test asserts the production registry still has `avatarSrc: null` for Quinn, so the fixture does not leak into ship code. E2E assertion can be added to `assignee-dropdown.spec.js` or `happy-path.spec.js` if selectors remain stable (will assert fallback path since production has no avatars). |
| AC2: fallback to current first-letter rendering | Component tests for unknown assignee and known user with `avatarSrc: null` assert the existing initial is visible and no broken image is rendered. |
| AC3: display known assignee name instead of raw id | Component test passes lowercase/raw `quinn` and asserts accessible label/title uses `Quinn`; dropdown/filter tests continue to assert display labels. |
| AC4: shared user model maps id to display name and optional avatar | Unit tests for `findAssigneeUser`, normalization, and `assigneeDisplayName`; file-level review confirms consumers use the registry. |
| AC5: v1 records for Quinn, Ivy, Lox, Rowan, Tom | Unit test asserts the registry contains exactly/at least these ids and display names. |
| AC6: v1 ships with all avatars unset (no avatar image files in this task) | Unit test asserts each v1 record has `avatarSrc === null`. File-level assertion: `apps/tasks/public/avatars/` does not exist in the diff (or is empty if it pre-existed). No PNG/JPG/SVG avatar assets added by this PR. |
| AC7: existing tests still pass | Run `npm test` or the repo's app-specific Tasks test command plus affected Playwright specs if practical. |

## Open questions and risks

- **Drift between product spec and task description** — the Tom-approved product spec says "all avatars are set"; the task description (also Tom-approved) says "v1 ships with all avatars unset. No avatar image files in this task." The task description is more recent and explicit, so the implementation follows it. The follow-up task that adds real avatar assets will need its own spec/AC cycle (copy under `apps/tasks/public/avatars/`, point `avatarSrc` at new paths, re-add an AC1 E2E that resolves real files).
- Static `/avatars/*.png` paths (the future-task shape) assume the Tasks app is served from the Vite root. If it is later mounted under a subpath, switch to imported assets or `import.meta.env.BASE_URL` handling.
- Extending the shared `Avatar` primitive is low risk, but needs regression coverage so existing text avatars and specimen pages keep working.
- When `src` is provided but the image fails to load (e.g. asset missing at runtime), the `Avatar` primitive should fall back gracefully. Verify the behavior is documented in the primitive's tests so the next-task avatar addition does not regress the fallback path.
