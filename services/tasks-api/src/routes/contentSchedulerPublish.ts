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

import type { ContentSchedulerItem } from '../../generated/prisma/index.js';

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
  | 'MISSING_CREDENTIALS'
  | 'NO_X_CLIENT';

export type PublishGuardResult =
  | { ok: true }
  | { ok: false; code: PublishGuardCode };

/**
 * Pure guard. Returns ok=false with a code if the item is not eligible
 * to publish right now. Reasons the guard can refuse:
 *  - status !== 'approved' → NOT_APPROVED (also covers already-published / removed)
 *  - scheduledFor > now + 60s → SCHEDULED_IN_FUTURE
 *  - today.publishedCount >= 1 (and the item isn't the existing one) → DAY_CAP_REACHED
 * The MISSING_CREDENTIALS / NO_X_CLIENT checks happen in the route, not here,
 * because they depend on process.env which is not safe to thread into a pure
 * function from a unit-test perspective.
 */
export function guardPublish(
  item: Pick<ContentSchedulerItem, 'status' | 'scheduledFor' | 'approvedAt'>,
  today: { publishedCount: number; publishedItemId?: string | null },
  now: Date = new Date()
): PublishGuardResult {
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
  createTweet(input: { text: string }): Promise<{ url: string; postedAt: Date }>;
}

/**
 * Deterministic fake used in dev/test. Generates a URL based on the SHA-256
 * prefix of the text so different inputs get different URLs but the same
 * input always produces the same URL.
 */
export class FakeXClient implements XClient {
  async createTweet({ text }: { text: string }): Promise<{ url: string; postedAt: Date }> {
    const { createHash } = await import('node:crypto');
    const id = createHash('sha256').update(text).digest('hex').slice(0, 16);
    return {
      url: `https://x.com/sindustries/status/${id}`,
      postedAt: new Date()
    };
  }
}

/**
 * Real client for production. Posts to api.twitter.com/2/tweets with bearer
 * auth. Wraps the fetch in a 10s timeout. Returns the URL the response
 * includes in `data.id` (i.e. https://x.com/<handle>/status/<id>).
 */
export class RealXClient implements XClient {
  constructor(
    private readonly bearerToken: string,
    private readonly handle: string = 'sindustries',
    private readonly timeoutMs: number = 10_000
  ) {}

  async createTweet({ text }: { text: string }): Promise<{ url: string; postedAt: Date }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch('https://api.twitter.com/2/tweets', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ text })
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
}

/**
 * Resolves the X client for the current process. Returns null when no
 * credentials are configured so the route can return a 503 with a clear
 * "missing credential" error.
 *
 * Selection rules (per tech design):
 *  - X_CLIENT=fake (default in dev/test): returns FakeXClient
 *  - X_CLIENT=real: requires X_API_BEARER_TOKEN; returns null otherwise
 *  - X_CLIENT unset: defaults to fake (returns FakeXClient)
 */
export function getXClient(): XClient | null {
  const kind = (process.env.X_CLIENT ?? 'fake').toLowerCase();
  if (kind === 'real') {
    const token = process.env.X_API_BEARER_TOKEN;
    if (!token) return null;
    const handle = process.env.X_HANDLE ?? 'sindustries';
    return new RealXClient(token, handle);
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