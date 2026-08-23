// Content Scheduler publish helpers.
//
// Pure logic (guardPublish) and an X client interface used by the
// /content-scheduler/items/:id/publish endpoint. The fake client is the
// default for dev/test; the real client posts to api.twitter.com/2/tweets
// when X_CLIENT=real is set. There is no automatic cron publishing — Tom
// clicks Publish manually per item.
//
// Task: 115e8d89-be43-4b81-9e0e-9ab422810f5f
// Tech design: docs/specs/content-scheduler-tab-tech-design.md

import type { ContentSchedulerItem } from '@prisma/client';

/**
 * Status values that block edits/removes/reorder. Mirrors the route-level
 * 409 responses in contentScheduler.ts.
 */
export const TERMINAL_STATUSES = ['published', 'removed'] as const;

/**
 * Items the publish endpoint refuses with a structured error code.
 * Each branch has a paired test in contentScheduler.test.ts.
 */
export type PublishGuardCode =
  | 'NOT_APPROVED'
  | 'ALREADY_PUBLISHED'
  | 'DAY_CAP_REACHED'
  | 'SCHEDULED_IN_FUTURE'
  | 'MANUAL_REPLY_NOT_PUBLISHABLE'
  | 'MISSING_CREDENTIALS'
  | 'NO_X_CLIENT';

export type PublishGuardResult =
  | { ok: true }
  | { ok: false; code: PublishGuardCode };

/**
 * Pure guard. Returns ok=false with a code if the item is not eligible
 * to publish right now. Reasons the guard can refuse:
 *  - kind === 'manual_reply' → MANUAL_REPLY_NOT_PUBLISHABLE (task 5279b310;
 *    manual-reply drafts are never auto-published and must be posted by
 *    Tom manually with the URL captured via PATCH /items/:id/posted-url)
 *  - status !== 'approved' → NOT_APPROVED (also covers already-published / removed)
 *  - scheduledFor > now + 60s → SCHEDULED_IN_FUTURE
 *  - today.publishedCount >= 1 (and the item isn't the existing one) → DAY_CAP_REACHED
 * The MISSING_CREDENTIALS / NO_X_CLIENT checks happen in the route, not here,
 * because they depend on process.env which is not safe to thread into a pure
 * function from a unit-test perspective.
 */
export function guardPublish(
  item: Pick<ContentSchedulerItem, 'status' | 'scheduledFor' | 'approvedAt' | 'kind'>,
  today: { publishedCount: number; publishedItemId?: string | null },
  now: Date = new Date()
): PublishGuardResult {
  // kind is non-nullable with a schema default of 'scheduled', so legacy
  // callers that pre-date the manual_reply addition always see 'scheduled'
  // via Prisma's column default. Treat undefined defensively in case a test
  // fixture still builds an item without the field.
  if ((item.kind ?? 'scheduled') === 'manual_reply') {
    return { ok: false, code: 'MANUAL_REPLY_NOT_PUBLISHABLE' };
  }
  if (item.status === 'published') {
    return { ok: false, code: 'ALREADY_PUBLISHED' };
  }
  if (item.status !== 'approved' || !item.approvedAt) {
    return { ok: false, code: 'NOT_APPROVED' };
  }
  if (item.scheduledFor) {
    const graceMs = 60_000;
    if (item.scheduledFor.getTime() - now.getTime() > graceMs) {
      return { ok: false, code: 'SCHEDULED_IN_FUTURE' };
    }
  }
  if (
    today.publishedCount >= 1 &&
    today.publishedItemId !== undefined &&
    today.publishedItemId !== null
  ) {
    return { ok: false, code: 'DAY_CAP_REACHED' };
  }
  return { ok: true };
}

/**
 * Tiny X client interface. Implementations post a tweet and return the
 * canonical URL + postedAt timestamp. The fake client returns deterministic
 * URLs so dev/test flows have stable assertions.
 */
export interface XClient {
  createTweet(input: { text: string; in_reply_to_tweet_id?: string }): Promise<{ url: string; postedAt: Date }>;
  /**
   * Resolve the @handle of a tweet's author from its numeric status id.
   * Returns null when the tweet doesn't exist / isn't visible (e.g. deleted,
   * protected). Used to reply to bookmarks whose saved link is a generic
   * `x.com/i/web/status/<id>` share URL that doesn't carry the author's
   * handle in the path.
   */
  getTweetAuthor(tweetId: string): Promise<{ handle: string } | null>;
}

/**
 * Deterministic fake used in dev/test. Generates a URL based on the SHA-256
 * prefix of the text so different inputs get different URLs but the same
 * input always produces the same URL.
 */
export class FakeXClient implements XClient {
  async createTweet(input: { text: string; in_reply_to_tweet_id?: string }): Promise<{ url: string; postedAt: Date }> {
    const { createHash } = await import('node:crypto');
    // Deterministic URL: hash of (text + reply id) so the same (text, reply)
    // pair always yields the same URL while keeping different inputs
    // distinguishable. Existing callers pass no reply id and continue to
    // produce the original behaviour.
    const seed = input.in_reply_to_tweet_id ? `${input.text}\u0001${input.in_reply_to_tweet_id}` : input.text;
    const id = createHash('sha256').update(seed).digest('hex').slice(0, 16);
    return {
      url: `https://x.com/sindustries/status/${id}`,
      postedAt: new Date()
    };
  }

  async getTweetAuthor(tweetId: string): Promise<{ handle: string } | null> {
    const { createHash } = await import('node:crypto');
    // Deterministic fake handle so dev/test flows have stable assertions.
    const digest = createHash('sha256').update(tweetId).digest('hex').slice(0, 8);
    return { handle: `fake_author_${digest}` };
  }
}

/**
 * Real client for production. Posts to api.twitter.com/2/tweets using
 * OAuth 1.0a User Context (the only auth type X permits for creating tweets).
 * Requires X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET.
 */
export class RealXClient implements XClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly accessToken: string,
    private readonly accessTokenSecret: string,
    private readonly handle: string = 'sindustries',
    private readonly timeoutMs: number = 10_000
  ) {}

  // `signedParams` are the OAuth1.0a "request parameters" that get folded
  // into the signature base string alongside the oauth_* params — i.e.
  // the URL query string (GET) or an application/x-www-form-urlencoded
  // body (POST). Per the OAuth1.0a spec, parameters from a *non*
  // form-urlencoded body (our POSTs are JSON) are NOT request parameters
  // and must NOT be signed. Callers with a JSON body must pass {} here;
  // passing the JSON payload's fields breaks the signature and X returns
  // a generic 401 Unauthorized with no indication the body caused it.
  private async oauthHeader(method: string, url: string, signedParams: Record<string, string>): Promise<string> {
    const { createHmac } = await import('node:crypto');

    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: timestamp,
      oauth_token: this.accessToken,
      oauth_version: '1.0'
    };

    const allParams = { ...oauthParams, ...signedParams };
    const paramString = Object.keys(allParams)
      .sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
      .join('&');

    const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramString)].join('&');
    const signingKey = `${encodeURIComponent(this.apiSecret)}&${encodeURIComponent(this.accessTokenSecret)}`;
    const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

    const headerParams = { ...oauthParams, oauth_signature: signature };
    const headerString = Object.keys(headerParams)
      .sort()
      .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(headerParams[k])}"`)
      .join(', ');

    return `OAuth ${headerString}`;
  }

  async createTweet(input: { text: string; in_reply_to_tweet_id?: string }): Promise<{ url: string; postedAt: Date }> {
    const url = 'https://api.twitter.com/2/tweets';
    const body: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text: input.text };
    if (input.in_reply_to_tweet_id) {
      body.reply = { in_reply_to_tweet_id: input.in_reply_to_tweet_id };
    }
    // JSON body — no signed params (see oauthHeader comment above).
    const authorization = await this.oauthHeader('POST', url, {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: { id?: string } };
      const id = json?.data?.id;
      if (!id) {
        throw new Error('X API returned no tweet id');
      }
      return {
        url: `https://x.com/${this.handle}/status/${id}`,
        postedAt: new Date()
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async getTweetAuthor(tweetId: string): Promise<{ handle: string } | null> {
    const url = `https://api.twitter.com/2/tweets/${encodeURIComponent(tweetId)}`;
    // GET query-string params are OAuth1.0a "request parameters" and must
    // be signed, unlike a JSON POST body (see oauthHeader comment above).
    const queryParams: Record<string, string> = {
      expansions: 'author_id',
      'user.fields': 'username'
    };
    const authorization = await this.oauthHeader('GET', url, queryParams);
    const query = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${url}?${query}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { authorization }
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        includes?: { users?: Array<{ username?: string }> };
      };
      const username = json?.includes?.users?.[0]?.username;
      return username ? { handle: username } : null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolves the X client for the current process. Returns null when no
 * credentials are configured so the route can return a 503 with a clear
 * "missing credential" error.
 *
 * Selection rules:
 *  - X_CLIENT=fake (default in dev/test): returns FakeXClient
 *  - X_CLIENT=real: requires X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
 *    X_ACCESS_TOKEN_SECRET; returns null if any are missing
 *  - X_CLIENT unset: defaults to fake
 */
// getXClient reads X_CLIENT/X_API_KEY/etc. from process.env at call time
// rather than the parsed config snapshot. Tests toggle these values per
// case to exercise both branches; in production they are set once at
// boot and the config schema (src/config/env.ts) validates the X_CLIENT=real
// contract — missing OAuth credentials at boot are a ConfigValidationError,
// not a silent null from this function.
export function getXClient(): XClient | null {
  const kind = (process.env.X_CLIENT ?? 'fake').toLowerCase();
  if (kind === 'real') {
    const apiKey = process.env.X_API_KEY;
    const apiSecret = process.env.X_API_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return null;
    const handle = process.env.X_HANDLE ?? 'sindustries';
    return new RealXClient(apiKey, apiSecret, accessToken, accessTokenSecret, handle);
  }
  return new FakeXClient();
}

/**
 * "Today" in Pacific/Auckland for the daily-cap check. Returns the date
 * portion as 'YYYY-MM-DD' along with the day-boundary Date objects so the
 * route can run a single timestamped query.
 */
export function getAucklandTodayParts(now: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const date = `${lookup.year}-${lookup.month}-${lookup.day}`;

  // Compute the UTC bounds for that NZ-local calendar day.
  // We binary-search for the start by stepping back from now until the
  // formatter yields a different day; then for end we add 24h and repeat.
  const startUtc = startOfAucklandDay(now);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { date, startUtc, endUtc };
}

function startOfAucklandDay(now: Date): Date {
  // Walk back from now until the day string flips. Bounded to 25 hours.
  const formatter = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const currentDay = formatter.format(now);
  let cursor = now.getTime();
  for (let i = 0; i < 25 * 60; i += 1) {
    cursor -= 60_000;
    if (formatter.format(new Date(cursor)) !== currentDay) {
      // step forward 1 minute to the start of currentDay
      return new Date(cursor + 60_000);
    }
  }
  // Fallback: return now (should never hit given bounded loop).
  return now;
}

/**
 * Manual publish gate — protects `POST /content-scheduler/items/:id/publish`
 * (the real-X write path) when `X_ACTOR_SECRET` is configured.
 *
 * Behavior matrix:
 *  - X_ACTOR_SECRET unset → pass-through (dev / local / CI without the secret
 *    stays usable; behavior documented in services/tasks-api/.env.example).
 *  - X_ACTOR_SECRET set + header missing → 401 UNAUTHORIZED before any X call.
 *  - X_ACTOR_SECRET set + header present + match → pass-through.
 *  - X_ACTOR_SECRET set + header present + mismatch → 401 UNAUTHORIZED.
 *
 * Comparison uses `crypto.timingSafeEqual` on equal-length buffers to avoid
 * leaking the secret via response-time differences. The header value and
 * the env var are both normalized to UTF-8 before comparison.
 *
 * This gate is **only** applied to the manual publish route. The auto-post
 * worker calls `publishContentSchedulerItem` directly with `actor='auto'`
 * and is intentionally not gated here — the worker is an in-process queue
 * consumer that already runs inside a trusted boundary.
 *
 * Task: 38d2ee65-a6c0-4952-a8ca-ad03d4856eb1
 * Tech design: docs/specs/cloud-readiness-x-publish-actor-secret-tech-design.md
 */
export type ActorSecretGuard =
  | { ok: true; configured: false }
  | { ok: true; configured: true }
  | { ok: false; reason: 'MISSING_HEADER' | 'MISMATCH' };

/**
 * Pure check. Reads the expected secret from `process.env.X_ACTOR_SECRET`
 * and the provided header from the caller. Returns whether the gate should
 * allow the request through.
 *
 * Pure (no Express coupling) so the unit tests can drive it without spinning
 * up the app. The route wrapper below maps a `false` result to a 401.
 */
/**
 * Pure check. Reads the expected secret from `process.env.X_ACTOR_SECRET`
 * and the provided header from the caller. Returns whether the gate should
 * allow the request through.
 *
 * Pure (no Express coupling) so the unit tests can drive it without spinning
 * up the app. The route wrapper below maps a `false` result to a 401.
 *
 * Reads `process.env` at call time rather than from the parsed `config`
 * snapshot so the gate reflects the current environment. The config
 * validation in `src/config/env.ts` shapes the contract (X_ACTOR_SECRET
 * must be at least 32 chars when set); this function is the runtime check.
 */
export function checkActorSecret(providedHeader: string | undefined | null): ActorSecretGuard {
  const expected = process.env.X_ACTOR_SECRET;
  if (!expected || expected.length === 0) {
    // Dev / local / CI mode — gate is disabled by configuration.
    return { ok: true, configured: false };
  }
  if (typeof providedHeader !== 'string' || providedHeader.length === 0) {
    return { ok: false, reason: 'MISSING_HEADER' };
  }
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(providedHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'MISMATCH' };
  }
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  const equal = timingSafeEqual(expectedBuf, providedBuf);
  return equal ? { ok: true, configured: true } : { ok: false, reason: 'MISMATCH' };
}