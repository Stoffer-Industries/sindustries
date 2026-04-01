import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';
import { evaluateAlertsForUser } from '../services/alerts.ts';

export const alertsRouter = Router();

alertsRouter.post('/alerts/evaluate', async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  const month = typeof req.body?.month === 'string' ? req.body.month : currentMonthKey();

  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const result = await evaluateAlertsForUser({ userId, month });
  res.status(200).json({ ok: true, ...result });
});

alertsRouter.get('/alerts', async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const events = await prisma.notificationEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100
  });

  res.status(200).json({
    alerts: events.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      body: e.body,
      createdAt: e.createdAt
    }))
  });
});

function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

