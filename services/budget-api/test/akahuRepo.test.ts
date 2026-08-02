import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  __resetKeyCacheForTests,
  __setKeyForTests,
  decryptToken,
  encryptToken
} from '../src/lib/secretBox';

// Mock the prisma module BEFORE importing the repo so the repo picks up
// the mock when it loads prisma via `../lib/prisma`.
const findUnique = vi.fn();
const upsert = vi.fn();
const update = vi.fn();

vi.mock('../src/lib/prisma', () => ({
  prisma: {
    akahuConnection: { findUnique, upsert, update }
  }
}));

// Import after the mock so the repo uses the mocked prisma.
const repo = await import('../src/repos/akahuRepo');

const fixedKey = createHash('sha256').update('repo-test-key').digest();
const PLAINTEXT = 'akahu-uAt-plaintext-' + 'a'.repeat(40);

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  update.mockReset();
  __resetKeyCacheForTests();
  __setKeyForTests(fixedKey);
});

describe('akahuRepo (encryption boundary)', () => {
  it('upsertAkahuConnection encrypts the token before passing to prisma', async () => {
    upsert.mockResolvedValueOnce({ id: 'row-1', userId: 'u-1', scope: 'ENDURING_CONSENT' });

    await repo.upsertAkahuConnection({
      userId: 'u-1',
      accessToken: PLAINTEXT,
      scope: 'ENDURING_CONSENT'
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    const stored = call.update.accessToken as Buffer;
    expect(Buffer.isBuffer(stored)).toBe(true);
    // Decrypting the stored blob must yield the original plaintext.
    expect(decryptToken(stored)).toBe(PLAINTEXT);
    // Plaintext must NOT appear anywhere in the serialized args.
    expect(JSON.stringify(call)).not.toContain(PLAINTEXT);
  });

  it('getAkahuConnectionForUser decrypts on the way out', async () => {
    const stored = encryptToken(PLAINTEXT);
    findUnique.mockResolvedValueOnce({
      id: 'row-1',
      userId: 'u-1',
      accessToken: stored,
      scope: 'ENDURING_CONSENT',
      lastSyncedAt: new Date('2026-08-02T00:00:00Z'),
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-02T00:00:00Z')
    });

    const row = await repo.getAkahuConnectionForUser('u-1');
    expect(row).not.toBeNull();
    expect(row!.accessToken).toBe(PLAINTEXT);
    expect(row!.scope).toBe('ENDURING_CONSENT');
  });

  it('getAkahuConnectionForUser returns null when the row does not exist', async () => {
    findUnique.mockResolvedValueOnce(null);
    const row = await repo.getAkahuConnectionForUser('ghost');
    expect(row).toBeNull();
  });

  it('markAkahuSyncComplete does not touch the token column', async () => {
    update.mockResolvedValueOnce({ id: 'row-1', userId: 'u-1' });
    await repo.markAkahuSyncComplete({
      userId: 'u-1',
      lastSyncedAt: new Date('2026-08-02T12:00:00Z')
    });
    const arg = update.mock.calls[0][0];
    expect(arg.data).toEqual({ lastSyncedAt: new Date('2026-08-02T12:00:00Z') });
    expect(arg.data).not.toHaveProperty('accessToken');
  });
});
