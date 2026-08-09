import crypto from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../lib/prisma.ts';
import { badRequest, sendError } from '../lib/http.ts';
import { approvalSessionTokenHash, approvalTypesForActor } from '../middleware/approvalAuth.ts';

type User = { username: string; actor: string; passwordHash: string };
const COOKIE = 'tasks_api_session';
function users(): User[] {
  const raw = process.env.TASKS_API_APPROVAL_USERS;
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('TASKS_API_APPROVAL_USERS must be valid JSON'); }
  if (!Array.isArray(value)) throw new Error('TASKS_API_APPROVAL_USERS must be a JSON array');
  return value as User[];
}
function verify(password: string, encoded: string): boolean {
  const [scheme, saltHex, expectedHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltHex || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function maxAgeMs() {
  const parsed = Number(process.env.TASKS_API_APPROVAL_SESSION_TTL_SECONDS ?? 28800);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed * 1000 : 28_800_000;
}
function cookieOptions(req) {
  const secure = process.env.NODE_ENV === 'production' || req.secure;
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs() };
}
function rawCookie(req): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('='); if (key === COOKIE) return decodeURIComponent(rest.join('='));
  } return null;
}

export const approvalSessionsRouter = Router();
approvalSessionsRouter.post('/auth/session', async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') return badRequest(res, 'INVALID_LOGIN', 'username and password are required');
    const user = users().find((candidate) => candidate.username === username);
    if (!user || !verify(password, user.passwordHash)) return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + maxAgeMs());
    await prisma.approvalSession.create({ data: { tokenHash: approvalSessionTokenHash(token), actor: user.actor, expiresAt } });
    res.cookie(COOKIE, token, cookieOptions(req));
    return res.status(201).json({ data: { actor: user.actor, approvalTypes: approvalTypesForActor(user.actor), expiresAt } });
  } catch (error) { return next(error); }
});
approvalSessionsRouter.get('/auth/session', async (req, res, next) => {
  try {
    const token = rawCookie(req); if (!token) return sendError(res, 401, 'SESSION_REQUIRED', 'No active session');
    const session = await prisma.approvalSession.findUnique({ where: { tokenHash: approvalSessionTokenHash(token) } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return sendError(res, 401, 'SESSION_REQUIRED', 'No active session');
    return res.json({ data: { actor: session.actor, approvalTypes: approvalTypesForActor(session.actor), expiresAt: session.expiresAt } });
  } catch (error) { return next(error); }
});
approvalSessionsRouter.delete('/auth/session', async (req, res, next) => {
  try {
    const token = rawCookie(req);
    if (token) await prisma.approvalSession.updateMany({ where: { tokenHash: approvalSessionTokenHash(token), revokedAt: null }, data: { revokedAt: new Date() } });
    res.clearCookie(COOKIE, { ...cookieOptions(req), maxAge: undefined });
    return res.status(204).send();
  } catch (error) { return next(error); }
});
