import { prisma } from '../lib/prisma';
import { decryptToken, encryptToken } from '../lib/secretBox';

export async function upsertAkahuConnection(params: {
  userId: string;
  accessToken: string;
  scope?: string | null;
}) {
  // Caller passes plaintext at the API boundary; repo encrypts before write.
  const ct = encryptToken(params.accessToken);
  return prisma.akahuConnection.upsert({
    where: { userId: params.userId },
    update: { accessToken: ct, scope: params.scope ?? undefined },
    create: { userId: params.userId, accessToken: ct, scope: params.scope ?? null }
  });
}

export async function getAkahuConnectionForUser(userId: string) {
  const row = await prisma.akahuConnection.findUnique({ where: { userId } });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    accessToken: decryptToken(Buffer.from(row.accessToken)),
    scope: row.scope,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function markAkahuSyncComplete(params: { userId: string; lastSyncedAt: Date }) {
  return prisma.akahuConnection.update({
    where: { userId: params.userId },
    data: { lastSyncedAt: params.lastSyncedAt }
  });
}

