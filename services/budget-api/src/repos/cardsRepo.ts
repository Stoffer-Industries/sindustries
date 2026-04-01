import { prisma } from '../lib/prisma.ts';

export async function getCardById(cardId: string) {
  return prisma.linkedCard.findUnique({ where: { id: cardId } });
}

export async function upsertMonthlyBudget(params: {
  cardId: string;
  userId: string;
  month: string;
  monthlyLimitCents: number;
}) {
  return prisma.cardMonthlyBudget.upsert({
    where: { cardId_month: { cardId: params.cardId, month: params.month } },
    update: { monthlyLimitCents: params.monthlyLimitCents },
    create: {
      cardId: params.cardId,
      userId: params.userId,
      month: params.month,
      monthlyLimitCents: params.monthlyLimitCents
    }
  });
}

export async function getMonthlyBudget(cardId: string, month: string) {
  return prisma.cardMonthlyBudget.findUnique({
    where: { cardId_month: { cardId, month } }
  });
}

