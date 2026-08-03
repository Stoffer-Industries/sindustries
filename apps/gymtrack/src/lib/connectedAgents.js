import { supabase } from './supabase.js';
import { mcpUrl } from './mcpConfig.js';

export async function listConnectedAgents() {
  const { data, error } = await supabase
    .from('gymtrack_oauth_consents')
    .select(`
      id,
      client_id,
      scope,
      granted_at,
      last_used_at,
      revoked_at,
      gymtrack_oauth_clients(client_name)
    `)
    .is('revoked_at', null)
    .order('granted_at', { ascending: false });

  if (error) return { data: null, error };

  return {
    data: (data ?? []).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: row.gymtrack_oauth_clients?.client_name ?? row.client_id,
      scope: row.scope,
      grantedAt: row.granted_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at
    })),
    error: null
  };
}

export async function revokeConnectedAgent(consentId) {
  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return { error: new Error('You are no longer signed in. Please refresh and try again.') };
  }

  const response = await fetch('/api/connected-agents/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ consentId })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      error: new Error(data.message ?? data.error ?? 'Failed to revoke connected agent.')
    };
  }

  return { error: null };
}

export async function fetchOAuthClient(clientId) {
  const { data, error } = await supabase
    .from('gymtrack_oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();

  return { data: data ?? null, error: error ?? null };
}

export async function submitAgentConsentDecision({ accessToken, approve, ...payload }) {
  const response = await fetch(mcpUrl('/oauth/authorize/decision'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ approve, ...payload })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      data: null,
      error: new Error(data.error_description ?? data.error ?? 'OAuth decision failed.')
    };
  }

  return { data, error: null };
}
