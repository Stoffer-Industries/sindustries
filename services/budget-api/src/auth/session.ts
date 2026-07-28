import crypto from 'node:crypto';

/**
 * SHA-256 hash of a session bearer token. Used to look up the Session row in
 * Prisma without ever storing the raw token. Same primitive already exists
 * inside src/routes/session.ts; this module makes it reusable from the
 * `requireSession` middleware.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}