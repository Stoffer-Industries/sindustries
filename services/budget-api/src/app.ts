import express from 'express';
import { helmetPreset } from './middleware/helmetPreset';
import { createRateLimit, positiveIntegerEnv } from './middleware/rateLimit';

import { alertsRouter } from './routes/alerts';
import { akahuRouter } from './routes/akahu';
import { cardsRouter } from './routes/cards';
import { categorizeRouter } from './routes/categorize';
import { categoriesRouter } from './routes/categories';
import { sessionRouter } from './routes/session';
import { transactionsRouter } from './routes/transactions';
import { requireSession } from './middleware/requireSession';

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
  const rateLimitWindowMs = positiveIntegerEnv('BUDGET_API_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
  const rateLimitMax = positiveIntegerEnv('BUDGET_API_RATE_LIMIT_MAX', 100);

  app.use(helmetPreset());

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

  // Body parsing must stay ahead of every route handler.
  app.use(express.json({ limit: process.env.BUDGET_API_JSON_LIMIT ?? '100kb' }));

  const sensitiveEndpointRateLimit = createRateLimit({
    name: 'budget-api-sensitive-endpoints',
    windowMs: rateLimitWindowMs,
    max: rateLimitMax
  });
  app.use('/api/v1/akahu/exchange', sensitiveEndpointRateLimit);
  app.use('/api/v1/session/dev-login', sensitiveEndpointRateLimit);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'budget-api' });
  });

  // /session is mounted WITHOUT requireSession — the dev-login endpoint mints
  // tokens, and /me now requires requireSession internally. All other user-data
  // routers are gated by requireSession so the userId is sourced from
  // req.session, never from request body/query.
  app.use('/api/v1', sessionRouter);
  app.use('/api/v1', requireSession, akahuRouter);
  app.use('/api/v1', requireSession, cardsRouter);
  app.use('/api/v1', requireSession, transactionsRouter);
  app.use('/api/v1', requireSession, categoriesRouter);
  app.use('/api/v1', requireSession, categorizeRouter);
  app.use('/api/v1', requireSession, alertsRouter);

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON request body is too large' }
      });
    }
    console.error(error);
    res.status(500).json({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }
    });
  });

  return app;
}