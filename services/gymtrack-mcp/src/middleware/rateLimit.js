// Hand-rolled fixed-window per-IP rate limiter for the gymtrack-mcp OAuth
// write surface. Mirrors the shape of the content-scheduler-api rate limit
// (fixed-window, in-memory Map keyed by IP, JSON error envelope on 429)
// without pulling in a new dependency — the contract is ~60 lines of
// straightforward code and gymtrack-mcp currently declares no rate-limit dep.
//
// Window state is per-process. With gymtrack-mcp running as a single Fly app
// instance in `syd`, that's a single map. If/when the service scales
// horizontally, the limit becomes per-instance — same posture as
// content-scheduler-api today and an explicit, accepted trade-off in the
// audit (2026-W37 T1.1).

function pickClientIp(req) {
  // Express resolves `req.ip` from `X-Forwarded-For` when `trust proxy` is
  // configured. gymtrack-mcp sets `trust proxy = 1` on the app so the Fly
  // edge hop is honoured. Tests run against supertest's in-process server,
  // so this resolves to the loopback address.
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function defaultRetryAfterSeconds(remainingMs) {
  // Round up — Retry-After is in whole seconds (RFC 7231 §7.1.3), and a
  // "try again in <1s" claim should round to 1s rather than 0.
  const seconds = Math.ceil(remainingMs / 1000);
  return Math.max(1, seconds);
}

export function createRateLimit({
  name,
  windowMs,
  max,
  exemptPaths = [],
  now = () => Date.now()
} = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('createRateLimit: name must be a non-empty string.');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('createRateLimit: windowMs must be a positive number.');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new TypeError('createRateLimit: max must be a positive number.');
  }

  // Fixed-window per-IP state. Eviction happens in the sweep below so the
  // map cannot grow unbounded under sustained unique-IP load.
  const buckets = new Map();
  let sweepTimer = null;

  function sweep() {
    const cutoff = now();
    for (const [ip, bucket] of buckets) {
      if (bucket.windowStartMs + windowMs <= cutoff) {
        buckets.delete(ip);
      }
    }
  }

  function ensureSweepTimer() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, windowMs);
    // The sweep timer is per-process; Node's default behaviour keeps it
    // alive even when no requests are in flight. Unref() so it never holds
    // the event loop open during shutdown.
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function middleware(req, res, next) {
    ensureSweepTimer();

    // Skip rate-limiting for exempt paths (health probes, discovery). The
    // exemption list is matched by path prefix against `req.path` (no query
    // string). Match `/health` exactly OR `/health/*` (so a future
    // `/health/deep` is also exempt).
    const requestPath = req.path ?? req.url ?? '';
    for (const exempt of exemptPaths) {
      if (exempt === requestPath) return next();
      if (exempt.endsWith('/') && requestPath.startsWith(exempt)) return next();
      if (requestPath.startsWith(`${exempt}/`)) return next();
    }

    const ip = pickClientIp(req);
    const currentMs = now();
    const bucket = buckets.get(ip);
    let count;
    let windowStartMs;
    let resetMs;

    if (!bucket || bucket.windowStartMs + windowMs <= currentMs) {
      windowStartMs = currentMs;
      count = 1;
      resetMs = windowStartMs + windowMs;
      buckets.set(ip, { windowStartMs, count });
    } else {
      windowStartMs = bucket.windowStartMs;
      count = bucket.count + 1;
      resetMs = windowStartMs + windowMs;
      bucket.count = count;
    }

    const remaining = Math.max(0, max - count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));

    if (count > max) {
      const retryAfterMs = Math.max(0, resetMs - currentMs);
      res.setHeader('Retry-After', String(defaultRetryAfterSeconds(retryAfterMs)));
      // eslint-disable-next-line no-console
      console.warn(`[gymtrack-mcp rate-limit] blocked ${name}`, {
        ip,
        method: req.method,
        path: req.originalUrl ?? requestPath
      });
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests; try again later'
        }
      });
    }

    return next();
  }

  // Expose internals for tests so vitest can assert window reset behaviour
  // deterministically (clear the bucket, advance the clock, repeat).
  middleware._internals = {
    buckets,
    sweep,
    stop,
    now
  };

  return middleware;
}
