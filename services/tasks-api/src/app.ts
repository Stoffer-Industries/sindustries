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
import { featureTaskAnalyticsRouter } from './routes/featureTaskAnalytics.ts';

// Content Scheduler was extracted into its own backend service as part of
// task 94d5e4fc (PR #2 in the series). The route mounts, adapter
// selection, worker, model, and middleware were moved to
// services/content-scheduler-api/. tasks-api remains task/workflow-only.



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
  app.use('/api/v1/auth/session', (req, res, next) =>
    req.method === 'POST' ? writeEndpointRateLimit(req, res, next) : next()
  );

  // General-mutation authentication gate (task 0719a8e3). Every
  // POST/PATCH/DELETE on the task, tag, and analytics surfaces requires a
  // valid session cookie or Bearer service credential. GET endpoints stay
  // open so the UI / agent queue / tasks app continue to read without
  // friction.
  //
  // The content-scheduler mount was moved to services/content-scheduler-api
  // as part of task 94d5e4fc (PR #2 in the series).
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
