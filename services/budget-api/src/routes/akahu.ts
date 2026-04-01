import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';
import { evaluateAlertsForUser } from '../services/alerts.ts';

export const akahuRouter = Router();

// MVP stub: in real integration this would fetch and upsert cards + transactions.
akahuRouter.post('/akahu/sync', async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return jsonError(res, 404, 'NOT_FOUND', 'User not found');

  // Create a demo card if none exist.
  const existing = await prisma.linkedCard.findFirst({ where: { userId } });
  const card =
    existing ??
    (await prisma.linkedCard.create({
      data: {
        userId,
        provider: 'demo',
        providerCardId: `demo-${userId}`,
        displayName: 'Demo Visa',
        last4: '1234'
      }
    }));

  // Insert a couple demo transactions (idempotent by providerTransactionId).
  await prisma.transaction.upsert({
    where: { providerTransactionId: `demo-txn-1-${userId}` },
    update: {},
    create: {
      userId,
      cardId: card.id,
      provider: 'demo',
      providerTransactionId: `demo-txn-1-${userId}`,
      occurredAt: new Date(),
      merchant: 'New World',
      description: 'Groceries',
      amountCents: 5421,
      direction: 'debit',
      category: 'other',
      categoryConfidence: 0.4,
      categorySource: 'import'
    }
  });

  await prisma.transaction.upsert({
    where: { providerTransactionId: `demo-txn-2-${userId}` },
    update: {},
    create: {
      userId,
      cardId: card.id,
      provider: 'demo',
      providerTransactionId: `demo-txn-2-${userId}`,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      merchant: 'Uber',
      description: 'Trip',
      amountCents: 1899,
      direction: 'debit',
      category: 'transport',
      categoryConfidence: 0.9,
      categorySource: 'import'
    }
  });

  const month = currentMonthKey();
  const alerts = await evaluateAlertsForUser({ userId, month });
  res.status(200).json({ ok: true, cardId: card.id, alerts });
});

function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

