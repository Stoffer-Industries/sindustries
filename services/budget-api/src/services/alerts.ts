import { evaluateMonthlyCardBudget, type BudgetStage } from '@sindustries/budget-domain';
import { prisma } from '../lib/prisma.ts';

export async function evaluateAlertsForUser(params: { userId: string; month: string }) {
  const cards = await prisma.linkedCard.findMany({ where: { userId: params.userId } });

  const created: string[] = [];
  for (const card of cards) {
    const budget = await prisma.cardMonthlyBudget.findUnique({
      where: { cardId_month: { cardId: card.id, month: params.month } }
    });
    if (!budget) continue;

    const spendCents = await getSpendCentsForCardMonth(card.id, params.month);
    const evaluation = evaluateMonthlyCardBudget({
      spendCents,
      limitCents: budget.monthlyLimitCents
    });

    for (const stage of evaluation.stagesCrossed) {
      const event = await createDedupeEvent({
        userId: params.userId,
        cardId: card.id,
        month: params.month,
        stage,
        spendCents,
        limitCents: budget.monthlyLimitCents
      });
      if (event) created.push(event.id);
    }
  }

  return { createdEventIds: created };
}

async function getSpendCentsForCardMonth(cardId: string, month: string) {
  const [y, m] = month.split('-').map((s) => Number(s));
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  const txns = await prisma.transaction.findMany({
    where: { cardId, occurredAt: { gte: from, lt: to }, direction: 'debit' },
    select: { amountCents: true }
  });

  return txns.reduce((acc, t) => acc + t.amountCents, 0);
}

async function createDedupeEvent(params: {
  userId: string;
  cardId: string;
  month: string;
  stage: BudgetStage;
  spendCents: number;
  limitCents: number;
}) {
  const dedupeKey = `${params.userId}:${params.cardId}:${params.month}:${params.stage}`;
  const title = stageTitle(params.stage);
  const body = `Spend is $${(params.spendCents / 100).toFixed(2)} of $${(
    params.limitCents / 100
  ).toFixed(2)} for ${params.month}.`;

  try {
    return await prisma.notificationEvent.create({
      data: {
        userId: params.userId,
        cardId: params.cardId,
        month: params.month,
        stage: params.stage,
        dedupeKey,
        type: 'budget_threshold',
        title,
        body
      }
    });
  } catch (e: any) {
    // Unique constraint -> already created
    if (String(e?.code) === 'P2002') return null;
    throw e;
  }
}

function stageTitle(stage: BudgetStage) {
  if (stage === 'warning80') return '80% budget warning';
  if (stage === 'warning95') return '95% budget warning';
  return 'Budget breached';
}

