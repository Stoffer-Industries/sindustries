import express from 'express';

import { alertsRouter } from './routes/alerts.ts';
import { akahuRouter } from './routes/akahu.ts';
import { cardsRouter } from './routes/cards.ts';
import { categorizeRouter } from './routes/categorize.ts';
import { categoriesRouter } from './routes/categories.ts';
import { sessionRouter } from './routes/session.ts';
import { transactionsRouter } from './routes/transactions.ts';

function getAllowedOrigins() {
  const configured = process.env.CORS_ALLOWED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured && configured.length > 0) {
    return new Set(configured);
  }

  return new Set(['http://localhost:19006', 'http://localhost:8081']);
}

export function createApp() {
  const app = express();
  const allowedOrigins = getAllowedOrigins();

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'budget-api' });
  });

  app.use('/api/v1', sessionRouter);
  app.use('/api/v1', akahuRouter);
  app.use('/api/v1', cardsRouter);
  app.use('/api/v1', transactionsRouter);
  app.use('/api/v1', categoriesRouter);
  app.use('/api/v1', categorizeRouter);
  app.use('/api/v1', alertsRouter);

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }
    });
  });

  return app;
}

