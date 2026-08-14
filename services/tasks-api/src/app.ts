import express from 'express';
import { helmetPreset } from './middleware/helmetPreset';
import { createRateLimit } from './middleware/rateLimit';
import { requireAuthenticatedUser } from './middleware/requireAuth.ts';
import { healthRouter } from './routes/health';
import { config } from './config/index.ts';
import { tasksRouter } from './routes/tasks';
import { taskApprovalsRouter } from './routes/taskApprovals';
import { approvalSessionsRouter } from './routes/approvalSessions.ts';
import { requiredApprovalsRouter } from './routes/requiredApprovals';
import { tagsRouter } from './routes/tags';
import { contentSchedulerRouter } from './routes/contentScheduler.ts';
import { xTweetRouter } from './routes/xTweet.ts';
import { featureTaskAnalyticsRouter } from './routes/featureTaskAnalytics.ts';
import { createInProcessJobSchedulerAdapter } from './routes/contentSchedulerJobs.inProcess.ts';
import { createBullMqJobSchedulerAdapter } from './routes/contentSchedulerJobs.bullmq.ts';
import {
  getJobSchedulerAdapterKind,
  setJobSchedulerAdapter
} from './routes/contentSchedulerJobs.ts';
import { processAutoPostJob } from './routes/autoPostWorker.ts';
import { contentSchedulerAutoPostRouter } from './routes/contentSchedulerAutoPost.ts';

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
    const adapter = createBullMqJobSchedulerAdapter();
    setJobSchedulerAdapter(adapter, 'bullmq');
    // eslint-disable-next-line no-console
    console.log('[tasks-api] JobSchedulerAdapter=bullmq (CONTENT_SCHEDULER_JOB_ADAPTER=bullmq)');
  } else {
    const adapter = createInProcessJobSchedulerAdapter();
    adapter.setHandler(async (job) => {
      await processAutoPostJob(job);
    });
    setJobSchedulerAdapter(adapter, 'in-process');
    // eslint-disable-next-line no-console
    console.log('[tasks-api] JobSchedulerAdapter=in-process (default)');
  }
  _adapterInstalled = true;
}

function getAllowedOrigins() {
  if (config.CORS_ALLOWED_ORIGINS.length > 0) {
    return new Set(config.CORS_ALLOWED_ORIGINS);
  }

  return new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:4173',
    'http://localhost:5174',
    'http://127.0.0.1:5174'
  ]);
}

export function createApp() {
  installDefaultAdapter();
  const app = express();
  const allowedOrigins = getAllowedOrigins();
  const rateLimitWindowMs = config.TASKS_API_RATE_LIMIT_WINDOW_MS;
  const rateLimitMax = config.TASKS_API_RATE_LIMIT_MAX;

  app.use(helmetPreset());

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-actor, x-actor-secret');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });

  // Body parsing must stay ahead of every route handler.
  app.use(express.json({ limit: config.TASKS_API_JSON_LIMIT }));

  const writeEndpointRateLimit = createRateLimit({
    name: 'tasks-api-write-endpoints',
    windowMs: rateLimitWindowMs,
    max: rateLimitMax
  });
  app.use('/api/v1/tasks', (req, res, next) =>
    req.method === 'POST' && req.path === '/' ? writeEndpointRateLimit(req, res, next) : next()
  );
  app.use('/api/v1/content-scheduler/items/:id/publish', writeEndpointRateLimit);
  app.use('/api/v1/auth/session', (req, res, next) =>
    req.method === 'POST' ? writeEndpointRateLimit(req, res, next) : next()
  );

  // General-mutation authentication gate (task 0719a8e3). Every
  // POST/PATCH/DELETE on the task, tag, content-scheduler, and analytics
  // surfaces requires a valid session cookie or Bearer service credential.
  // GET endpoints stay open so the UI / agent queue / tasks app continue
  // to read without friction.
  //
  // The middleware is mounted ahead of the routers so 401s are returned
  // before any handler runs (and before Prisma is hit). Per-route
  // authorization (e.g. "comments allowed for any authenticated user") is
  // the route's responsibility; this middleware only authenticates.
  const mutationMethods = new Set(['POST', 'PATCH', 'DELETE']);
  const gateMutations = (req: express.Request, res: express.Response, next: express.NextFunction) =>
    mutationMethods.has(req.method) ? requireAuthenticatedUser(req, res, next) : next();

  app.use('/api/v1/tasks', gateMutations);
  app.use('/api/v1/tags', gateMutations);
  app.use('/api/v1/content-scheduler', gateMutations);
  app.use('/api/v1/feature-task-analytics/events', (req, _res, next) =>
    req.method === 'POST' ? requireAuthenticatedUser(req, _res, next) : next()
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'tasks-api' });
  });

  app.use('/api/v1', healthRouter);
  app.use('/api/v1', tasksRouter);
  app.use('/api/v1', taskApprovalsRouter);
  app.use('/api/v1', approvalSessionsRouter);
  app.use('/api/v1', requiredApprovalsRouter);
  app.use('/api/v1', tagsRouter);
  app.use('/api/v1', contentSchedulerRouter);
  app.use('/api/v1', contentSchedulerAutoPostRouter);
  app.use('/api/v1', xTweetRouter());
  app.use('/api/v1', featureTaskAnalyticsRouter);

  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON request body is too large' }
      });
    }
    console.error(error);
    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error'
      }
    });
  });

  return app;
}
