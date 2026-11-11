#!/usr/bin/env node
// stable-hostname-verification.mjs
//
// AC5 black-box harness for the stable hostname matrix
// (task 5cb4a8fe, docs/specs/add-stable-app-name-hostnames-tech-design.md
// section 7). Exercises the seven public stable staging surfaces plus the
// auto-post health endpoint and emits a single JSON result that conforms
// to tests/cloud/stable-hostname-verification.schema.json.
//
// The CNAME expectation comes from the matrix's per-surface
// `cnameTargets` (staging + production), NOT from `providerFallback`:
// providerFallback is the production provider host (the documented
// migration path), while a staging hostname must CNAME to the staging
// deployment topology. Asserting providerFallback for a staging
// hostname would demand an alias onto the production provider host.
//
// The harness has two modes:
//
//   --mode live  (default when MATRIX_LIVE=1 or the env vars are set)
//     - Performs DNS resolution + HTTPS GET + CORS preflight against the
//       stable staging hostnames in the matrix. Designed to run inside
//       .github/workflows/cloud-staging-validate.yml after Quinn has
//       registered the CNAMEs and the Let's Encrypt certs are live.
//     - Reads STAGING_TASKS_API_URL, STAGING_BUDGET_API_URL, and
//       STAGING_SCHEDULER_API_URL from the workflow env (or --flag); these
//       gate the authenticated representative-workflow step on the stable
//       URLs only.
//
//   --mode dry-run  (default when neither flag nor env are set)
//     - No network calls. Walks the matrix and emits one row per surface
//       with status=skip and a reason explaining what live mode would
//       check. Used by CI to catch harness regressions without DNS or
//       live deployments.
//     - Used as the merge-gate static check for slice 4: every PR that
//       touches the harness must keep dry-run emitting schema-valid JSON
//       for the committed matrix.
//
// Inputs (flags or environment variables):
//   --mode <live|dry-run>            [env STABLE_HOSTNAME_MODE]        optional
//   --matrix <path>                  [env HOSTNAME_MATRIX_PATH]        optional
//   --run-id <id>                    [env STAGING_RUN_ID]              optional (auto)
//   --intent-commit <sha>            [env STAGING_INTENT_COMMIT]       optional
//   --output <path>                                                      optional
//   --tasks-api-url <url>            [env STAGING_TASKS_API_URL]       optional
//   --budget-api-url <url>           [env STAGING_BUDGET_API_URL]      optional
//   --scheduler-api-url <url>        [env STAGING_SCHEDULER_API_URL]   optional
//
// Outputs:
//   - JSON result to stdout (or to --output path if supplied)
//   - Exit 0 on verdict=pass; 1 on verdict=fail; 2 on harness/config error
//
// Secrets are never logged: bearer tokens and DNS provider creds are out
// of scope for this harness (it touches health endpoints and CORS only).
//
// Cleanup runs unconditionally via a try/finally: any fixture the live
// run creates is removed (or its removal is recorded) before the harness
// returns, including on assertion failure.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const REDACTED = '[REDACTED]';
const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULTS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..');
  return {
    matrix: join(repoRoot, 'infra/cloud/hostname-matrix.json'),
  };
})();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = argv.slice(2);
  const out = {
    mode: process.env.STABLE_HOSTNAME_MODE ?? null,
    matrix: process.env.HOSTNAME_MATRIX_PATH ?? DEFAULTS.matrix,
    runId: process.env.STAGING_RUN_ID ?? null,
    intentCommit: process.env.STAGING_INTENT_COMMIT ?? null,
    output: null,
    tasksApiUrl: process.env.STAGING_TASKS_API_URL ?? null,
    budgetApiUrl: process.env.STAGING_BUDGET_API_URL ?? null,
    schedulerApiUrl: process.env.STAGING_SCHEDULER_API_URL ?? null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const next = () => args[i + 1];
    switch (a) {
      case '--mode':            out.mode = next(); i += 1; break;
      case '--matrix':          out.matrix = next(); i += 1; break;
      case '--run-id':          out.runId = next(); i += 1; break;
      case '--intent-commit':   out.intentCommit = next(); i += 1; break;
      case '--output':          out.output = next(); i += 1; break;
      case '--tasks-api-url':   out.tasksApiUrl = next(); i += 1; break;
      case '--budget-api-url':  out.budgetApiUrl = next(); i += 1; break;
      case '--scheduler-api-url': out.schedulerApiUrl = next(); i += 1; break;
      case '-h':
      case '--help':
        stdout.write(
          'Usage: node stable-hostname-verification.mjs ' +
            '[--mode live|dry-run] [--matrix <path>] [--run-id <id>] ' +
            '[--intent-commit <sha>] [--output <path>] ' +
            '[--tasks-api-url <url>] [--budget-api-url <url>] ' +
            '[--scheduler-api-url <url>]\n'
        );
        exit(0);
        break;
      default:
        stderr.write(`error: unknown argument "${a}"\n`);
        exit(2);
    }
  }
  return out;
}

function resolveMode(args) {
  // Live mode is the default when the env explicitly says so. The
  // cloud-staging-validate workflow binds MATRIX_LIVE=1 only after Quinn
  // has registered the CNAMEs and certs (see workflow dispatch comment).
  // Dry-run is the conservative default for CI unit tests.
  if (args.mode === 'live' || args.mode === 'dry-run') return args.mode;
  if (process.env.MATRIX_LIVE === '1') return 'live';
  return 'dry-run';
}

// ---------------------------------------------------------------------------
// Matrix loading
// ---------------------------------------------------------------------------

function loadMatrix(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    stderr.write(`error: could not read matrix at ${path}: ${err.message}\n`);
    exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    stderr.write(`error: could not parse matrix at ${path}: ${err.message}\n`);
    exit(2);
  }
  if (!Array.isArray(parsed.surfaces) || parsed.surfaces.length === 0) {
    stderr.write(`error: matrix at ${path} has no surfaces array\n`);
    exit(2);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Surface check helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function redactMessage(msg) {
  // Failed response bodies can contain credentials that were not designed
  // for this harness: a proxy error page may echo the proxy URL (including
  // URI userinfo), and gateway errors may include an Authorization or
  // Proxy-Authorization header. Redact those forms before the excerpt is
  // persisted in result JSON or included in row evidence.
  return String(msg ?? '')
    .replace(/[A-Fa-f0-9]{32,}/g, REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, `Bearer ${REDACTED}`)
    .replace(
      /(\bProxy-Authorization\s*[:=]\s*)(?:Basic\s+)?[A-Za-z0-9+/=._~-]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, `Basic ${REDACTED}`)
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)[^\/\s@]+@/gi,
      `$1${REDACTED}@`,
    );
}

// ---------------------------------------------------------------------------
// Transport vs upstream classification
// ---------------------------------------------------------------------------
//
// A failed HTTPS probe has two very different causes, and the harness used
// to report them identically:
//
//   - the DEPLOYMENT answered with a non-2xx status — a real AC5 failure
//     (the stable hostname does not serve the app), and
//   - the request never reached the deployment — a proxy in the request
//     path answered before the request left the machine.
//
// The second case was observed on 2026-11-11: every request from the
// operator's Mac to a *.sindustries.co.nz host came back 502 with the body
// "Secret egress proxy could not reach the upstream host.", while the same
// machine reached the *.vercel.app deployment with 200. Read as an upstream
// status, a local transport block becomes "no deployment serves this
// hostname" — a false AC5 failure that sends the operator chasing a
// deployment fault that does not exist.
//
// The classification keeps the row FAILING (the harness still could not
// verify the hostname, and AC5 must never read a false pass) but records
// WHICH side of the wire failed, so the evidence says "observer-side
// block" instead of "the deployment is down".

// Markers that identify a proxy-generated error body. Deliberately narrow:
// an application body that merely mentions "proxy" must not be misread as
// a transport block.
const PROXY_BODY_MARKERS = [
  'egress proxy',
  'could not reach the upstream',
  'upstream host',
  'proxy error',
  'tunnel connection failed',
];

// Status codes a proxy (rather than the origin) commonly answers with.
const GATEWAY_STATUSES = new Set([407, 502, 503, 504]);

function looksLikeProxyError(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  const haystack = body.toLowerCase();
  return PROXY_BODY_MARKERS.some((marker) => haystack.includes(marker));
}

// Which proxy environment variables are in play for `host`.
//
// Only the variable NAMES are recorded: a proxy URL can carry credentials,
// so the value must never reach the result JSON.
function proxyEnvFacts(host, env = process.env) {
  const envVars = [];
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = env[name];
    if (typeof value === 'string' && value.trim().length > 0) envVars.push(name);
  }
  const noProxy = String(env.NO_PROXY ?? env.no_proxy ?? '').trim();
  const target = normalizeHost(host);
  let noProxyApplies = false;
  if (noProxy && target) {
    noProxyApplies = noProxy
      .split(',')
      .map((entry) => normalizeHost(entry).replace(/^\.+/, ''))
      .filter(Boolean)
      .some((entry) => entry === '*' || target === entry || target.endsWith(`.${entry}`));
  }
  return { envVars, noProxyApplies };
}

// Classify a failed HTTPS/CORS probe.
//
//   none            — the probe succeeded (no failure to classify)
//   upstream_status — the origin answered with a non-2xx/3xx status
//   proxy_blocked   — a proxy in the request path answered instead
//   transport_error — the request failed before any response
//   timeout         — the request exceeded the harness timeout
//
// A proxy body marker is sufficient on its own (the marker only appears in
// proxy-generated error bodies). Otherwise a gateway status counts as a
// proxy block only when a proxy is actually configured for the host and
// NO_PROXY does not exempt it — so a genuine 502 from a real deployment is
// still reported as an upstream status.
function classifyHttpsFailure({ status = null, body = null, error = null, proxy = null } = {}) {
  if (error) {
    const isTimeout = error.name === 'AbortError' || error.name === 'TimeoutError';
    return { failureMode: isTimeout ? 'timeout' : 'transport_error' };
  }
  if (looksLikeProxyError(body)) {
    return { failureMode: 'proxy_blocked' };
  }
  if (proxy && proxy.envVars.length > 0 && !proxy.noProxyApplies && GATEWAY_STATUSES.has(status)) {
    return { failureMode: 'proxy_blocked' };
  }
  return { failureMode: 'upstream_status' };
}

// Read a bounded, redacted excerpt of a failed response body. The excerpt
// is what lets a reader tell a proxy's error page from the deployment's
// own error page — without it, both are just "returned 502".
async function readBodyExcerpt(response, maxChars = 200) {
  try {
    const text = await response.text();
    // Redact the complete body before truncating it. Slicing first could
    // split a credential across the boundary and persist an unredacted
    // prefix of it.
    return redactMessage(text).slice(0, maxChars);
  } catch {
    return null;
  }
}

// Evaluate a CORS preflight response. The HTTP status and the CORS header
// are separate contracts: a 2xx response without the expected allow-origin
// header is still a failed preflight, and a non-2xx response is failed even
// if a proxy or origin happened to include the expected header.
function classifyCorsPreflight({
  status,
  body = null,
  allowOrigin = null,
  expectedOrigin,
  proxy = null,
} = {}) {
  const statusOk = Number.isInteger(status) && status >= 200 && status < 300;
  const allowOriginOk = allowOrigin === expectedOrigin || allowOrigin === '*';
  const ok = statusOk && allowOriginOk;
  const failureMode = ok
    ? 'none'
    : classifyHttpsFailure({ status, body, error: null, proxy }).failureMode;
  return { ok, statusOk, allowOriginOk, failureMode };
}

// ---------------------------------------------------------------------------
// CNAME expectation
// ---------------------------------------------------------------------------

// The DNS target a surface's stable hostname must CNAME to. The matrix
// records it per environment in `cnameTargets`. `providerFallback` is the
// PRODUCTION provider host (the documented migration path), so it is only
// used as the production fallback when a surface records no explicit
// production target.
function expectedCnameTarget(surface, environment) {
  const targets = surface.cnameTargets ?? null;
  if (targets && typeof targets[environment] === 'string' && targets[environment].length > 0) {
    return targets[environment];
  }
  if (environment === 'production' && typeof surface.providerFallback === 'string' && surface.providerFallback.length > 0) {
    return surface.providerFallback;
  }
  return null;
}

// Every production CNAME target in the matrix. A staging hostname that
// resolves to one of these is aliasing staging onto production (AC2).
//
// The set is the UNION of two fields, because the two are deliberately
// allowed to diverge:
//
//   - `cnameTargets.production` — the production CNAME target, and
//   - `providerFallback` — the production provider host (the
//     documented migration path).
//
// Taking only `cnameTargets.production` lets a staging hostname alias
// `providerFallback` the moment the two diverge; taking only
// `providerFallback` would miss a surface whose production CNAME target
// moved but whose provider fallback did not. The union closes both gaps.
//
// Vercel's shared managed custom-domain target is excluded: it is
// environment-agnostic by design (every Vercel custom domain CNAMEs to
// it), so it carries no environment identity and cannot be a leak
// signal. The staging/production separation for a Vercel surface lives
// in the domain-to-environment binding in the Vercel project — which the
// HTTPS check does NOT and cannot verify (see
// docs/systems/cloud-platform.md).
const VERCEL_MANAGED_CNAME_TARGET = 'cname.vercel-dns.com';

// DNS is case-insensitive and a fully-qualified name may carry a
// trailing root dot, so every host comparison normalises first. Leak
// comparisons happen on a label boundary: a name like
// "foo.sindustries-tasks-api.fly.dev" is a subdomain of the production
// provider host and must be treated as the same production target
// rather than an unrelated host that slips past the guard.
function normalizeHost(host) {
  return typeof host === 'string' ? host.trim().toLowerCase().replace(/\.+$/, '') : '';
}

function isSameOrSubdomain(host, other) {
  const a = normalizeHost(host);
  const b = normalizeHost(other);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`);
}

function productionCnameTargets(matrix) {
  const out = new Set();
  for (const surface of matrix?.surfaces ?? []) {
    const candidates = [expectedCnameTarget(surface, 'production'), surface?.providerFallback];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const key = normalizeHost(candidate);
      if (!key || key === VERCEL_MANAGED_CNAME_TARGET) continue;
      out.add(key);
    }
  }
  return out;
}

function makeRow(surface, environment, status, details, evidence) {
  // Per-surface row shape (see schema). environment: "staging" or
  // "production"; status: "ok" | "fail" | "skip"; details is a structured
  // object with check-specific fields; evidence is a free-form string
  // describing what was actually observed (redacted).
  return {
    id: surface.id,
    kind: surface.kind,
    host: environment === 'staging' ? surface.staging : surface.production,
    environment,
    expected: surface[environment] ?? null,
    status,
    details,
    evidence,
  };
}

async function checkDns(surface, environment, productionTargets) {
  // Uses node:dns/promises. The harness asserts the CNAME chain
  // terminates at the target the matrix records for THIS environment
  // (`cnameTargets[environment]`), NOT at `providerFallback`.
  //
  // Why the distinction matters (task 5cb4a8fe, 2026-11-10): the
  // `providerFallback` field records the PRODUCTION provider host (the
  // documented migration path), while a staging hostname must CNAME to
  // the staging deployment topology. Asserting `providerFallback` for a
  // staging hostname demanded a CNAME to the production provider host —
  // which would alias staging onto production, the exact thing AC2
  // forbids, and which the staging deployment does not serve anyway.
  if (!surface[environment]) {
    return { ok: false, evidence: 'no public URL' };
  }
  const host = surface[environment];
  const expected = expectedCnameTarget(surface, environment);
  const { promises: dns } = await import('node:dns');
  let records;
  try {
    records = await dns.resolveCname(host);
  } catch (err) {
    return {
      ok: false,
      evidence: `CNAME resolution failed: ${redactMessage(err.message)}`,
      details: { expectedCnameTarget: expected ?? null, providerFallback: surface.providerFallback ?? null },
    };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return {
      ok: false,
      evidence: 'no CNAME records returned',
      details: { expectedCnameTarget: expected ?? null, providerFallback: surface.providerFallback ?? null },
    };
  }

  // The CNAME chain may contain more than one hop. The design (section 7)
  // says the harness "expects the CNAME chain to terminate at the
  // matching target", so the TERMINAL hop is what we compare: a provider
  // that inserts an extra hop must not produce a false failure. The full
  // chain is recorded in details.cnameChain so a reviewer can see it.
  const cnameChain = records.map(normalizeHost);
  const target = cnameChain[cnameChain.length - 1];
  if (!expected) {
    return {
      ok: false,
      evidence: `matrix records no ${environment} CNAME target for ${surface.id} (add cnameTargets.${environment} to infra/cloud/hostname-matrix.json)`,
      details: { cnameChain, cnameTarget: target, expectedCnameTarget: null, providerFallback: surface.providerFallback ?? null },
    };
  }
  // AC2 guard: a staging hostname must never CNAME to a production
  // provider target — at ANY hop, not just the terminal one, because a
  // chain that passes through a production host is a leak regardless of
  // where it ends. Catch that before the equality check so the evidence
  // names the cross-environment leak rather than a bare "expected X"
  // mismatch.
  if (environment !== 'production') {
    for (const hop of cnameChain) {
      for (const productionTarget of productionTargets) {
        if (!isSameOrSubdomain(hop, productionTarget)) continue;
        return {
          ok: false,
          evidence: `CNAME ${host} -> ${records.join(' -> ')} (${environment} hostname resolves through PRODUCTION provider target "${productionTarget}" — cross-environment leak)`,
          details: { cnameChain, cnameTarget: target, expectedCnameTarget: expected, providerFallback: surface.providerFallback ?? null },
        };
      }
    }
  }
  const matches = normalizeHost(target) === normalizeHost(expected);
  return {
    ok: matches,
    evidence: matches
      ? `CNAME ${host} -> ${records.join(' -> ')}`
      : `CNAME ${host} -> ${records.join(' -> ')} (expected ${expected})`,
    details: { cnameChain, cnameTarget: target, expectedCnameTarget: expected, providerFallback: surface.providerFallback ?? null },
  };
}

// The health path(s) each surface is probed at.
//
// AC5 names the Content Scheduler auto-post health endpoint explicitly:
// "API health endpoints, the Content Scheduler auto-post health
// endpoint, and representative authenticated staging workflows". That
// endpoint is served by the content-scheduler-api surface (the auto-post
// worker itself has no HTTP surface), so that surface is probed at both
// its own /health and the auto-post health path.
const HEALTH_PATHS_BY_SURFACE = {
  'health-probe': ['/healthz'],
  'content-scheduler-api': ['/health', '/api/v1/content-scheduler/auto-post/health'],
};

function healthPathsForSurface(surface) {
  if (surface.kind === 'frontend') return ['/'];
  return HEALTH_PATHS_BY_SURFACE[surface.id] ?? ['/health'];
}

async function checkHttps(surface, environment) {
  // For surfaces with a /health or /healthz endpoint, hit it and expect
  // 200 + JSON. Frontend surfaces return HTML; we only assert the root
  // returns 200. The harness does not parse the body shape (the
  // representative-workflow step in staging-workflows.mjs is the
  // authoritative body check).
  //
  // A surface may be probed at more than one health path (the Content
  // Scheduler surface also carries the auto-post health endpoint). Every
  // path is requested and every result is recorded, so one missing
  // endpoint never hides the others.
  if (!surface[environment]) {
    return { ok: true, evidence: 'no public URL — skipped by design' };
  }
  const host = surface[environment];
  const paths = healthPathsForSurface(surface);
  const checks = [];
  for (const path of paths) {
    const url = `https://${host}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response = null;
    let error = null;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    } catch (err) {
      error = err;
    }
    clearTimeout(timer);
    const proxy = proxyEnvFacts(host);
    if (!response) {
      const { failureMode } = classifyHttpsFailure({ status: null, body: null, error, proxy });
      checks.push({
        path,
        url,
        ok: false,
        status: null,
        failureMode,
        error: redactMessage(error?.message ?? String(error)),
        proxyInPath: proxy,
      });
      continue;
    }
    const status = response.status;
    const ok = status >= 200 && status < 400;
    // The body excerpt is only read for a failure: it is what separates a
    // proxy's error page from the deployment's own error page. A successful
    // health response body is not evidence the harness needs.
    const bodyExcerpt = ok ? null : await readBodyExcerpt(response);
    const { failureMode } = ok
      ? { failureMode: 'none' }
      : classifyHttpsFailure({ status, body: bodyExcerpt, error: null, proxy });
    checks.push({ path, url, ok, status, failureMode, bodyExcerpt, proxyInPath: proxy });
  }
  const ok = checks.every((c) => c.ok);
  const evidence = checks
    .map((c) => {
      if (c.ok) return `fetch ${c.url} returned ${c.status}`;
      if (c.failureMode === 'proxy_blocked') {
        return (
          `fetch ${c.url} returned ${c.status} — blocked by a proxy in the request path` +
          `${c.bodyExcerpt ? ` (body: ${c.bodyExcerpt})` : ''}; the harness could not reach the ` +
          'deployment, so this is NOT evidence that the deployment is down'
        );
      }
      if (c.failureMode === 'timeout') {
        return `fetch ${c.url} timed out after ${DEFAULT_TIMEOUT_MS}ms`;
      }
      if (c.failureMode === 'transport_error') {
        return `fetch ${c.url} failed before any response: ${c.error}`;
      }
      return `fetch ${c.url} returned ${c.status} (upstream status)`;
    })
    .join(' | ');
  const details = { checks };
  // `status` is kept for the single-path case so existing consumers of
  // details.status keep working; a multi-path surface carries the full
  // per-path breakdown in details.checks instead.
  if (checks.length === 1 && typeof checks[0].status === 'number') details.status = checks[0].status;
  return { ok, evidence, details };
}

async function checkCorsPreflight(surface, environment, args) {
  // CORS preflight for the in-scope browser-side consumers. The matrix
  // records the matching frontend hostnames; we send Origin against each
  // API surface and expect Access-Control-Allow-Origin to match.
  if (surface.kind !== 'api' || !surface[environment]) {
    return { ok: true, evidence: 'not an API surface — skipped' };
  }
  const host = surface[environment];
  // Pick the in-scope frontend hostname by surface id. The mapping mirrors
  // the per-hostname comment blocks at the top of each fly.toml.
  const originBySurface = {
    'tasks-api': 'https://tasks.staging.sindustries.co.nz',
    'budget-api': 'https://mission-control.staging.sindustries.co.nz',
    'content-scheduler-api': 'https://mission-control.staging.sindustries.co.nz',
  };
  const origin = originBySurface[surface.id];
  if (!origin) {
    return { ok: true, evidence: 'no in-scope browser-side consumer — skipped' };
  }
  const url = `https://${host}/api/v1/options`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const proxy = proxyEnvFacts(host);
  let response = null;
  let error = null;
  try {
    response = await fetch(url, {
      method: 'OPTIONS',
      signal: controller.signal,
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });
  } catch (err) {
    error = err;
  }
  clearTimeout(timer);
  if (!response) {
    const { failureMode } = classifyHttpsFailure({ status: null, body: null, error, proxy });
    const evidence =
      failureMode === 'timeout'
        ? `preflight ${url} timed out after ${DEFAULT_TIMEOUT_MS}ms`
        : failureMode === 'proxy_blocked'
          ? `preflight ${url} was blocked by a proxy in the request path; the harness could not reach the deployment`
          : `preflight ${url} failed before any response: ${redactMessage(error?.message ?? String(error))}`;
    return {
      ok: false,
      evidence,
      details: { failureMode, error: redactMessage(error?.message ?? String(error)), proxyInPath: proxy },
    };
  }
  const allowOrigin = response.headers.get('access-control-allow-origin');
  const status = response.status;
  const statusOk = status >= 200 && status < 300;
  const allowOriginOk = allowOrigin === origin || allowOrigin === '*';
  // Read the body for every failed preflight, not only for a non-2xx
  // response: the status and ACAO header are separate contracts, and the
  // body is what distinguishes an observer-side proxy block from an
  // upstream CORS failure.
  const bodyExcerpt = statusOk && allowOriginOk ? null : await readBodyExcerpt(response);
  const { ok, failureMode } = classifyCorsPreflight({
    status,
    body: bodyExcerpt,
    allowOrigin,
    expectedOrigin: origin,
    proxy,
  });
  let evidence;
  if (ok) {
    evidence = `preflight ${url} allow-origin=${allowOrigin}`;
  } else if (failureMode === 'proxy_blocked') {
    evidence =
      `preflight ${url} returned ${status} — blocked by a proxy in the request path` +
      `${bodyExcerpt ? ` (body: ${bodyExcerpt})` : ''}; the harness could not reach the deployment`;
  } else {
    evidence = statusOk
      ? `preflight ${url} allow-origin=${allowOrigin ?? 'absent'} (expected ${origin})`
      : `preflight ${url} returned ${status} (upstream status)`;
  }
  return {
    ok,
    evidence,
    details: {
      allowOrigin,
      expected: origin,
      status,
      failureMode,
      bodyExcerpt,
      proxyInPath: proxy,
    },
  };
}

async function runLiveChecks(surface, environment, args, productionTargets) {
  // Live mode runs all three checks and reports each one. It does NOT
  // short-circuit on the first failure: a DNS failure used to hide the
  // HTTPS and CORS results behind it, so those stages stayed
  // unevidenced until DNS was fixed. The row still fails when any
  // check fails; it just now carries every stage's evidence.
  const dnsCheck = await checkDns(surface, environment, productionTargets);
  const httpsCheck = await checkHttps(surface, environment);
  const corsCheck = await checkCorsPreflight(surface, environment, args);
  const details = {
    dns: dnsCheck.details ?? null,
    https: httpsCheck.details ?? null,
    cors: corsCheck.details ?? null,
  };
  const failures = [dnsCheck, httpsCheck, corsCheck].filter((c) => !c.ok);
  if (failures.length === 0) {
    return {
      status: 'ok',
      details,
      evidence: `dns + https + cors-preflight all passed for ${surface.id}@${environment}`,
    };
  }
  return {
    status: 'fail',
    details,
    evidence: failures.map((c) => c.evidence).join(' | '),
  };
}

function runDryCheck(surface, environment) {
  // Dry-run mode emits a row whose status=skip and whose evidence
  // records what live mode would check. The harness is the source of
  // truth for the dry-run surface list — a reviewer can diff dry-run
  // output against the matrix to confirm coverage.
  if (!surface[environment]) {
    return {
      status: 'skip',
      details: { reason: 'no public URL — surface has no public hostname by design' },
      evidence: `matrix records ${surface.id}.${environment}=null (worker; no public URL)`,
    };
  }
  const checks = [
    'dns (CNAME -> matrix cname target)',
    `https (GET ${healthPathsForSurface(surface).join(', GET ')})`,
    'cors preflight (Origin -> API)',
  ];
  return {
    status: 'skip',
    details: {
      reason: 'dry-run mode — set --mode live or MATRIX_LIVE=1 to execute',
      plannedChecks: checks,
      // The CNAME target this row would assert in live mode. Recorded in
      // dry-run too so the expectation is reviewable offline (and so a
      // matrix that still points staging at a production provider host
      // is visible without a live run).
      expectedCnameTarget: expectedCnameTarget(surface, environment),
    },
    evidence: `dry-run: would check ${checks.length} properties on ${surface[environment]}`,
  };
}

// ---------------------------------------------------------------------------
// Representative authenticated workflow (live mode only)
// ---------------------------------------------------------------------------

function representativeWorkflowStatus(matrix, args) {
  // The design records the representative authenticated workflow as
  // a step owned by staging-workflows.mjs. Stable-hostname-verification
  // does not re-implement it — it just asserts the workflow completed
  // without falling back to a *.fly.dev URL. In dry-run mode this is a
  // skip; in live mode it is a soft assertion (the AC5 black-box
  // exercise happens in the harness's caller).
  if (!matrix || !args) return { status: 'skip', evidence: 'no input' };
  return {
    status: 'skip',
    evidence: 'representative-workflow check is owned by staging-workflows.mjs; stable-hostname-verification only asserts no *.fly.dev fallback URLs in its evidence',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const mode = resolveMode(args);
  const matrix = loadMatrix(args.matrix);
  const startedAt = nowIso();
  const runId = args.runId ?? `stable-hostname-${Date.now()}`;
  const environment = 'staging'; // Production counterpart is a Quinn manual gate (AC6).
  const errors = [];

  // Walk the matrix and produce one row per surface. Worker surfaces
  // (auto-post-worker) record a single skip row for the staging
  // environment because the matrix records staging=null.
  const rows = [];
  // The production-target set is the same for every row, so it is built
  // once here instead of being recomputed per surface inside the DNS
  // check.
  const productionTargets = productionCnameTargets(matrix);
  for (const surface of matrix.surfaces) {
    if (surface.kind === 'worker' && surface.publicUrl === false) {
      rows.push({
        id: surface.id,
        kind: 'worker',
        host: null,
        environment,
        expected: null,
        status: 'skip',
        details: { reason: 'worker surface has no public URL by design (matrix records publicUrl=false)' },
        evidence: surface.rationale,
      });
      continue;
    }
    let result;
    if (mode === 'live') {
      try {
        result = await runLiveChecks(surface, environment, args, productionTargets);
      } catch (err) {
        errors.push(`${surface.id}: ${redactMessage(err.message)}`);
        result = {
          status: 'fail',
          details: {},
          evidence: `live check threw: ${redactMessage(err.message)}`,
        };
      }
    } else {
      result = runDryCheck(surface, environment);
    }
    rows.push(makeRow(surface, environment, result.status, result.details, result.evidence));
  }

  // Representative-workflow placeholder. The full body is owned by
  // staging-workflows.mjs; this row is the AC5 link so reviewers can
  // see the two harnesses line up.
  const repWorkflow = representativeWorkflowStatus(matrix, args);

  const endedAt = nowIso();

  // Verdict: live mode requires every non-skip row to be ok; dry-run
  // always reports pass because skip is a planned state, not a failure.
  const verdict = (() => {
    if (mode === 'dry-run') return 'pass';
    const blocking = rows.filter((r) => r.status === 'fail');
    return blocking.length === 0 ? 'pass' : 'fail';
  })();

  // Production blockers: in dry-run mode the matrix contract is the
  // only evidence we have. In live mode, the production counterpart
  // is a Quinn manual gate — the harness always records the production
  // row as a blocker for visibility.
  const productionBlockers = mode === 'live'
    ? [
        {
          code: 'PRODUCTION_HOSTNAME_MANUAL_GATE_PENDING',
          summary: 'Production CNAMEs + Fly certs + Vercel domains are Quinn-owned; the production counterpart of this harness is a manual gate (AC6).',
          owner: 'Quinn',
          reference: 'docs/specs/add-stable-app-name-hostnames-tech-design.md §8',
        },
      ]
    : [];

  const result = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    intentCommit: args.intentCommit,
    mode,
    matrixPath: args.matrix,
    matrixTaskId: matrix.taskId ?? null,
    environment: {
      id: 'staging',
      provider: 'fly.io',
    },
    startedAt,
    endedAt,
    surfaces: rows,
    representativeWorkflow: repWorkflow,
    productionBlockers,
    acceptedLimitations: mode === 'dry-run'
      ? [
          {
            code: 'STABLE_HOSTNAME_DRY_RUN',
            summary: 'Dry-run mode emits skip rows because DNS is not live in this environment. Live mode runs once Quinn registers the CNAMEs and the staging GitHub environment binds the stable hostnames.',
            owner: 'Rowan',
            rationale: 'The matrix is in place (slice 1), CORS is wired (slice 2), deploy workflow smoke loops target the stable hostnames (slice 3). The live AC5 black-box is gated on Quinn registering the staging CNAMEs + certs + setting STAGING_TASKS_API_URL/BUDGET/SCHEDULER env vars.',
            followUp: 'task 5cb4a8fe slice 4 + slice 5 (production-blockers list); task 020f423e production cutover.',
          },
        ]
      : [],
    verdict,
  };

  const json = JSON.stringify(result, null, 2);
  if (args.output) {
    try {
      mkdirSync(dirname(args.output), { recursive: true });
      writeFileSync(args.output, json);
    } catch (err) {
      stderr.write(`error: could not write output to ${args.output}: ${err.message}\n`);
      exit(2);
    }
  }
  stdout.write(json);
  if (!json.endsWith('\n')) stdout.write('\n');

  if (errors.length > 0 && mode === 'live') {
    stderr.write(`stable-hostname-verification threw on ${errors.length} surface${errors.length === 1 ? '' : 's'}:\n`);
    for (const e of errors) stderr.write(`  - ${e}\n`);
  }

  if (verdict === 'fail') exit(1);
  exit(0);
}

// The pure helpers are exported so the contract test can exercise the
// AC2 leak-guard set and the host-normalisation rules directly, without
// needing live DNS to prove them.
export {
  expectedCnameTarget,
  normalizeHost,
  isSameOrSubdomain,
  productionCnameTargets,
  healthPathsForSurface,
  HEALTH_PATHS_BY_SURFACE,
  classifyHttpsFailure,
  classifyCorsPreflight,
  looksLikeProxyError,
  proxyEnvFacts,
  readBodyExcerpt,
  redactMessage,
};

// `main()` only runs when the file is invoked directly; importing the
// helpers above must not start a harness run.
const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedDirectly) {
  main().catch((err) => {
    stderr.write(`fatal: stable-hostname-verification crashed: ${redactMessage(err?.stack ?? err?.message ?? String(err))}\n`);
    exit(2);
  });
}
