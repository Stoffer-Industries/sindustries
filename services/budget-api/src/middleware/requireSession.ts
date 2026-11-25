import { createClerkClient, verifyToken } from '@clerk/backend';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { jsonError } from '../lib/http';
import { asyncHandler } from '../lib/asyncHandler';
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

const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const clerkClient = clerkSecretKey ? createClerkClient({ secretKey: clerkSecretKey }) : null;

async function resolveClerkSession(token: string): Promise<SessionContext | null> {
  if (!clerkSecretKey || !clerkClient) return null;
  const claims = await verifyToken(token, { secretKey: clerkSecretKey });
  if (!claims.sub) return null;

  // A subject already linked to a budget user is sufficient; do not make a
  // Clerk API request on every authenticated API call.
  let user = await prisma.user.findUnique({ where: { clerkUserId: claims.sub } });
  if (user) return { id: 'clerk:' + claims.sub, userId: user.id, expiresAt: null };

  const clerkUser = await clerkClient.users.getUser(claims.sub);
  const primaryEmailAddress = clerkUser.primaryEmailAddress;
  if (!primaryEmailAddress || primaryEmailAddress.verification?.status !== 'verified') {
    return null;
  }
  const email = primaryEmailAddress.emailAddress;

  user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    user = await prisma.user.update({ where: { id: user.id }, data: { clerkUserId: claims.sub, email } });
  } else {
    user = await prisma.user.create({ data: { clerkUserId: claims.sub, email } });
  }

  return { id: 'clerk:' + claims.sub, userId: user.id, expiresAt: null };
}

/** Accepts local database sessions and verified Clerk bearer tokens. */
export const requireSession = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header('Authorization');
    const token = auth && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
    if (!token) return jsonError(res, 401, 'UNAUTHORIZED', 'Missing bearer token');

    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      select: { id: true, userId: true }
    });
    if (session) {
      req.session = { id: session.id, userId: session.userId, expiresAt: null };
      return next();
    }

    try {
      const clerkSession = await resolveClerkSession(token);
      if (!clerkSession) return jsonError(res, 401, 'UNAUTHORIZED', 'Invalid session');
      req.session = clerkSession;
      return next();
    } catch (error) {
      console.error('Clerk session resolution failed', error);
      return jsonError(res, 401, 'UNAUTHORIZED', 'Invalid session');
    }
  }
);
