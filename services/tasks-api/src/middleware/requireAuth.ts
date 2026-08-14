// General mutation authentication middleware for tasks-api.
//
// Widen the existing ApprovalSession cookie + TASKS_API_APPROVAL_SERVICE_CREDENTIALS
// identity primitive to gate every mutation route (POST/PATCH/DELETE) instead of
// only the structured-approval routes. The shape is intentionally a near-clone
// of `requireApprovalPrincipal`:
//   - cookie `tasks_api_session` parsed first; looks up the ApprovalSession row
//   - `Authorization: Bearer <token>` parsed second; matches against the same
//     TASKS_API_APPROVAL_SERVICE_CREDENTIALS env-var schema (shared credential
//     store, no second identity system)
//   - on success, sets `req.user = { actor, kind }`
//   - on failure, returns 401 AUTH_REQUIRED with a uniform error body
//
// Unlike `requireApprovalPrincipal`, this middleware does NOT enforce any
// permission policy. Per-route authorization (e.g. "comments are allowed for
// any authenticated user") lives in the route handler. This is the seam that
// the cloud-auth migration (task 206927ed) will replace behind the existing
// cookie + Bearer parsing — no route handlers need to change when the
// credential-verification implementation swaps out.
//
// Tech design: docs/specs/tasks-api-mutations-auth-tech-design.md (task 0719a8e3)

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { sendError } from '../lib/http.ts';
import { config } from '../config/index.ts';

export type MutationUser =
  | { actor: string; kind: 'browser_session' }
  | { actor: string; kind: 'service' };

declare global {
  namespace Express {
    interface Request {
      user?: MutationUser;
    }
  }
}

type ServiceCredential = { token: string; actor: string; approvalTypes: string[] };

/**
 * Parse TASKS_API_APPROVAL_SERVICE_CREDENTIALS at module load so malformed
 * config fails process boot (not the first authenticated request). This is
 * the same module-load-time parse as `approvalAuth.ts`; the credential store
 * is intentionally shared so we don't run two parsers with potentially
 * different error handling.
 */
function loadServiceCredentials(): ServiceCredential[] {
  const raw = config.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
  if (!raw || raw === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `TASKS_API_APPROVAL_SERVICE_CREDENTIALS must be valid JSON: ${(e as Error).message}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('TASKS_API_APPROVAL_SERVICE_CREDENTIALS must be a JSON array');
  }
  return parsed.map((value, index) => {
    const item = value as Partial<ServiceCredential>;
    if (
      typeof item?.token !== 'string' ||
      item.token.length < 16 ||
      typeof item.actor !== 'string' ||
      !Array.isArray(item.approvalTypes)
    ) {
      throw new Error(`TASKS_API_APPROVAL_SERVICE_CREDENTIALS[${index}] is invalid`);
    }
    return item as ServiceCredential;
  });
}

// Parse once at module load; the frozen reference is reused per request.
const SERVICE_CREDENTIALS: ReadonlyArray<ServiceCredential> = loadServiceCredentials();

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenMatches(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Middleware: authenticate the request via session cookie OR Bearer service
 * credential. On success sets `req.user`. On failure returns 401 AUTH_REQUIRED
 * with a uniform error body shape (`{ error: { code, message } }`).
 *
 * The middleware never enforces a permission boundary — any authenticated
 * user can call any gated mutation route. Per-route authorization (e.g.
 * "comments are allowed for any authenticated user; task updates require
 * actor in {Quinn, Tom}") is the route handler's responsibility. Phase 1
 * intentionally allows every authenticated actor through; permission
 * refinement comes in Phase 2 (cloud auth).
 */
export async function requireAuthenticatedUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionToken = cookie(req, 'tasks_api_session');
    if (sessionToken) {
      const session = await prisma.approvalSession.findUnique({
        where: { tokenHash: tokenHash(sessionToken) }
      });
      if (session && !session.revokedAt && session.expiresAt > new Date()) {
        req.user = { actor: session.actor, kind: 'browser_session' };
        return next();
      }
    }

    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const credential = match
      ? SERVICE_CREDENTIALS.find((entry) => tokenMatches(match[1], entry.token))
      : null;
    if (!credential) {
      return sendError(
        res,
        401,
        'AUTH_REQUIRED',
        'A valid session or service credential is required'
      );
    }
    req.user = { actor: credential.actor, kind: 'service' };
    return next();
  } catch (error) {
    return next(error);
  }
}

export const requireAuthTokenHash = tokenHash;
