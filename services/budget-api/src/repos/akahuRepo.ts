import { prisma } from '../lib/prisma.ts';

export async function upsertAkahuConnection(params: {
  userId: string;
  accessToken: string;
  scope?: string | null;
}) {
  return prisma.akahuConnection.upsert({
    where: { userId: params.userId },
    update: { accessToken: params.accessToken, scope: params.scope ?? undefined },
    create: { userId: params.userId, accessToken: params.accessToken, scope: params.scope ?? null }
  });
}

export async function getAkahuConnectionForUser(userId: string) {
  return prisma.akahuConnection.findUnique({ where: { userId } });
}

