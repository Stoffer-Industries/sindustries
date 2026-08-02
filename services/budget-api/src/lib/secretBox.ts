import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for short-lived secrets (currently: Akahu
 * access tokens; designed to absorb future secrets without API churn).
 *
 * Blob layout: `[version:1 | nonce:12 | ciphertext:N | tag:16]`
 *  - version byte `0x01` is the current envelope.
 *  - nonce is random per encryption (12 bytes; GCM standard).
 *  - ciphertext is the AES-GCM output (same length as plaintext for the
 *    modes we use).
 *  - tag is the GCM auth tag (16 bytes).
 *
 * Key material: `BUDGET_API_TOKEN_KEY` is hashed with SHA-256 to derive the
 * 32-byte AES key. That makes any-length env-var acceptable while keeping
 * the on-disk format stable.
 */

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BUDGET_API_TOKEN_KEY;
  if (!raw || raw.length === 0) {
    throw new Error(
      'BUDGET_API_TOKEN_KEY is required (>= 16 chars recommended). Generate with: openssl rand -hex 32'
    );
  }
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

// --- Test helpers --------------------------------------------------------
// These let test code inject a deterministic key without touching
// BUDGET_API_TOKEN_KEY in the env, and clear the cached key between cases.

export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}

export function __setKeyForTests(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`__setKeyForTests: key must be a ${KEY_BYTES}-byte Buffer`);
  }
  cachedKey = key;
}
