import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(size = 32) {
  return randomBytes(size).toString('base64url');
}

export function pkceChallengeForVerifier(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}
