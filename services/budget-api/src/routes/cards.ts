import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';
import { getCardById, getMonthlyBudget, upsertMonthlyBudget } from '../repos/cardsRepo.ts';

export const cardsRouter = Router();

cardsRouter.get('/cards/balance-history', async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const now = new Date();
  const defaultFrom = new Date(now.valueOf() - 30 * 24 * 60 * 60 * 1000);
  const fromDate = parseQueryDate(req.query.from, defaultFrom);
  const toDate = parseQueryDate(req.query.to, now);
  if (!fromDate || !toDate) {
    return jsonError(res, 400, 'BAD_REQUEST', 'from/to must be ISO dates');
  }
  if (fromDate > toDate) {
    return jsonError(res, 400, 'BAD_REQUEST', 'from must be before to');
  }

  const [cards, snapshots] = await Promise.all([
    prisma.linkedCard.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        displayName: true,
        provider: true,
        providerCardId: true,
        currentBalanceCents: true,
        availableBalanceCents: true,
        balanceCurrency: true,
        balanceOverdrawn: true,
        balanceUpdatedAt: true
      }
    }),
    prisma.accountBalanceSnapshot.findMany({
      where: {
        userId,
        capturedAt: { gte: fromDate, lte: toDate }
      },
      orderBy: { capturedAt: 'asc' },
      select: {
        cardId: true,
        capturedAt: true,
        currentBalanceCents: true,
        availableBalanceCents: true,
        currency: true,
        overdrawn: true
      }
    })
  ]);

  const series: Record<
    string,
    {
      capturedAt: Date;
      currentBalanceCents: number | null;
      availableBalanceCents: number | null;
      currency: string | null;
      overdrawn: boolean | null;
    }[]
  > = {};
  const totalsByCapturedAt = new Map<string, number>();

  for (const snapshot of snapshots) {
    series[snapshot.cardId] ??= [];
    series[snapshot.cardId].push(snapshot);

    const totalValue = snapshot.currentBalanceCents ?? snapshot.availableBalanceCents;
    if (totalValue !== null) {
      const key = snapshot.capturedAt.toISOString();
      totalsByCapturedAt.set(key, (totalsByCapturedAt.get(key) ?? 0) + totalValue);
    }
  }

  const totalSeries = Array.from(totalsByCapturedAt.entries())
    .map(([capturedAt, currentBalanceCents]) => ({
      capturedAt,
      currentBalanceCents
    }))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  res.status(200).json({
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    accounts: cards,
    series,
    totalSeries
  });
});

cardsRouter.post('/cards/:cardId/budget', async (req, res) => {
  const { cardId } = req.params;
  const monthlyLimitCents =
    typeof req.body?.monthlyLimitCents === 'number'
      ? req.body.monthlyLimitCents
      : null;

  if (!monthlyLimitCents || monthlyLimitCents <= 0) {
    return jsonError(res, 400, 'BAD_REQUEST', 'monthlyLimitCents must be > 0');
  }

  const card = await getCardById(cardId);
  if (!card) return jsonError(res, 404, 'NOT_FOUND', 'Card not found');

  const budget = await upsertMonthlyBudget({
    cardId,
    userId: card.userId,
    month: currentMonthKey(),
    monthlyLimitCents
  });

  res.status(200).json({ budget });
});

cardsRouter.get('/cards/:cardId/spend-summary', async (req, res) => {
  const { cardId } = req.params;
  const month = typeof req.query.month === 'string' ? req.query.month : null;
  if (!month) return jsonError(res, 400, 'BAD_REQUEST', 'month is required');

  const [y, m] = month.split('-').map((s) => Number(s));
  if (!y || !m || m < 1 || m > 12) {
    return jsonError(res, 400, 'BAD_REQUEST', 'month must be YYYY-MM');
  }

  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  const txns = await prisma.transaction.findMany({
    where: { cardId, occurredAt: { gte: from, lt: to }, direction: 'debit' },
    select: { amountCents: true }
  });

  const spendCents = txns.reduce((acc, t) => acc + t.amountCents, 0);

  const budget = await getMonthlyBudget(cardId, month);

  res.status(200).json({
    cardId,
    month,
    spendCents,
    monthlyLimitCents: budget?.monthlyLimitCents ?? null
  });
});

function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function parseQueryDate(value: unknown, fallback: Date) {
  if (typeof value !== 'string') return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

