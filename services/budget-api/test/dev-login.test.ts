import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    session: { create: vi.fn() }
  }
}));

vi.mock('../src/lib/prisma.ts', () => ({ prisma: mocks.prisma }));

import { createApp } from '../src/app';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('POST /api/v1/session/dev-login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('returns 404 outside local development (NODE_ENV=production)', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(createApp())
      .post('/api/v1/session/dev-login')
      .send({ email: 'dev@example.com' });

    expect(res.status).toBe(404);
    // Staging/production must never touch the DB for this route.
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
    expect(mocks.prisma.session.create).not.toHaveBeenCalled();
  });

  it('returns 404 outside local development (NODE_ENV=test)', async () => {
    // Staging runs NODE_ENV=production, but the guard must also reject
    // the in-process test environment when the route is hit directly.
    process.env.NODE_ENV = 'test';
    const res = await request(createApp())
      .post('/api/v1/session/dev-login')
      .send({ email: 'dev@example.com' });

    expect(res.status).toBe(404);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('mints a session in NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    mocks.prisma.user.create.mockResolvedValue({
      id: 'user_dev_1',
      email: 'dev@example.com'
    });
    mocks.prisma.session.create.mockResolvedValue({ id: 'session_dev_1' });

    const res = await request(createApp())
      .post('/api/v1/session/dev-login')
      .send({ email: 'dev@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token: expect.any(String),
      user: { id: 'user_dev_1', email: 'dev@example.com' }
    });
    expect(mocks.prisma.user.create).toHaveBeenCalled();
    expect(mocks.prisma.session.create).toHaveBeenCalled();
  });

  it('returns 400 when email is missing in NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';

    const res = await request(createApp())
      .post('/api/v1/session/dev-login')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
  });
});
