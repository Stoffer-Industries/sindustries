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
//   204 No Content             — success (also: relay not configured yet)
//   400 { error: 'invalid_request', message: '<reason>' }
//   401 { error: 'invalid_token' }
//   405 { error: 'method_not_allowed' }   Allow: POST
//   413 { error: 'payload_too_large' }
//   429 { error: 'rate_limited' }
//   502 { error: 'upstream_failure', message: '<reason>' }
//   502 { error: 'misconfigured_loki_endpoint', message: '<actionable>' }
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
 *
 * Returns `null` for shapes the rewriter cannot safely transform — a bare
 * host like `https://otlp-gateway-prod-<region>.grafana.net` has no
 * `/v1[-suffix]` to strip, so any URL the rewriter would construct by
 * appending `/loki/api/v1/push` is a 404 against the OTLP gateway on
 * Grafana Cloud (OTLP and the Loki push API live on different hosts
 * there). Callers MUST treat null as "configuration is incomplete — set
 * `GRAFANA_CLOUD_LOKI_ENDPOINT` explicitly" rather than guessing.
 */
export function lokiPushUrl(base) {
  if (!base) return null;
  // Already a Loki push URL — leave it alone.
  if (/\/loki\/api\/v1\/push\/?$/.test(base)) return base;

  // The rewriter is only safe on SINGLE-HOST OTel-collector
  // deployments where OTLP and the Loki push API are served from the
  // same host. The canonical shape is exactly
  // `https://<host>/v1[-suffix]` — no other path segments. Anything
  // outside that shape is a multi-host trap:
  //
  //   * Bare host (e.g. `https://otlp-gateway-prod-<region>.grafana.net`,
  //     the real Grafana Cloud prod shape) — OTLP lives under
  //     `/otlp/v1/*` on this tenant and Loki push lives on the separate
  //     `logs-prod-<stack>` host. Appending `/loki/api/v1/push` to a
  //     bare host answers 404 because the OTLP gateway does not serve
  //     the Loki push API.
  //   * Multi-segment path (e.g.
  //     `https://<host>/otlp/v1/logs`) — the canonical single-host
  //     rewriter assumes one host serves both; on Grafana Cloud (and
  //     similar split-tenant setups) the OTLP `/otlp/v1/*` is on the
  //     gateway and the Loki push is on `logs-prod-*`. Stripping
  //     `/v1/logs` and appending `/loki/api/v1/push` lands on the
  //     wrong host.
  //   * Anything else that does not look like the canonical
  //     `/v1[-suffix]` shape — same root cause: we cannot derive a
  //     working Loki URL without knowing the deployment topology.
  //
  // Returning null lets the caller surface a 502 `misconfigured_loki_
  // endpoint` instead of silently no-opping or silently 404'ing. The
  // override env var `GRAFANA_CLOUD_LOKI_ENDPOINT` is the only way to
  // forward on multi-host tenants.
  if (!/^https?:\/\/[^/]+\/v1(?:\/(?:traces|metrics|logs))?\/?$/.test(base)) {
    return null;
  }
  return (
    base
      .replace(/\/v1(?:\/(?:traces|metrics|logs))?\/?$/, '')
      .replace(/\/+$/, '') + '/loki/api/v1/push'
  );
}

export function lokiEndpoint() {
  // An explicit Loki push URL always wins. Grafana Cloud serves OTLP from
  // the `otlp-prod-*` gateway host and the Loki HTTP push API from the
  // separate `logs-prod-<stack>` host, so on multi-host tenants operators
  // point at the right one via `GRAFANA_CLOUD_LOKI_ENDPOINT`. The
  // OTLP-derived value stays as the fallback for single-host deployments
  // where the rewriter pattern matches. Returns `null` when neither
  // produces a URL — caller must check `lokiMisconfiguredReason()` to
  // distinguish a missing config from a misconfigured one.
  const explicit = process.env.GRAFANA_CLOUD_LOKI_ENDPOINT;
  if (explicit) return explicit;
  return lokiPushUrl(process.env.GRAFANA_CLOUD_OTLP_ENDPOINT);
}

/**
 * Human-readable explanation of why no Loki endpoint could be resolved,
 * or `null` when configuration is fine. Used by the handler to choose
 * between a 204 no-op (relay intentionally not configured) and a 502
 * `misconfigured_loki_endpoint` (operator tried but the OTLP base is
 * not the same host as the Loki push API).
 */
export function lokiMisconfiguredReason() {
  if (process.env.GRAFANA_CLOUD_LOKI_ENDPOINT) return null;
  const otlpBase = process.env.GRAFANA_CLOUD_OTLP_ENDPOINT;
  if (!otlpBase) return null;
  if (lokiPushUrl(otlpBase)) return null;
  return (
    'set GRAFANA_CLOUD_LOKI_ENDPOINT explicitly — the relay could not ' +
    'derive a Loki push URL from GRAFANA_CLOUD_OTLP_ENDPOINT; on ' +
    'Grafana Cloud tenants OTLP and the Loki push API live on ' +
    'different hosts (otlp-prod-* vs. logs-prod-*)'
  );
}

// Matches a bare HTTP header name per RFC 9110 token rules.
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Convert `GRAFANA_CLOUD_OTLP_HEADERS` into real HTTP headers.
 *
 * That variable is an OTLP *exporter header string*, not a header value.
 * Every place that defines it documents the exporter form
 * (`Authorization=Basic <base64>`, optionally comma-separated over several
 * headers), because that is the format the OTel SDKs and
 * `bootstrap-observability.sh` already consume:
 *
 *   infra/cloud/observability/env/.env.example
 *     GRAFANA_CLOUD_OTLP_HEADERS="Authorization=Basic <redacted-base64>"
 *   docs/systems/observability.md
 *     a quoted `Authorization=Basic <base64(instance_id:access_policy_token)>`
 *     exporter header
 *   infra/cloud/observability/bootstrap-observability.sh
 *     OTEL_EXPORTER_OTLP_HEADERS="${GRAFANA_CLOUD_OTLP_HEADERS}"
 *
 * The relay used to pass the raw string through as the `Authorization`
 * value, so an operator who followed the documentation produced the header
 * `Authorization: Authorization=Basic <base64>`. Grafana Cloud rejects that
 * with 401, the relay maps it to 502 upstream_failure, and the browser
 * event is dropped — which reads as "the telemetry relay is broken" rather
 * than "the credential was formatted for the wrong transport".
 *
 * Parsing rules:
 *   - Comma-separated `key=value` pairs become real headers. Only the
 *     FIRST `=` splits, so base64 padding (`dGVzdA==`) survives intact.
 *   - A segment whose leading `=`-delimited chunk is not a valid header
 *     name is treated as a bare header value, so `Basic <b64>` keeps
 *     working.
 *   - Values are URL-decoded, per the OTLP header-string spec.
 */
export function parseOtlpHeaderString(raw) {
  const headers = {};
  if (typeof raw !== 'string') return headers;

  const trimmed = raw.trim();
  if (!trimmed) return headers;

  for (const segment of trimmed.split(',')) {
    const part = segment.trim();
    if (!part) continue;

    const eq = part.indexOf('=');
    if (eq === -1) {
      // Bare value with no `key=` prefix — a valid Authorization value.
      headers.Authorization = part;
      continue;
    }

    const name = part.slice(0, eq).trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      // Not a header pair. The `=` belongs to base64 padding, so treat the
      // whole segment as a bare value instead of splitting on it.
      headers.Authorization = part;
      continue;
    }

    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not percent-encoded; use the value as written.
    }
    headers[name] = value.trim();
  }

  return headers;
}

/**
 * The server-held Grafana credential as real HTTP headers, or null when no
 * usable credential is configured.
 */
export function lokiAuthHeaders() {
  const headers = parseOtlpHeaderString(process.env.GRAFANA_CLOUD_OTLP_HEADERS);
  return Object.keys(headers).length > 0 ? headers : null;
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
  const upstreamHeaders = lokiAuthHeaders();
  if (!endpoint) {
    // If the operator attempted to configure the relay but the OTLP
    // base does not serve the Loki push API (the Grafana Cloud multi-
    // host shape), surface a clear actionable 502 instead of silently
    // no-oping. Silently no-oping here would have masked a config gap
    // behind a 204, and the browser event would have been dropped with
    // no operator-visible signal.
    const reason = lokiMisconfiguredReason();
    if (reason) {
      return res.status(502).json({
        error: 'misconfigured_loki_endpoint',
        message: reason
      });
    }
    // Relay is intentionally not configured in this environment (no
    // OTLP and no override) — treat the request as a no-op so the auth
    // flow stays unblocked. The function still rate-limits and validates
    // so a misconfigured caller surfaces quickly.
    return res.status(204).end();
  }
  if (!upstreamHeaders) {
    // Endpoint resolved but credential is unset / blank — half-armed
    // intermediate state during staged rollouts. Keep the existing
    // no-op behaviour so the caller does not see 502 spam while
    // credentials are still landing.
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
        ...upstreamHeaders
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
  lokiPushUrl,
  lokiMisconfiguredReason,
  lokiAuthHeaders
};
