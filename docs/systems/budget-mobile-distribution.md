# Budget Mobile Distribution

## Architecture and ownership

Budget Mobile (`apps/budget-mobile`) is distributed to iOS testers through Expo EAS Build and TestFlight. The Sindustries repo owns the app configuration, EAS profiles, and GitHub Actions update workflow. Expo owns build orchestration and OTA update hosting; Apple owns TestFlight delivery and signing credentials.

The Budget Mobile app uses `expo-updates` with `runtimeVersion.policy = "sdkVersion"` and the EAS Update branch/channel named `main`. Native runtime changes still require a new TestFlight build; compatible JS and asset changes can ship over the air.

## Runtime behaviour and operational flow

1. A TestFlight build is created from `apps/budget-mobile/eas.json` using the `testflight` profile:
   ```bash
   npx eas build --platform ios --profile testflight --auto-submit
   ```
2. The `testflight` build profile is bound to the `main` EAS Update channel.
3. On every push to `main`, `.github/workflows/ci.yml` runs `eas update --branch main --message "..."` from `apps/budget-mobile` using `EXPO_TOKEN`.
4. Installed TestFlight builds fetch compatible JS/asset updates from the `main` branch on launch.
5. The app shows the active update ID, runtime version, update channel, and update timestamp in Settings. A compact build/update banner is also visible across the app.

## Data contracts, API fields, task comments, and tags

No backend data model, API route, or service contract changes are introduced by this distribution flow.

Operational repo configuration:

- `apps/budget-mobile/app.json`
  - `expo.updates.url = https://u.expo.dev/<project-id>`
  - `expo.runtimeVersion.policy = sdkVersion`
  - `expo.extra.eas.projectId = <project-id>`
  - `expo.ios.bundleIdentifier = nz.co.sindustries.budgetmobile`
- `apps/budget-mobile/eas.json`
  - `build.testflight.distribution = store`
  - `build.testflight.channel = main`
  - `submit.testflight.ios = {}`
- GitHub Actions secret: `EXPO_TOKEN`
- Task workflow comments:
  - `[openclaw-needed]` requests Quinn-owned external Expo/Apple/GitHub secret setup.
  - `[openclaw-done]` confirms the external setup is complete.

## Runbook notes and common failure modes

- If GitHub Actions fails with an Expo auth error, rotate or recreate `EXPO_TOKEN` in the repository Actions secrets.
- If `eas build --auto-submit` fails on first upload, run `npx eas build --platform ios --profile testflight`, then `npx eas submit --platform ios --latest --profile testflight` after Apple credentials are bound.
- If OTA updates do not appear on Tom's phone, confirm the installed TestFlight build is on the `main` channel and that the update runtime version matches the installed SDK runtime.
- If `app.json` still contains the placeholder all-zero project ID, Quinn must run `npx eas init` and replace both placeholder UUIDs before build/update validation can pass.
- Expo SDK upgrades require a fresh TestFlight build because `sdkVersion` runtime policy separates OTA compatibility by SDK.

## Related specs, tasks, and PRs

- Task: `f8f38a04-d27e-4c33-a538-7ed4d9bc5929` — Budget Mobile: TestFlight install + OTA updates from main
- Tech design: `docs/specs/budget-mobile-testflight-ota-tech-design.md`
- Product spec: `brain/tasks/specs/in-progress/budget-mobile-testflight-ota-2026-07-16.md`
- PR: pending
