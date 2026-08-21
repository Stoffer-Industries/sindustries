import express from 'express';
import helmet from 'helmet';
import { config, resolveRedisUrl } from './config/index.ts';
import { contentSchedulerRouter } from './routes/contentScheduler.ts';
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