type AkahuTokenResponse = {
  success?: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type AkahuListResponse<T> = {
  success: boolean;
  items: T[];
  cursor?: { next?: string | null };
  message?: string;
};

type AkahuActionResponse = {
  success?: boolean;
  message?: string;
};

export type AkahuAccount = {
  _id: string;
  name?: string;
  status?: string;
  type?: string;
  balance?: {
    current?: number;
    available?: number;
    currency?: string;
    overdrawn?: boolean;
  };
};

export type AkahuTransaction = {
  _id: string;
  _account: string;
  date: string;
  description: string;
  amount: number;
  type?: string;
  merchant?: { name?: string } | null;
};

export type AkahuPendingTransaction = Omit<AkahuTransaction, '_id' | 'merchant'> & {
  updated_at?: string;
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ---------------------------------------------------------------------------
// Per-call deadlines, typed timeout/HTTP errors, and a kind-scoped retry
// policy. `kind: 'read'` calls (accounts/transactions/pending) are retried on
// 429/502/503/504 and on timeout; `kind: 'write'` calls (token exchange,
// /v1/refresh) are never retried — authorization codes are single-use and a
// retried refresh only deepens provider throttling.
// ---------------------------------------------------------------------------

export class AkahuTimeoutError extends Error {
  readonly code = 'AKAHU_TIMEOUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AkahuTimeoutError';
  }
}

export class AkahuHttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AkahuHttpError';
    this.status = status;
    this.code = `AKAHU_HTTP_${status}`;
  }
}

/** A deadline shared across a set of calls, e.g. the whole `/akahu/sync` request. */
export type AkahuBudget = { readonly deadlineAt: number };

export function createAkahuBudget(ms: number): AkahuBudget {
  return { deadlineAt: Date.now() + ms };
}

function remainingBudgetMs(budget: AkahuBudget | undefined): number {
  return budget ? budget.deadlineAt - Date.now() : Infinity;
}

// Read lazily (not hoisted to a module-load-time constant) so it stays
// env-configurable per the tech design's open question #3, and so tests can
// override it without needing to re-import the module.
function defaultPerCallTimeoutMs(): number {
  const raw = Number(process.env.AKAHU_PER_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}
const READ_MAX_ATTEMPTS = 4;
const RETRYABLE_READ_STATUSES = new Set([429, 502, 503, 504]);

type AkahuCallKind = 'read' | 'write';

type FetchAkahuResult = {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
  retryAfterHeader: string | null;
};

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Races `promise` against `signal` aborting, so a deadline bounds both the
 * header response and the subsequent body read — regardless of whether the
 * underlying `fetch`/body-stream implementation itself observes the signal
 * once the response has already resolved.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutError: AkahuTimeoutError
): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutError);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(isAbortError(err) ? timeoutError : err);
      }
    );
  });
}

async function fetchAkahuOnce(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<FetchAkahuResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timeoutError = new AkahuTimeoutError(
    `Akahu request to ${String(url)} timed out after ${timeoutMs}ms`
  );

  const res = await raceWithAbort(fetch(url, { ...init, signal }), signal, timeoutError);
  const text = await raceWithAbort(res.text(), signal, timeoutError);
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    text,
    json,
    retryAfterHeader: res.headers.get('retry-after')
  };
}

function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.min(retryAfterSec * 1000, 2_000);
  }
  const base = Math.min(50 * 2 ** (attempt - 1), 400);
  return base + Math.random() * base;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Issues a single Akahu HTTP call under a per-call deadline, retrying
 * `kind: 'read'` calls on transient failures within the optional whole-sync
 * `budget`. `kind: 'write'` calls are attempted exactly once.
 */
async function fetchAkahu(
  url: string | URL,
  init: RequestInit,
  opts: { kind: AkahuCallKind; timeoutMs?: number; budget?: AkahuBudget }
): Promise<FetchAkahuResult> {
  const timeoutMs = opts.timeoutMs ?? defaultPerCallTimeoutMs();

  if (opts.kind === 'write') {
    return fetchAkahuOnce(url, init, timeoutMs);
  }

  // The first attempt always runs regardless of budget — only a *retry*
  // (attempt > 1) is gated on remaining budget, so a caller always gets at
  // least one try even with a near-exhausted whole-sync budget.
  let lastResult: FetchAkahuResult | undefined;
  for (let attempt = 1; attempt <= READ_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && remainingBudgetMs(opts.budget) <= 0) {
      if (lastResult) return lastResult;
      throw new AkahuTimeoutError('Akahu whole-sync budget exhausted before a retry could start');
    }

    try {
      const result = await fetchAkahuOnce(url, init, timeoutMs);
      const retryable = RETRYABLE_READ_STATUSES.has(result.status);
      if (!retryable || attempt === READ_MAX_ATTEMPTS) {
        return result;
      }
      lastResult = result;
      await sleep(
        Math.min(
          backoffDelayMs(attempt, result.retryAfterHeader),
          Math.max(0, remainingBudgetMs(opts.budget))
        )
      );
    } catch (err) {
      if (err instanceof AkahuTimeoutError && attempt < READ_MAX_ATTEMPTS) {
        if (remainingBudgetMs(opts.budget) <= 0) throw err;
        await sleep(Math.min(backoffDelayMs(attempt, null), Math.max(0, remainingBudgetMs(opts.budget))));
        continue;
      }
      throw err;
    }
  }

  // Unreachable: the loop always returns or throws, but TS needs an exhaustive return.
  return lastResult as FetchAkahuResult;
}

function parseAkahuList<T>(result: FetchAkahuResult, endpoint: string): AkahuListResponse<T> {
  const json = result.json as AkahuListResponse<T> | null;
  if (!result.ok || !json || json.success !== true || !Array.isArray(json.items)) {
    const msg = (json as any)?.message ?? `HTTP ${result.status}`;
    throw new AkahuHttpError(result.status, `Akahu ${endpoint} failed: ${msg}`);
  }
  return json;
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  redirectUri?: string;
}) {
  const client_id = requiredEnv('AKAHU_CLIENT_ID');
  const client_secret = requiredEnv('AKAHU_CLIENT_SECRET');
  const redirect_uri = params.redirectUri ?? requiredEnv('AKAHU_REDIRECT_URI');

  const result = await fetchAkahu(
    'https://oauth.akahu.nz/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri,
        client_id,
        client_secret
      })
    },
    { kind: 'write' }
  );

  const json = result.json as AkahuTokenResponse | null;
  if (!result.ok || !json?.access_token) {
    const msg = json?.error_description ?? json?.error ?? `HTTP ${result.status}`;
    throw new AkahuHttpError(result.status, `Akahu token exchange failed: ${msg}`);
  }

  return { accessToken: json.access_token, scope: json.scope ?? null };
}

export async function akahuGetAccounts(params: { accessToken: string; budget?: AkahuBudget }) {
  const appIdToken = requiredEnv('AKAHU_CLIENT_ID');
  const result = await fetchAkahu(
    'https://api.akahu.io/v1/accounts',
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'X-Akahu-Id': appIdToken
      }
    },
    { kind: 'read', budget: params.budget }
  );

  return parseAkahuList<AkahuAccount>(result, '/accounts').items;
}

export async function akahuRefreshAllAccounts(params: { accessToken: string; budget?: AkahuBudget }) {
  const appIdToken = requiredEnv('AKAHU_CLIENT_ID');
  const result = await fetchAkahu(
    'https://api.akahu.io/v1/refresh',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'X-Akahu-Id': appIdToken
      }
    },
    { kind: 'write' }
  );

  const json = result.json as AkahuActionResponse | null;

  if (result.status === 429) {
    return {
      requested: false,
      rateLimited: true,
      message: json?.message ?? 'Akahu refresh was recently requested'
    };
  }

  if (!result.ok || json?.success !== true) {
    const msg = json?.message ?? `HTTP ${result.status}`;
    throw new AkahuHttpError(result.status, `Akahu /refresh failed: ${msg}`);
  }

  return { requested: true, rateLimited: false, message: json?.message ?? null };
}

export async function akahuGetTransactions(params: {
  accessToken: string;
  startMs?: number;
  endMs?: number;
  cursor?: string;
  budget?: AkahuBudget;
}): Promise<{ items: AkahuTransaction[]; nextCursor: string | null }> {
  const appIdToken = requiredEnv('AKAHU_CLIENT_ID');
  const url = new URL('https://api.akahu.io/v1/transactions');
  // Akahu expects ISO 8601 date-time strings in query params, and requires
  // start/end to be repeated on every page of a paginated traversal.
  if (typeof params.startMs === 'number')
    url.searchParams.set('start', new Date(params.startMs).toISOString());
  if (typeof params.endMs === 'number')
    url.searchParams.set('end', new Date(params.endMs).toISOString());
  if (params.cursor) url.searchParams.set('cursor', params.cursor);

  const result = await fetchAkahu(
    url,
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'X-Akahu-Id': appIdToken
      }
    },
    { kind: 'read', budget: params.budget }
  );

  const json = parseAkahuList<AkahuTransaction>(result, '/transactions');
  // cursor.next is null on the final page; never forward a null/undefined
  // cursor back to the provider.
  const nextCursor = json.cursor?.next ?? null;
  return { items: json.items, nextCursor };
}

export async function akahuGetPendingTransactions(params: { accessToken: string; budget?: AkahuBudget }) {
  const appIdToken = requiredEnv('AKAHU_CLIENT_ID');
  const result = await fetchAkahu(
    'https://api.akahu.io/v1/transactions/pending',
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'X-Akahu-Id': appIdToken
      }
    },
    { kind: 'read', budget: params.budget }
  );

  return parseAkahuList<AkahuPendingTransaction>(result, '/transactions/pending').items;
}

// ---------------------------------------------------------------------------
// Cursor traversal over `akahuGetTransactions`, with cycle detection and a
// page cap. A repeated cursor or a hit page cap is reported as incomplete
// rather than treated as success; an empty final page (`cursor.next: null`)
// is the only completion signal.
// ---------------------------------------------------------------------------

export const AKAHU_TRANSACTIONS_PAGE_CAP = 50;

export async function paginateAkahuTransactions(params: {
  accessToken: string;
  startMs?: number;
  endMs?: number;
  budget?: AkahuBudget;
  pageCap?: number;
}): Promise<{ items: AkahuTransaction[]; complete: boolean; pagesFetched: number }> {
  const pageCap = params.pageCap ?? AKAHU_TRANSACTIONS_PAGE_CAP;
  const items: AkahuTransaction[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;

  while (true) {
    const page = await akahuGetTransactions({
      accessToken: params.accessToken,
      startMs: params.startMs,
      endMs: params.endMs,
      cursor,
      budget: params.budget
    });
    pagesFetched += 1;
    items.push(...page.items);

    if (page.nextCursor === null) {
      return { items, complete: true, pagesFetched };
    }

    if (seenCursors.has(page.nextCursor) || pagesFetched >= pageCap) {
      return { items, complete: false, pagesFetched };
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
