// apps/gymtrack/api/telemetry.js
//
// Vercel serverless relay for GymTrack browser error telemetry.
//
// Task: e89db27f-6d78-418e-91c1-0759f8779d06 (Add GymTrack browser error
// telemetry to Grafana).
//
// The browser bundle cannot hold the hosted Grafana Cloud OTLP
// credentials — bundling them leaks the operator's instance key. This
// relay accepts sanitized browser events over HTTPS, validates a
// per-deploy shared token, re-redacts the payload (defence in depth),
// rate-limits the caller, and forwards to the hosted Grafana Cloud
// Loki HTTP push endpoint with the server-held Authorization header.
//
// Contract:
//   POST /api/telemetry
//   Authorization: Bearer <VITE_TELEMETRY_TOKEN>
//   Content-Type: application/json
//   Body: { environment, release, route, operation, provider, errorCode,
//           status, message, stack, userAgent, timestamp, source }
//
// Responses:
//   204 No Content             — success
//   400 { error: 'invalid_request', message: '<reason>' }
//   401 { error: 'invalid_token' }
//   405 { error: 'method_not_allowed' }   Allow: POST
//   413 { error: 'payload_too_large' }
//   429 { error: 'rate_limited' }
//   502 { error: 'upstream_failure', message: '<reason>' }
//
// The function never returns the relay token or the upstream response
// body to the browser.

import { timingSafeEqual } from 'node:crypto';

const MAX_RAW_BODY_BYTES = 32 * 1024;
const MAX_STRUCTURED_BYTES = 8 * 1024;
const REQUIRED_FIELDS = [
  'environment',
  'release',
  'route',
  'operation',
  'timestamp'
];
const MAX_EVENTS_PER_MINUTE_PER_TOKEN = 60;

const tokenBuckets = new Map();

function tokenMatches(provided) {
  const expected = process.env.TELEMETRY_RELAY_TOKEN;
  if (!expected) return false;
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function rateLimit(token) {
  const now = Date.now();
  const bucket = tokenBuckets.get(token) ?? { count: 0, windowStart: now };
  if (now - bucket.windowStart >= 60_000) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  if (bucket.count >= MAX_EVENTS_PER_MINUTE_PER_TOKEN) {
    tokenBuckets.set(token, bucket);
    return false;
  }
  bucket.count += 1;
  tokenBuckets.set(token, bucket);
  return true;
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;
const PASSWORD_PATTERN = /password[=:]\s*\S+/gi;

function redactString(input) {
  if (typeof input !== 'string') return null;
  return input
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(PASSWORD_PATTERN, 'password=[redacted]');
}

function truncate(input, max) {
  if (typeof input !== 'string') return null;
  return input.length <= max ? input : input.slice(0, max);
}

function reRedactPayload(payload) {
  return {
    environment: truncate(payload.environment, 32) ?? '',
    release: truncate(payload.release, 64) ?? '',
    route: truncate(payload.route, 128) ?? '',
    operation: truncate(payload.operation, 64) ?? '',
    provider: typeof payload.provider === 'string' ? payload.provider.slice(0, 32) : null,
    errorCode: truncate(payload.errorCode, 64) ?? null,
    status: truncate(payload.status, 32) ?? null,
    message: truncate(redactString(payload.message ?? ''), 200),
    stack: truncate(redactString(payload.stack ?? ''), 1024),
    userAgent: truncate(payload.userAgent, 256) ?? '',
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
    source: typeof payload.source === 'string' ? payload.source.slice(0, 32) : 'browser'
  };
}

/**
 * Derive the Loki HTTP push URL from a Grafana Cloud OTLP endpoint.
 *
 * Pure so it can be asserted directly against every documented shape.
 */
export function lokiPushUrl(base) {
  if (!base) return null;
  // Already a Loki push URL — leave it alone.
  if (/\/loki\/api\/v1\/push\/?$/.test(base)) return base;

  // The documented value in infra/cloud/observability/env/.env.example is
  // `https://otlp-<region>.grafana.net/v1/` (trailing slash, no signal
  // segment), so the rewrite MUST cover the bare `/v1` suffix as well as
  // `/v1/{traces,metrics,logs}`. Matching only the signal form left the
  // base URL untouched and silently POSTed Loki envelopes to the OTLP
  // collector root, which answers non-2xx and surfaced as 502 upstream.
  return (
    base
      .replace(/\/v1(?:\/(?:traces|metrics|logs))?\/?$/, '')
      .replace(/\/+$/, '') + '/loki/api/v1/push'
  );
}

export function lokiEndpoint() {
  // An explicit Loki push URL always wins. Grafana Cloud serves OTLP from
  // the `otlp-prod-*` gateway host and the Loki HTTP push API from the
  // separate `logs-prod-<stack>` host, so operators can point at the right
  // one without a code change. The OTLP-derived value stays as the
  // fallback for single-host deployments.
  const explicit = process.env.GRAFANA_CLOUD_LOKI_ENDPOINT;
  if (explicit) return explicit;
  return lokiPushUrl(process.env.GRAFANA_CLOUD_OTLP_ENDPOINT);
}

function lokiAuthHeader() {
  return process.env.GRAFANA_CLOUD_OTLP_HEADERS ?? '';
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RAW_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(auth);
  if (!match || !tokenMatches(match[1])) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  if (!rateLimit(match[1])) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    if (err?.message === 'payload_too_large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    return res.status(400).json({ error: 'invalid_request', message: 'malformed_body' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'invalid_request', message: 'invalid_json' });
  }

  if (typeof payload !== 'object' || payload === null) {
    return res.status(400).json({ error: 'invalid_request', message: 'expected_object' });
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      return res
        .status(400)
        .json({ error: 'invalid_request', message: `missing_or_invalid_field:${field}` });
    }
  }

  const sanitized = reRedactPayload(payload);
  const structuredBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
  if (structuredBytes > MAX_STRUCTURED_BYTES) {
    return res.status(400).json({ error: 'invalid_request', message: 'payload_too_large_structured' });
  }

  const endpoint = lokiEndpoint();
  const authHeader = lokiAuthHeader();
  if (!endpoint || !authHeader) {
    // Relay is intentionally not configured in this environment — treat
    // the request as a no-op so the auth flow stays unblocked. The
    // function still rate-limits and validates so a misconfigured caller
    // surfaces quickly.
    return res.status(204).end();
  }

  const lokiPayload = {
    streams: [
      {
        stream: {
          app: 'gymtrack',
          source: 'browser',
          environment: sanitized.environment,
          release: sanitized.release,
          route: sanitized.route,
          operation: sanitized.operation,
          provider: sanitized.provider ?? 'none',
          errorCode: sanitized.errorCode ?? 'none',
          status: sanitized.status ?? 'none'
        },
        values: [[`${Date.now()}000000`, JSON.stringify(sanitized)]]
      }
    ]
  };

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader
      },
      body: JSON.stringify(lokiPayload)
    });
    if (!upstream.ok) {
      return res
        .status(502)
        .json({ error: 'upstream_failure', message: `loki_${upstream.status}` });
    }
  } catch (err) {
    return res
      .status(502)
      .json({ error: 'upstream_failure', message: err?.message ?? 'loki_unreachable' });
  }

  return res.status(204).end();
}

export const _testInternals = {
  redactString,
  truncate,
  reRedactPayload,
  tokenMatches,
  rateLimit,
  tokenBuckets,
  lokiEndpoint,
  lokiPushUrl
};
