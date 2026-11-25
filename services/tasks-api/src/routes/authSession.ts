import { Router } from 'express';
import { approvalTypesForActor } from '../middleware/approvalAuth.ts';
import { requireAuthenticatedUser } from '../middleware/requireAuth.ts';
import { sendError } from '../lib/http.ts';

export const authSessionRouter = Router();

authSessionRouter.get('/auth/session', requireAuthenticatedUser, (req, res) => {
  const principal = req.user;
  if (!principal) {
    return sendError(res, 401, 'AUTH_REQUIRED', 'A valid bearer credential is required');
  }
  return res.json({
    data: {
      actor: principal.actor,
      displayName: principal.actor,
      approvalTypes: approvalTypesForActor(principal.actor)
    }
  });
});
