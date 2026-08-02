# Runbook — Rotate Akahu access tokens

**Owner:** Rowan (engineering)
**Triggers:** `BUDGET_API_TOKEN_KEY` rotation, suspected compromise of the at-rest key, or any case where existing ciphertext must be re-encrypted.
**Related:** task `f1175b18` (encrypt Akahu access tokens at rest), `services/budget-api/src/lib/secretBox.ts`, `prisma/migrations/<ts>_akahu_access_token_bytes/migration.sql`.

## Why this exists

`AkahuConnection.accessToken` is stored as AES-256-GCM ciphertext keyed off `BUDGET_API_TOKEN_KEY` (32-byte SHA-256 digest of the env var). The encryption layer is intentionally **single-key** (no envelope, no KMS) for pre-cloud simplicity — every stored token is bound to whatever value of `BUDGET_API_TOKEN_KEY` was live when it was written. If we ever change the key, every existing row becomes undecryptable.

There is no fallback or dual-key decrypt path. Rotation therefore forces a full re-link across affected users.

## Pre-flight

1. Snapshot the `AkahuConnection` table before any rotation:
   ```sql
   pg_dump -t '"AkahuConnection"' --data-only --no-owner > akahu-pre-rotate-$(date -u +%Y%m%dT%H%M%SZ).sql
   ```
   The backup is **still ciphertext** under the old key — useful for forensic / rollback only, not for resuming service.
2. Confirm the Akahu OAuth client (`AKAHU_CLIENT_ID`, `AKAHU_REDIRECT_URI`) is still valid and the OAuth app is reachable. Without it, users cannot re-link and `/akahu/sync` will return `401 UNAUTHORIZED` for every user.
3. Notify Tom (product) and Quinn (engineering lead) at least 30 minutes before the rotation window. Users will see `Akahu not linked` on the next sync and may file support tickets.

## Rotation procedure

### 1. Generate a new key

```sh
openssl rand -hex 32
```

Treat the output as a high-sensitivity secret. Store it in the platform secret manager (`BUDGET_API_TOKEN_KEY` slot), not in `.env` files or git.

### 2. Deploy with the new key

Push the new `BUDGET_API_TOKEN_KEY` via the normal deploy pipeline. There is no overlap window — the moment the new key is live, every existing row is unreadable. This is acceptable because the migration already zeroed plaintext rows; nothing on disk depends on the old key anymore.

If a **partial** rotation is needed (rolling a single instance, e.g. for verification), expect every `getAkahuConnectionForUser` call against the rotated instance to throw `decryptToken: unsupported version byte` or a GCM auth-tag failure. Treat that as expected; do not patch around it.

### 3. Force affected users to re-link

The `/akahu/sync` route already handles `401 UNAUTHORIZED → 'Akahu not linked for this user'` cleanly (see `services/budget-api/src/routes/akahu.ts`). Users will hit this on their next sync attempt. They re-link by:

1. Opening the app's Connect-to-Akahu flow.
2. Granting enduring consent on `oauth.akahu.nz`.
3. Returning to `/akahu/exchange` with the code; the new token is encrypted under the new key and persisted.

For a proactive rotation, also:

- Ship an in-app banner ("Akahu connection needs to be re-linked — please reconnect.") on the Workouts / Accounts tab.
- Email affected users (via the `EMAIL_FROM` template) with a deep link to the re-link flow.

### 4. Verify

After the deploy:

```sql
-- Should be 0: every row should have a fresh ciphertext blob whose version byte is 0x01.
SELECT count(*) FROM "AkahuConnection"
WHERE octet_length("accessToken") < (1 + 12 + 16);
```

```ts
// Smoke test: encrypt/decrypt round-trip with the live key.
import { encryptToken, decryptToken } from './services/budget-api/src/lib/secretBox.js';
const blob = encryptToken('smoke-test');
console.assert(decryptToken(blob) === 'smoke-test');
```

If any row reports a `decryptToken` error in the budget-api logs, the rotation did not land cleanly — roll back to the previous key and re-run.

## Rollback

1. Restore the previous `BUDGET_API_TOKEN_KEY` value in the secret manager.
2. Re-deploy. Existing ciphertext rows (under the old key) decrypt successfully again.
3. The pre-flight `pg_dump` is only useful if the secret-manager state itself was corrupted; in the common case (rotating the value, not the store), re-deploying the old value is sufficient.

Users who re-linked during the rotation window will have rows encrypted under the **new** key. After rollback, those rows are unreadable and they will be prompted to re-link again on next sync. This is acceptable: the affected user surface is small and the re-link flow is fast.

## Future hardening (not in scope today)

When we move to a cloud target with KMS access:

1. Switch to envelope encryption: generate a per-row DEK, encrypt the DEK with the KMS-managed master key.
2. Store `[version:2 | wrappedDek:N | nonce:12 | ciphertext:N | tag:16]`.
3. Add a dual-key decrypt path so rotations no longer force a full re-link.

Tracked as a follow-up task; see the cloud-readiness theme in `docs/repo-audits/`.
