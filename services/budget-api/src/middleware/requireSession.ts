import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { jsonError } from '../lib/http';
import { hashSessionToken } from '../auth/session';

export interface SessionContext {
  id: string;
  userId: string;
  expiresAt: Date | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionContext;
  }
}

/**
 * Express middleware that requires a valid `Authorization: Bearer <token>`
 * header. On success, attaches `req.session = { id, userId, expiresAt }` and
 * calls `next()`. On failure, responds with 401 UNAUTHORIZED before any
 * downstream handler runs.
 *
 * Currently the Session model has no `expiresAt` column; we expose it as
 * `null` so the contract is stable when column lands (sibling rate-limit task).
 *
 * Excludes nothing — register this only on routes that should be gated.
 * `/session/dev-login` (the login endpoint itself) and `/health` are mounted
 * separately in app.ts and never go through this middleware.
 */
export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const auth = req.header('Authorization');
  const token =
    auth && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : null;

  if (!token) {
    return jsonError(res, 401, 'UNAUTHORIZED', 'Missing bearer token');
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { id: true, userId: true }
  });

  if (!session) {
    return jsonError(res, 401, 'UNAUTHORIZED', 'Invalid session');
  }

  req.session = {
    id: session.id,
    userId: session.userId,
    expiresAt: null
  };

  next();
}