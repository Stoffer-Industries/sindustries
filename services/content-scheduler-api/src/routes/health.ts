import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'content-scheduler-api',
    version: process.env.GIT_COMMIT_SHA ?? null,
  });
});
