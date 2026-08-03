# Tech Design — Cloud readiness: encrypt Akahu access tokens at rest

**Task:** 💻 Cloud readiness: encrypt Akahu access tokens at rest (`f1175b18`)
**Task link:** `http://localhost:4001/api/v1/tasks/f1175b18-e274-4af7-8b6f-b5ef01247bce` (active data plane is `:4001` prodlike per MEMORY.md)
**Owned by:** Rowan (responsible-implementer)
**Audit source:** `docs/repo-audits/2026-W29.md` Theme 2 / Milestone 1-A — **Critical** finding: `AkahuConnection.accessToken` plaintext in Postgres (`services/budget-api/prisma/schema.prisma:42`).
**System spec:** `docs/specs/budget-akahu.md` (existing — describes the OAuth flow and connection lifecycle; no rewrite needed, this change is invisible at the OAuth boundary.)

## Problem

`AkahuConnection.accessToken` is a plaintext `String` column. A DB dump yields live NZ bank-aggregation credentials. We need AES-256-GCM at rest with a key sourced from runtime config, before any cloud deployment.

## Goals

- `accessToken` is **never** written to Postgres as plaintext.
- The encryption key is **never** hard-coded; it comes from `BUDGET_API_TOKEN_KEY` at runtime.
- All read paths go through a single `decryptToken()` helper; all write paths go through a single `encryptToken()` helper.
- The auth boundary (`/akahu/authorize-url`, `/akahu/exchange`, `/akahu/sync`) is **unchanged from the caller's perspective** — callers still pass/receive plaintext strings at the API; encryption is purely a persistence concern.
- A versioned blob so future key-rotation or KMS migration can be added without dropping old rows.

## Non-goals

- KMS-managed master key (follow-up: add DEK + KMS envelope when cloud target is chosen).
- Re-architecting the OAuth flow or Akahu client.
- Per-row key rotation (single-env-key is fine for pre-cloud; design supports future v2-byte swap).

## Approach

Single `Bytes` column on `AkahuConnection` storing a versioned blob. Two helpers (`encryptToken`, `decryptToken`) live in a new `src/lib/secretBox.ts` module. The repo layer (`akahuRepo.ts`) is the only place that touches the raw bytes; routes continue to work in plaintext.

```
plaintext (string at API boundary)
  → encryptToken(plaintext)        # src/lib/secretBox.ts
  → Buffer: [version:1 | nonce:12 | ciphertext:N | tag:16]   # 29..N bytes
  → prisma.akahuConnection.upsert  # Bytes column
  → Postgres bytea
```

Reverse path on read:

```
prisma.akahuConnection.findUnique → Buffer (Bytes)
  → decryptToken(Buffer)           # src/lib/secretBox.ts
  → plaintext (string at API boundary)
  → return to caller { ...conn, accessToken: plaintext }
```

### Cipher choice

- **AES-256-GCM** (authenticated encryption). 32-byte key, 12-byte random nonce per encryption, 16-byte auth tag.
- **Key derivation:** `SHA-256(BUDGET_API_TOKEN_KEY)` → 32 bytes. Accepts any-length key string (env var, file path, etc.) and is deterministic so the same key unlocks the same blob. Switch to `scrypt` later if we want to harden against low-entropy keys.
- **Version byte:** first byte of the blob is `0x01`. Lets us support `0x02` (e.g., KMS envelope) without dropping existing rows.

### Module: `services/budget-api/src/lib/secretBox.ts`

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BUDGET_API_TOKEN_KEY;
  if (!raw) throw new Error('BUDGET_API_TOKEN_KEY is required (>= 16 chars recommended)');
  cachedKey = createHash('sha256').update(raw).digest();
  return cachedKey;
}

export function encryptToken(plaintext: string): Buffer {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptToken: plaintext must be a non-empty string');
  }
  const key = getKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, tag]);
}

export function decryptToken(blob: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES) {
    throw new Error('decryptToken: ciphertext too short');
  }
  if (buf[0] !== VERSION) {
    throw new Error(`decryptToken: unsupported version byte 0x${buf[0].toString(16)}`);
  }
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(1 + NONCE_BYTES, buf.length - TAG_BYTES);
  const key = getKey();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Test helpers — let tests inject a fixed key without touching env
export function __resetKeyCacheForTests() { cachedKey = null; }
export function __setKeyForTests(key: Buffer) { cachedKey = key; }
```

### Schema change

```prisma
model AkahuConnection {
  id          String   @id @default(uuid()) @db.Uuid
  userId      String   @unique @db.Uuid
  accessToken Bytes    // versioned blob: [version:1, nonce:12, ciphertext:N, tag:16]
  scope       String?
  lastSyncedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Migration: a single `Bytes` column replacing the existing `String`. Migration verifies the column is empty (or asks for a one-time OAuth re-link) before dropping — see "Backfill / rotation" below.

### Repo change: `services/budget-api/src/repos/akahuRepo.ts`

The repo boundary is the **only** place that touches raw bytes. Callers receive plaintext.

```ts
import { decryptToken, encryptToken } from '../lib/secretBox';

export async function upsertAkahuConnection(params: {
  userId: string;
  accessToken: string;       // plaintext at API boundary
  scope?: string | null;
}) {
  const ct = encryptToken(params.accessToken);
  return prisma.akahuConnection.upsert({
    where: { userId: params.userId },
    update: { accessToken: ct, scope: params.scope ?? undefined },
    create: { userId: params.userId, accessToken: ct, scope: params.scope ?? null }
  });
}

export async function getAkahuConnectionForUser(userId: string) {
  const row = await prisma.akahuConnection.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    accessToken: decryptToken(Buffer.from(row.accessToken)),  // plaintext
    scope: row.scope,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function markAkahuSyncComplete(params: { userId: string; lastSyncedAt: Date }) {
  return prisma.akahuConnection.update({
    where: { userId: params.userId },
    data: { lastSyncedAt: params.lastSyncedAt }
  });
}
```

### Routes

`routes/akahu.ts` is **unchanged** at the function signature level. It already passes `accessToken: string` to/from the repo, and continues to do so. The encryption is invisible at the route layer.

The only change to `routes/akahu.ts` is unrelated line 85-86: today it falls back to `process.env.AKAHU_DEV_USER_ACCESS_TOKEN` if the connection is missing. We'll keep that behavior but document it as a dev-only path.

### `services/budget-api/.env.example`

Add:

```
# AES-256-GCM key for at-rest encryption of Akahu access tokens (and any future secrets).
# Generate with: openssl rand -hex 32
# REQUIRED in production. In dev, auto-generated if missing? No — fail loudly so it's never silently weak.
BUDGET_API_TOKEN_KEY=
```

### `apps/budget-mobile` / `apps/mission-control`

No changes — these are clients of the API and don't touch the persisted token.

## Backfill / one-time rotation (AC4)

Two viable paths. **Defaulting to one-time rotation** because:

- We're pre-cloud and the affected surface is small (a handful of dev/test rows).
- Backfill requires reading plaintext, encrypting on the way through, and double-writing during a window — more code, more risk.
- The audit calls for "safe migration/backfill **or** documented one-time rotation procedure" — rotation is an acceptable path.

**Rotation procedure to ship in the PR description + a runbook entry:**

1. Deploy the schema migration (adds `Bytes` column, drops `String` column).
2. Any user with an existing `AkahuConnection` row needs to re-link via OAuth:
   - `GET /akahu/authorize-url` → user opens in browser
   - `POST /akahu/exchange` with the new code → fresh token stored as encrypted blob
3. If we want zero-downtime: pre-deploy a script that lists every existing user, sends them a one-time "please re-link Akahu" prompt, and marks the row as `requiresRelink: true`. The script is out of scope for this PR but the design doesn't block it.

If Quinn prefers backfill, I can swap in a pre-deploy script that reads all rows, encrypts each, writes the new column, then a single migration to drop the old column. Same wire-level behavior, just a different deploy-shape.

## Test plan

**Unit tests** (`test/secretBox.test.ts`):

- `encryptToken('abc')` then `decryptToken(...)` returns `'abc'`.
- Two encrypts of the same plaintext produce different ciphertexts (random nonce).
- Tampering with the ciphertext byte → `decryptToken` throws (GCM auth tag fails).
- Tampering with the auth tag → throws.
- Unsupported version byte → throws.
- Truncated buffer → throws.
- `encryptToken` throws when `BUDGET_API_TOKEN_KEY` is missing.
- `decryptToken` throws when `BUDGET_API_TOKEN_KEY` is missing.
- Cross-key decryption fails (encrypt with key A, decrypt with key B → throws).

**Integration tests** (`test/akahuRepo.test.ts`):

- `upsertAkahuConnection({ accessToken: 'tok_abc' })` then `getAkahuConnectionForUser(userId).accessToken === 'tok_abc'`.
- The raw row in Postgres (queried via `prisma.$queryRaw`) contains `Bytes` that DOES NOT contain the substring `tok_abc` (plaintext-leak guard).
- `upsertAkahuConnection` overwrites the existing row and the read returns the new value.
- `markAkahuSyncComplete` does not touch `accessToken`.

**Log/observability guard:**

- A test that instantiates the repo and asserts that `JSON.stringify` of the row's `accessToken` (as returned from the repo) does NOT contain the prefix `v1:` or any version byte. (Both the encrypted blob and the plaintext are sensitive; the repo returns plaintext, but the test ensures the test harness isn't accidentally serializing the raw bytes.)

**Manual smoke test** (documented in PR description):

- `psql` query: `SELECT access_token FROM akahu_connections LIMIT 5;` — result is bytea, not text, and doesn't lex-match a recognizable token prefix.
- `BUDGET_API_TOKEN_KEY=missing npm run dev:api` → server fails to start on first Akahu request (intentional).

## AC verification matrix

| AC | Where in plan |
|----|---------------|
| AC1 — `accessToken` stored as ciphertext via Prisma migration | Schema change to `Bytes`; migration drops old `String` column |
| AC2 — Read/write paths go through `encryptToken`/`decryptToken` (AES-256-GCM) | `src/lib/secretBox.ts` + `akahuRepo.ts` boundary |
| AC3 — Key from runtime config (`BUDGET_API_TOKEN_KEY`), never hard-coded | `getKey()` reads `process.env.BUDGET_API_TOKEN_KEY`; `.env.example` documents; no fallback |
| AC4 — Plaintext rows have a safe migration path or documented rotation | One-time rotation procedure documented above; backfill script option noted |
| AC5 — Tests cover encrypt/decrypt round-trip + plaintext not returned from persistence/log paths | `test/secretBox.test.ts` + `test/akahuRepo.test.ts` + raw-bytes assertion in integration test |

## Open questions / non-blockers

1. **Backfill vs rotation** — Quinn to pick. Default is rotation. If backfill is preferred, I'll add a pre-deploy script.
2. **Key backup / disaster recovery** — Out of scope. The `BUDGET_API_TOKEN_KEY` is a runtime secret; if it's lost, all encrypted tokens are lost (acceptable: re-link via OAuth). I'll add a sentence to the runbook.
3. **Per-row salt** — Not needed because we use a random nonce per encryption. Filing as "no" in the design.
4. **Should `BUDGET_API_TOKEN_KEY` be different per environment?** Yes (dev/staging/prod). I'll add a note to the runbook.

## Files changed in this PR

- `services/budget-api/prisma/schema.prisma` — column type change
- `services/budget-api/prisma/migrations/2026MMDDHHMMSS_akahu_token_encryption/migration.sql` — alter table
- `services/budget-api/src/lib/secretBox.ts` — new module
- `services/budget-api/src/repos/akahuRepo.ts` — boundary uses helpers
- `services/budget-api/.env.example` — document `BUDGET_API_TOKEN_KEY`
- `services/budget-api/README.md` — key rotation / disaster-recovery note
- `services/budget-api/test/secretBox.test.ts` — new
- `services/budget-api/test/akahuRepo.test.ts` — new

## Out of scope

- KMS-managed master key (e.g., AWS KMS, GCP KMS) — follow-up task.
- Encrypting other `String` secrets in the same schema (none currently stored).
- Auto-rotation of `BUDGET_API_TOKEN_KEY`.
