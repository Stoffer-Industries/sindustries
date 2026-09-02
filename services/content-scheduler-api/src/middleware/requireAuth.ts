// General mutation authentication middleware for content-scheduler-api.
//
// Widen the existing tasks-api ApprovalSession cookie +
// TASKS_API_APPROVAL_SERVICE_CREDENTIALS identity primitive to gate every
// mutation route (POST/PATCH/DELETE) on the content-scheduler-api user
// surface. The shape is intentionally a near-clone of
// services/tasks-api/src/middleware/requireAuth.ts so that the two
// services speak the same auth dialect; we deliberately do NOT extract a
// shared package in this task to keep the A1 (W36) scope focused on
// landing the security boundary. A follow-up extraction task will
// consolidate both call sites into packages/service-auth-middleware/.
//
// Auth paths:
//   1. Cookie `tasks_api_session` — look up the ApprovalSession row in
//      `tasks_api."ApprovalSession"` via $queryRaw (cross-schema raw
//      query — tasks-api is the canonical owner of this table;
//      content-scheduler-api reads it but never writes).
//   2. `Authorization: Bearer <token>` — matches against
//      CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS (parsed at
//      module load with fail-fast semantics on malformed JSON).
//
// On success: `req.user = { actor, kind }`.
// On failure: 401 AUTH_REQUIRED with a uniform error body.
//
// The middleware never enforces a permission boundary — any
// authenticated user can call any gated mutation route. Per-route
// authorization is the route handler's responsibility.
//
// Tech design: docs/specs/content-scheduler-auth-tech-design.md (task bd755ad4)

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

type ServiceCredential = {
  token: string;
  actor: string;
  approvalTypes: string[];
};

type ApprovalSessionRow = {
  id: string;
  actor: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

/**
 * Parse CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS at module load
 * so malformed config fails process boot (not the first authenticated
 * request). Mirrors tasks-api's loadServiceCredentials() shape; the
 * credential stores are intentionally separate (different token sets per
 * service) so a leaked content-scheduler token does not unlock
 * tasks-api.
 */
function loadServiceCredentials(): ServiceCredential[] {
  const raw = config.CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS;
  if (!raw || raw === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS must be valid JSON: ${(e as Error).message}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      'CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS must be a JSON array'
    );
  }
  return parsed.map((value, index) => {
    const item = value as Partial<ServiceCredential>;
    if (
      typeof item?.token !== 'string' ||
      item.token.length < 16 ||
      typeof item.actor !== 'string' ||
      !Array.isArray(item.approvalTypes)
    ) {
      throw new Error(
        `CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS[${index}] is invalid`
      );
    }
    return item as ServiceCredential;
  });
}

// Parse once at module load; the frozen reference is reused per request.
const SERVICE_CREDENTIALS: ReadonlyArray<ServiceCredential> =
  loadServiceCredentials();

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
 * Look up a browser session by its cookie token. Cross-schema read
 * against `tasks_api."ApprovalSession"` — tasks-api is the canonical
 * owner of this table (it issues cookies, runs the session create/revoke
 * routes, and stores the tokenHash). content-scheduler-api reads but
 * never writes; a single source of truth keeps cookie revocation
 * consistent across services.
 *
 * Returns null when the session is missing, expired, or revoked.
 */
async function lookupBrowserSession(
  sessionToken: string
): Promise<{ actor: string } | null> {
  const tokenHashHex = tokenHash(sessionToken);
  const rows = await prisma.$queryRaw<ApprovalSessionRow[]>`
    SELECT id, actor, "expiresAt", "revokedAt"
    FROM tasks_api."ApprovalSession"
    WHERE "tokenHash" = ${tokenHashHex}
    LIMIT 1
  `;
  const found = rows[0];
  if (!found) return null;
  if (found.revokedAt) return null;
  if (found.expiresAt <= new Date()) return null;
  return { actor: found.actor };
}

/**
 * Middleware: authenticate the request via session cookie OR Bearer
 * service credential. On success sets `req.user`. On failure returns
 * 401 AUTH_REQUIRED.
 */
export async function requireAuthenticatedUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionToken = cookie(req, 'tasks_api_session');
    if (sessionToken) {
      const session = await lookupBrowserSession(sessionToken);
      if (session) {
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

/**
 * Build a method-scoped gate. Mirrors tasks-api's gateMutations helper
 * (`services/tasks-api/src/app.ts`); kept inline because it's a one-liner
 * and exposing it from the shared extraction would be premature.
 */
export function methodGate(
  methods: ReadonlySet<string>,
  handler: (req: Request, res: Response, next: NextFunction) => unknown
): (req: Request, res: Response, next: NextFunction) => unknown {
  return (req, res, next) =>
    methods.has(req.method.toUpperCase()) ? handler(req, res, next) : next();
}
