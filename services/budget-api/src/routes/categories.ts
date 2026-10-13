import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { jsonError } from '../lib/http';
import { asyncHandler } from '../lib/asyncHandler';

export const categoriesRouter = Router();

// All routes here run behind requireSession (see app.ts) so userId is read
// from req.session.userId rather than from a query/body parameter.

categoriesRouter.get(
  '/categories/timeseries',
  asyncHandler(async (req, res) => {
    const userId = req.session!.userId;
    const from = typeof req.query.from === 'string' ? req.query.from : null;
    const to = typeof req.query.to === 'string' ? req.query.to : null;

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

    // Use a null-prototype object so category names like 'constructor',
    // '__proto__', and 'toString' don't trigger inherited-property reads
    // (e.g. series[category].push is not a function on a `constructor`
    // slot, or accidental __proto__/toString reassignment). Split the
    // bucket key on the FIRST `|` only so a category whose name contains
    // `|` (e.g. 'a|b') round-trips unchanged in the timeseries response
    // instead of being silently truncated to the substring before the
    // first `|`.
    const series = Object.create(null) as Record<
      string,
      { day: string; amountCents: number }[]
    >;
    for (const [key, amountCents] of buckets.entries()) {
      const sep = key.indexOf('|');
      const day = key.slice(0, sep);
      const category = key.slice(sep + 1);
      series[category] ??= [];
      series[category].push({ day, amountCents });
    }

    for (const cat of Object.keys(series)) {
      series[cat].sort((a, b) => a.day.localeCompare(b.day));
    }

    res.status(200).json({ from, to, series });
  })
);