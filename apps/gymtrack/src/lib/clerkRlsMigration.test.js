import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20260924000000_clerk_rls_third_party_auth_assert.sql'
);
const runbookPath = resolve(process.cwd(), '../../infra/cloud/scripts/run-clerk-rls-test.sh');

const migration = readFileSync(migrationPath, 'utf8');
const executableSql = migration
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const runbook = readFileSync(runbookPath, 'utf8');

describe('Clerk RLS forward migration', () => {
  it('rewrites every user-owned policy to the verified text sub claim', () => {
    const policyNames = [
      'profiles_self_select',
      'profiles_self_insert',
      'profiles_self_update',
      'workouts_user_isolation',
      'workout_sets_user_isolation',
      'planned_workouts_user_isolation',
      'planned_workout_sets_user_isolation',
      'gymtrack_oauth_consents_user_read'
    ];

    for (const policyName of policyNames) {
      expect(executableSql).toMatch(
        new RegExp(`alter\\s+policy\\s+${policyName}\\s+on`, 'i')
      );
    }

    expect(executableSql).not.toMatch(
      /(?:using|with check)\s*\([^;]*auth\.uid\s*\(\s*\)/is
    );
    expect(executableSql.match(/auth\.jwt\s*\(\s*\)\s*->>\s*'sub'/gi)?.length).toBeGreaterThanOrEqual(
      policyNames.length
    );
  });

  it('does not depend on a non-existent database view for control-plane config', () => {
    expect(executableSql).not.toContain('auth.third_party_providers');
  });

  it('requires real bearer-token requests for the two-user isolation test', () => {
    expect(runbook).toContain('Authorization: Bearer');
    expect(runbook).toContain('/rest/v1/workouts');
    expect(runbook).not.toContain("set local request.jwt.claim.sub");
  });
});
