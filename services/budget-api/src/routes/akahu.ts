import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';
import { evaluateAlertsForUser } from '../services/alerts.ts';
import {
  akahuGetAccounts,
  akahuGetTransactions,
  exchangeAuthorizationCode
} from '../services/akahuClient.ts';
import { getAkahuConnectionForUser, upsertAkahuConnection } from '../repos/akahuRepo.ts';

export const akahuRouter = Router();

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
    const [accounts, txns] = await Promise.all([
      akahuGetAccounts({
        accessToken:
          (conn?.accessToken ?? process.env.AKAHU_DEV_USER_ACCESS_TOKEN ?? '').trim()
      }),
      akahuGetTransactions({
        accessToken:
          (conn?.accessToken ?? process.env.AKAHU_DEV_USER_ACCESS_TOKEN ?? '').trim(),
        startMs,
        endMs
      })
    ]);

    // Upsert accounts into LinkedCard so the rest of the app can treat them "card-like".
    const cardsByProviderId = new Map<string, { id: string }>();
    for (const acc of accounts) {
      const card = await prisma.linkedCard.upsert({
        where: {
          provider_providerCardId: { provider: 'akahu', providerCardId: acc._id }
        },
        update: { displayName: acc.name ?? 'Akahu account' },
        create: {
          userId,
          provider: 'akahu',
          providerCardId: acc._id,
          displayName: acc.name ?? 'Akahu account',
          last4: null
        },
        select: { id: true }
      });
      cardsByProviderId.set(acc._id, card);
    }

    // Upsert transactions (idempotent by providerTransactionId).
    let upserted = 0;
    for (const t of txns) {
      const card = cardsByProviderId.get(t._account);
      if (!card) continue;

      const amountCentsAbs = Math.round(Math.abs(t.amount) * 100);
      const direction = t.amount < 0 ? 'debit' : 'credit';
      const merchant = t.merchant?.name ?? null;

      await prisma.transaction.upsert({
        where: { providerTransactionId: `akahu:${t._id}` },
        update: {
          occurredAt: new Date(t.date),
          merchant,
          description: t.description,
          amountCents: amountCentsAbs,
          direction
        },
        create: {
          userId,
          cardId: card.id,
          provider: 'akahu',
          providerTransactionId: `akahu:${t._id}`,
          occurredAt: new Date(t.date),
          merchant,
          description: t.description,
          amountCents: amountCentsAbs,
          direction,
          category: 'other',
          categoryConfidence: 0,
          categorySource: 'import'
        }
      });
      upserted += 1;
    }

    const month = currentMonthKey();
    const alerts = await evaluateAlertsForUser({ userId, month });
    res.status(200).json({ ok: true, accounts: accounts.length, transactions: upserted, alerts });
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

