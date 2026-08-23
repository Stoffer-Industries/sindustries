import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.ts';
import { sendError } from '../lib/http.ts';
import { config } from '../config/index.ts';

export type ApprovalType = 'spec' | 'tech_design' | 'qa_agent' | 'accepted';
type ServiceCredential = { token: string; actor: string; approvalTypes: ApprovalType[] };
export type ApprovalPrincipal = { actor: string; approvalTypes: ReadonlySet<ApprovalType>; kind: 'browser_session' | 'service' };

declare global { namespace Express { interface Request { approvalPrincipal?: ApprovalPrincipal } } }

// `feature_task_lobster` is the automated feature-task workflow itself, not
// a human/agent identity. It may only create/revoke the mechanical `qa_agent`
// placeholder row (`ensure_qa_agent_gate`'s POST + DELETE bootstrap pattern in
// `agents/workflows/feature-task/src/main.rs`) — the row it can write always
// ends the call in `state: revoked`. Ash remains the only actor whose POST can
// leave the row `state: approved`, since only Ash's identity carries semantic
// approval intent; the audit trail (`owner`) distinguishes the two.
const ACTOR_PERMISSIONS: Record<string, ReadonlySet<ApprovalType>> = {
  Tom: new Set(['spec', 'accepted']),
  Quinn: new Set(['tech_design']),
  Ash: new Set(['qa_agent']),
  feature_task_lobster: new Set(['qa_agent'])
};

function loadServiceCredentials(): ServiceCredential[] {
  const raw = config.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
  if (!raw || raw === '[]') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`TASKS_API_APPROVAL_SERVICE_CREDENTIALS must be valid JSON: ${(e as Error).message}`); }
  if (!Array.isArray(parsed)) throw new Error('TASKS_API_APPROVAL_SERVICE_CREDENTIALS must be a JSON array');
  return parsed.map((value, index) => {
    const item = value as Partial<ServiceCredential>;
    if (typeof item?.token !== 'string' || item.token.length < 16 || typeof item.actor !== 'string' ||
      !Array.isArray(item.approvalTypes) || item.approvalTypes.some((t) => !['spec', 'tech_design', 'qa_agent', 'accepted'].includes(t as ApprovalType))) {
      throw new Error(`TASKS_API_APPROVAL_SERVICE_CREDENTIALS[${index}] is invalid`);
    }
    return item as ServiceCredential;
  });
}

// Parse once at module load so malformed config fails process boot (not the
// first authenticated request) and we don't re-parse JSON per request.
const SERVICE_CREDENTIALS: ReadonlyArray<ServiceCredential> = loadServiceCredentials();

function parseServiceCredentials(): ReadonlyArray<ServiceCredential> {
  return SERVICE_CREDENTIALS;
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
function tokenHash(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }
function tokenMatches(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
export function approvalTypesForActor(actor: string): ApprovalType[] {
  return [...(ACTOR_PERMISSIONS[actor] ?? [])];
}

function permissions(actor: string, requested?: ApprovalType[]) {
  const policy = ACTOR_PERMISSIONS[actor];
  return policy ? new Set((requested ?? [...policy]).filter((type) => policy.has(type))) : null;
}

export async function requireApprovalPrincipal(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionToken = cookie(req, 'tasks_api_session');
    if (sessionToken) {
      const session = await prisma.approvalSession.findUnique({ where: { tokenHash: tokenHash(sessionToken) } });
      if (session && !session.revokedAt && session.expiresAt > new Date()) {
        const allowed = permissions(session.actor);
        if (!allowed) return sendError(res, 403, 'APPROVAL_ACTOR_FORBIDDEN', 'Actor is not permitted to mutate approvals');
        req.approvalPrincipal = { actor: session.actor, approvalTypes: allowed, kind: 'browser_session' };
        return next();
      }
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const credential = match ? parseServiceCredentials().find((entry) => tokenMatches(match[1], entry.token)) : null;
    if (!credential) return sendError(res, 401, 'APPROVAL_AUTH_REQUIRED', 'A valid approval session or service credential is required');
    const allowed = permissions(credential.actor, credential.approvalTypes);
    if (!allowed) return sendError(res, 403, 'APPROVAL_ACTOR_FORBIDDEN', 'Actor is not permitted to mutate approvals');
    req.approvalPrincipal = { actor: credential.actor, approvalTypes: allowed, kind: 'service' };
    return next();
  } catch (error) { return next(error); }
}

export function authorizeApprovalType(req: Request, res: Response, type: ApprovalType): boolean {
  if (!req.approvalPrincipal?.approvalTypes.has(type)) {
    sendError(res, 403, 'APPROVAL_TYPE_FORBIDDEN', `${req.approvalPrincipal?.actor ?? 'Actor'} cannot mutate ${type} approval`);
    return false;
  }
  return true;
}

export const approvalSessionTokenHash = tokenHash;
