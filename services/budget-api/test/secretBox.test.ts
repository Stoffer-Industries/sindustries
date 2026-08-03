import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  encryptToken,
  decryptToken,
  __resetKeyCacheForTests,
  __setKeyForTests
} from '../src/lib/secretBox';

describe('secretBox (AES-256-GCM)', () => {
  const fixedKey = createHash('sha256').update('unit-test-key-deterministic').digest();

  beforeEach(() => {
    __resetKeyCacheForTests();
    __setKeyForTests(fixedKey);
  });

  it('round-trips a plaintext token', () => {
    const plaintext = 'akahu-uAt-' + 'x'.repeat(40);
    const blob = encryptToken(plaintext);
    expect(decryptToken(blob)).toBe(plaintext);
  });

  it('produces a different ciphertext each call (random nonce)', () => {
    const plaintext = 'akahu-uAt-deterministic';
    const blob1 = encryptToken(plaintext);
    const blob2 = encryptToken(plaintext);
    expect(blob1.equals(blob2)).toBe(false);
    // Both still decrypt to the same plaintext.
    expect(decryptToken(blob1)).toBe(plaintext);
    expect(decryptToken(blob2)).toBe(plaintext);
  });

  it('prefixes the blob with version byte 0x01', () => {
    const blob = encryptToken('hello');
    expect(blob[0]).toBe(0x01);
  });

  it('refuses empty plaintext', () => {
    expect(() => encryptToken('')).toThrow(/non-empty string/);
  });

  it('refuses non-string plaintext', () => {
    // Loose tsconfig (`strict: false`) means TS doesn't flag `number` here,
    // so this exercises the runtime guard without an `@ts-expect-error`.
    expect(() => encryptToken(123 as unknown as string)).toThrow(/non-empty string/);
  });

  it('rejects a blob that is too short to contain version+nonce+tag', () => {
    const tiny = Buffer.from([0x01, 0x02, 0x03]);
    expect(() => decryptToken(tiny)).toThrow(/ciphertext too short/);
  });

  it('rejects an unknown version byte', () => {
    const good = encryptToken('hello');
    const tampered = Buffer.from(good);
    tampered[0] = 0x99;
    expect(() => decryptToken(tampered)).toThrow(/unsupported version byte 0x99/);
  });

  it('rejects ciphertext tampered in the middle (auth tag fails)', () => {
    const blob = encryptToken('hello world');
    const tampered = Buffer.from(blob);
    // Flip a byte in the ciphertext region (after version+nonce, before tag).
    const target = 1 + 12 + 2; // version + nonce + 2 bytes into ct
    tampered[target] = tampered[target] ^ 0xff;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it('rejects ciphertext when decrypted with the wrong key', () => {
    const blob = encryptToken('secret payload');
    __resetKeyCacheForTests();
    const wrongKey = randomBytes(32);
    __setKeyForTests(wrongKey);
    expect(() => decryptToken(blob)).toThrow();
  });

  it('accepts Uint8Array as well as Buffer', () => {
    const blob = encryptToken('array-input');
    const view = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    expect(decryptToken(view)).toBe('array-input');
  });

  it('survives the JSON-ish path: Buffer -> Uint8Array -> decryptToken', () => {
    const blob = encryptToken('round-trip-via-uint8');
    const intermediate = new Uint8Array(blob); // copy
    expect(decryptToken(intermediate)).toBe('round-trip-via-uint8');
  });
});
