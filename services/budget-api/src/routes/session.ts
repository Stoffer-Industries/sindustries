import { Router } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { jsonError } from '../lib/http';
import { hashSessionToken } from '../auth/session';
import { requireSession } from '../middleware/requireSession';

export const sessionRouter = Router();

// Local dev only: create a session and user. NOT gated by requireSession —
// this is the endpoint that mints the bearer token in the first place.
sessionRouter.post('/session/dev-login', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : null;
  if (!email) return jsonError(res, 400, 'BAD_REQUEST', 'email is required');

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashSessionToken(token);

  const user =
    (await prisma.user.findUnique({ where: { email } })) ??
    (await prisma.user.create({ data: { email } }));

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash
    }
  });

  res.status(200).json({
    token,
    user: { id: user.id, email: user.email }
  });
});

// /me uses requireSession so that the userId is read off req.session (set by
// the middleware after Bearer-token validation). Response shape is unchanged
// so the existing mobile app continues to work without client changes.
sessionRouter.get('/me', requireSession, async (req, res) => {
  const session = await prisma.session.findUnique({
    where: { id: req.session!.id },
    include: { user: true }
  });
  if (!session) return jsonError(res, 401, 'UNAUTHORIZED', 'Invalid session');

  const cards = await prisma.linkedCard.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: 'desc' }
  });

  res.status(200).json({
    user: { id: session.user.id, email: session.user.email },
    cards: cards.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      last4: c.last4
    }))
  });
});