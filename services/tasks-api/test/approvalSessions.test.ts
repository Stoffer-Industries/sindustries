import crypto from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = { approvalSession: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() } };
vi.mock('../src/lib/prisma.ts', () => ({ prisma: db }));
const { createApp } = await import('../src/app.ts');
function hash(password: string) { const salt = Buffer.from('session-test-salt'); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 32).toString('hex')}`; }
describe('approval browser sessions', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.TASKS_API_APPROVAL_USERS = JSON.stringify([{ username: 'tom', actor: 'Tom', passwordHash: hash('correct horse') }]); });
  it('verifies password, persists only token hash, and sets protected cookie', async () => {
    db.approvalSession.create.mockResolvedValue({});
    const res = await request(createApp()).post('/api/v1/auth/session').send({ username: 'tom', password: 'correct horse' });
    expect(res.status).toBe(201); expect(res.body.data.actor).toBe('Tom');
    expect(res.headers['set-cookie'][0]).toMatch(/tasks_api_session=.*HttpOnly.*SameSite=Lax/);
    const data = db.approvalSession.create.mock.calls[0][0].data;
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/); expect(data).not.toHaveProperty('token');
  });
  it('rejects an invalid password without creating a session', async () => {
    const res = await request(createApp()).post('/api/v1/auth/session').send({ username: 'tom', password: 'wrong' });
    expect(res.status).toBe(401); expect(db.approvalSession.create).not.toHaveBeenCalled();
  });
  it('returns the current durable session', async () => {
    db.approvalSession.findUnique.mockResolvedValue({ actor: 'Tom', expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    const res = await request(createApp()).get('/api/v1/auth/session').set('Cookie', 'tasks_api_session=opaque-token');
    expect(res.status).toBe(200); expect(res.body.data.actor).toBe('Tom');
  });
  it('rejects expired and revoked sessions', async () => {
    db.approvalSession.findUnique.mockResolvedValue({ actor: 'Tom', expiresAt: new Date(Date.now() - 1), revokedAt: null });
    expect((await request(createApp()).get('/api/v1/auth/session').set('Cookie', 'tasks_api_session=expired')).status).toBe(401);
  });
  it('revokes logout idempotently and clears the cookie', async () => {
    db.approvalSession.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(createApp()).delete('/api/v1/auth/session').set('Cookie', 'tasks_api_session=opaque-token');
    expect(res.status).toBe(204); expect(db.approvalSession.updateMany).toHaveBeenCalled(); expect(res.headers['set-cookie'][0]).toMatch(/tasks_api_session=;/);
  });
});
