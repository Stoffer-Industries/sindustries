import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { hashSessionToken } from '../src/auth/session';
import { prisma } from '../src/lib/prisma';

/**
 * Real-DB ownership contract integration test (task 1eb22a09, audit W38 T0/F4).
 *
 * Closes the audit gap where the existing mocked `ownership-contract.test.ts`
 * (`services/budget-api/test/ownership-contract.test.ts:1`) blanket-mocks
 * `prisma` via `vi.mock('../src/lib/prisma.ts')`. With the prisma module
 * replaced wholesale, a real bug in the Prisma layer — a mistyped field, a
 * missing `where`, a broken transaction boundary — silently passes CI. This
 * file calls the same `createApp()` boundary the mocked test exercises, but
 * against the actual Postgres service CI provisions, so the ownership
 * contract is verified against the real database the budget-api is designed
 * to run against.
 *
 * Self-skip gate: the file only runs when `BUDGET_API_INTEGRATION_TEST === '1'`.
 * The renamed `budget-api-unit` job deliberately does NOT set this env var,
 * so `npm test` locally (and in unit CI) skips this file. The sibling
 * `budget-api-db-integration` job sets the env var so the test runs there.
 *
 * CI Postgres service is throwaway (one container per job), so `TRUNCATE …
 * CASCADE` is safe; no other job shares this database. If a future CI
 * topology change shares the Postgres service across jobs, this test's
 * truncate would erase data mid-run — keep that constraint in mind.
 */

// Stable user UUIDs so that re-runs against the same DB (rare but possible
// during local debugging) don't conflict on the unique email constraint.
// The CI service is throwaway, but local devs running this against a long-
// lived DB benefit from stable ids.
const USER_1_ID = '11111111-1111-1111-1111-111111111111';
const USER_2_ID = '22222222-2222-2222-2222-222222222222';

const CARD_1_ID = '11111111-aaaa-bbbb-cccc-000000000001';
const CARD_2_ID = '22222222-aaaa-bbbb-cccc-000000000002';

// Per-run random token suffixes keep the `session.tokenHash` unique across
// reruns (the column is @unique). The SHA-256 hash is deterministic, but
// the input token varies so we never collide with a prior run's row.
const TOKEN_USER_1 = `task-1eb22a09-it-user-1-${crypto.randomBytes(8).toString('hex')}`;
const TOKEN_USER_2 = `task-1eb22a09-it-user-2-${crypto.randomBytes(8).toString('hex')}`;
const HASH_USER_1 = hashSessionToken(TOKEN_USER_1);
const HASH_USER_2 = hashSessionToken(TOKEN_USER_2);

const TXN_1_ID = '11111111-eeee-eeee-eeee-000000000001';
const ALERT_1_ID = '11111111-ffff-ffff-ffff-000000000001';

const ENABLED = process.env.BUDGET_API_INTEGRATION_TEST === '1';

// Stub Akahu's outbound HTTP layer at the network edge. Any route handler
// that calls `fetch(...)` against api.akahu.io / oauth.akahu.nz gets a
// benign empty success response, so the test never hits the real network.
// Mirrors the pattern already used in `services/budget-api/test/akahuClient.test.ts:12`.
function stubAkahuFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      // List endpoints return an empty Akahu-shaped envelope so any handler
      // iterating `items` sees an empty array rather than crashing on a
      // missing field.
      if (
        url.includes('/v1/accounts') ||
        url.includes('/v1/cards') ||
        url.includes('/v1/transactions')
      ) {
        return new Response(JSON.stringify({ success: true, items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // Action endpoints (refresh, exchange, etc.) get a generic success.
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    })
  );
}

// describe.skip when the integration env var is unset so this file is a
// no-op in unit CI and local `npm test` runs.
const d = ENABLED ? describe : describe.skip;

d('budget-api ownership contract — real Postgres (task 1eb22a09)', () => {
  beforeAll(async () => {
    // Reset every domain table. CI Postgres is throwaway, so a full
    // CASCADE truncate is the simplest correct primitive. Order is
    // leaf-first so foreign keys resolve cleanly even without CASCADE,
    // but CASCADE makes the order irrelevant.
    // Tables are schema-qualified (`budget_api."PascalCase"`) because the
    // migration set puts every Prisma model in the `budget_api` schema and
    // uses quoted PascalCase identifiers. Without the schema prefix Postgres
    // looks in `public`; without the correct casing the lookup is case-
    // sensitive (the catalog preserves the quoted PascalCase form).
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "budget_api"."CategorizationFeedback",
        "budget_api"."BalanceAlertConfig",
        "budget_api"."NotificationEvent",
        "budget_api"."CardMonthlyBudget",
        "budget_api"."Transaction",
        "budget_api"."AccountBalanceSnapshot",
        "budget_api"."AkahuConnection",
        "budget_api"."LinkedCard",
        "budget_api"."Session",
        "budget_api"."User"
      RESTART IDENTITY CASCADE
    `);

    await prisma.user.createMany({
      data: [
        { id: USER_1_ID, email: 'it-user-1@budget-api.test' },
        { id: USER_2_ID, email: 'it-user-2@budget-api.test' }
      ]
    });

    await prisma.session.createMany({
      data: [
        { userId: USER_1_ID, tokenHash: HASH_USER_1 },
        { userId: USER_2_ID, tokenHash: HASH_USER_2 }
      ]
    });

    await prisma.linkedCard.createMany({
      data: [
        {
          id: CARD_1_ID,
          userId: USER_1_ID,
          provider: 'akahu',
          providerCardId: 'acc_user_1',
          displayName: 'Everyday account'
        },
        {
          id: CARD_2_ID,
          userId: USER_2_ID,
          provider: 'akahu',
          providerCardId: 'acc_user_2',
          displayName: 'Everyday account'
        }
      ]
    });

    await prisma.transaction.create({
      data: {
        id: TXN_1_ID,
        userId: USER_1_ID,
        cardId: CARD_1_ID,
        provider: 'akahu',
        providerTransactionId: `prov-${TXN_1_ID}`,
        occurredAt: new Date('2026-04-15T00:00:00.000Z'),
        merchant: 'Acme',
        description: 'Acme purchase',
        amountCents: 1500,
        direction: 'debit',
        category: 'shopping',
        categorySource: 'model',
        categoryConfidence: 0.8
      }
    });

    await prisma.notificationEvent.create({
      data: {
        id: ALERT_1_ID,
        userId: USER_1_ID,
        type: 'warning80',
        title: '80% of monthly budget',
        body: 'You are close to your limit',
        dedupeKey: `task-1eb22a09-alert-${ALERT_1_ID}`
      }
    });

    stubAkahuFetch();
  });

  beforeEach(() => {
    // Re-stub the fetch global in case a prior test (or Vitest's module
    // reset between tests) unstubs it. The Akahu stub is the same shape
    // for every test in this file, so a single shared implementation
    // suffices.
    stubAkahuFetch();
  });

  // No afterEach cleanup. The beforeAll TRUNCATE + seed is sufficient
  // because every test uses stable fixture IDs (USER_1_ID, CARD_1_ID,
  // TXN_1_ID, ALERT_1_ID) and the route handlers under test don't
  // depend on per-test ordering of those fixtures. An earlier version
  // of this suite ran a per-test TRUNCATE here that — once the snake-
  // case identifier bug was fixed — actually succeeded and wiped the
  // shared seed rows that downstream tests (AC5/AC6/AC7) depend on.
  // Removing the wipe keeps every test running against the complete
  // dataset. If a future test mutates a fixture other tests need,
  // re-seed that fixture in that test rather than reintroducing a
  // global afterEach wipe.

  // ─── Cards: budget ─────────────────────────────────────────────────────────

  describe('POST /cards/:cardId/budget — AC1', () => {
    it('returns 200 for the card owner', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1_ID}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(200);
      expect(res.body.budget).toMatchObject({ cardId: CARD_1_ID });
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1_ID}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when the card does not exist', async () => {
      const missing = '00000000-aaaa-bbbb-cccc-000000000000';
      const res = await request(createApp())
        .post(`/api/v1/cards/${missing}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(404);
    });
  });

  // ─── Cards: spend summary ──────────────────────────────────────────────────

  describe('GET /cards/:cardId/spend-summary — AC2', () => {
    it('returns 200 with the spend payload for the card owner', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1_ID}/spend-summary`)
        .query({ month: '2026-04' })
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body.cardId).toBe(CARD_1_ID);
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1_ID}/spend-summary`)
        .query({ month: '2026-04' })
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Cards: alert config ───────────────────────────────────────────────────

  describe('GET /cards/:cardId/alert-config — AC3', () => {
    it('returns 200 with the config for the card owner (null when unset)', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1_ID}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      // Per audit W29 Theme 1 / Milestone 1-B: absence of a config row is
      // surfaced as `config: null` to avoid leaking record existence.
      expect(res.body).toEqual({ config: null });
    });

    it('returns 200 with {config: null} for a different session user (no info-leak)', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1_ID}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ config: null });
    });
  });

  describe('POST /cards/:cardId/alert-config — AC4', () => {
    it('returns 200 for the card owner', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1_ID}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ condition: 'more-than', thresholdCents: 10_000 });
      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({
        cardId: CARD_1_ID,
        condition: 'more-than',
        thresholdCents: 10_000
      });
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1_ID}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ condition: 'more-than', thresholdCents: 10_000 });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /cards/:cardId/alert-config — AC5', () => {
    it('returns 200 for the card owner', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/cards/${CARD_1_ID}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/cards/${CARD_1_ID}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Alerts ────────────────────────────────────────────────────────────────

  describe('DELETE /alerts/:alertId — AC6', () => {
    it('returns 200 for the alert owner', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${ALERT_1_ID}`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${ALERT_1_ID}`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when the alert does not exist', async () => {
      const missing = '00000000-ffff-ffff-ffff-000000000000';
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${missing}`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Transactions ──────────────────────────────────────────────────────────

  describe('PATCH /transactions/:transactionId/category — AC7', () => {
    it('returns 200 for the transaction owner', async () => {
      const res = await request(createApp())
        .patch(`/api/v1/transactions/${TXN_1_ID}/category`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ category: 'dining' });
      expect(res.status).toBe(200);
      expect(res.body.transaction).toMatchObject({
        id: TXN_1_ID,
        category: 'dining'
      });
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .patch(`/api/v1/transactions/${TXN_1_ID}/category`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ category: 'dining' });
      expect(res.status).toBe(404);
    });
  });
});
