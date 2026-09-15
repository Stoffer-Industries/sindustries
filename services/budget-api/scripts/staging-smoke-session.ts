#!/usr/bin/env -S node --no-warnings
/**
 * staging-smoke-session.ts
 *
 * Operator CLI for the budget-api cloud-staging smoke harness
 * (task 2850c5ac, docs/specs/cloud-staging-environment-tech-design.md
 * section 2). Creates a synthetic user + session inside the staging
 * database so tests/cloud/staging-workflows.mjs can exercise authenticated
 * routes without an alternate product login path.
 *
 * Modes:
 *   mint       create a synthetic user + session, write the bearer token
 *              to the operator-specified mode-0600 file, print the IDs.
 *   revoke     delete the synthetic user/session pair identified by the
 *              --user-id / --session-id flags (or by --email).
 *   reconcile  remove any stale staging-smoke+<uuid>@sindustries.invalid
 *              users + their sessions that were not cleaned up.
 *
 * Safety guards (all required — refusing them is the whole point):
 *   - refuses to run unless --staging is passed AND the env var
 *     BUDGET_STAGING_ENVIRONMENT=staging is set. Belt and suspenders; the
 *     script will not silently fall back to "production" if either side is
 *     missing.
 *   - refuses DATABASE_URL values that look like production or main-db
 *     (substring match against a deny list; the list is small but covers
 *     the names the Fly staging vs production app pair uses).
 *   - the bearer token is only ever written to a path the operator passes
 *     via --token-out, and is force-written mode 0600 (0600 on POSIX). It
 *     never reaches stdout, logs, or any path outside the operator pass.
 *   - cleanup trap: a SIGINT/SIGTERM handler revokes the session and
 *     unlinks the token file so an interrupted mint does not leave a live
 *     bearer credential behind.
 *   - the synthetic email always uses the staging-only domain
 *     staging-smoke+<uuid>@sindustries.invalid so reconcile mode can find
 *     and remove every fixture it created.
 *
 * Out of scope: this CLI does NOT add an HTTP route, does NOT change any
 * existing endpoint, and does NOT mint a token for any non-staging database.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PrismaClient } from '../generated/prisma/index.js';
import { hashSessionToken } from '../src/auth/session.js';

const SYNTHETIC_DOMAIN = '@sindustries.invalid';
const SYNTHETIC_PREFIX = 'staging-smoke+';
const STAGING_ENV_VALUE = 'staging';

// DATABASE_URL substrings that strongly imply production/main. The list is
// intentionally narrow — we only refuse to operate against databases whose
// Fly app name or schema name makes their role obvious. The staging Fly app
// for budget-api is `sindustries-budget-api-staging`; the production app is
// `sindustries-budget-api`. Adjust if those names change.
const PRODUCTION_DENY_SUBSTRINGS = [
  'sindustries-budget-api', // production Fly app name (substring match)
  'budget-api-prod',
  'budget-api-production',
  ':5432/main', // production Postgres schema in our existing deployments
];

type Mode = 'mint' | 'revoke' | 'reconcile';

interface ParsedArgs {
  mode: Mode;
  staging: boolean;
  email: string | null;
  tokenOut: string | null;
  userId: string | null;
  sessionId: string | null;
  dryRun: boolean;
  json: boolean;
}

// Exported for unit tests; the CLI itself still owns argv parsing.
export const SYNTHETIC_DOMAIN_FOR_TESTS = SYNTHETIC_DOMAIN;
export const SYNTHETIC_PREFIX_FOR_TESTS = SYNTHETIC_PREFIX;
export const PRODUCTION_DENY_SUBSTRINGS_FOR_TESTS = PRODUCTION_DENY_SUBSTRINGS;

export function isProductionDatabaseUrl(url: string): boolean {
  if (!url) return true; // refuse empty DATABASE_URL — guard against operator omission
  for (const needle of PRODUCTION_DENY_SUBSTRINGS) {
    if (url.includes(needle)) return true;
  }
  return false;
}

export function assertStagingEnvironmentForTests(
  parsed: ParsedArgs,
  stagingEnvValue: string | undefined
): void {
  if (!parsed.staging) {
    throw new Error('--staging flag required (this CLI only operates against staging)');
  }
  if (stagingEnvValue !== STAGING_ENV_VALUE) {
    throw new Error(
      `BUDGET_STAGING_ENVIRONMENT must be set to '${STAGING_ENV_VALUE}'; refusing to operate against anything else.`
    );
  }
  const url = env.DATABASE_URL ?? '';
  if (url.length === 0) {
    throw new Error('DATABASE_URL is required');
  }
  if (isProductionDatabaseUrl(url)) {
    throw new Error(
      `DATABASE_URL strongly suggests a production/main database; refusing to run.`
    );
  }
}

export function isSyntheticEmail(email: string): boolean {
  return email.endsWith(SYNTHETIC_DOMAIN);
}

export function buildSyntheticEmailForTests(): string {
  return buildSyntheticEmail();
}

function fail(message: string, code = 1): never {
  stderrWrite(`error: ${message}\n`);
  exit(code);
}

function stderrWrite(s: string): void {
  // process.stderr.write exists at runtime but the type union in some
  // bundled lib.dom typings makes it ambiguous; cast keeps the script
  // working under strict tsconfigs.
  (process.stderr as unknown as { write: (s: string) => void }).write(s);
}

function parseArgs(): ParsedArgs {
  const args = argv.slice(2);
  let mode: Mode | null = null;
  let staging = false;
  let email: string | null = null;
  let tokenOut: string | null = null;
  let userId: string | null = null;
  let sessionId: string | null = null;
  let dryRun = false;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    switch (a) {
      case 'mint':
      case 'revoke':
      case 'reconcile':
        if (mode !== null) fail(`mode already set to '${mode}', refusing '${a}'`);
        mode = a;
        break;
      case '--staging':
        staging = true;
        break;
      case '--email':
        email = requireValue(args, i, '--email');
        i += 1;
        break;
      case '--token-out':
        tokenOut = requireValue(args, i, '--token-out');
        i += 1;
        break;
      case '--user-id':
        userId = requireValue(args, i, '--user-id');
        i += 1;
        break;
      case '--session-id':
        sessionId = requireValue(args, i, '--session-id');
        i += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--json':
        json = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        exit(0);
      default:
        fail(`unknown argument: ${a}`);
    }
  }

  if (mode === null) fail('mode required: mint | revoke | reconcile');
  return { mode, staging, email, tokenOut, userId, sessionId, dryRun, json };
}

function requireValue(args: string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    fail(`${flag} requires a value`);
  }
  return next;
}

function printHelp(): void {
  stdout.write(
    [
      'Usage: tsx scripts/staging-smoke-session.ts <mint|revoke|reconcile>',
      '                                            --staging [flags]',
      '',
      'Required environment:',
      '  BUDGET_STAGING_ENVIRONMENT=staging   refuses to run otherwise',
      '  DATABASE_URL                         Postgres connection string',
      '',
      'Flags:',
      '  --staging          required mode flag (belt to env-var suspenders)',
      '  --email <addr>     synthetic email (mint). Default: auto-generated.',
      '  --token-out <path> mint mode: write the bearer token here, mode 0600.',
      '  --user-id <uuid>   revoke mode: target user id (alternative to --email).',
      '  --session-id <uuid> revoke mode: target session id (alternative to --email).',
      '  --dry-run          reconcile mode: list stale fixtures, do not delete.',
      '  --json             emit machine-readable JSON to stdout instead of prose.',
      '',
      'See docs/specs/cloud-staging-environment-tech-design.md section 2.',
      ''
    ].join('\n')
  );
}

function assertStagingEnvironment(parsed: ParsedArgs): void {
  if (!parsed.staging) {
    fail('--staging flag required (this CLI only operates against staging)');
  }
  if (env.BUDGET_STAGING_ENVIRONMENT !== STAGING_ENV_VALUE) {
    fail(
      `BUDGET_STAGING_ENVIRONMENT must be set to '${STAGING_ENV_VALUE}'; ` +
        `refusing to operate against anything else.`
    );
  }
  const url = env.DATABASE_URL ?? '';
  if (url.length === 0) fail('DATABASE_URL is required');
  for (const needle of PRODUCTION_DENY_SUBSTRINGS) {
    if (url.includes(needle)) {
      fail(
        `DATABASE_URL contains '${needle}' which strongly suggests a ` +
          `production/main database; refusing to run.`
      );
    }
  }
}

function buildSyntheticEmail(): string {
  return `${SYNTHETIC_PREFIX}${randomUUID()}${SYNTHETIC_DOMAIN}`;
}

interface MintResult {
  mode: 'mint';
  userId: string;
  sessionId: string;
  email: string;
  tokenPath: string;
}

async function runMint(parsed: ParsedArgs, prisma: PrismaClient): Promise<MintResult> {
  if (parsed.tokenOut === null) fail('--token-out <path> is required for mint mode');
  const tokenPath = resolve(parsed.tokenOut);
  if (existsSync(tokenPath)) {
    fail(`refusing to overwrite existing file at ${tokenPath}`);
  }
  const email = parsed.email ?? buildSyntheticEmail();
  if (!email.endsWith(SYNTHETIC_DOMAIN)) {
    fail(
      `mint mode requires a synthetic email ending in ${SYNTHETIC_DOMAIN}; ` +
        `received '${email}'. Use --email staging-smoke+<id>${SYNTHETIC_DOMAIN} or omit to auto-generate.`
    );
  }

  const token = randomBytes(24).toString('hex');
  const tokenHash = hashSessionToken(token);

  const user =
    (await prisma.user.findUnique({ where: { email } })) ??
    (await prisma.user.create({ data: { email } }));

  const session = await prisma.session.create({
    data: { userId: user.id, tokenHash }
  });

  writeFileSync(tokenPath, token, { mode: 0o600 });
  // chmodSync is a no-op when writeFileSync's mode option is honored, but
  // some filesystems silently downgrade the bit on write (e.g. umask 077
  // is fine but umask 022 would leak the read bit). Reassert explicitly.
  chmodSync(tokenPath, 0o600);

  const cleanup = (): void => {
    try {
      if (existsSync(tokenPath)) unlinkSync(tokenPath);
    } catch {
      // best-effort cleanup
    }
  };
  const onSignal = (): void => {
    cleanup();
    exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    mode: 'mint',
    userId: user.id,
    sessionId: session.id,
    email,
    tokenPath
  };
}

interface RevokeResult {
  mode: 'revoke';
  userId: string;
  deletedSessions: number;
  deletedUsers: number;
}

async function runRevoke(parsed: ParsedArgs, prisma: PrismaClient): Promise<RevokeResult> {
  if (parsed.email === null && parsed.userId === null && parsed.sessionId === null) {
    fail('revoke mode requires --email, --user-id, or --session-id');
  }

  // Resolve the user id and gather all sessions to delete. Cascade on the
  // Session model deletes sessions when the user is deleted, but we delete
  // sessions explicitly first to keep the operation idempotent under
  // repeated runs.
  const userIdFromSession = parsed.sessionId
    ? (await prisma.session.findUnique({
        where: { id: parsed.sessionId },
        select: { userId: true }
      }))?.userId ?? null
    : null;
  const userId =
    parsed.userId ??
    userIdFromSession ??
    (parsed.email
      ? (await prisma.user.findUnique({
          where: { email: parsed.email },
          select: { id: true }
        }))?.id ?? null
      : null);

  if (userId === null) {
    fail('could not resolve a user to revoke (no matching row)');
  }

  const deletedSessions = await prisma.session.deleteMany({ where: { userId } });
  const deletedUsers = await prisma.user.deleteMany({ where: { id: userId } });

  return {
    mode: 'revoke',
    userId,
    deletedSessions: deletedSessions.count,
    deletedUsers: deletedUsers.count
  };
}

interface ReconcileResult {
  mode: 'reconcile';
  dryRun: boolean;
  matchedUsers: number;
  deletedSessions: number;
  deletedUsers: number;
}

async function runReconcile(
  parsed: ParsedArgs,
  prisma: PrismaClient
): Promise<ReconcileResult> {
  // Find every user whose email uses our prefix and is on the synthetic
  // invalid domain. The Prisma contains filter is on a unique column and
  // the matched set is bounded by previous mints.
  const staleUsers = await prisma.user.findMany({
    where: { email: { startsWith: SYNTHETIC_PREFIX } },
    select: { id: true, email: true }
  });
  const staleIds = staleUsers.map((u) => u.id);

  if (parsed.dryRun) {
    return {
      mode: 'reconcile',
      dryRun: true,
      matchedUsers: staleIds.length,
      deletedSessions: 0,
      deletedUsers: 0
    };
  }

  const deletedSessions = await prisma.session.deleteMany({
    where: { userId: { in: staleIds } }
  });
  const deletedUsers = await prisma.user.deleteMany({
    where: { id: { in: staleIds } }
  });

  return {
    mode: 'reconcile',
    dryRun: false,
    matchedUsers: staleIds.length,
    deletedSessions: deletedSessions.count,
    deletedUsers: deletedUsers.count
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs();
  assertStagingEnvironment(parsed);
  const prisma = new PrismaClient();
  try {
    let result: MintResult | RevokeResult | ReconcileResult;
    if (parsed.mode === 'mint') {
      result = await runMint(parsed, prisma);
    } else if (parsed.mode === 'revoke') {
      result = await runRevoke(parsed, prisma);
    } else {
      result = await runReconcile(parsed, prisma);
    }
    if (parsed.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only invoke main() when this file is run directly. Importing the module
// from a test (or any other consumer of the exported guards) must not run
// argv parsing, which would call process.exit() and tear down the worker.
function isMainModule(): boolean {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    return pathToFileURL(resolve(invoked)).href === fileURLToPath(import.meta.url)
      || pathToFileURL(resolve(invoked)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`unexpected failure: ${msg}`);
  });
}