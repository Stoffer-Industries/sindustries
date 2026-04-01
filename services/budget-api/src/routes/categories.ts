import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';

export const categoriesRouter = Router();

categoriesRouter.get('/categories/timeseries', async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;

  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');
  if (!from || !to) return jsonError(res, 400, 'BAD_REQUEST', 'from and to are required');

  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.valueOf()) || Number.isNaN(toDate.valueOf())) {
    return jsonError(res, 400, 'BAD_REQUEST', 'from/to must be ISO dates');
  }

  const txns = await prisma.transaction.findMany({
    where: {
      userId,
      direction: 'debit',
      occurredAt: { gte: fromDate, lt: toDate }
    },
    select: { occurredAt: true, category: true, amountCents: true }
  });

  // Group by day+category in memory (MVP). Later: materialize table.
  const buckets = new Map<string, number>();
  for (const t of txns) {
    const day = t.occurredAt.toISOString().slice(0, 10);
    const category = t.category ?? 'other';
    const key = `${day}|${category}`;
    buckets.set(key, (buckets.get(key) ?? 0) + t.amountCents);
  }

  const series: Record<string, { day: string; amountCents: number }[]> = {};
  for (const [key, amountCents] of buckets.entries()) {
    const [day, category] = key.split('|');
    series[category] ??= [];
    series[category].push({ day, amountCents });
  }

  for (const cat of Object.keys(series)) {
    series[cat].sort((a, b) => a.day.localeCompare(b.day));
  }

  res.status(200).json({ from, to, series });
});

