import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_DENY_SUBSTRINGS_FOR_TESTS,
  SYNTHETIC_DOMAIN_FOR_TESTS,
  SYNTHETIC_PREFIX_FOR_TESTS,
  assertStagingEnvironmentForTests,
  buildSyntheticEmailForTests,
  isProductionDatabaseUrl,
  isSyntheticEmail
} from '../../scripts/staging-smoke-session';

// The CLI module's top-level imports (PrismaClient, fs, etc.) mean we
// cannot dynamic-import the whole module without side effects. The pure
// helpers above are exported specifically for unit testing the safety
// guards without spawning a child process or stubbing the whole argv.

describe('staging-smoke-session guards (pure helpers)', () => {
  describe('PRODUCTION_DENY_SUBSTRINGS', () => {
    it('contains the known production app identifier', () => {
      expect(PRODUCTION_DENY_SUBSTRINGS_FOR_TESTS).toContain('sindustries-budget-api');
    });

    it('matches a URL that mentions the production schema', () => {
      const url = 'postgresql://app:pass@db.internal:5432/main?schema=public';
      expect(isProductionDatabaseUrl(url)).toBe(true);
    });

    it('matches the production Fly app substring', () => {
      expect(
        isProductionDatabaseUrl(
          'postgresql://app:pass@sindustries-budget-api.internal:5432/budget?schema=public'
        )
      ).toBe(true);
    });

    it('does not flag a clearly-staging URL', () => {
      const url = 'postgresql://app:pass@db.internal:5432/budget_staging?schema=public';
      expect(isProductionDatabaseUrl(url)).toBe(false);
    });

    it('refuses an empty DATABASE_URL (treats empty as production-like)', () => {
      expect(isProductionDatabaseUrl('')).toBe(true);
    });
  });

  describe('assertStagingEnvironmentForTests', () => {
    const baseParsed = {
      mode: 'mint' as const,
      staging: true,
      email: null,
      tokenOut: '/tmp/x',
      userId: null,
      sessionId: null,
      dryRun: false,
      json: false
    };

    function withEnv(envValue: string | undefined, dbUrl: string | undefined) {
      const originalEnv = process.env;
      process.env = { ...originalEnv };
      if (envValue === undefined) delete process.env.BUDGET_STAGING_ENVIRONMENT;
      else process.env.BUDGET_STAGING_ENVIRONMENT = envValue;
      if (dbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = dbUrl;
      return () => {
        process.env = originalEnv;
      };
    }

    it('throws when --staging is not set', () => {
      const restore = withEnv('staging', 'postgresql://app:pass@db/budget_staging');
      try {
        expect(() =>
          assertStagingEnvironmentForTests({ ...baseParsed, staging: false }, 'staging')
        ).toThrow(/--staging flag required/);
      } finally {
        restore();
      }
    });

    it('throws when BUDGET_STAGING_ENVIRONMENT is missing', () => {
      const restore = withEnv(undefined, 'postgresql://app:pass@db/budget_staging');
      try {
        expect(() =>
          assertStagingEnvironmentForTests(baseParsed, undefined)
        ).toThrow(/BUDGET_STAGING_ENVIRONMENT must be set to/);
      } finally {
        restore();
      }
    });

    it('throws when BUDGET_STAGING_ENVIRONMENT is the wrong value', () => {
      const restore = withEnv('production', 'postgresql://app:pass@db/budget_staging');
      try {
        expect(() =>
          assertStagingEnvironmentForTests(baseParsed, 'production')
        ).toThrow(/BUDGET_STAGING_ENVIRONMENT must be set to/);
      } finally {
        restore();
      }
    });

    it('throws when DATABASE_URL is missing', () => {
      const restore = withEnv('staging', undefined);
      try {
        expect(() =>
          assertStagingEnvironmentForTests(baseParsed, 'staging')
        ).toThrow(/DATABASE_URL is required/);
      } finally {
        restore();
      }
    });

    it('throws when DATABASE_URL looks production-like', () => {
      const restore = withEnv(
        'staging',
        'postgresql://app:pass@sindustries-budget-api.internal:5432/main'
      );
      try {
        expect(() =>
          assertStagingEnvironmentForTests(baseParsed, 'staging')
        ).toThrow(/strongly suggests a production\/main database/);
      } finally {
        restore();
      }
    });

    it('passes when --staging flag, env var, and a non-production URL are all set', () => {
      const restore = withEnv(
        'staging',
        'postgresql://app:pass@db.internal:5432/budget_staging?schema=public'
      );
      try {
        expect(() =>
          assertStagingEnvironmentForTests(baseParsed, 'staging')
        ).not.toThrow();
      } finally {
        restore();
      }
    });
  });

  describe('email shape', () => {
    it('accepts the synthetic domain', () => {
      expect(
        isSyntheticEmail(`staging-smoke+${'a'.repeat(36)}${SYNTHETIC_DOMAIN_FOR_TESTS}`)
      ).toBe(true);
    });

    it('rejects a normal email', () => {
      expect(isSyntheticEmail('user@example.com')).toBe(false);
    });

    it('builds a unique synthetic email using the documented prefix and domain', () => {
      const e1 = buildSyntheticEmailForTests();
      const e2 = buildSyntheticEmailForTests();
      expect(e1).not.toBe(e2);
      expect(e1.startsWith(SYNTHETIC_PREFIX_FOR_TESTS)).toBe(true);
      expect(e1.endsWith(SYNTHETIC_DOMAIN_FOR_TESTS)).toBe(true);
    });
  });
});