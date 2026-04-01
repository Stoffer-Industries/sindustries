import { Categories, normalizeMerchantKey } from '@sindustries/budget-domain';
import { prisma } from '../lib/prisma.ts';

export type CategorizationResult = {
  category: string;
  confidence: number;
  source: 'rule' | 'model';
  merchantKey: string;
};

export async function categorizeTransaction(input: {
  userId: string;
  merchant: string;
  description?: string | null;
  amountCents?: number;
}): Promise<CategorizationResult> {
  const merchantKey = normalizeMerchantKey(input.merchant || input.description || 'unknown');

  // 1) Feedback rule: take the most recent correction for this merchantKey.
  const recent = await prisma.categorizationFeedback.findFirst({
    where: { userId: input.userId, merchantKey },
    orderBy: { createdAt: 'desc' }
  });

  if (recent?.correctedCategory) {
    return {
      category: recent.correctedCategory,
      confidence: 0.95,
      source: 'rule',
      merchantKey
    };
  }

  // 2) Model fallback (stub): simple keyword rules. Replace with real LLM provider later.
  const guess = heuristicCategory(input.merchant, input.description ?? '');
  return {
    category: guess.category,
    confidence: guess.confidence,
    source: 'model',
    merchantKey
  };
}

function heuristicCategory(merchant: string, description: string) {
  const text = `${merchant} ${description}`.toLowerCase();
  const pick = (category: string, confidence: number) => ({ category, confidence });

  if (text.includes('uber') || text.includes('taxi')) return pick('transport', 0.9);
  if (text.includes('new world') || text.includes('countdown') || text.includes('paknsave'))
    return pick('groceries', 0.85);
  if (text.includes('netflix') || text.includes('spotify')) return pick('subscriptions', 0.9);
  if (text.includes('mcdonald') || text.includes('cafe') || text.includes('restaurant'))
    return pick('dining', 0.8);

  return pick('other', 0.5);
}

// Exported for callers that want a stable taxonomy list.
export const categoryTaxonomy = Categories;

