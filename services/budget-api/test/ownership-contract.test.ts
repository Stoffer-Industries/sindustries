import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    session: { findUnique: vi.fn() },
    linkedCard: { findUnique: vi.fn() },
    cardMonthlyBudget: { findUnique: vi.fn(), upsert: vi.fn() },
    transaction: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn()
    },
    notificationEvent: { findUnique: vi.fn(), delete: vi.fn() },
    balanceAlertConfig: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    accountBalanceSnapshot: { findMany: vi.fn() },
    categorizationFeedback: { create: vi.fn() }
  }
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));
vi.mock('../src/services/categorizer.ts', () => ({
  categorizeTransaction: vi.fn(),
  categoryTaxonomy: []
}));

import { createApp } from '../src/app';
import { hashSessionToken } from '../src/auth/session';

/**
 * Ownership contract test (task f39a20a7, audit W29 Theme 1 / Milestone 1-B).
 *
 * After PR #316 (sessions middleware, task ec42d3a1) lands, the auth-contract
 * test (services/budget-api/test/auth-contract.test.ts) covers the bare 401
 * gate. This file covers the second half of the auth contract: **with a valid
 * session, the same user can read/mutate the resource and a different user
 * cannot.** That coverage is AC5 of task f39a20a7.
 *
 * AC4 text note: the task description says "Cross-user access returns 403",
 * but the production code returns 404 on cross-user access for every guarded
 * route to avoid information-leak (don't disclose the existence of a record
 * the caller can't see). This file asserts the actual behaviour (404) and
 * surfaces the discrepancy in the test name; the task description amendment
 * is a separate concern owned by Tom.
 */

const USER_1 = 'user_1';
const USER_2 = 'user_2';
const SESSION_1 = { id: 'session_1', userId: USER_1 };
const SESSION_2 = { id: 'session_2', userId: USER_2 };
const TOKEN_USER_1 = 'task-f39a20a7-token-user-1';
const TOKEN_USER_2 = 'task-f39a20a7-token-user-2';
const HASH_USER_1 = hashSessionToken(TOKEN_USER_1);
const HASH_USER_2 = hashSessionToken(TOKEN_USER_2);

const CARD_1 = {
  id: 'card_1',
  userId: USER_1,
  displayName: 'Everyday account',
  provider: 'akahu',
  providerCardId: 'acc_1'
};

const ALERT_1 = {
  id: 'alert_1',
  userId: USER_1,
  type: 'warning80',
  title: '80% of monthly budget',
  body: 'You are close to your limit',
  createdAt: new Date('2026-04-15T00:00:00.000Z')
};

const CONFIG_1 = {
  id: 'config_1',
  cardId: CARD_1.id,
  userId: USER_1,
  condition: 'more-than',
  thresholdCents: 10_000,
  pushEnabled: true,
  emailEnabled: false
};

const TXN_1 = {
  id: 'txn_1',
  userId: USER_1,
  cardId: CARD_1.id,
  merchant: 'Acme',
  description: 'Acme purchase',
  amountCents: 1500,
  category: 'shopping',
  categorySource: 'model',
  categoryConfidence: 0.8
};

describe('budget-api ownership contract (task f39a20a7) — same-user success + cross-user denial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AKAHU_DEV_USER_ACCESS_TOKEN = '';

    // Session lookup: each token resolves to its owner.
    mocks.prisma.session.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.tokenHash === HASH_USER_1) return SESSION_1;
      if (args?.where?.tokenHash === HASH_USER_2) return SESSION_2;
      return null;
    });

    // Default: every record exists and is owned by USER_1. Individual tests
    // override these to exercise the cross-user (USER_2) and missing-record
    // (null) branches.
    mocks.prisma.linkedCard.findUnique.mockResolvedValue(CARD_1);
    mocks.prisma.notificationEvent.findUnique.mockResolvedValue(ALERT_1);
    mocks.prisma.balanceAlertConfig.findUnique.mockResolvedValue(CONFIG_1);
    mocks.prisma.balanceAlertConfig.upsert.mockResolvedValue(CONFIG_1);
    mocks.prisma.balanceAlertConfig.delete.mockResolvedValue(CONFIG_1);
    mocks.prisma.transaction.findUnique.mockResolvedValue(TXN_1);
    mocks.prisma.transaction.update.mockResolvedValue({
      ...TXN_1,
      category: 'dining',
      categorySource: 'manual',
      categoryConfidence: 1
    });
    mocks.prisma.cardMonthlyBudget.upsert.mockResolvedValue({
      id: 'budget_1',
      cardId: CARD_1.id,
      userId: USER_1,
      month: '2026-04',
      monthlyLimitCents: 50_000
    });
    mocks.prisma.cardMonthlyBudget.findUnique.mockResolvedValue(null);
    mocks.prisma.transaction.findMany.mockResolvedValue([]);
    mocks.prisma.notificationEvent.delete.mockResolvedValue(ALERT_1);
    mocks.prisma.accountBalanceSnapshot.findMany.mockResolvedValue([]);
    mocks.prisma.categorizationFeedback.create.mockResolvedValue({});
  });

  // ─── Cards ─────────────────────────────────────────────────────────────────

  describe('POST /cards/:cardId/budget — AC1', () => {
    it('returns 200 for the card owner', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1.id}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(200);
      expect(res.body.budget).toMatchObject({ cardId: CARD_1.id });
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1.id}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(mocks.prisma.cardMonthlyBudget.upsert).not.toHaveBeenCalled();
    });

    it('returns 404 when the card does not exist', async () => {
      mocks.prisma.linkedCard.findUnique.mockResolvedValue(null);
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1.id}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(404);
      expect(mocks.prisma.cardMonthlyBudget.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /cards/:cardId/spend-summary — AC1', () => {
    it('returns 200 with the spend payload for the card owner', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1.id}/spend-summary`)
        .query({ month: '2026-04' })
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body.cardId).toBe(CARD_1.id);
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1.id}/spend-summary`)
        .query({ month: '2026-04' })
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
      expect(mocks.prisma.transaction.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── Alert config ──────────────────────────────────────────────────────────

  describe('GET /cards/:cardId/alert-config — AC1', () => {
    it('returns 200 with the config for the card owner', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1.id}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({ cardId: CARD_1.id, condition: 'more-than' });
    });

    it('returns 200 with {config: null} for a different session user (no info-leak of record existence)', async () => {
      const res = await request(createApp())
        .get(`/api/v1/cards/${CARD_1.id}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      // Spec: don't disclose presence of an alert config. Return config:null.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ config: null });
    });
  });

  describe('POST /cards/:cardId/alert-config — AC1', () => {
    it('returns 200 for the card owner', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1.id}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ condition: 'more-than', thresholdCents: 10_000 });
      expect(res.status).toBe(200);
      expect(res.body.config).toMatchObject({ cardId: CARD_1.id });
      expect(mocks.prisma.balanceAlertConfig.upsert).toHaveBeenCalledTimes(1);
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1.id}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ condition: 'more-than', thresholdCents: 10_000 });
      expect(res.status).toBe(404);
      expect(mocks.prisma.balanceAlertConfig.upsert).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /cards/:cardId/alert-config — AC1', () => {
    it('returns 200 for the card owner', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/cards/${CARD_1.id}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mocks.prisma.balanceAlertConfig.delete).toHaveBeenCalledTimes(1);
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/cards/${CARD_1.id}/alert-config`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
      expect(mocks.prisma.balanceAlertConfig.delete).not.toHaveBeenCalled();
    });
  });

  // ─── Alerts ────────────────────────────────────────────────────────────────

  describe('DELETE /alerts/:alertId — AC2', () => {
    it('returns 200 for the alert owner', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${ALERT_1.id}`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mocks.prisma.notificationEvent.delete).toHaveBeenCalledTimes(1);
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${ALERT_1.id}`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
      expect(mocks.prisma.notificationEvent.delete).not.toHaveBeenCalled();
    });

    it('returns 404 when the alert does not exist', async () => {
      mocks.prisma.notificationEvent.findUnique.mockResolvedValue(null);
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${ALERT_1.id}`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`);
      expect(res.status).toBe(404);
      expect(mocks.prisma.notificationEvent.delete).not.toHaveBeenCalled();
    });
  });

  // ─── Transactions ──────────────────────────────────────────────────────────

  describe('PATCH /transactions/:transactionId/category — AC3', () => {
    it('returns 200 for the transaction owner', async () => {
      const res = await request(createApp())
        .patch(`/api/v1/transactions/${TXN_1.id}/category`)
        .set('Authorization', `Bearer ${TOKEN_USER_1}`)
        .send({ category: 'dining' });
      expect(res.status).toBe(200);
      expect(res.body.transaction).toMatchObject({ id: TXN_1.id, category: 'dining' });
      expect(mocks.prisma.transaction.update).toHaveBeenCalledTimes(1);
    });

    it('returns 404 (no info-leak) for a different session user', async () => {
      const res = await request(createApp())
        .patch(`/api/v1/transactions/${TXN_1.id}/category`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ category: 'dining' });
      expect(res.status).toBe(404);
      expect(mocks.prisma.transaction.update).not.toHaveBeenCalled();
    });
  });

  // ─── AC4 — cross-user access does not reveal or mutate ─────────────────────

  describe('AC4: cross-user access does not mutate nor reveal the resource', () => {
    it('a different session user cannot upsert a budget (write side-effect blocked)', async () => {
      const res = await request(createApp())
        .post(`/api/v1/cards/${CARD_1.id}/budget`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ monthlyLimitCents: 50_000 });
      expect(res.status).toBe(404);
      expect(mocks.prisma.cardMonthlyBudget.upsert).not.toHaveBeenCalled();
    });

    it('a different session user cannot delete an alert (write side-effect blocked)', async () => {
      const res = await request(createApp())
        .delete(`/api/v1/alerts/${ALERT_1.id}`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`);
      expect(res.status).toBe(404);
      expect(mocks.prisma.notificationEvent.delete).not.toHaveBeenCalled();
    });

    it('a different session user cannot recategorize a transaction (write side-effect blocked)', async () => {
      const res = await request(createApp())
        .patch(`/api/v1/transactions/${TXN_1.id}/category`)
        .set('Authorization', `Bearer ${TOKEN_USER_2}`)
        .send({ category: 'dining' });
      expect(res.status).toBe(404);
      expect(mocks.prisma.transaction.update).not.toHaveBeenCalled();
    });
  });
});
