import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20261013000000_clerk_phase_4_link_existing_users.sql'
);
const clerkAuthPath = resolve(process.cwd(), 'src/lib/clerkAuth.jsx');

const migration = readFileSync(migrationPath, 'utf8');
const executableSql = migration
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

const clerkAuth = readFileSync(clerkAuthPath, 'utf8');

describe('Clerk Phase 4 — verified-email linking migration', () => {
  it('defines a SECURITY DEFINER function with the expected signature', () => {
    expect(executableSql).toMatch(
      /create or replace function public\.link_clerk_user_to_profile\s*\(\s*\n?\s*p_clerk_user_id text\s*,\s*\n?\s*p_email text\s*,\s*\n?\s*p_email_verified boolean\s*,\s*\n?\s*p_signup_source text default 'clerk_first_login'/is
    );
    expect(executableSql).toMatch(/security\s+definer/i);
    expect(executableSql).toMatch(/language\s+plpgsql/i);
    expect(executableSql).toMatch(/returns\s+public\.profiles/i);
  });

  it('guards the caller-jwt / clerk_user_id match before any data read', () => {
    // The auth.jwt()->>'sub' check must happen before the lookup so a
    // signed-in user cannot pass another user's clerk_user_id and
    // claim that user's pre-migration row.
    const jwtGuardIdx = executableSql.search(/auth\.jwt\s*\(\s*\)\s*->>\s*'sub'/i);
    const legacyLookupIdx = executableSql.search(
      /legacy_auth_user_id\s+is\s+not\s+null/i
    );
    expect(jwtGuardIdx).toBeGreaterThan(-1);
    expect(legacyLookupIdx).toBeGreaterThan(-1);
    expect(jwtGuardIdx).toBeLessThan(legacyLookupIdx);
  });

  it('rejects unverified-email link attempts when a legacy profile matches', () => {
    expect(executableSql).toMatch(
      /unverified_email_cannot_link/i
    );
  });

  it('handles the three documented cases — already linked, link, fresh insert', () => {
    // Case 1: already linked (clerk_user_id = $input) — returns row.
    expect(executableSql).toMatch(/where\s+clerk_user_id\s*=\s*p_clerk_user_id/i);
    // Case 2: link — updates clerk_user_id on a legacy row.
    expect(executableSql).toMatch(/for\s+update/i);
    expect(executableSql).toMatch(/clerk_user_id\s*=\s*p_clerk_user_id/i);
    // Case 3: fresh insert.
    expect(executableSql).toMatch(/insert\s+into\s+public\.profiles/i);
    expect(executableSql).toMatch(/unique_violation/i);
  });

  it('grants EXECUTE to authenticated only', () => {
    expect(executableSql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.link_clerk_user_to_profile[^\n]*\s+to\s+authenticated/i
    );
    // anon should NOT have execute — the function mutates profiles.
    expect(executableSql).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.link_clerk_user_to_profile[^\n]*\s+to\s+anon/i
    );
  });

  it('lowercases and trims the email before lookup so case does not break linking', () => {
    expect(executableSql).toMatch(/v_email\s*:=\s*lower\s*\(\s*trim\s*\(\s*p_email\s*\)\s*\)/i);
    expect(executableSql).toMatch(/where\s+email\s*=\s*v_email/i);
  });

  it('installs a defensive state assertion at migration time', () => {
    expect(executableSql).toMatch(
      /Phase 4 regression: link_clerk_user_to_profile function is missing/i
    );
    expect(executableSql).toMatch(
      /Phase 4 regression: link_clerk_user_to_profile is missing EXECUTE grant to authenticated/i
    );
  });
});

describe('Clerk Phase 4 — clerkAuth.jsx wiring', () => {
  it('imports the supabase client and calls link_clerk_user_to_profile on session establish', () => {
    expect(clerkAuth).toMatch(
      /import\s*\{[^}]*supabase[^}]*\}\s*from\s*'\.\/supabase\.js'/i
    );
    expect(clerkAuth).toMatch(
      /\.rpc\(['"]link_clerk_user_to_profile['"]/i
    );
  });

  it('reads email verification from primaryEmailAddress.verification.status', () => {
    expect(clerkAuth).toMatch(
      /primaryEmailAddress\?\.verification\?\.status\s*===\s*'verified'/i
    );
  });

  it('does NOT block sign-in on linking errors (logs and continues)', () => {
    // The useEffect must not throw, must log the error, and the auth
    // flow must not have a try/catch that surfaces the error to the UI.
    expect(clerkAuth).toMatch(
      /gymtrack\/clerk-phase-4-linking: rpc failed/i
    );
    expect(clerkAuth).toMatch(
      /gymtrack\/clerk-phase-4-linking: unexpected error/i
    );
  });

  it('maps Clerk provider strings to the function-accepted signup_source values', () => {
    expect(clerkAuth).toMatch(
      /if\s*\(\s*externalProvider\s*===\s*'oauth_google'\s*\)\s*return\s*'google'/i
    );
    expect(clerkAuth).toMatch(
      /if\s*\(\s*externalProvider\s*===\s*'oauth_apple'\s*\)\s*return\s*'apple'/i
    );
    expect(clerkAuth).toMatch(
      /if\s*\(\s*user\?\.passwordEnabled\s*\)\s*return\s*'email_password'/i
    );
    expect(clerkAuth).toMatch(/return\s*'clerk_first_login'/i);
  });
});
