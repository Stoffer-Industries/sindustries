import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/http.ts';
import {
  authenticateRequest,
  AuthenticationFailure,
  type AuthPrincipal
} from './authenticate.ts';

export type MutationUser = AuthPrincipal;

declare global {
  namespace Express {
    interface Request {
      user?: MutationUser;
    }
  }
}

/**
 * Authenticate a request with a Bearer service credential or Clerk session
 * token. Authentication establishes identity only; route handlers retain
 * responsibility for actor-specific authorization.
 */
export async function requireAuthenticatedUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await authenticateRequest(req);
    next();
  } catch (error) {
    if (error instanceof AuthenticationFailure) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    next(error);
  }
}
