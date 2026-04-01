import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';
import { getCardById, getMonthlyBudget, upsertMonthlyBudget } from '../repos/cardsRepo.ts';

export const cardsRouter = Router();

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

