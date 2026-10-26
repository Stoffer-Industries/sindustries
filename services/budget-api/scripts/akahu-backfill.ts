#!/usr/bin/env -S node --no-warnings
/**
 * akahu-backfill.ts
 *
 * Operator CLI for the bounded Akahu backfill (task a37b31c9, AC6).
 *
 * Repairs transaction history that the pre-fix sync silently truncated: the
 * old client fetched only the first page of a window and then advanced the
 * checkpoint, so rows past the first page were lost permanently.
 *
 * Usage:
 *   tsx scripts/akahu-backfill.ts --user <uuid> --start <iso|epoch-ms> --end <iso|epoch-ms> [--dry-run]
 *   tsx scripts/akahu-backfill.ts --start <iso> --end <iso> [--dry-run]   # single linked user
 *
 * Flags:
 *   --user <uuid>            The budget-api user whose history is repaired.
 *                             Optional when exactly one user is linked.
 *   --start <iso|epoch-ms>   Inclusive window start.
 *   --end <iso|epoch-ms>     Exclusive window end.
 *   --dry-run                Count rows and write nothing at all.
 *   --max-lookback-days <n>  Explicit historical bound. Only needed when the
 *                             provider does not report `access_granted_at`;
 *                             when supplied it takes precedence and narrows
 *                             the window the operator is willing to request.
 *
 * Safety rules (refusing them is the point of this script):
 *   - The window must sit inside the provider's own historical allowance.
 *     The allowance is read from the provider (`/me`), never guessed.
 *   - `--dry-run` writes nothing: no transaction upserts, no run record.
 *   - The backfill is additive and idempotent: rows are upserted by
 *     `providerTransactionId`, nothing is deleted, and `lastSyncedAt` is
 *     never touched.
 *   - The access token is read from the encrypted connection row in the
 *     database. It is never an argument and never printed.
 *
 * Out of scope: this CLI adds no HTTP route and no admin surface. It is a
 * deliberately manual, one-off repair tool (tech design open question #4).
 */

import { resolve } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prisma } from '../src/lib/prisma.js';
import { getAkahuConnectionForUser } from '../src/repos/akahuRepo.js';
import {
  runAkahuBackfill,
  AkahuBackfillWindowError
} from '../src/services/akahuBackfill.js';

type ParsedArgs = {
  user: string | null;
  start: string | null;
  end: string | null;
  dryRun: boolean;
  maxLookbackDays: number | null;
};

function fail(message: string): never {
  stdout.write(`akahu-backfill: ${message}\n`);
  exit(1);
}

function parseArgs(argvList: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    user: null,
    start: null,
    end: null,
    dryRun: false,
    maxLookbackDays: null
  };

  for (let i = 0; i < argvList.length; i += 1) {
    const arg = argvList[i];
    const next = (): string => {
      const value = argvList[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--user':
        parsed.user = next();
        break;
      case '--start':
        parsed.start = next();
        break;
      case '--end':
        parsed.end = next();
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--max-lookback-days': {
        const raw = next();
        const days = Number(raw);
        if (!Number.isFinite(days) || days <= 0) {
          fail('--max-lookback-days must be a positive number of days');
        }
        parsed.maxLookbackDays = days;
        break;
      }
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!parsed.start) fail('--start is required');
  if (!parsed.end) fail('--end is required');
  return parsed;
}

function parseTimestamp(raw: string, flag: string): number {
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && /^\d+$/.test(raw)) return asNumber;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    fail(`${flag} must be an ISO-8601 timestamp or epoch milliseconds, got: ${raw}`);
  }
  return parsed;
}

async function resolveUserId(explicit: string | null): Promise<string> {
  if (explicit) return explicit;

  const connections = await prisma.akahuConnection.findMany({ select: { userId: true } });
  if (connections.length === 0) {
    fail('no Akahu connection exists in this database; pass --user explicitly');
  }
  if (connections.length > 1) {
    fail(
      `${connections.length} Akahu connections exist in this database; ` +
        'pass --user explicitly so the repair targets one user'
    );
  }
  return connections[0].userId;
}

async function main(): Promise<void> {
  const parsed = parseArgs(argv.slice(2));
  const startMs = parseTimestamp(parsed.start!, '--start');
  const endMs = parseTimestamp(parsed.end!, '--end');

  const userId = await resolveUserId(parsed.user);
  const connection = await getAkahuConnectionForUser(userId);
  if (!connection) {
    fail(`no Akahu connection found for user ${userId}`);
  }

  try {
    const result = await runAkahuBackfill({
      userId,
      accessToken: connection.accessToken,
      startMs,
      endMs,
      dryRun: parsed.dryRun,
      maxLookbackDays: parsed.maxLookbackDays ?? undefined
    });

    stdout.write(
      `${JSON.stringify(
        {
          ...result,
          windowStart: new Date(startMs).toISOString(),
          windowEnd: new Date(endMs).toISOString()
        },
        null,
        2
      )}\n`
    );
  } catch (err) {
    if (err instanceof AkahuBackfillWindowError) {
      fail(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  } finally {
    await prisma.$disconnect();
  }
}

// Only invoke main() when this file is run directly. Importing the module
// from a test must not run argv parsing, which would call process.exit().
function isMainModule(): boolean {
  try {
    const invoked = process.argv[1];
    if (!invoked) return false;
    return (
      pathToFileURL(resolve(invoked)).href === fileURLToPath(import.meta.url) ||
      pathToFileURL(resolve(invoked)).href === import.meta.url
    );
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
