import { supabaseAdminClient } from './supabase.js';

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function createSupabaseRepo({ client = supabaseAdminClient() } = {}) {
  return {
    async getOAuthClient(clientId) {
      const { data, error } = await client
        .from('gymtrack_oauth_clients')
        .select('*')
        .eq('client_id', clientId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async getConsent(consentId) {
      const { data, error } = await client
        .from('gymtrack_oauth_consents')
        .select('*')
        .eq('id', consentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async upsertConsent({ userId, clientId, scope, grantedAt }) {
      const { data: existing, error: existingError } = await client
        .from('gymtrack_oauth_consents')
        .select('*')
        .eq('user_id', userId)
        .eq('client_id', clientId)
        .is('revoked_at', null)
        .maybeSingle();
      if (existingError) throw existingError;

      if (existing) {
        const { data, error } = await client
          .from('gymtrack_oauth_consents')
          .update({
            scope,
            granted_at: iso(grantedAt)
          })
          .eq('id', existing.id)
          .select()
          .single();
        if (error) throw error;
        return data;
      }

      const { data, error } = await client
        .from('gymtrack_oauth_consents')
        .insert({
          user_id: userId,
          client_id: clientId,
          scope,
          granted_at: iso(grantedAt)
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async createAuthorizationCode(record) {
      const { data, error } = await client
        .from('gymtrack_oauth_authorization_codes')
        .insert({
          consent_id: record.consentId,
          user_id: record.userId,
          client_id: record.clientId,
          code_hash: record.codeHash,
          redirect_uri: record.redirectUri,
          scope: record.scope,
          code_challenge: record.codeChallenge,
          code_challenge_method: record.codeChallengeMethod,
          expires_at: iso(record.expiresAt)
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async consumeAuthorizationCode({ codeHash, clientId, redirectUri, consumedAt }) {
      const { data, error } = await client.rpc('gymtrack_consume_oauth_authorization_code', {
        p_code_hash: codeHash,
        p_client_id: clientId,
        p_redirect_uri: redirectUri,
        p_consumed_at: iso(consumedAt)
      });
      if (error) throw error;
      return data ?? null;
    },

    async createToken(record) {
      const { data, error } = await client
        .from('gymtrack_oauth_tokens')
        .insert({
          consent_id: record.consentId,
          user_id: record.userId,
          client_id: record.clientId,
          scope: record.scope,
          family_id: record.familyId,
          parent_token_id: record.parentTokenId ?? null,
          access_token_hash: record.accessTokenHash,
          refresh_token_hash: record.refreshTokenHash,
          access_token_expires_at: iso(record.accessTokenExpiresAt),
          refresh_token_expires_at: iso(record.refreshTokenExpiresAt)
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async markTokenRotated({ tokenId, replacedByTokenId, rotatedAt }) {
      const { error } = await client
        .from('gymtrack_oauth_tokens')
        .update({
          rotated_at: iso(rotatedAt),
          revoked_at: iso(rotatedAt),
          revocation_reason: 'refresh_rotated',
          replaced_by_token_id: replacedByTokenId
        })
        .eq('id', tokenId);
      if (error) throw error;
    },

    async rotateRefreshToken({
      refreshTokenHash,
      clientId,
      rotatedAt,
      nextAccessTokenHash,
      nextRefreshTokenHash,
      nextAccessTokenExpiresAt,
      nextRefreshTokenExpiresAt
    }) {
      const { data, error } = await client.rpc('gymtrack_rotate_oauth_refresh_token', {
        p_refresh_token_hash: refreshTokenHash,
        p_client_id: clientId,
        p_rotated_at: iso(rotatedAt),
        p_next_access_token_hash: nextAccessTokenHash,
        p_next_refresh_token_hash: nextRefreshTokenHash,
        p_next_access_token_expires_at: iso(nextAccessTokenExpiresAt),
        p_next_refresh_token_expires_at: iso(nextRefreshTokenExpiresAt)
      });
      if (error) throw error;
      return data ?? { status: 'invalid' };
    },

    async findTokenByAccessHash(accessTokenHash) {
      const { data, error } = await client
        .from('gymtrack_oauth_tokens')
        .select('*')
        .eq('access_token_hash', accessTokenHash)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async findTokenByRefreshHash(refreshTokenHash) {
      const { data, error } = await client
        .from('gymtrack_oauth_tokens')
        .select('*')
        .eq('refresh_token_hash', refreshTokenHash)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async touchTokenUsage({ tokenId, consentId, usedAt }) {
      const timestamp = iso(usedAt);
      const [tokenResult, consentResult] = await Promise.all([
        client.from('gymtrack_oauth_tokens').update({ last_used_at: timestamp }).eq('id', tokenId),
        client.from('gymtrack_oauth_consents').update({ last_used_at: timestamp }).eq('id', consentId)
      ]);
      if (tokenResult.error) throw tokenResult.error;
      if (consentResult.error) throw consentResult.error;
    },

    async revokeConsentFamily({ consentId, revokedAt, reason }) {
      const timestamp = iso(revokedAt);
      const [consentResult, tokenResult, codeResult] = await Promise.all([
        client
          .from('gymtrack_oauth_consents')
          .update({ revoked_at: timestamp })
          .eq('id', consentId)
          .is('revoked_at', null),
        client
          .from('gymtrack_oauth_tokens')
          .update({ revoked_at: timestamp, revocation_reason: reason ?? 'revoked' })
          .eq('consent_id', consentId)
          .is('revoked_at', null),
        client
          .from('gymtrack_oauth_authorization_codes')
          .update({ revoked_at: timestamp })
          .eq('consent_id', consentId)
          .is('revoked_at', null)
      ]);
      if (consentResult.error) throw consentResult.error;
      if (tokenResult.error) throw tokenResult.error;
      if (codeResult.error) throw codeResult.error;
    },

    async revokeAccessOrRefreshToken({ tokenId, revokedAt, reason }) {
      const { error } = await client
        .from('gymtrack_oauth_tokens')
        .update({ revoked_at: iso(revokedAt), revocation_reason: reason ?? 'revoked' })
        .eq('id', tokenId)
        .is('revoked_at', null);
      if (error) throw error;
    },

    async verifySupabaseUserAccessToken(accessToken) {
      const { data, error } = await client.auth.getUser(accessToken);
      if (error) return null;
      return data.user ?? null;
    }
  };
}
