import { prisma } from '../lib/prisma.ts';

export async function listTransactionsForUser(userId: string) {
  return prisma.transaction.findMany({
    where: { userId },
    orderBy: { occurredAt: 'desc' },
    take: 200
  });
}

export async function getTransactionById(id: string) {
  return prisma.transaction.findUnique({ where: { id } });
}

export async function updateTransactionCategory(params: {
  transactionId: string;
  category: string;
}) {
  return prisma.transaction.update({
    where: { id: params.transactionId },
    data: {
      category: params.category,
      categorySource: 'manual',
      categoryConfidence: 1.0
    }
  });
}

export async function recordCategorizationFeedback(params: {
  userId: string;
  merchantKey: string;
  originalCategory: string | null;
  correctedCategory: string;
}) {
  return prisma.categorizationFeedback.create({
    data: {
      userId: params.userId,
      merchantKey: params.merchantKey,
      originalCategory: params.originalCategory,
      correctedCategory: params.correctedCategory
    }
  });
}

