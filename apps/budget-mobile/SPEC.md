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
4. **Sync Akahu transactions**
   - User taps **Sync now**, or links Akahu for the first time.
   - The app calls `POST /api/v1/akahu/sync` and reads the response's completeness fields.

## Sync completeness

The sync route reports whether the requested window was covered in full. The app must not claim a complete sync when the response says otherwise.

- `complete: true` — the window was traversed to the end. The app shows `Sync complete` (or `Akahu linked and synced` after a first-time link).
- `complete: false` — the window was only partially traversed, so some history may be missing. The app shows `Sync incomplete — some history may be missing` instead of `Sync complete`.
- A failed sync is reported as before: the status is cleared and an alert names the failure.
- `AKAHU_TIMEOUT` and `AKAHU_CANCELLED` are distinct failures. A timeout means the provider exceeded the sync budget and no checkpoint was advanced; a cancellation means the request was abandoned. Both leave the checkpoint unchanged, so the next sync retries the same window.

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
