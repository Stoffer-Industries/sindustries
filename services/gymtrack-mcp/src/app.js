import express from 'express';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createSupabaseRepo } from './repo.js';
import { DEFAULT_SCOPE, normalizeScope, SUPPORTED_SCOPES } from './scopes.js';
import { MCP_TOOLS, callMcpTool } from './mcpTools.js';
import { pkceChallengeForVerifier, randomToken, sha256Hex } from './crypto.js';
import { supabaseAdminClient } from './supabase.js';

function appendOAuthParams(baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, value);
  });
  return url.toString();
}

function parseBearerToken(req) {
  const header = req.headers.authorization ?? req.headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function setBearerChallengeHeader(res, issuer) {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="gymtrack-mcp", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`
  );
}

function oauthJsonError(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}

// Strip token-shaped strings, Bearer-prefixed values, and Supabase URLs from
// error text before returning it to clients. Bounded to 80 characters so the
// response shape stays predictable. Original detail is still available via
// server-side logging at each catch site.
function redactErrorForResponse(message) {
  if (message == null) return '';
  const text = String(message);
  const redacted = text
    .replace(/[A-Za-z0-9_-]{32,}/g, '…[redacted]…')
    .replace(/Bearer\s+\S+/gi, 'Bearer …[redacted]…')
    .replace(/https?:\/\/[^\s]*supabase[^\s]*/gi, '…[redacted-supabase-url]…');
  return redacted.length > 80 ? `${redacted.slice(0, 80)}…` : redacted;
}

function jsonRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function validateClientRedirect(repo, clientId, redirectUri) {
  if (!clientId) return { error: 'client_id is required.' };
  if (!redirectUri) return { error: 'redirect_uri is required.' };

  const oauthClient = await repo.getOAuthClient(clientId);
  if (!oauthClient) return { error: 'Unknown client_id.' };

  const allowed = Array.isArray(oauthClient.redirect_uris)
    ? oauthClient.redirect_uris
    : [];
  if (!allowed.includes(redirectUri)) {
    return { error: 'redirect_uri is not registered for this client.' };
  }

  return { oauthClient };
}

function validateAuthorizeRequest(query) {
  if (query.response_type !== 'code') {
    return 'response_type must be code.';
  }
  if (!String(query.state ?? '').trim()) {
    return 'state is required.';
  }
  if (!query.code_challenge) {
    return 'code_challenge is required.';
  }
  if (query.code_challenge_method !== 'S256') {
    return 'code_challenge_method must be S256.';
  }
  const normalized = normalizeScope(query.scope ?? DEFAULT_SCOPE);
  if (normalized.error) return normalized.error;
  return null;
}

async function resolveOAuthIdentity(repo, token, now = new Date()) {
  if (!token) return null;
  const row = await repo.findTokenByAccessHash(sha256Hex(token));
  if (!row) return null;
  const consent = await repo.getConsent(row.consent_id);
  if (!consent) return null;
  if (row.revoked_at || consent.revoked_at) return null;
  if (new Date(row.access_token_expires_at).getTime() <= now.getTime()) return null;

  repo.touchTokenUsage({ tokenId: row.id, consentId: consent.id, usedAt: now }).catch(() => {});

  return {
    tokenId: row.id,
    consentId: consent.id,
    userId: row.user_id,
    clientId: row.client_id,
    scope: row.scope
  };
}

export function createApp({
  config = loadConfig(),
  repo = createSupabaseRepo(),
  gymtrackClient = supabaseAdminClient(),
  now = () => new Date()
} = {}) {
  const app = express();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === config.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.status(200).json({
      service: 'gymtrack-mcp',
      mcpEndpoint: `${config.issuer}/mcp`,
      authorizationServer: `${config.issuer}/.well-known/oauth-authorization-server`
    });
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'gymtrack-mcp' });
  });

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.status(200).json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth/authorize`,
      token_endpoint: `${config.issuer}/oauth/token`,
      revocation_endpoint: `${config.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SUPPORTED_SCOPES
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.status(200).json({
      resource: `${config.issuer}/mcp`,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: SUPPORTED_SCOPES
    });
  });

  app.get('/oauth/authorize', async (req, res) => {
    try {
      const requestError = validateAuthorizeRequest(req.query);
      if (requestError) return oauthJsonError(res, 400, 'invalid_request', requestError);

      const clientResult = await validateClientRedirect(
        repo,
        req.query.client_id,
        req.query.redirect_uri
      );
      if (clientResult.error) {
        return oauthJsonError(res, 400, 'invalid_client', clientResult.error);
      }

      const consentUrl = new URL('/agent-consent', config.appUrl);
      [
        'client_id',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
        'code_challenge',
        'code_challenge_method'
      ].forEach((key) => {
        const value = req.query[key];
        if (value != null) consentUrl.searchParams.set(key, value);
      });

      return res.redirect(302, consentUrl.toString());
    } catch (error) {
      return oauthJsonError(res, 500, 'server_error', redactErrorForResponse(error.message));
    }
  });

  app.post('/oauth/authorize/decision', async (req, res) => {
    try {
      const bearer = parseBearerToken(req);
      if (!bearer) {
        setBearerChallengeHeader(res, config.issuer);
        return oauthJsonError(res, 401, 'invalid_request', 'Missing user access token.');
      }

      const user = await repo.verifySupabaseUserAccessToken(bearer);
      if (!user) {
        setBearerChallengeHeader(res, config.issuer);
        return oauthJsonError(res, 401, 'access_denied', 'User session is not valid.');
      }

      const requestError = validateAuthorizeRequest({
        ...req.body,
        response_type: 'code'
      });
      if (requestError) return oauthJsonError(res, 400, 'invalid_request', requestError);

      const clientResult = await validateClientRedirect(repo, req.body.client_id, req.body.redirect_uri);
      if (clientResult.error) return oauthJsonError(res, 400, 'invalid_client', clientResult.error);

      if (req.body.approve === false) {
        return res.status(200).json({
          redirectTo: appendOAuthParams(req.body.redirect_uri, {
            error: 'access_denied',
            state: req.body.state ?? ''
          })
        });
      }

      const normalizedScope = normalizeScope(req.body.scope ?? DEFAULT_SCOPE);
      if (normalizedScope.error) {
        return oauthJsonError(res, 400, 'invalid_scope', normalizedScope.error);
      }

      const consent = await repo.upsertConsent({
        userId: user.id,
        clientId: req.body.client_id,
        scope: normalizedScope.scope,
        grantedAt: now()
      });

      const code = randomToken(24);
      await repo.createAuthorizationCode({
        consentId: consent.id,
        userId: user.id,
        clientId: req.body.client_id,
        codeHash: sha256Hex(code),
        redirectUri: req.body.redirect_uri,
        scope: normalizedScope.scope,
        codeChallenge: req.body.code_challenge,
        codeChallengeMethod: req.body.code_challenge_method,
        expiresAt: new Date(now().getTime() + config.authorizationCodeTtlSeconds * 1000)
      });

      return res.status(200).json({
        redirectTo: appendOAuthParams(req.body.redirect_uri, {
          code,
          state: req.body.state ?? ''
        })
      });
    } catch (error) {
      return oauthJsonError(res, 500, 'server_error', redactErrorForResponse(error.message));
    }
  });

  app.post('/oauth/token', async (req, res) => {
    try {
      const grantType = req.body.grant_type;
      const clientId = req.body.client_id;
      if (!grantType) return oauthJsonError(res, 400, 'invalid_request', 'grant_type is required.');
      if (!clientId) return oauthJsonError(res, 400, 'invalid_request', 'client_id is required.');

      const oauthClient = await repo.getOAuthClient(clientId);
      if (!oauthClient) return oauthJsonError(res, 400, 'invalid_client', 'Unknown client_id.');

      if (grantType === 'authorization_code') {
        const code = req.body.code;
        const redirectUri = req.body.redirect_uri;
        const verifier = req.body.code_verifier;
        if (!code || !redirectUri || !verifier) {
          return oauthJsonError(
            res,
            400,
            'invalid_request',
            'code, redirect_uri, and code_verifier are required.'
          );
        }

        const clientResult = await validateClientRedirect(repo, clientId, redirectUri);
        if (clientResult.error) return oauthJsonError(res, 400, 'invalid_client', clientResult.error);

        const codeRow = await repo.consumeAuthorizationCode({
          codeHash: sha256Hex(code),
          clientId,
          redirectUri,
          consumedAt: now()
        });

        if (!codeRow) return oauthJsonError(res, 400, 'invalid_grant', 'Authorization code is not valid.');
        if (codeRow.code_challenge_method !== 'S256') {
          return oauthJsonError(res, 400, 'invalid_grant', 'Unsupported PKCE challenge method.');
        }
        if (pkceChallengeForVerifier(verifier) !== codeRow.code_challenge) {
          return oauthJsonError(res, 400, 'invalid_grant', 'PKCE verification failed.');
        }

        const consent = await repo.getConsent(codeRow.consent_id);
        if (!consent || consent.revoked_at) {
          return oauthJsonError(res, 400, 'invalid_grant', 'Consent has been revoked.');
        }

        const accessToken = randomToken(32);
        const refreshToken = randomToken(32);
        await repo.createToken({
          consentId: consent.id,
          userId: consent.user_id,
          clientId: consent.client_id,
          scope: consent.scope,
          familyId: randomUUID(),
          accessTokenHash: sha256Hex(accessToken),
          refreshTokenHash: sha256Hex(refreshToken),
          accessTokenExpiresAt: new Date(now().getTime() + config.accessTokenTtlSeconds * 1000),
          refreshTokenExpiresAt: new Date(now().getTime() + config.refreshTokenTtlSeconds * 1000)
        });

        return res.status(200).json({
          token_type: 'Bearer',
          access_token: accessToken,
          expires_in: config.accessTokenTtlSeconds,
          refresh_token: refreshToken,
          scope: consent.scope
        });
      }

      if (grantType === 'refresh_token') {
        const refreshToken = req.body.refresh_token;
        if (!refreshToken) {
          return oauthJsonError(res, 400, 'invalid_request', 'refresh_token is required.');
        }

        const accessToken = randomToken(32);
        const nextRefreshToken = randomToken(32);
        const rotation = await repo.rotateRefreshToken({
          refreshTokenHash: sha256Hex(refreshToken),
          clientId,
          rotatedAt: now(),
          nextAccessTokenHash: sha256Hex(accessToken),
          nextRefreshTokenHash: sha256Hex(nextRefreshToken),
          nextAccessTokenExpiresAt: new Date(now().getTime() + config.accessTokenTtlSeconds * 1000),
          nextRefreshTokenExpiresAt: new Date(now().getTime() + config.refreshTokenTtlSeconds * 1000)
        });

        if (rotation.status === 'invalid') {
          return oauthJsonError(res, 400, 'invalid_grant', 'Refresh token is not valid.');
        }

        if (rotation.status === 'consent_revoked') {
          return oauthJsonError(res, 400, 'invalid_grant', 'Consent has been revoked.');
        }

        if (rotation.status === 'replayed') {
          return oauthJsonError(res, 400, 'invalid_grant', 'Refresh token has already been used.');
        }

        if (rotation.status === 'expired') {
          return oauthJsonError(res, 400, 'invalid_grant', 'Refresh token has expired.');
        }

        if (rotation.status !== 'rotated') {
          return oauthJsonError(res, 500, 'server_error', redactErrorForResponse(`Unexpected refresh rotation status: ${rotation.status}`));
        }

        return res.status(200).json({
          token_type: 'Bearer',
          access_token: accessToken,
          expires_in: config.accessTokenTtlSeconds,
          refresh_token: nextRefreshToken,
          scope: rotation.consent.scope
        });
      }

      return oauthJsonError(res, 400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
    } catch (error) {
      return oauthJsonError(res, 500, 'server_error', redactErrorForResponse(error.message));
    }
  });

  app.post('/oauth/revoke', async (req, res) => {
    try {
      const token = req.body.token;
      if (!token) return res.status(200).end();

      const tokenHash = sha256Hex(token);
      const row =
        (await repo.findTokenByAccessHash(tokenHash)) ??
        (await repo.findTokenByRefreshHash(tokenHash));

      if (row) {
        await repo.revokeConsentFamily({
          consentId: row.consent_id,
          revokedAt: now(),
          reason: 'oauth_revocation'
        });
      }

      return res.status(200).end();
    } catch (error) {
      return oauthJsonError(res, 500, 'server_error', redactErrorForResponse(error.message));
    }
  });

  app.post('/mcp', async (req, res) => {
    const rpc = req.body;
    if (!rpc || typeof rpc !== 'object') {
      return res.status(400).json(jsonRpcError(null, -32700, 'Invalid JSON-RPC payload.'));
    }

    try {
      const identity = await resolveOAuthIdentity(repo, parseBearerToken(req), now());
      if (!identity) {
        setBearerChallengeHeader(res, config.issuer);
        return res.status(401).json(jsonRpcError(rpc.id ?? null, -32001, 'Unauthorized.'));
      }

      if (rpc.method === 'initialize') {
        return res.status(200).json(
          jsonRpcSuccess(rpc.id ?? null, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'gymtrack-mcp', version: '0.1.0' }
          })
        );
      }

      if (rpc.method === 'tools/list') {
        return res.status(200).json(jsonRpcSuccess(rpc.id ?? null, { tools: MCP_TOOLS }));
      }

      if (rpc.method === 'tools/call') {
        const result = await callMcpTool({
          client: gymtrackClient,
          identity,
          name: rpc.params?.name,
          args: rpc.params?.arguments ?? {}
        });
        return res.status(200).json(jsonRpcSuccess(rpc.id ?? null, result));
      }

      return res.status(404).json(jsonRpcError(rpc.id ?? null, -32601, `Method not found: ${rpc.method}`));
    } catch (error) {
      const status = error?.status ?? 500;
      const code = status === 400 ? -32602 : status === 403 ? -32003 : -32000;
      return res.status(status).json(jsonRpcError(rpc.id ?? null, code, redactErrorForResponse(error.message)));
    }
  });

  return app;
}
