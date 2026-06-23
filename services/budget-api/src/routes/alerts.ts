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

alertsRouter.delete('/alerts/:alertId', async (req, res) => {
  const { alertId } = req.params;
  const existing = await prisma.notificationEvent.findUnique({ where: { id: alertId } });
  if (!existing) return jsonError(res, 404, 'NOT_FOUND', 'Alert not found');
  await prisma.notificationEvent.delete({ where: { id: alertId } });
  res.status(200).json({ ok: true });
});

alertsRouter.get('/cards/:cardId/alert-config', async (req, res) => {
  const { cardId } = req.params;
  const config = await prisma.balanceAlertConfig.findUnique({ where: { cardId } });
  if (!config) return res.status(200).json({ config: null });
  res.status(200).json({
    config: {
      id: config.id,
      cardId: config.cardId,
      condition: config.condition,
      thresholdCents: config.thresholdCents,
      pushEnabled: config.pushEnabled,
      emailEnabled: config.emailEnabled
    }
  });
});

alertsRouter.post('/cards/:cardId/alert-config', async (req, res) => {
  const { cardId } = req.params;
  const condition = req.body?.condition;
  const thresholdCents = req.body?.thresholdCents;
  const pushEnabled = typeof req.body?.pushEnabled === 'boolean' ? req.body.pushEnabled : true;
  const emailEnabled = typeof req.body?.emailEnabled === 'boolean' ? req.body.emailEnabled : false;

  if (condition !== 'more-than' && condition !== 'less-than') {
    return jsonError(res, 400, 'BAD_REQUEST', 'condition must be more-than or less-than');
  }
  if (typeof thresholdCents !== 'number' || thresholdCents <= 0) {
    return jsonError(res, 400, 'BAD_REQUEST', 'thresholdCents must be > 0');
  }

  const card = await prisma.linkedCard.findUnique({ where: { id: cardId } });
  if (!card) return jsonError(res, 404, 'NOT_FOUND', 'Card not found');

  const config = await prisma.balanceAlertConfig.upsert({
    where: { cardId },
    create: { userId: card.userId, cardId, condition, thresholdCents, pushEnabled, emailEnabled },
    update: { condition, thresholdCents, pushEnabled, emailEnabled }
  });

  res.status(200).json({
    config: {
      id: config.id,
      cardId: config.cardId,
      condition: config.condition,
      thresholdCents: config.thresholdCents,
      pushEnabled: config.pushEnabled,
      emailEnabled: config.emailEnabled
    }
  });
});

alertsRouter.delete('/cards/:cardId/alert-config', async (req, res) => {
  const { cardId } = req.params;
  const existing = await prisma.balanceAlertConfig.findUnique({ where: { cardId } });
  if (!existing) return jsonError(res, 404, 'NOT_FOUND', 'Alert config not found');
  await prisma.balanceAlertConfig.delete({ where: { cardId } });
  res.status(200).json({ ok: true });
});

function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
