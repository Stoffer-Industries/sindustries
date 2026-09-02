import express from 'express';
import helmet from 'helmet';
import { config, resolveRedisUrl } from './config/index.ts';
import { contentSchedulerRouter } from './routes/contentScheduler.ts';
import { contentSchedulerServiceRouter } from './routes/contentSchedulerService.ts';
import { contentSchedulerAutoPostRouter } from './routes/contentSchedulerAutoPost.ts';
import { xTweetRouter } from './routes/xTweet.ts';
import { createInProcessJobSchedulerAdapter } from './routes/contentSchedulerJobs.inProcess.ts';
import { createBullMqJobSchedulerAdapter } from './routes/contentSchedulerJobs.bullmq.ts';
import {
  getJobSchedulerAdapterKind,
  setJobSchedulerAdapter,
} from './routes/contentSchedulerJobs.ts';
import { processAutoPostJob } from './workers/autoPostWorker.ts';
import { createRateLimit } from './middleware/rateLimit.ts';
import { methodGate, requireAuthenticatedUser } from './middleware/requireAuth.ts';
import { healthRouter } from './routes/health.ts';

// Adapter selection mirrors the worker entrypoint:
//   - CONTENT_SCHEDULER_JOB_ADAPTER=bullmq → BullMQ + Redis (durable across
//     restarts; required for production and cloud).
//   - CONTENT_SCHEDULER_JOB_ADAPTER=in-process (default) → in-memory
//     setTimeout queue. Survives the API's lifetime but not restart.
//     Suitable for local dev and unit tests.
// The selection is logged so an operator can see which adapter is live.
let _adapterInstalled = false;
function installDefaultAdapter() {
  if (_adapterInstalled) return;
  if (getJobSchedulerAdapterKind()) return;
  const adapterKind = config.CONTENT_SCHEDULER_JOB_ADAPTER;
  if (adapterKind === 'bullmq') {
    const adapter = createBullMqJobSchedulerAdapter({ redisUrl: resolveRedisUrl() });
    setJobSchedulerAdapter(adapter, 'bullmq');
    // eslint-disable-next-line no-console
    console.log(
      `[content-scheduler-api] JobSchedulerAdapter=bullmq (CONTENT_SCHEDULER_JOB_ADAPTER=bullmq)`,
    );
  } else {
    const adapter = createInProcessJobSchedulerAdapter();
    adapter.setHandler(async (job) => {
      await processAutoPostJob(job);
    });
    setJobSchedulerAdapter(adapter, 'in-process');
    // eslint-disable-next-line no-console
    console.log(
      `[content-scheduler-api] JobSchedulerAdapter=in-process (default)`,
    );
  }
  _adapterInstalled = true;
}

function getAllowedOrigins(): Set<string> {
  if (config.CORS_ALLOWED_ORIGINS.length > 0) {
    return new Set(config.CORS_ALLOWED_ORIGINS);
  }
  return new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
    'http://localhost:5175',
    'http://localhost:5176',
  ]);
}

export function createApp() {
  installDefaultAdapter();
  const app = express();
  const allowedOrigins = getAllowedOrigins();
  const rateLimitWindowMs = config.CONTENT_SCHEDULER_API_RATE_LIMIT_WINDOW_MS;
  const rateLimitMax = config.CONTENT_SCHEDULER_API_RATE_LIMIT_MAX;

  app.use(helmet());

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PATCH, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-actor, x-actor-secret',
      );
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  const writeEndpointRateLimit = createRateLimit({
    name: 'content-scheduler-write-endpoints',
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
  });
  app.use('/api/v1/content-scheduler/items/:id/publish', writeEndpointRateLimit);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'content-scheduler-api' });
  });

  // Service-to-service routes (x-actor-secret + x-content-ingest-secret
  // gates) must be mounted BEFORE the auth middleware so the Fly headless
  // worker and the CTO Craft LangGraph pipeline can call the API without
  // a Bearer token or session cookie. The auth middleware gates the
  // user-facing mutation surface only.
  app.use('/api/v1', contentSchedulerServiceRouter);

  // Gate every mutation (POST/PATCH/DELETE) under
  // /api/v1/content-scheduler/items* and /api/v1/content-scheduler/reorder
  // on either an authenticated browser session (tasks_api_session cookie)
  // or a Bearer service credential
  // (CONTENT_SCHEDULER_API_APPROVAL_SERVICE_CREDENTIALS).
  //
  // The gate is method-scoped via methodGate(): `app.use(path, mw)` fires
  // the middleware on EVERY method under that path prefix, which would
  // 401 the public GETs the tech design keeps open. methodGate(WRITE_METHODS, ...)
  // restricts the middleware to mutation methods so the GET surface
  // (/items, /items/:id, /today-status, /health) stays public per the
  // Phase-1 Auth matrix in
  // docs/specs/content-scheduler-auth-tech-design.md (task bd755ad4 / W36 A1).
  const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
  app.use(
    '/api/v1/content-scheduler/items',
    methodGate(WRITE_METHODS, requireAuthenticatedUser)
  );
  app.use(
    '/api/v1/content-scheduler/reorder',
    methodGate(WRITE_METHODS, requireAuthenticatedUser)
  );

  app.use('/api/v1', healthRouter);
  app.use('/api/v1', contentSchedulerRouter);
  app.use('/api/v1', contentSchedulerAutoPostRouter);
  app.use('/api/v1', xTweetRouter());

  app.use((req, res) => {
    res.status(404).json({
      error: 'NotFound',
      message: `No route for ${req.method} ${req.path}`,
    });
  });

  return app;
}