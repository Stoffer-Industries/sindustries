-- Encrypt Akahu access tokens at rest (task f1175b18, AC1/AC2).
--
-- The `AkahuConnection.accessToken` column previously held the plaintext NZ
-- bank-aggregation credential. We replace it with `bytea` storing an
-- AES-256-GCM envelope: [version:1 | nonce:12 | ciphertext:N | tag:16].
--
-- Existing rows are dropped on purpose. See AC4 / runbook:
--   docs/runbooks/rotate-akahu-access-tokens.md
-- Affected users must re-link via OAuth after deploy. Pre-cloud, the
-- affected surface is dev/test rows only.
--
-- The repository layer (src/repos/akahuRepo.ts) is the sole caller of the
-- encrypt/decrypt helpers (src/lib/secretBox.ts); routes are unchanged.

ALTER TABLE "AkahuConnection"
  DROP COLUMN "accessToken",
  ADD COLUMN "accessToken" BYTEA NOT NULL DEFAULT '\x'::bytea;

-- Remove the default so future inserts must provide a real ciphertext.
ALTER TABLE "AkahuConnection"
  ALTER COLUMN "accessToken" DROP DEFAULT;
