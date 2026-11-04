import { prisma } from '../lib/prisma';
import {
  akahuGetAccounts,
  akahuGetMe,
  createAkahuBudget,
  paginateAkahuTransactions,
  AkahuCancelledError,
  AkahuTimeoutError,
  AkahuTraversalError,
  type AkahuTransaction
} from './akahuClient';
import { ensureAkahuCards, upsertAkahuSettledTransactions } from './akahuIngest';

/**
 * Bounded Akahu backfill (task a37b31c9, AC6).
 *
 * Repairs transaction history that the pre-fix sync silently truncated: the
 * old client fetched only the first page of a window and then advanced the
 * checkpoint, so any row past the first page was lost permanently.
 *
 * The backfill is:
 *   - **bounded** — the window must sit inside the provider's own historical
 *     allowance (`access_granted_at` on `/me`), or inside an explicit
 *     operator-supplied bound. A window outside the allowance is refused
 *     *before* any transaction page is requested.
 *   - **dry-run first** — `--dry-run` counts rows and writes nothing: no
 *     transaction upserts and no run record.
 *   - **idempotent** — rows are upserted by `providerTransactionId`, so a
 *     second run over the same window creates no duplicates and only updates
 *     the run record's counters.
 *   - **additive** — it never deletes a settled row and never touches
 *     `lastSyncedAt`. The checkpoint is the sync watermark, not a backfill
 *     artefact.
 *
 * It runs under the same per-call and whole-sync budgets as a normal sync,
 * so a backfill can fail part-way and be re-run safely.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKFILL_BUDGET_MS = 120_000;

export class AkahuBackfillWindowError extends Error {
  readonly code = 'AKAHU_BACKFILL_WINDOW_OUT_OF_ALLOWANCE' as const;
  constructor(
    message: string,
    readonly detail: { earliestAllowedMs: number; requestedStartMs: number; requestedEndMs: number }
  ) {
    super(message);
    this.name = 'AkahuBackfillWindowError';
  }
}

export type AkahuBackfillAllowance = {
  earliestAllowedMs: number;
  source: 'provider' | 'override' | 'override-required';
};

export type AkahuBackfillOptions = {
  userId: string;
  accessToken: string;
  startMs: number;
  endMs: number;
  dryRun: boolean;
  /** Explicit operator bound, used when the provider does not report one. */
  maxLookbackDays?: number;
  nowMs?: number;
  budgetMs?: number;
};

export type AkahuBackfillResult = {
  applied: boolean;
  complete: boolean;
  pagesFetched: number;
  rowsSeen: number;
  rowsUpserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  /** Rows left alone because the provider transaction belongs to another user. */
  rowsSkippedCrossTenant: number;
  /** Provider accounts left alone because the card belongs to another user. */
  accountsSkippedCrossTenant: number;
  runId: string | null;
  allowance: AkahuBackfillAllowance;
};

/**
 * Resolves the earliest window start the backfill may request.
 *
 * The provider's `access_granted_at` is the authoritative bound and is
 * always consulted. An explicit `--max-lookback-days` can only narrow that
 * provider bound. When the provider omits the bound, the explicit override
 * becomes mandatory; the allowance is never guessed.
 */
export async function resolveAkahuBackfillAllowance(params: {
  accessToken: string;
  maxLookbackDays?: number;
  nowMs: number;
  budget?: ReturnType<typeof createAkahuBudget>;
  signal?: AbortSignal;
}): Promise<AkahuBackfillAllowance> {
  const overrideDays = typeof params.maxLookbackDays === 'number' && Number.isFinite(params.maxLookbackDays)
    ? params.maxLookbackDays
    : null;
  if (overrideDays !== null && overrideDays <= 0) {
    throw new Error('--max-lookback-days must be greater than zero');
  }

  const me = await akahuGetMe({
    accessToken: params.accessToken,
    budget: params.budget,
    signal: params.signal
  });
  if (me.accessGrantedAtMs === null) {
    if (overrideDays !== null) {
      return {
        earliestAllowedMs: params.nowMs - Math.floor(overrideDays * DAY_MS),
        source: 'override-required'
      };
    }
    throw new Error(
      'Akahu did not report access_granted_at for this connection, so the historical ' +
        'allowance cannot be read. Re-run with an explicit --max-lookback-days bound ' +
        'rather than guessing one.'
    );
  }
  if (overrideDays === null) {
    return { earliestAllowedMs: me.accessGrantedAtMs, source: 'provider' };
  }
  const overrideBound = params.nowMs - Math.floor(overrideDays * DAY_MS);
  return {
    earliestAllowedMs: Math.max(me.accessGrantedAtMs, overrideBound),
    source: overrideBound > me.accessGrantedAtMs ? 'override' : 'provider'
  };
}

export async function runAkahuBackfill(
  options: AkahuBackfillOptions
): Promise<AkahuBackfillResult> {
  const nowMs = options.nowMs ?? Date.now();
  const budget = createAkahuBudget(options.budgetMs ?? DEFAULT_BACKFILL_BUDGET_MS);

  const allowance = await resolveAkahuBackfillAllowance({
    accessToken: options.accessToken,
    maxLookbackDays: options.maxLookbackDays,
    nowMs,
    budget
  });

  // The window is validated before any transaction page is requested, so an
  // out-of-allowance window costs one metadata call and zero data calls.
  assertWindowWithinAllowance({
    startMs: options.startMs,
    endMs: options.endMs,
    nowMs,
    earliestAllowedMs: allowance.earliestAllowedMs
  });

  const accounts = await akahuGetAccounts({ accessToken: options.accessToken, budget });

  let transactions: AkahuTransaction[] = [];
  let pagesFetched = 0;
  let complete = false;
  let traversalFailure: Error | null = null;

  try {
    const traversal = await paginateAkahuTransactions({
      accessToken: options.accessToken,
      startMs: options.startMs,
      endMs: options.endMs,
      budget
    });
    transactions = traversal.items;
    pagesFetched = traversal.pagesFetched;
    complete = traversal.complete;
  } catch (err) {
    if (err instanceof AkahuTraversalError) {
      // Keep the pages already fetched: the upsert is idempotent, so a
      // re-run of the same window converges.
      transactions = err.items;
      pagesFetched = err.pagesFetched;
      complete = false;
      traversalFailure =
        err.cause instanceof Error ? err.cause : new Error(err.message);
    } else {
      throw err;
    }
  }

  // A dry run writes nothing — not a transaction, not a run record.
  if (options.dryRun) {
    return {
      applied: false,
      complete,
      pagesFetched,
      rowsSeen: transactions.length,
      rowsUpserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      rowsSkippedCrossTenant: 0,
      accountsSkippedCrossTenant: 0,
      runId: null,
      allowance
    };
  }

  const { cardsByProviderId, cardsSkippedCrossTenant } = await ensureAkahuCards({
    userId: options.userId,
    accounts,
    captureBalanceSnapshots: false
  });

  const { created, updated, skipped, skippedCrossTenant } = await upsertAkahuSettledTransactions({
    userId: options.userId,
    transactions,
    cardsByProviderId
  });

  const status = traversalFailure
    ? created + updated > 0
      ? 'partial'
      : 'failed'
    : complete
      ? 'completed'
      : 'partial';

  // Re-running the same window updates the existing run record's counters
  // rather than stacking a second record for the same window. A run over a
  // *different* window is a different record.
  const windowStartMs = BigInt(options.startMs);
  const windowEndMs = BigInt(options.endMs);
  const existingRun = await prisma.akahuBackfillRun.findFirst({
    where: { userId: options.userId, windowStartMs, windowEndMs },
    select: { id: true }
  });
  const runData = {
    mode: 'apply',
    status,
    pagesFetched,
    rowsSeen: transactions.length,
    rowsUpserted: created + updated,
    finishedAt: new Date()
  };
  const run = existingRun
    ? await prisma.akahuBackfillRun.update({
        where: { id: existingRun.id },
        data: runData,
        select: { id: true }
      })
    : await prisma.akahuBackfillRun.create({
        data: {
          userId: options.userId,
          windowStartMs,
          windowEndMs,
          startedAt: new Date(nowMs),
          ...runData
        },
        select: { id: true }
      });

  if (traversalFailure) {
    // The failure is reported after the run record is written, so the
    // partial work is auditable. A timeout or a cancellation is rethrown
    // unchanged so the operator sees the same distinction the sync route
    // makes.
    if (traversalFailure instanceof AkahuTimeoutError) throw traversalFailure;
    if (traversalFailure instanceof AkahuCancelledError) throw traversalFailure;
    throw new Error(
      `Akahu backfill failed part-way after ${pagesFetched} page(s): ${traversalFailure.message}`
    );
  }

  return {
    applied: true,
    complete,
    pagesFetched,
    rowsSeen: transactions.length,
    rowsUpserted: created + updated,
    rowsUpdated: updated,
    rowsSkipped: skipped,
    rowsSkippedCrossTenant: skippedCrossTenant,
    accountsSkippedCrossTenant: cardsSkippedCrossTenant,
    runId: run.id,
    allowance
  };
}

function assertWindowWithinAllowance(params: {
  startMs: number;
  endMs: number;
  nowMs: number;
  earliestAllowedMs: number;
}): void {
  const { startMs, endMs, nowMs, earliestAllowedMs } = params;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('Backfill window start and end must be finite timestamps');
  }
  if (startMs >= endMs) {
    throw new Error('Backfill window start must be earlier than its end');
  }
  if (endMs > nowMs) {
    throw new Error('Backfill window must not end in the future');
  }
  if (startMs < earliestAllowedMs) {
    throw new AkahuBackfillWindowError(
      `Refusing backfill: the requested window starts ${new Date(startMs).toISOString()}, ` +
        `which is before the earliest allowed start ${new Date(earliestAllowedMs).toISOString()}. ` +
        'The historical allowance is read from the provider, never guessed.',
      { earliestAllowedMs, requestedStartMs: startMs, requestedEndMs: endMs }
    );
  }
}
