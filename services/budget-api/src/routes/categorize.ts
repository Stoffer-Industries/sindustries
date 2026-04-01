import { Router } from 'express';
import { jsonError } from '../lib/http.ts';
import { categorizeTransaction, categoryTaxonomy } from '../services/categorizer.ts';

export const categorizeRouter = Router();

categorizeRouter.post('/categorize/predict', async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  const merchant = typeof req.body?.merchant === 'string' ? req.body.merchant : null;
  const description =
    typeof req.body?.description === 'string' ? req.body.description : null;
  const amountCents =
    typeof req.body?.amountCents === 'number' ? req.body.amountCents : undefined;

  if (!userId) return jsonError(res, 400, 'BAD_REQUEST', 'userId is required');
  if (!merchant) return jsonError(res, 400, 'BAD_REQUEST', 'merchant is required');

  const result = await categorizeTransaction({
    userId,
    merchant,
    description,
    amountCents
  });

  res.status(200).json({ taxonomy: categoryTaxonomy, result });
});

