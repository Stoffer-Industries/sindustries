---
status: draft
task_id: f1175b18-e274-4af7-8b6f-b5ef01247bce
product_spec: n/a (audit-driven: docs/repo-audits/2026-W29.md Theme 2 / Milestone 1-A)
shipped_pr: null
shipped_date: null
---

# Cloud readiness: encrypt Akahu access tokens at rest

## Links

- Product spec: n/a — derived from `docs/repo-audits/2026-W29.md` Theme 2 / Milestone 1-A
- Tech design: `docs/specs/cloud-readiness-akahu-encrypt-at-rest-tech-design.md`
- Task: `f1175b18-e274-4af7-8b6f-b5ef01247bce`
- Tasks API record: `http://localhost:4001/api/v1/tasks/f1175b18-e274-4af7-8b6f-b5ef01247bce`

## Repositories

- Primary repo: `Stoffer-Industries/sindustries`
- Branch: `task-f1175b18-cloud-readiness-akahu-encrypt-at-rest`
- Worktree: `~/workspaces/rowan/sindustries`
- Expected `.openclaw` follow-up: `[openclaw-needed]` Quinn must provision `BUDGET_API_TOKEN_KEY` in cloud runtime secrets (not committed).

## Scope

`AkahuConnection.accessToken` is currently stored as plaintext `String` in the Prisma schema. The audit calls this Critical: a database dump or backup leak exposes live bank-linking credentials. Before cloud exposure, tokens must be stored as ciphertext using AES-256-GCM, with the key supplied by runtime config.

This task introduces a small encryption helper, a Prisma migration that converts the column to `Bytes`, and a backfill/rotation procedure for any existing rows.

## Ownership boundary

- Encryption helper lives in `services/budget-api/src/lib/crypto/secretBox.ts`. It is service-local because Akahu is owned by `budget-api`. If other services later need the same primitive, it can be promoted to a shared package then — not now, to avoid premature abstraction.
- The encryption key is a runtime concern (cloud secret), not a config-file concern. It must never appear in `.env`, `.env.example`, or the repo.
- We use AES-256-GCM (authenticated encryption) so we get integrity for free. AES-CBC + HMAC would be equivalent but adds two key paths; GCM is simpler.

## Implementation plan

File/module scope:

- `services/budget-api/prisma/schema.prisma` — change `accessToken String` to `accessToken Bytes` on `AkahuConnection`. Add a sibling column `accessTokenIv Bytes?` if we choose to store the IV alongside the ciphertext; alternatively prepend the IV to the ciphertext bytes and store as a single `Bytes` column (preferred — fewer columns, fewer migration footguns).
- `services/budget-api/prisma/migrations/<timestamp>_akahu_encrypt_access_token/migration.sql` — new migration. For SQLite (dev/test): `CREATE TABLE AkahuConnection_new (... accessToken BLOB NOT NULL)`, copy with `encrypt(old)`, drop old, rename. For Postgres (cloud): `ALTER TABLE "AkahuConnection" ALTER COLUMN "accessToken" TYPE BYTEA USING convert_to(...)`. The migration must be a no-op when no rows exist.
- `services/budget-api/src/lib/crypto/secretBox.ts` — new. Exports `encrypt(plaintext: string): Buffer` and `decrypt(ciphertext: Buffer): string`. Uses Node `crypto.createCipheriv('aes-256-gcm', key, iv)` with 12-byte random IV, prepends `[iv(12) | authTag(16) | ciphertext]` to the returned buffer. Key is loaded lazily from `process.env.BUDGET_API_TOKEN_KEY` (32 bytes, base64-encoded) and cached for the process lifetime; throws at first use if missing.
- `services/budget-api/src/lib/crypto/secretBox.test.ts` — new. Round-trip encrypt/decrypt, tampered ciphertext fails GCM auth, wrong key fails, missing key throws with a clear error.
- `services/budget-api/src/services/akahuConnectionService.ts` (or current read/write site) — route every `accessToken` read/write through `secretBox`. The model layer returns decrypted plaintext only to callers that already had access pre-encryption; logging/tracing paths must explicitly redact the field.
- `services/budget-api/src/routes/akahu.ts` (or `exchange` route) — the Akahu OAuth exchange path stores the returned access token via the service, which now encrypts.
- `services/budget-api/scripts/rotate-akahu-tokens.ts` — new one-time rotation helper. Reads every row, decrypts with old key, re-encrypts with new key, writes back in a transaction. Idempotent and safe to re-run. Documented in the runbook.
- `services/budget-api/.env.example` — add `BUDGET_API_TOKEN_KEY=` with a comment: "32 bytes, base64 — set in cloud; do NOT commit".

## Data model / API contract

- `AkahuConnection.accessToken`: `String` → `Bytes`. Stored as `[iv(12) | authTag(16) | ciphertext(N)]`.
- New env var: `BUDGET_API_TOKEN_KEY` — required at boot in cloud; missing → process refuses to start with a clear log line.
- API responses: unchanged. The `/akahu/...` routes never return the access token in responses today; this task does not change that contract.

## Workflow / cron / skill changes

- None. No Lobster or cron touches Akahu tokens.

## Test plan (AC verification matrix)

| AC | Verification |
|---|---|
| AC1 — column is ciphertext (Bytes), Prisma migration in place | Schema diff in PR; migration file present; integration test inserts and reads back, asserts the stored bytes are NOT the plaintext. |
| AC2 — all read/write paths go through AES-256-GCM helper | Grep test: ripgrep for `accessToken` assignments in `services/budget-api/src` returns only references to `secretBox.encrypt/decrypt`. `secretBox.test.ts` proves helper correctness. |
| AC3 — key from runtime config, never hard-coded | `secretBox.ts` reads `process.env.BUDGET_API_TOKEN_KEY`; unit test injects a key via env and verifies encrypt/decrypt. Grep test confirms no key literal anywhere in `src/`. `.env.example` does not contain a real value. |
| AC4 — safe migration/backfill for existing rows | `scripts/rotate-akahu-tokens.ts` covers rotation. Migration `up` migrates any pre-existing rows by encrypting with the configured key; migration `down` decrypts back to plaintext (only for safe rollback in dev). Documented in `docs/systems/budget-api-auth.md` (or new runbook entry) with a one-time-run example. |
| AC5 — tests cover round-trip + plaintext not leaked to logs/persistence | `secretBox.test.ts` (round-trip + tamper). A contract test runs the exchange path end-to-end, asserts the Prisma row's `accessToken` bytes do not contain the plaintext substring. A logger test asserts redaction in `pino`/`winston` output. |

User-visible ACs: none of the ACs are user-visible app flows — this is purely a persistence/secret-handling hardening task. E2E is not applicable; coverage is at unit + integration layers.

## Open questions and risks

- **Multi-key rotation window**: GCM with a single key means rotating the key requires a downtime window or dual-key support. Out of scope for v1; the `rotate-akahu-tokens.ts` script is the documented one-time path.
- **Backup snapshots**: any pre-encryption DB snapshot is still plaintext. The runbook must call out snapshot handling (treat as compromised; rotate tokens after migration).
- **Test data**: local SQLite dev DBs often have plaintext rows. The migration's idempotent encrypt path must work against dev DBs as well as a fresh Postgres cloud DB.

## Linked audit

- `docs/repo-audits/2026-W29.md` — Theme 2 (Budget-API secrets), Milestone 1-A, severity Critical.