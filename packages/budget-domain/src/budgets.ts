export type BudgetStage = 'warning80' | 'warning95' | 'breached100';

export type BudgetEvaluation = {
  spendCents: number;
  limitCents: number;
  ratio: number;
  stagesCrossed: BudgetStage[];
};

export function evaluateMonthlyCardBudget(params: {
  spendCents: number;
  limitCents: number;
}): BudgetEvaluation {
  const spendCents = Math.max(0, Math.trunc(params.spendCents));
  const limitCents = Math.max(1, Math.trunc(params.limitCents));

  const ratio = spendCents / limitCents;
  const stagesCrossed: BudgetStage[] = [];

  if (ratio >= 0.8) stagesCrossed.push('warning80');
  if (ratio >= 0.95) stagesCrossed.push('warning95');
  if (ratio >= 1) stagesCrossed.push('breached100');

  return { spendCents, limitCents, ratio, stagesCrossed };
}

