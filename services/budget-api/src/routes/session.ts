import { Router } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.ts';
import { jsonError } from '../lib/http.ts';

export const sessionRouter = Router();

function hash(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Local dev only: create a session and user.
sessionRouter.post('/session/dev-login', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : null;
  if (!email) return jsonError(res, 400, 'BAD_REQUEST', 'email is required');

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = hash(token);

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

sessionRouter.get('/me', async (req, res) => {
  const auth = req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  if (!token) return jsonError(res, 401, 'UNAUTHORIZED', 'Missing bearer token');

  const session = await prisma.session.findUnique({
    where: { tokenHash: hash(token) },
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

