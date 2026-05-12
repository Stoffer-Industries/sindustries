import { Router } from 'express';
import { jsonError } from '../lib/http.ts';
import { normalizeMerchantKey } from '@sindustries/budget-domain';
import {
  getTransactionById,
  listTransactionsForUser,
  recordCategorizationFeedback,
  updateTransactionCategory
} from '../repos/transactionsRepo.ts';

export const transactionsRouter = Router();

transactionsRouter.get('/transactions', async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : null;
  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');

  const txns = await listTransactionsForUser(userId);

  res.status(200).json({
    transactions: txns.map((t) => ({
      id: t.id,
      occurredAt: t.occurredAt,
      merchant: t.merchant,
      description: t.description,
      amountCents: t.amountCents,
      direction: t.direction,
      category: t.category,
      categorySource: t.categorySource,
      categoryConfidence: t.categoryConfidence,
      pending: t.providerTransactionId.startsWith('akahu-pending:')
    }))
  });
});

transactionsRouter.patch('/transactions/:transactionId/category', async (req, res) => {
  const { transactionId } = req.params;
  const category = typeof req.body?.category === 'string' ? req.body.category : null;
  if (!category) return jsonError(res, 400, 'BAD_REQUEST', 'category is required');

  const txn = await getTransactionById(transactionId);
  if (!txn) return jsonError(res, 404, 'NOT_FOUND', 'Transaction not found');

  const updated = await updateTransactionCategory({
    transactionId: txn.id,
    category
  });

  await recordCategorizationFeedback({
    userId: txn.userId,
    merchantKey: normalizeMerchantKey(txn.merchant ?? txn.description ?? 'unknown'),
    originalCategory: txn.category,
    correctedCategory: category
  });

  res.status(200).json({ transaction: updated });
});

