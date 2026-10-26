import { createHash } from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { jsonError } from '../lib/http';
import { asyncHandler } from '../lib/asyncHandler';
import { evaluateAlertsForUser } from '../services/alerts';
import {
  akahuGetAccounts,
  akahuGetPendingTransactions,
  akahuRefreshAllAccounts,
  AkahuCancelledError,
  AkahuNetworkError,
  AkahuTimeoutError,
  AkahuTraversalError,
  createAkahuBudget,
  exchangeAuthorizationCode,
  paginateAkahuTransactions,
  type AkahuTransaction
} from '../services/akahuClient';
import {
  getAkahuConnectionForUser,
  markAkahuSyncComplete,
  upsertAkahuConnection
} from '../repos/akahuRepo';
import { categorizeTransaction } from '../services/categorizer';
import {
  ensureAkahuCards,
  upsertAkahuSettledTransactions
} from '../services/akahuIngest';

export const akahuRouter = Router();

const INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const FORCE_SYNC_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const AKAHU_PENDING_PROVIDER_ID_PREFIX = 'akahu-pending:';
const AKAHU_SYNC_BUDGET_MS_DEFAULT = 20_000;
// Keep the interactive sync's serial categorisation/write phase bounded to
// roughly 500 settled rows. Larger windows remain incomplete and are retried
// or repaired with the operator backfill, whose page cap is intentionally 50.
const AKAHU_SYNC_PAGE_CAP = 5;

/**
 * Whole-sync budget shared by every provider call and every pagination
 * round of one `/akahu/sync` request. Env-configurable so the deployed
 * latency can be tuned without a code change (tech design open question #3).
 */
function akahuSyncBudgetMs(): number {
  const raw = Number(process.env.AKAHU_SYNC_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : AKAHU_SYNC_BUDGET_MS_DEFAULT;
}

// All routes here run behind requireSession (see app.ts) so userId is read
// from req.session.userId rather than from a query/body parameter. The user
// row is guaranteed to exist (the session FK enforces this), so the redundant
// `prisma.user.findUnique` + 404 dance is removed.

akahuRouter.get(
  '/akahu/authorize-url',
  asyncHandler(async (req, res) => {
    const userId = req.session!.userId;

    const clientId = process.env.AKAHU_CLIENT_ID;
    const redirectUri = process.env.AKAHU_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return jsonError(res, 500, 'INTERNAL_SERVER_ERROR', 'Akahu env not configured');
    }

    const url = new URL('https://oauth.akahu.nz');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'ENDURING_CONSENT');
    url.searchParams.set('state', userId);
    // Native deep-link friendliness (per Akahu docs). If redirect URI isn't a deep link, this is harmless.
    url.searchParams.set('redirect_mode', 'deep_link');

    res.status(200).json({ authorizeUrl: url.toString() });
  })
);

akahuRouter.post(
  '/akahu/exchange',
  asyncHandler(async (req, res) => {
    const userId = req.session!.userId;
    const code = typeof req.body?.code === 'string' ? req.body.code : null;
    if (!code) return jsonError(res, 400, 'BAD_REQUEST', 'code is required');

    try {
      const { accessToken, scope } = await exchangeAuthorizationCode({ code });
      await upsertAkahuConnection({ userId, accessToken, scope });
      res.status(200).json({ ok: true });
    } catch (e: any) {
      return jsonError(res, 400, 'BAD_REQUEST', e?.message ?? 'Akahu exchange failed');
    }
  })
);

akahuRouter.post(
  '/akahu/sync',
  asyncHandler(async (req, res) => {
    const userId = req.session!.userId;
    const startMs = typeof req.body?.startMs === 'number' ? req.body.startMs : undefined;
    const endMs = typeof req.body?.endMs === 'number' ? req.body.endMs : undefined;
    const force = req.body?.force === true;

    const conn = await getAkahuConnectionForUser(userId);
    if (!conn) {
      // Dev convenience: allow auto-linking from a provided User Access Token,
      // so we don't need OAuth client secrets during local development.
      const devUserAccessToken = process.env.AKAHU_DEV_USER_ACCESS_TOKEN;
      if (!devUserAccessToken) {
        return jsonError(res, 401, 'UNAUTHORIZED', 'Akahu not linked for this user');
      }

      await upsertAkahuConnection({ userId, accessToken: devUserAccessToken, scope: null });
    }

    try {
      const accessToken =
        (conn?.accessToken ?? process.env.AKAHU_DEV_USER_ACCESS_TOKEN ?? '').trim();
      const nowMs = Date.now();
      const syncStartMs =
        typeof startMs === 'number'
          ? startMs
          : force
            ? Math.max(0, nowMs - FORCE_SYNC_LOOKBACK_MS)
            : conn?.lastSyncedAt
              ? Math.max(0, conn.lastSyncedAt.getTime() - INCREMENTAL_OVERLAP_MS)
              : undefined;
      const syncEndMs = typeof endMs === 'number' ? endMs : nowMs;
      const budget = createAkahuBudget(akahuSyncBudgetMs());
      // Request-scoped signal: a client disconnect stops provider work
      // instead of leaving it running until the per-call deadline.
      const requestController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) requestController.abort();
      });
      const signal = requestController.signal;

      const refresh = force
        ? await akahuRefreshAllAccounts({ accessToken, budget, signal })
        : null;

      const [accounts, pendingTxns] = await Promise.all([
        akahuGetAccounts({
          accessToken,
          budget,
          signal
        }),
        akahuGetPendingTransactions({
          accessToken,
          budget,
          signal
        })
      ]);

      // Traverse the settled-transaction window to exhaustion. A partial
      // traversal is reported as `complete: false` and never advances the
      // checkpoint (invariant I1).
      let txns: AkahuTransaction[] = [];
      let pagesFetched = 0;
      let traversalComplete = false;
      let traversalError: string | null = null;
      try {
        const traversal = await paginateAkahuTransactions({
          accessToken,
          // Akahu can surface transactions after the bank date has already passed,
          // especially for cards. Keep a larger overlap so late arrivals are upserted.
          startMs: syncStartMs,
          endMs: syncEndMs,
          budget,
          pageCap: AKAHU_SYNC_PAGE_CAP,
          signal
        });
        txns = traversal.items;
        pagesFetched = traversal.pagesFetched;
        traversalComplete = traversal.complete;
      } catch (err) {
        if (err instanceof AkahuTraversalError) {
          const cause = err.cause;
          // A deadline overrun or a client disconnect aborts the sync: those
          // are not partial-but-usable results.
          if (cause instanceof AkahuTimeoutError || cause instanceof AkahuCancelledError) {
            throw cause;
          }
          // A provider failure on a later page keeps the pages already
          // fetched (the upsert is idempotent) and reports an incomplete sync.
          txns = err.items;
          pagesFetched = err.pagesFetched;
          traversalComplete = false;
          traversalError = err.message;
        } else {
          throw err;
        }
      }

      // Upsert accounts into LinkedCard so the rest of the app can treat them "card-like".
      const { cardsByProviderId, balanceSnapshotsCreated, cardsSkippedCrossTenant } =
        await ensureAkahuCards({
          userId,
          accounts,
          captureBalanceSnapshots: true
        });

      // Upsert transactions (idempotent by providerTransactionId).
      const { created, updated, categorized: settledCategorized, skipped, skippedCrossTenant } =
        await upsertAkahuSettledTransactions({
          userId,
          transactions: txns,
          cardsByProviderId
        });
      // Pending rows are categorised too, so the reported total covers both.
      let categorized = settledCategorized;

      // Pending transactions have no stable Akahu id. Rebuild our local pending set each sync
      // so items disappear once Akahu moves them into settled /transactions.
      await prisma.transaction.deleteMany({
        where: {
          userId,
          provider: 'akahu',
          providerTransactionId: { startsWith: AKAHU_PENDING_PROVIDER_ID_PREFIX }
        }
      });

      let pendingCreated = 0;
      for (const [idx, t] of pendingTxns.entries()) {
        const card = cardsByProviderId.get(t._account);
        if (!card) continue;

        const amountCentsAbs = Math.round(Math.abs(t.amount) * 100);
        const direction = t.amount < 0 ? 'debit' : 'credit';
        const merchant = null;
        const description = t.description ?? 'Pending transaction';
        const providerTransactionId = pendingProviderTransactionId(t, idx);
        const cat = await categorizeTransaction({
          userId,
          merchant: description,
          description,
          amountCents: amountCentsAbs
        });
        categorized += 1;

        await prisma.transaction.create({
          data: {
            userId,
            cardId: card.id,
            provider: 'akahu',
            providerTransactionId,
            occurredAt: new Date(t.date),
            merchant,
            description,
            amountCents: amountCentsAbs,
            direction,
            category: cat.category,
            categoryConfidence: cat.confidence,
            categorySource: cat.source
          }
        });
        pendingCreated += 1;
      }

      // The checkpoint advances only on a complete traversal: an incomplete
      // window is re-requested by the next sync (safe — the upsert is
      // idempotent by providerTransactionId).
      // Missing-card rows are not persisted. Keep the provider window open so
      // the next sync can retry them after the card mapping is repaired.
      const checkpointAdvanced = traversalComplete && skipped === 0;
      if (checkpointAdvanced) {
        await markAkahuSyncComplete({ userId, lastSyncedAt: new Date(syncEndMs) });
      }

      const month = currentMonthKey();
      const alerts = await evaluateAlertsForUser({ userId, month });
      res.status(200).json({
        ok: true,
        complete: traversalComplete,
        checkpointAdvanced,
        pagesFetched,
        transactionsFetched: txns.length,
        accounts: accounts.length,
        created,
        updated,
        pendingCreated,
        balanceSnapshotsCreated,
        categorized,
        cardsSkippedCrossTenant,
        transactionsSkippedNoCard: skipped,
        transactionsSkippedCrossTenant: skippedCrossTenant,
        refresh,
        alerts,
        ...(traversalError ? { error: traversalError } : {})
      });
    } catch (e: any) {
      // A deadline overrun and a client disconnect are distinguishable from
      // an ordinary provider failure.
      if (e instanceof AkahuTimeoutError) {
        return jsonError(res, 400, 'AKAHU_TIMEOUT', e?.message ?? 'Akahu sync timed out');
      }
      if (e instanceof AkahuCancelledError) {
        return jsonError(res, 400, 'AKAHU_CANCELLED', e?.message ?? 'Akahu sync was cancelled');
      }
      if (e instanceof AkahuNetworkError) {
        return jsonError(res, 502, 'AKAHU_NETWORK', e?.message ?? 'Akahu transport failed');
      }
      return jsonError(res, 400, 'BAD_REQUEST', e?.message ?? 'Akahu sync failed');
    }
  })
);

function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function pendingProviderTransactionId(
  txn: { _account: string; date: string; description?: string; amount: number; type?: string },
  index: number
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        account: txn._account,
        date: txn.date,
        description: txn.description ?? '',
        amount: txn.amount,
        type: txn.type ?? '',
        index
      })
    )
    .digest('hex')
    .slice(0, 32);

  return `${AKAHU_PENDING_PROVIDER_ID_PREFIX}${digest}`;
}


