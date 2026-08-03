import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { pkceChallengeForVerifier, sha256Hex } from '../src/crypto.js';

const createPlannedWorkout = vi.fn();
const fetchWorkoutHistory = vi.fn();
const fetchExerciseProgression = vi.fn();

vi.mock('../../../apps/gymtrack/server/agentData.js', () => ({
  createPlannedWorkout: (...args) => createPlannedWorkout(...args),
  fetchWorkoutHistory: (...args) => fetchWorkoutHistory(...args),
  fetchExerciseProgression: (...args) => fetchExerciseProgression(...args),
  validatePlannedWorkoutBody: () => null,
  parseHistoryLimit: (value) => (value == null ? 10 : Number(value)),
  parseProgressionLimit: (value) => (value == null ? 20 : Number(value)),
  normalizeExerciseName: (value) => (typeof value === 'string' ? value.trim() : null),
  exerciseNameErrorMessage: () => 'exerciseName is required.'
}));

const { createApp } = await import('../src/app.js');

class FakeRepo {
  constructor() {
    this.clients = [
      {
        client_id: 'claude-desktop',
        client_name: 'Claude Desktop',
        redirect_uris: ['https://claude.example/callback']
      }
    ];
    this.users = new Map([['supabase-user-token', { id: 'user-1', email: 'rowan@example.com' }]]);
    this.consents = [];
    this.codes = [];
    this.tokens = [];
  }

  async getOAuthClient(clientId) {
    return this.clients.find((client) => client.client_id === clientId) ?? null;
  }

  async getConsent(consentId) {
    return this.consents.find((consent) => consent.id === consentId) ?? null;
  }

  async upsertConsent({ userId, clientId, scope, grantedAt }) {
    let consent = this.consents.find(
      (row) => row.user_id === userId && row.client_id === clientId && row.revoked_at == null
    );
    if (!consent) {
      consent = {
        id: `consent-${this.consents.length + 1}`,
        user_id: userId,
        client_id: clientId,
        scope,
        granted_at: grantedAt.toISOString(),
        revoked_at: null,
        last_used_at: null
      };
      this.consents.push(consent);
    } else {
      consent.scope = scope;
      consent.granted_at = grantedAt.toISOString();
    }
    return structuredClone(consent);
  }

  async createAuthorizationCode(record) {
    const row = {
      id: `code-${this.codes.length + 1}`,
      consent_id: record.consentId,
      user_id: record.userId,
      client_id: record.clientId,
      code_hash: record.codeHash,
      redirect_uri: record.redirectUri,
      scope: record.scope,
      code_challenge: record.codeChallenge,
      code_challenge_method: record.codeChallengeMethod,
      expires_at: record.expiresAt.toISOString(),
      consumed_at: null,
      revoked_at: null
    };
    this.codes.push(row);
    return structuredClone(row);
  }

  async consumeAuthorizationCode({ codeHash, clientId, redirectUri, consumedAt }) {
    const row = this.codes.find(
      (item) => item.code_hash === codeHash && item.client_id === clientId && item.redirect_uri === redirectUri
    );
    if (!row) return null;
    const before = structuredClone(row);
    if (row.consumed_at == null) row.consumed_at = consumedAt.toISOString();
    return before;
  }

  async createToken(record) {
    const row = {
      id: `token-${this.tokens.length + 1}`,
      consent_id: record.consentId,
      user_id: record.userId,
      client_id: record.clientId,
      scope: record.scope,
      family_id: record.familyId,
      parent_token_id: record.parentTokenId ?? null,
      access_token_hash: record.accessTokenHash,
      refresh_token_hash: record.refreshTokenHash,
      access_token_expires_at: record.accessTokenExpiresAt.toISOString(),
      refresh_token_expires_at: record.refreshTokenExpiresAt.toISOString(),
      revoked_at: null,
      revocation_reason: null,
      rotated_at: null,
      replaced_by_token_id: null,
      last_used_at: null
    };
    this.tokens.push(row);
    return structuredClone(row);
  }

  async markTokenRotated({ tokenId, replacedByTokenId, rotatedAt }) {
    const row = this.tokens.find((item) => item.id === tokenId);
    row.rotated_at = rotatedAt.toISOString();
    row.revoked_at = rotatedAt.toISOString();
    row.revocation_reason = 'refresh_rotated';
    row.replaced_by_token_id = replacedByTokenId;
  }

  async findTokenByAccessHash(hash) {
    const row = this.tokens.find((item) => item.access_token_hash === hash);
    return row ? structuredClone(row) : null;
  }

  async findTokenByRefreshHash(hash) {
    const row = this.tokens.find((item) => item.refresh_token_hash === hash);
    return row ? structuredClone(row) : null;
  }

  async touchTokenUsage({ tokenId, consentId, usedAt }) {
    const timestamp = usedAt.toISOString();
    const token = this.tokens.find((item) => item.id === tokenId);
    const consent = this.consents.find((item) => item.id === consentId);
    token.last_used_at = timestamp;
    consent.last_used_at = timestamp;
  }

  async revokeConsentFamily({ consentId, revokedAt, reason }) {
    const timestamp = revokedAt.toISOString();
    const consent = this.consents.find((item) => item.id === consentId);
    if (consent && consent.revoked_at == null) consent.revoked_at = timestamp;
    this.tokens.forEach((token) => {
      if (token.consent_id === consentId && token.revoked_at == null) {
        token.revoked_at = timestamp;
        token.revocation_reason = reason ?? 'revoked';
      }
    });
    this.codes.forEach((code) => {
      if (code.consent_id === consentId && code.revoked_at == null) {
        code.revoked_at = timestamp;
      }
    });
  }

  async verifySupabaseUserAccessToken(accessToken) {
    return this.users.get(accessToken) ?? null;
  }
}

function makeApp(overrides = {}) {
  const repo = overrides.repo ?? new FakeRepo();
  const gymtrackClient = overrides.gymtrackClient ?? {};
  const now = overrides.now ?? (() => new Date('2026-08-03T00:00:00.000Z'));
  const app = createApp({
    repo,
    gymtrackClient,
    now,
    config: {
      issuer: 'https://mcp.example',
      appUrl: 'https://gymtrack.example',
      webOrigin: 'https://gymtrack.example',
      port: 8787,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
      authorizationCodeTtlSeconds: 600
    }
  });
  return { app, repo };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GymTrack MCP OAuth server', () => {
  it('redirects authorize requests into the GymTrack consent page', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        scope: 'history:read progression:read workouts:write',
        state: 'opaque-state',
        code_challenge: 'pkce-challenge',
        code_challenge_method: 'S256'
      });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('https://gymtrack.example/agent-consent');
    expect(response.headers.location).toContain('client_id=claude-desktop');
    expect(response.headers.location).toContain('state=opaque-state');
  });

  it('issues hashed access+refresh tokens and rotates refresh tokens', async () => {
    const fixedNow = new Date('2026-08-03T00:00:00.000Z');
    const { app, repo } = makeApp({ now: () => fixedNow });

    const decision = await request(app)
      .post('/oauth/authorize/decision')
      .set('Authorization', 'Bearer supabase-user-token')
      .send({
        approve: true,
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        scope: 'history:read progression:read workouts:write',
        state: 'opaque-state',
        code_challenge: 'dmVyLWNoYWxsZW5nZQ',
        code_challenge_method: 'S256'
      });

    expect(decision.status).toBe(200);
    const redirectUrl = new URL(decision.body.redirectTo);
    const code = redirectUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const verifier = 'verifier-123';
    // Override the stored PKCE challenge so the test can exchange the code with a known verifier.
    repo.codes[0].code_challenge = pkceChallengeForVerifier(verifier);

    const exchange = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        code,
        code_verifier: verifier
      });

    expect(exchange.status).toBe(200);
    expect(exchange.body.token_type).toBe('Bearer');
    expect(exchange.body.scope).toBe('history:read progression:read workouts:write');
    expect(repo.tokens).toHaveLength(1);
    expect(repo.tokens[0].access_token_hash).toBe(sha256Hex(exchange.body.access_token));
    expect(repo.tokens[0].refresh_token_hash).toBe(sha256Hex(exchange.body.refresh_token));
    expect(repo.tokens[0].access_token_hash).not.toBe(exchange.body.access_token);
    expect(repo.tokens[0].refresh_token_hash).not.toBe(exchange.body.refresh_token);

    const refresh = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'claude-desktop',
        refresh_token: exchange.body.refresh_token
      });

    expect(refresh.status).toBe(200);
    expect(repo.tokens).toHaveLength(2);
    expect(repo.tokens[0].rotated_at).toBe(fixedNow.toISOString());
    expect(repo.tokens[1].parent_token_id).toBe(repo.tokens[0].id);

    const replay = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'claude-desktop',
        refresh_token: exchange.body.refresh_token
      });

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(repo.consents[0].revoked_at).toBe(fixedNow.toISOString());
  });

  it('lists tools and enforces user isolation from the token identity', async () => {
    const { app, repo } = makeApp();
    const consent = await repo.upsertConsent({
      userId: 'user-1',
      clientId: 'claude-desktop',
      scope: 'history:read progression:read workouts:write',
      grantedAt: new Date('2026-08-03T00:00:00.000Z')
    });
    await repo.createToken({
      consentId: consent.id,
      userId: 'user-1',
      clientId: 'claude-desktop',
      scope: consent.scope,
      familyId: 'family-1',
      accessTokenHash: sha256Hex('oauth-access-token'),
      refreshTokenHash: sha256Hex('oauth-refresh-token'),
      accessTokenExpiresAt: new Date('2026-08-03T01:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-11-01T00:00:00.000Z')
    });

    createPlannedWorkout.mockResolvedValueOnce({ plannedWorkoutId: 'plan-1', setCount: 1 });
    fetchWorkoutHistory.mockResolvedValueOnce({ workouts: [{ id: 'workout-1' }] });
    fetchExerciseProgression.mockResolvedValueOnce({ exerciseName: 'Bench Press', sets: [] });

    const list = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer oauth-access-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((tool) => tool.name)).toEqual([
      'plan_workout',
      'read_history',
      'read_exercise_progression'
    ]);

    const call = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer oauth-access-token')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'plan_workout',
          arguments: {
            scheduledFor: '2026-08-03',
            title: 'Push Day',
            userId: 'malicious-user',
            exercises: [{ name: 'Bench Press', sets: [{ reps: 5, weight: 80, unit: 'kg' }] }]
          }
        }
      });

    expect(call.status).toBe(200);
    expect(createPlannedWorkout).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: 'user-1', legacyAgentKeyId: null })
    );
  });
});
