# Budget Mobile

## EAS Build + Update

Budget Mobile ships iOS test builds through EAS Build/TestFlight and receives JS/asset changes through EAS Update on the `main` channel.

### First-time setup

Quinn owns the one-time external setup because it requires Expo and Apple credentials outside this repo:

1. Run `npx eas init` in `apps/budget-mobile` and replace both placeholder UUIDs in `app.json`:
   - `expo.updates.url`: `https://u.expo.dev/<project-id>`
   - `expo.extra.eas.projectId`: `<project-id>`
2. Create a GitHub Actions repository secret named `EXPO_TOKEN` for `Stoffer-Industries/sindustries`.
3. Bind the Expo project to the Apple Developer team and provision signing credentials for `nz.co.sindustries.budgetmobile`.
4. Confirm the first TestFlight submission is available to Tom.

### Build for TestFlight

From this app directory:

```bash
npx eas build --platform ios --profile testflight --auto-submit
```

The `testflight` build profile uses the `main` EAS Update channel, so installed builds receive compatible OTA updates published to that branch.

### Publish an OTA update manually

```bash
npx eas update --branch main --message "manual: describe the change"
```

GitHub Actions also runs this command automatically after every push to `main` using the merge commit message and SHA.

### Runtime version policy

`app.json` uses `runtimeVersion.policy = "sdkVersion"`. JS and asset updates are compatible across builds with the same Expo SDK. Native dependency changes or Expo SDK upgrades still require a fresh TestFlight build.

### In-app verification

The Settings screen shows the current EAS update ID, runtime version, update channel, and update timestamp so Tom can confirm which push is installed.
