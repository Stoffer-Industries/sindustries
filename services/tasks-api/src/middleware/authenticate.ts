import crypto from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import type { Request } from 'express';
import { config } from '../config/index.ts';

export type AuthPrincipal =
  | { actor: string; kind: 'service'; approvalTypes: string[] }
  | { actor: string; kind: 'clerk_session'; clerkUserId: string };

type ServiceCredential = { token: string; actor: string; approvalTypes: string[] };
type AuthorizedUser = { clerkUserId: string; actor: string };

export class AuthenticationFailure extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: 'AUTH_REQUIRED' | 'AUTH_FORBIDDEN',
    message: string
  ) {
    super(message);
    this.name = 'AuthenticationFailure';
  }
}

function parseServiceCredentials(): ServiceCredential[] {
  const raw = config.TASKS_API_APPROVAL_SERVICE_CREDENTIALS;
  if (!raw || raw === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`TASKS_API_APPROVAL_SERVICE_CREDENTIALS must be valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('TASKS_API_APPROVAL_SERVICE_CREDENTIALS must be a JSON array');
  }
  return parsed.map((value, index) => {
    const row = value as Partial<ServiceCredential>;
    if (typeof row.token !== 'string' || row.token.length < 16 ||
      typeof row.actor !== 'string' || !Array.isArray(row.approvalTypes)) {
      throw new Error(`TASKS_API_APPROVAL_SERVICE_CREDENTIALS[${index}] is invalid`);
    }
    return row as ServiceCredential;
  });
}

function parseAuthorizedUsers(): AuthorizedUser[] {
  return JSON.parse(config.TASKS_API_CLERK_AUTHORIZED_USERS) as AuthorizedUser[];
}

const SERVICE_CREDENTIALS = parseServiceCredentials();
const AUTHORIZED_USERS = parseAuthorizedUsers();

function tokenMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return match?.[1] ?? null;
}

/**
 * Verification material for Clerk session tokens.
 *
 * The PEM JWT key is preferred because it verifies the token offline. The
 * backend secret is used only when no JWT key is provisioned, because it
 * makes the service fetch JWKS over the network. Exactly one credential is
 * passed, so a configured secret is never handed to the verifier needlessly.
 */
function clerkVerificationOptions(): { jwtKey?: string; secretKey?: string } {
  if (config.CLERK_JWT_KEY) return { jwtKey: config.CLERK_JWT_KEY };
  if (config.CLERK_SECRET_KEY) return { secretKey: config.CLERK_SECRET_KEY };
  return {};
}

/** Resolve the request's single authoritative service or Clerk principal. */
export async function resolvePrincipal(req: Request): Promise<AuthPrincipal> {
  const token = bearerToken(req);
  if (!token) {
    throw new AuthenticationFailure(401, 'AUTH_REQUIRED', 'A valid bearer credential is required');
  }

  const service = SERVICE_CREDENTIALS.find((entry) => tokenMatches(token, entry.token));
  if (service) {
    return { actor: service.actor, kind: 'service', approvalTypes: [...service.approvalTypes] };
  }

  let verification;
  try {
    verification = await verifyToken(token, {
      ...clerkVerificationOptions(),
      authorizedParties: config.TASKS_API_CLERK_AUTHORIZED_PARTIES
    });
  } catch {
    throw new AuthenticationFailure(401, 'AUTH_REQUIRED', 'A valid bearer credential is required');
  }
  if (verification.errors || !verification.data) {
    throw new AuthenticationFailure(401, 'AUTH_REQUIRED', 'A valid bearer credential is required');
  }

  const claims = verification.data as { iss?: unknown; sub?: unknown };
  if (config.TASKS_API_CLERK_ISSUER && claims.iss !== config.TASKS_API_CLERK_ISSUER) {
    throw new AuthenticationFailure(401, 'AUTH_REQUIRED', 'A valid bearer credential is required');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw new AuthenticationFailure(401, 'AUTH_REQUIRED', 'A valid bearer credential is required');
  }

  const user = AUTHORIZED_USERS.find((entry) => entry.clerkUserId === claims.sub);
  if (!user) {
    throw new AuthenticationFailure(403, 'AUTH_FORBIDDEN', 'This account is not authorized for Tasks');
  }
  return { actor: user.actor, clerkUserId: user.clerkUserId, kind: 'clerk_session' };
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPrincipal;
    }
  }
}

export async function authenticateRequest(req: Request): Promise<AuthPrincipal> {
  if (req.user) return req.user;
  const principal = await resolvePrincipal(req);
  req.user = principal;
  return principal;
}
