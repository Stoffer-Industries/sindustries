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
      },
      {
        client_id: 'openclaw',
        client_name: 'OpenClaw',
        redirect_uris: ['http://127.0.0.1:8789/callback']
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
    if (
      row.consumed_at != null ||
      row.revoked_at != null ||
      new Date(row.expires_at).getTime() <= consumedAt.getTime()
    ) {
      return null;
    }
    row.consumed_at = consumedAt.toISOString();
    return structuredClone(row);
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

  async rotateRefreshToken({
    refreshTokenHash,
    clientId,
    rotatedAt,
    nextAccessTokenHash,
    nextRefreshTokenHash,
    nextAccessTokenExpiresAt,
    nextRefreshTokenExpiresAt
  }) {
    const source = this.tokens.find(
      (item) => item.refresh_token_hash === refreshTokenHash && item.client_id === clientId
    );
    if (!source) return { status: 'invalid' };

    const consent = this.consents.find((item) => item.id === source.consent_id) ?? null;
    if (!consent || consent.revoked_at) {
      await this.revokeConsentFamily({
        consentId: source.consent_id,
        revokedAt: rotatedAt,
        reason: 'consent_revoked'
      });
      return {
        status: 'consent_revoked',
        source_token: structuredClone(source),
        consent: consent ? structuredClone(consent) : null
      };
    }

    if (source.revoked_at || source.rotated_at) {
      await this.revokeConsentFamily({
        consentId: source.consent_id,
        revokedAt: rotatedAt,
        reason: 'refresh_replay_detected'
      });
      return {
        status: 'replayed',
        source_token: structuredClone(source),
        consent: structuredClone(consent)
      };
    }

    if (new Date(source.refresh_token_expires_at).getTime() <= rotatedAt.getTime()) {
      return {
        status: 'expired',
        source_token: structuredClone(source),
        consent: structuredClone(consent)
      };
    }

    const nextRow = await this.createToken({
      consentId: consent.id,
      userId: consent.user_id,
      clientId: consent.client_id,
      scope: consent.scope,
      familyId: source.family_id,
      parentTokenId: source.id,
      accessTokenHash: nextAccessTokenHash,
      refreshTokenHash: nextRefreshTokenHash,
      accessTokenExpiresAt: nextAccessTokenExpiresAt,
      refreshTokenExpiresAt: nextRefreshTokenExpiresAt
    });

    source.rotated_at = rotatedAt.toISOString();
    source.revoked_at = rotatedAt.toISOString();
    source.revocation_reason = 'refresh_rotated';
    source.replaced_by_token_id = nextRow.id;
    source.last_used_at = rotatedAt.toISOString();
    consent.last_used_at = rotatedAt.toISOString();

    return {
      status: 'rotated',
      source_token: structuredClone(source),
      next_token: structuredClone(nextRow),
      consent: structuredClone(consent)
    };
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

  it('rejects authorize requests without a non-empty state value', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        scope: 'history:read progression:read workouts:write',
        state: '   ',
        code_challenge: 'pkce-challenge',
        code_challenge_method: 'S256'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
    expect(response.body.error_description).toMatch(/state is required/i);
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

    const reusedCode = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        code,
        code_verifier: verifier
      });

    expect(reusedCode.status).toBe(400);
    expect(reusedCode.body.error).toBe('invalid_grant');

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

  it('cascades revocation across the token family when a rotated refresh token is replayed', async () => {
    const fixedNow = new Date('2026-08-04T00:00:00.000Z');
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

    const verifier = 'verifier-family-cascade';
    repo.codes[0].code_challenge = pkceChallengeForVerifier(verifier);
    const code = new URL(decision.body.redirectTo).searchParams.get('code');

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
    const originalRefreshToken = exchange.body.refresh_token;

    const rotation = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'claude-desktop',
        refresh_token: originalRefreshToken
      });

    expect(rotation.status).toBe(200);
    const rotatedRefreshToken = rotation.body.refresh_token;

    expect(repo.tokens).toHaveLength(2);
    const sourceToken = repo.tokens[0];
    const replacementToken = repo.tokens[1];
    expect(replacementToken.parent_token_id).toBe(sourceToken.id);
    expect(sourceToken.rotated_at).toBe(fixedNow.toISOString());
    expect(sourceToken.revocation_reason).toBe('refresh_rotated');
    expect(replacementToken.revoked_at).toBeNull();
    expect(replacementToken.revocation_reason).toBeNull();

    const replay = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'claude-desktop',
        refresh_token: originalRefreshToken
      });

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    // Family cascade: the already-rotated source token keeps its original rotation
    // reason (the cascade skips rows whose revoked_at is already set), and the
    // replacement token — the one an attacker would actually try to use next —
    // is revoked with the dedicated cascade reason.
    expect(sourceToken.revocation_reason).toBe('refresh_rotated');
    expect(replacementToken.revoked_at).toBe(fixedNow.toISOString());
    expect(replacementToken.revocation_reason).toBe('refresh_replay_detected');
    expect(repo.consents[0].revoked_at).toBe(fixedNow.toISOString());

    // The replacement's refresh token must also be unusable after the cascade —
    // attempting to rotate it surfaces the now-revoked consent and returns
    // invalid_grant, not a new access token.
    const subsequentRefresh = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'claude-desktop',
        refresh_token: rotatedRefreshToken
      });

    expect(subsequentRefresh.status).toBe(400);
    expect(subsequentRefresh.body.error).toBe('invalid_grant');
    expect(repo.tokens).toHaveLength(2);
  });

  it('revocation disables both MCP access and refresh-token exchange', async () => {
    const { app, repo } = makeApp();

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

    const verifier = 'verifier-123';
    repo.codes[0].code_challenge = pkceChallengeForVerifier(verifier);
    const code = new URL(decision.body.redirectTo).searchParams.get('code');

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

    const revoke = await request(app)
      .post('/oauth/revoke')
      .type('form')
      .send({ token: exchange.body.refresh_token });

    expect(revoke.status).toBe(200);

    const refresh = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'claude-desktop',
        refresh_token: exchange.body.refresh_token
      });

    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toBe('invalid_grant');

    const mcp = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${exchange.body.access_token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(mcp.status).toBe(401);
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
      expect.objectContaining({ userId: 'user-1', consentId: consent.id })
    );
  });

  it('advertises the bearer challenge header on unauthenticated /mcp requests', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32001, message: 'Unauthorized.' }
    });
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="gymtrack-mcp", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"'
    );
  });

  it('advertises the bearer challenge header on unauthenticated /oauth/authorize/decision requests', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/oauth/authorize/decision')
      .send({
        approve: true,
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        scope: 'history:read',
        state: 'opaque-state',
        code_challenge: 'dmVyLWNoYWxsZW5nZQ',
        code_challenge_method: 'S256'
      });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe(
      'Bearer realm="gymtrack-mcp", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"'
    );
  });

  it('redacts token-shaped, bearer-prefixed, and supabase substrings from 500 error descriptions', async () => {
    class ThrowingRepo extends FakeRepo {
      async getOAuthClient() {
        const tokenLike = 'a'.repeat(40);
        const jwtLike = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload';
        const supabaseUrl = 'https://abcdefghijklmnop.supabase.co/rest/v1/foo';
        throw new Error(`Connection failed: ${tokenLike} Bearer ${jwtLike} ${supabaseUrl}`);
      }
    }
    const repo = new ThrowingRepo();
    const { app } = makeApp({ repo });

    const response = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'claude-desktop',
        redirect_uri: 'https://claude.example/callback',
        scope: 'history:read',
        state: 'opaque-state',
        code_challenge: 'dmVyLWNoYWxsZW5nZQ',
        code_challenge_method: 'S256'
      });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('server_error');
    const description = response.body.error_description;
    expect(description).not.toContain('a'.repeat(40));
    expect(description).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(description).not.toContain('supabase.co');
    expect(description).toContain('…[redacted]…');
    expect(description).toContain('…[redacted-supabase-url]…');
    // 80-char cap with one trailing ellipsis if truncation occurred
    expect(description.length).toBeLessThanOrEqual(81);
  });

  it('rejects openclaw token exchange when no consent row exists for (user_id, openclaw)', async () => {
    const { app, repo } = makeApp();

    // Build an authorization code that points at a consent_id that does not
    // exist in the repo. This mirrors the "consent row never written" condition
    // AC4 locks against: a fresh OpenClaw install attempting the PKCE dance
    // against a user who has never approved the new client_id.
    const code = 'openclaw-orphan-consent-code';
    const verifier = 'openclaw-orphan-verifier';
    await repo.createAuthorizationCode({
      consentId: 'consent-does-not-exist',
      userId: 'user-1',
      clientId: 'openclaw',
      codeHash: sha256Hex(code),
      redirectUri: 'http://127.0.0.1:8789/callback',
      scope: 'history:read progression:read workouts:write',
      codeChallenge: pkceChallengeForVerifier(verifier),
      codeChallengeMethod: 'S256',
      expiresAt: new Date('2026-08-15T01:00:00.000Z')
    });

    const exchange = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'openclaw',
        redirect_uri: 'http://127.0.0.1:8789/callback',
        code,
        code_verifier: verifier
      });

    expect(exchange.status).toBe(400);
    expect(exchange.body.error).toBe('invalid_grant');
    expect(exchange.body.error_description).toMatch(/consent/i);
    expect(repo.tokens).toHaveLength(0);
  });

  it('rejects openclaw authorize requests with a redirect_uri that is not registered for the client', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: 'openclaw',
        redirect_uri: 'https://attacker.example/callback',
        scope: 'history:read',
        state: 'opaque-state',
        code_challenge: 'dmVyLWNoYWxsZW5nZQ',
        code_challenge_method: 'S256'
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_client');
    expect(response.body.error_description).toBe(
      'redirect_uri is not registered for this client.'
    );
  });
});
