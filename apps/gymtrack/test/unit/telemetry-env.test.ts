import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_SHA = process.env.GT_TELEMETRY_E2E_SHA;
const DEFAULT_SHA = 'e2e00000000000000000000000000000000000000';

/**
 * Load the telemetry e2e env module with a specific
 * `GT_TELEMETRY_E2E_SHA` in the environment.
 *
 * The module reads the variable at import time, so the registry is reset
 * before every import to pick up the current value.
 */
async function loadModule(sha: string | undefined) {
  vi.resetModules();
  if (sha === undefined) {
    delete process.env.GT_TELEMETRY_E2E_SHA;
  } else {
    process.env.GT_TELEMETRY_E2E_SHA = sha;
  }
  return import('../e2e/telemetry-env');
}

describe('telemetry e2e build identifier', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_SHA === undefined) {
      delete process.env.GT_TELEMETRY_E2E_SHA;
    } else {
      process.env.GT_TELEMETRY_E2E_SHA = ORIGINAL_SHA;
    }
  });

  it('falls back to the synthetic sha when no override is supplied', async () => {
    const mod = await loadModule(undefined);
    expect(mod.TELEMETRY_E2E_COMMIT_SHA).toBe(DEFAULT_SHA);
  });

  it('accepts a SHA-like hex value', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const mod = await loadModule(sha);
    expect(mod.TELEMETRY_E2E_COMMIT_SHA).toBe(sha);
  });

  it('accepts a short hex sha and trims surrounding whitespace', async () => {
    const mod = await loadModule('  abc1234  ');
    expect(mod.TELEMETRY_E2E_COMMIT_SHA).toBe('abc1234');
  });

  it.each([
    ['command substitution', 'e2e0000$(whoami)'],
    ['a command separator', 'e2e0000; touch /tmp/pwned'],
    ['an extra shell argument', 'e2e0000 --rm'],
    ['non-hex characters', 'zzzzzzz'],
    ['a backtick', 'e2e0000`id`'],
    ['more than 64 characters', 'a'.repeat(65)],
  ])('rejects a value carrying %s', async (_label, value) => {
    await expect(loadModule(value)).rejects.toThrow(
      /GT_TELEMETRY_E2E_SHA must be a SHA-like hex string/
    );
  });
});
