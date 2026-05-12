import { createHash } from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';
import { evaluateAlertsForUser } from '../services/alerts.ts';
import {
  akahuGetAccounts,
  akahuGetPendingTransactions,
  akahuRefreshAllAccounts,
  akahuGetTransactions,
  exchangeAuthorizationCode
} from '../services/akahuClient.ts';
import {
  getAkahuConnectionForUser,
  markAkahuSyncComplete,
  upsertAkahuConnection
} from '../repos/akahuRepo.ts';
import { categorizeTransaction } from '../services/categorizer.ts';

export const akahuRouter = Router();

const INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const FORCE_SYNC_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const AKAHU_PENDING_PROVIDER_ID_PREFIX = 'akahu-pending:';

akahuRouter.get('/akahu/authorize-url', async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonError(res, 404, 'NOT_FOUND', 'User not found');

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
});

akahuRouter.post('/akahu/exchange', async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  const code = typeof req.body?.code === 'string' ? req.body.code : null;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');
  if (!code) return jsonError(res, 400, 'BAD_REQUEST', 'code is required');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonError(res, 404, 'NOT_FOUND', 'User not found');

  try {
    const { accessToken, scope } = await exchangeAuthorizationCode({ code });
    await upsertAkahuConnection({ userId, accessToken, scope });
    res.status(200).json({ ok: true });
  } catch (e: any) {
    return jsonError(res, 400, 'BAD_REQUEST', e?.message ?? 'Akahu exchange failed');
  }
});

akahuRouter.post('/akahu/sync', async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  const startMs = typeof req.body?.startMs === 'number' ? req.body.startMs : undefined;
  const endMs = typeof req.body?.endMs === 'number' ? req.body.endMs : undefined;
  const force = req.body?.force === true;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonError(res, 404, 'NOT_FOUND', 'User not found');

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
    const refresh = force ? await akahuRefreshAllAccounts({ accessToken }) : null;

    const [accounts, txns, pendingTxns] = await Promise.all([
      akahuGetAccounts({
        accessToken
      }),
      akahuGetTransactions({
        accessToken,
        // Akahu can surface transactions after the bank date has already passed,
        // especially for cards. Keep a larger overlap so late arrivals are upserted.
        startMs: syncStartMs,
        endMs: syncEndMs
      }),
      akahuGetPendingTransactions({
        accessToken
      })
    ]);

    // Upsert accounts into LinkedCard so the rest of the app can treat them "card-like".
    const cardsByProviderId = new Map<string, { id: string }>();
    const balanceCapturedAt = new Date();
    let balanceSnapshotsCreated = 0;
    for (const acc of accounts) {
      const currentBalanceCents = akahuAmountToCents(acc.balance?.current);
      const availableBalanceCents = akahuAmountToCents(acc.balance?.available);
      const balanceCurrency = acc.balance?.currency ?? null;
      const balanceOverdrawn =
        typeof acc.balance?.overdrawn === 'boolean' ? acc.balance.overdrawn : null;
      const hasBalance =
        currentBalanceCents !== null ||
        availableBalanceCents !== null ||
        balanceCurrency !== null ||
        balanceOverdrawn !== null;

      const card = await prisma.linkedCard.upsert({
        where: {
          provider_providerCardId: { provider: 'akahu', providerCardId: acc._id }
        },
        update: {
          displayName: acc.name ?? 'Akahu account',
          currentBalanceCents,
          availableBalanceCents,
          balanceCurrency,
          balanceOverdrawn,
          balanceUpdatedAt: hasBalance ? balanceCapturedAt : null
        },
        create: {
          userId,
          provider: 'akahu',
          providerCardId: acc._id,
          displayName: acc.name ?? 'Akahu account',
          last4: null,
          currentBalanceCents,
          availableBalanceCents,
          balanceCurrency,
          balanceOverdrawn,
          balanceUpdatedAt: hasBalance ? balanceCapturedAt : null
        },
        select: { id: true }
      });
      cardsByProviderId.set(acc._id, card);

      if (hasBalance) {
        await prisma.accountBalanceSnapshot.create({
          data: {
            userId,
            cardId: card.id,
            currentBalanceCents,
            availableBalanceCents,
            currency: balanceCurrency,
            overdrawn: balanceOverdrawn,
            capturedAt: balanceCapturedAt
          }
        });
        balanceSnapshotsCreated += 1;
      }
    }

    // Upsert transactions (idempotent by providerTransactionId).
    let created = 0;
    let updated = 0;
    let categorized = 0;
    for (const t of txns) {
      const card = cardsByProviderId.get(t._account);
      if (!card) continue;

      const amountCentsAbs = Math.round(Math.abs(t.amount) * 100);
      const direction = t.amount < 0 ? 'debit' : 'credit';
      const merchant = t.merchant?.name ?? null;
      const providerTransactionId = `akahu:${t._id}`;

      const existing = await prisma.transaction.findUnique({
        where: { providerTransactionId },
        select: { id: true }
      });

      if (existing) {
        await prisma.transaction.update({
          where: { providerTransactionId },
          data: {
            occurredAt: new Date(t.date),
            merchant,
            description: t.description,
            amountCents: amountCentsAbs,
            direction
          }
        });
        updated += 1;
        continue;
      }

      const categoryInputMerchant = merchant ?? t.description ?? 'unknown';
      const cat = await categorizeTransaction({
        userId,
        merchant: categoryInputMerchant,
        description: t.description,
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
          description: t.description,
          amountCents: amountCentsAbs,
          direction,
          category: cat.category,
          categoryConfidence: cat.confidence,
          categorySource: cat.source
        }
      });
      created += 1;
    }

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

    await markAkahuSyncComplete({ userId, lastSyncedAt: new Date() });

    const month = currentMonthKey();
    const alerts = await evaluateAlertsForUser({ userId, month });
    res.status(200).json({
      ok: true,
      accounts: accounts.length,
      created,
      updated,
      pendingCreated,
      balanceSnapshotsCreated,
      categorized,
      refresh,
      alerts
    });
  } catch (e: any) {
    return jsonError(res, 400, 'BAD_REQUEST', e?.message ?? 'Akahu sync failed');
  }
});

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

function akahuAmountToCents(amount: number | undefined) {
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

