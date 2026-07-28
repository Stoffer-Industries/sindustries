import { Router } from 'express';
import { jsonError } from '../lib/http';
import { categorizeTransaction, categoryTaxonomy } from '../services/categorizer';

export const categorizeRouter = Router();

// All routes here run behind requireSession (see app.ts) so userId is read
// from req.session.userId rather than from a query/body parameter.

categorizeRouter.post('/categorize/predict', async (req, res) => {
  const userId = req.session!.userId;
  const merchant = typeof req.body?.merchant === 'string' ? req.body.merchant : null;
  const description =
    typeof req.body?.description === 'string' ? req.body.description : null;
  const amountCents =
    typeof req.body?.amountCents === 'number' ? req.body.amountCents : undefined;

  if (!merchant) return jsonError(res, 400, 'BAD_REQUEST', 'merchant is required');

  const result = await categorizeTransaction({
    userId,
    merchant,
    description,
    amountCents
  });

  res.status(200).json({ taxonomy: categoryTaxonomy, result });
});