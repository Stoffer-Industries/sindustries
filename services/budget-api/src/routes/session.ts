import { Router } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { jsonError } from '../lib/http';
import { asyncHandler } from '../lib/asyncHandler';
import { hashSessionToken } from '../auth/session';
import { requireSession } from '../middleware/requireSession';

export const sessionRouter = Router();

sessionRouter.post(
  '/session/dev-login',
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV !== 'development') return res.sendStatus(404);
    const email = typeof req.body?.email === 'string' ? req.body.email : null;
    if (!email) return jsonError(res, 400, 'BAD_REQUEST', 'email is required');

    const token = crypto.randomBytes(24).toString('hex');
    const user = (await prisma.user.findUnique({ where: { email } })) ?? (await prisma.user.create({ data: { email } }));
    await prisma.session.create({ data: { userId: user.id, tokenHash: hashSessionToken(token) } });
    res.status(200).json({ token, user: { id: user.id, email: user.email } });
  })
);

sessionRouter.get(
  '/me',
  requireSession,
  asyncHandler(async (req, res) => {
    const user = req.session!.id.startsWith('clerk:')
      ? await prisma.user.findUnique({ where: { id: req.session!.userId } })
      : (await prisma.session.findUnique({
          where: { id: req.session!.id },
          include: { user: true }
        }))?.user;
    if (!user) return jsonError(res, 401, 'UNAUTHORIZED', 'Invalid session');
    const cards = await prisma.linkedCard.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
    res.status(200).json({
      user: { id: user.id, email: user.email },
      cards: cards.map((c) => ({ id: c.id, displayName: c.displayName, last4: c.last4 }))
    });
  })
);
