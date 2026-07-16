---
status: approved
task_id: f8f38a04-d27e-4c33-a538-7ed4d9bc5929
product_spec: brain/tasks/specs/in-progress/budget-mobile-testflight-ota-2026-07-16.md
shipped_pr: null
shipped_date: null
---

# Tech Design — Budget Mobile: TestFlight + OTA Updates from Main

## Product intent

Spec (`brain/tasks/specs/in-progress/budget-mobile-testflight-ota-2026-07-16.md`) outcome: Tom can install budget-mobile on his iPhone via TestFlight and receive automatic over-the-air JS/asset updates within minutes of any merge to `main`, with no rebuild, no App Store wait, and no cable. This closes the on-device feedback loop so Tom can test real changes on-device throughout the day.

The five ACs collectively produce: a working TestFlight build (AC1), an OTA channel that pushes JS updates on every merge to `main` (AC2+AC3), a visible in-app identifier that proves which update is running (AC4), and a documented project configuration so a fresh checkout can run a build/update without extra setup (AC5).

## Task, branch, worktree, repo

- **Task:** `f8f38a04-d27e-4c33-a538-7ed4d9bc5929` (Budget Mobile: TestFlight install + OTA updates from main)
- **Branch:** `task-f8f38a04-budget-mobile-testflight-ota`
- **Worktree:** `~/workspaces/rowan/sindustries-task-f8f38a04-budget-mobile-testflight-ota`
- **Repo:** `Stoffer-Industries/sindustries` (monorepo)
- **App scope:** `apps/budget-mobile/` only

## Service boundary and data ownership

This task touches the budget-mobile app (`apps/budget-mobile/`) and the repo-level CI workflow (`.github/workflows/`). No new services, no new database tables, no new routes — EAS Build and EAS Update are Expo's hosted build/distribution surface, not part of our backend architecture. There is no change to `services/budget-api` ownership or data. No temporary placements; nothing to extract.

## `.openclaw` boundary notes

The following items live outside this repo and require Quinn (not Rowan) to set them up before the implementation PR can be merged green:

1. **EXPO_TOKEN secret** at `Stoffer-Industries/sindustries` repo → Settings → Secrets and variables → Actions → `EXPO_TOKEN`. Quinn creates this by signing into expo.dev, opening the budget-mobile EAS project, and copying a new token. Rowan posts `[openclaw-needed]` with the exact repo path + env var name + the command that needs it once the design is approved.
2. **Apple Developer Team ID + signing credentials for TestFlight.** EAS Build handles provisioning profile generation when EXPO_TOKEN is wired and the Apple team ID is provided in the EAS dashboard. Rowan configures `eas.json` with the iOS submission profile pointing at TestFlight and the EAS Build command (`eas build --platform ios --profile testflight --auto-submit`) — but the actual first TestFlight submission requires an interactive Apple ID sign-in via `eas credentials` (or upload of an Apple API key). Quinn coordinates that interactive step; Rowan cannot do it from CI.
3. **EAS Update channel** for the `main` branch. Quinn creates the `main` update channel in the EAS dashboard (or accepts whatever EAS creates from `--branch main --message "..."`) and confirms Tom's TestFlight install is bound to that channel.

Quinn's `[openclaw-done]` confirmation is required before Rowan can move the task from `doing` to `acceptance`; the implementation PR can land and merge without it, but AC1 + AC2 verification need Quinn's confirmation that the secrets/channels are wired.

## Implementation plan

### File / module scope

- `apps/budget-mobile/eas.json` (new): EAS Build + Submit + Update profiles. One `preview` profile for ad-hoc builds, one `production` profile targeting TestFlight (`simulator: false`, `distribution: "store"`), and one `production` Update channel bound to the `main` branch. Submit config (Apple Team ID, ASC API key path) is configured via EAS dashboard, not checked in.
- `apps/budget-mobile/app.json` (edit): add the `updates` block under the top-level `expo` key:
  ```json
  "updates": {
    "url": "https://u.expo.dev/<project-id>",
    "runtimeVersion": { "policy": "sdkVersion" }
  },
  "ios": {
    "infoPlist": {
      "ITSAppUsesNonExemptEncryption": false
    }
  }
  ```
  The `runtimeVersion.policy: "sdkVersion"` strategy keeps OTA compatibility simple per the spec note (no native runtime version bumps per build, so any JS change on the same SDK is compatible). `ITSAppUsesNonExemptEncryption: false` is the standard EAS TestFlight override so the build does not need an encryption compliance export.
- `apps/budget-mobile/src/components/UpdateBanner.tsx` (new): small banner shown at the top of `DashboardScreen` when `Updates.updateId` is available. Reads `expo-updates`'s `updateId`, `createdAt`, and `runtimeVersion`, renders them in a low-key style (matches existing `tokens.budget.color.muted` palette so it does not compete with the budget UI). Shows `"dev build"` when running locally (no `updateId`).
- `apps/budget-mobile/App.tsx` (edit): add an `UpdateBanner` mount point above the `Stack.Navigator` so it is visible on every screen. Wrap the navigator in `<UpdatesProvider>` from `expo-updates` so the banner can read update state.
- `apps/budget-mobile/package.json` (edit): add `eas-cli` as a devDependency (`^latest`), so `eas update` runs in CI without a global install.
- `apps/budget-mobile/src/screens/SettingsScreen.tsx` (new, optional but covered by AC4): a Settings tab on the dashboard with the build/update identifier, runtime version, and a "Check for updates" button. **Decision:** keep this as the primary AC4 surface (instead of relying only on `UpdateBanner`) because a Settings screen is a more permanent home for build metadata and Tom already expects it for on-device feedback. The `UpdateBanner` is a "you got a new update" indicator only.
- `.github/workflows/ci.yml` (edit): add a new `eas-update-on-main` job:
  - `on: push: branches: [main]` (CI already triggers on `main` push)
  - `if: github.event.head_commit.author.email != '41898282+github-actions[bot]@users.noreply.github.com'` (avoid loops when the bot pushes)
  - `runs-on: ubuntu-latest`, `concurrency: { group: eas-update-main, cancel-in-progress: false }`
  - steps: `actions/checkout@v4`, `actions/setup-node@v4` (Node 22), `npm ci`, `npx eas update --branch main --message "ci: ${{ github.event.head_commit.message }} (sha ${{ github.sha }})" --non-interactive`
  - env: `EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}`
- `docs/specs/budget-mobile-testflight-ota-tech-design.md`: this file (drafted here, committed on branch).
- `docs/systems/budget-mobile-distribution.md` (new, on ship): durable architecture doc covering EAS Build/Submit/Update profiles, the CI trigger, the runtimeVersion strategy, and the runbook for first-time EAS setup + secrets rotation.

### Data model / API contract changes

None. No new backend routes, no new tables, no new event payloads. EAS Update is content-delivery infrastructure, not part of our API.

### Workflow, cron, and skill changes

- New GitHub Actions job (`eas-update-on-main`) — covered above.
- No cron changes (EAS Update is push-triggered, not scheduled).
- No skill changes. The heartbeat still drives task state; the new CI job runs independently.

### AC-by-AC verification matrix

| AC  | Verification layer       | Evidence captured in PR                                                                                          |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| AC1 | manual (EAS dashboard)   | Screenshot of `eas build --platform ios --profile testflight --auto-submit` finishing + TestFlight build row    |
| AC2 | file + unit              | `eas.json` profile `production` includes `channel: "main"`; `app.json` `updates.url` points at `u.expo.dev`     |
| AC3 | ci (GitHub Actions)      | `eas-update-on-main` job definition in `.github/workflows/ci.yml`; first successful run attached to PR         |
| AC4 | file + unit              | `SettingsScreen.test.tsx` renders `updateId`, `runtimeVersion`, and timestamp; `UpdateBanner` unit test         |
| AC5 | docs + manual            | `README.md` in `apps/budget-mobile/` section "EAS Build + Update" documents setup steps; fresh-clone dry run   |

E2E coverage is not feasible for this task: TestFlight installs require a real Apple Developer account, an interactive `eas credentials` step on first build, and physical iPhone install. All ACs are therefore verified at the `file` / `ci` / `manual` layers above. The fallback is documented here so future audits see why E2E was skipped.

### Test plan (beyond the matrix)

- `npm test --workspace @sindustries/budget-mobile` runs new unit tests for `SettingsScreen` (renders updateId) and `UpdateBanner` (shows dev-build placeholder when no updateId).
- A `preflight:eas-update` Vitest that mocks `expo-updates` and verifies the Settings screen calls `Updates.checkForUpdateAsync()` on mount and surfaces the result.
- A CI dry run: `npx eas update --branch main --message "ci-dry-run" --non-interactive` against a branch named `ci/dry-run-eas-update` (does not push to `main`), gated behind a workflow_dispatch trigger so it never auto-runs against `main`.

## Risks and open questions

1. **EXPO_TOKEN rotation.** When Expo rotates the personal access token, CI breaks silently. Add a `docs/systems/budget-mobile-distribution.md` runbook entry describing the rotation cadence and how to update the GH secret without re-running a build.
2. **`auto-submit` vs manual submit.** Some Apple Developer accounts require manual approval for the first TestFlight upload; if `eas build --auto-submit` fails on first run, fall back to `eas build` + `eas submit --latest` and document the fallback in the runbook.
3. **runtimeVersion policy.** `sdkVersion` ties OTA updates to the Expo SDK version. When we eventually upgrade Expo SDK (e.g. 54 → 55), JS-only OTA updates from SDK 54 builds will NOT roll forward into SDK 55 builds — that requires a fresh TestFlight build. The spec already accepts this constraint.
4. **What to put in `--message`.** Using `${{ github.event.head_commit.message }}` includes the full commit message, which can include line breaks. EAS rejects messages with newlines. Plan: collapse to single line, truncate to 240 chars.
5. **First-time EAS project init.** Before `eas build` works, the EAS project must be created (`eas init`). Quinn runs this once; the resulting `extra.eas.projectId` is what `app.json` references. The PR must include the projectId once it is known; if it lands before `eas init` runs, the implementation PR is blocked on Quinn's `[openclaw-done]`.

## Out of scope (per spec)

- Android distribution (can be added later).
- Full App Store submission or production release.
- Native module changes or full rebuilds triggered by CI (OTA covers JS/assets only; native changes still require a manual TestFlight build).
- Push notification or background update delivery.

## Implementation milestones

1. **Tech design approved** — Quinn posts `[tech-design-approved] true`.
2. **Quinn runs EAS init** — creates the EAS project, captures the projectId, creates the `EXPO_TOKEN` GH secret, signs in to Apple for first build, creates the `main` update channel. Quinn posts `[openclaw-done]`.
3. **Implementation PR opened (draft)** — `eas.json`, `app.json` updates block, `SettingsScreen` + `UpdateBanner`, CI workflow job, unit tests, docs.
4. **Convert to ready-for-review** — all CI green, set assignee + reviewers per `pr-process` skill.
5. **Quinn approves + CI green → Rowan merges.** Tom installs the resulting TestFlight build and confirms the `main` channel OTA updates land on his phone within minutes of the next merge.
6. **System spec** — `docs/systems/budget-mobile-distribution.md` updated before moving to `acceptance`.