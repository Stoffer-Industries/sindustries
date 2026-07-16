# Budget Mobile App Spec

## Overview

Budget Mobile gives Tom an on-device view of Sindustries budget accounts, balances, alerts, and update status. During TestFlight testing the app must make it easy to confirm which EAS Update is installed.

## Flows

1. **Review account balances**
   - User opens the app and lands on Accounts.
   - The app shows account cards, a total balance panel, and demo balances when no session is active.
2. **Navigate budget sections**
   - User uses the bottom pill tab bar to switch between Accounts, Spend, and Alerts.
3. **Inspect build/update status**
   - User taps the header `more` button on Accounts.
   - The app opens Settings.
   - Settings shows the current update ID, short update ID, runtime version, EAS channel, update creation timestamp, whether updates are enabled, and whether the launch is embedded or OTA.
   - User can tap **Check for updates** to ask Expo Updates whether a compatible OTA update is available.

## Screens

### Accounts

- Header title: `Accounts`.
- Header subtitle shows either signed-in email or demo-state copy.
- Header `more` button opens Settings.
- A compact build/update banner appears above the navigator and remains visible while moving between screens.

### Settings

- Shows TestFlight/EAS Update metadata needed to verify OTA delivery from `main`.
- Shows `dev build / embedded` or `dev build` when Expo Updates has no update ID in local development.
- Provides a manual update check action for TestFlight/debug validation.

## E2E coverage

No automated E2E coverage is currently defined for Budget Mobile. TestFlight install, Apple signing, and EAS Update delivery require Expo/Apple credentials plus a physical iPhone, so this task is covered by TypeScript validation and manual TestFlight/EAS verification.
