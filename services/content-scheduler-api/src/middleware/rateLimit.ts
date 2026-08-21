import { rateLimit } from 'express-rate-limit';

type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
};

export function createRateLimit({ name, windowMs, max }: RateLimitOptions) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, _next, options) => {
      // eslint-disable-next-line no-console
      console.warn(`[content-scheduler-api rate-limit] blocked ${name}`, {
        ip: req.ip,
        method: req.method,
        path: req.originalUrl,
      });
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' },
      });
    },
  });
}