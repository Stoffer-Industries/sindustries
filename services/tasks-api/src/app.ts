import express from 'express';
import { healthRouter } from './routes/health';
import { tasksRouter } from './routes/tasks';
import { tagsRouter } from './routes/tags';
import { contentSchedulerRouter } from './routes/contentScheduler.ts';
import { createInProcessJobSchedulerAdapter } from './routes/contentSchedulerJobs.inProcess.ts';
import {
  getJobSchedulerAdapterKind,
  setJobSchedulerAdapter
} from './routes/contentSchedulerJobs.ts';
import { processAutoPostJob } from './routes/autoPostWorker.ts';

// Install the default in-process JobSchedulerAdapter so the route layer
// always has an adapter available. Tests can override this via
// `setJobSchedulerAdapter(...)` in their setup. The adapter is registered
// exactly once per process; calling `setJobSchedulerAdapter` again would
// replace it, which is what tests use.
let _adapterInstalled = false;
function installDefaultAdapter() {
  if (_adapterInstalled) return;
  if (getJobSchedulerAdapterKind()) return;
  const adapter = createInProcessJobSchedulerAdapter();
  adapter.setHandler(async (job) => {
    await processAutoPostJob(job);
  });
  setJobSchedulerAdapter(adapter, 'in-process');
  _adapterInstalled = true;
}

function getAllowedOrigins() {
  const configured = process.env.CORS_ALLOWED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured && configured.length > 0) {
    return new Set(configured);
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

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-actor');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  });

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'tasks-api' });
  });

  app.use('/api/v1', healthRouter);
  app.use('/api/v1', tasksRouter);
  app.use('/api/v1', tagsRouter);
  app.use('/api/v1', contentSchedulerRouter);

  app.use((error, _req, res, _next) => {
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
