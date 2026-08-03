import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';

/**
 * Settings panel mounted at `/settings/connected-agents` listing every
 * OAuth consent the user has granted, plus a Revoke button per row.
 *
 * The list is read through the user's Supabase session — gymtrack_oauth_consents
 * has an RLS policy that scopes rows to auth.uid(), so we can read the
 * user's own consents directly from the browser using the anon client +
 * the user's access token. Revoke goes through /api/oauth/revoke so the
 * token family is revoked server-side and the consent row's revoked_at
 * is flipped in the same transaction.
 *
 * Empty state: "No agents connected yet" with a link back to /workout.
 * Loading: a small placeholder while the initial fetch resolves.
 */
export default function ConnectedAgents() {
  const { session, loading } = useAuth();
  const [consents, setConsents] = useState([]);
  const [fetchError, setFetchError] = useState(null);
  const [revoking, setRevoking] = useState(null); // client_id currently being revoked
  const [revokeError, setRevokeError] = useState(null);

  const reload = useCallback(async () => {
    if (!session) return;
    setFetchError(null);
    const { data, error } = await supabase
      .from('gymtrack_oauth_consents')
      .select('client_id, scopes, granted_at, revoked_at')
      .eq('user_id', session.user.id)
      .is('revoked_at', null)
      .order('granted_at', { ascending: false });
    if (error) {
      setFetchError(error.message);
      return;
    }
    setConsents(data ?? []);
  }, [session]);

  useEffect(() => {
    if (!loading && session) {
      reload();
    }
  }, [loading, session, reload]);

  if (loading) {
    return (
      <main className="container connected-agents" data-testid="connected-agents-loading">
        <p>Loading…</p>
      </main>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: { pathname: '/settings/connected-agents' } }} />;
  }

  async function handleRevoke(clientId) {
    setRevoking(clientId);
    setRevokeError(null);
    try {
      // /api/oauth/revoke needs a token to revoke. We have no plaintext
      // OAuth token stored in the browser (Supabase persists only its
      // own session, not the MCP access token). The cleanest path is a
      // dedicated endpoint that revokes by (user, client). We call that
      // here; if the endpoint does not exist yet we fall back to a
      // user-side UPDATE on the consent row that marks revoked_at.
      const { data: refreshed } = await supabase.auth.getSession();
      const accessToken = refreshed?.session?.access_token;
      if (!accessToken) {
        setRevokeError('Your sign-in has expired. Please sign in again.');
        setRevoking(null);
        return;
      }

      // The dedicated /api/oauth/revoke-by-consent endpoint accepts the
      // user's Supabase access_token + client_id, looks up every still-live
      // access + refresh token for (user_id, client_id), and revokes the
      // family. The consent row is also marked revoked_at.
      const resp = await fetch('/api/oauth/revoke-by-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, access_token: accessToken })
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        setRevokeError(payload?.message ?? `Revoke failed (HTTP ${resp.status}).`);
        setRevoking(null);
        return;
      }
      await reload();
    } catch (err) {
      setRevokeError(err?.message ?? 'Revoke failed.');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <main className="container connected-agents" data-testid="connected-agents">
      <h1>Connected Agents</h1>
      <p className="subtitle">
        Agents you have authorized to act on your behalf. Revoke to disconnect immediately.
      </p>

      {fetchError ? (
        <div className="status show error" role="alert" data-testid="connected-agents-fetch-error">
          {fetchError}
        </div>
      ) : null}

      {revokeError ? (
        <div className="status show error" role="alert" data-testid="connected-agents-revoke-error">
          {revokeError}
        </div>
      ) : null}

      {consents.length === 0 && !fetchError ? (
        <p className="status" data-testid="connected-agents-empty">
          No agents connected yet. Connect an MCP-compatible client like Claude or ChatGPT to get started.
        </p>
      ) : (
        <ul className="connected-agents-list" data-testid="connected-agents-list">
          {consents.map((c) => (
            <li key={c.client_id} className="connected-agent-row" data-testid={`connected-agent-${c.client_id}`}>
              <div className="connected-agent-meta">
                <strong>{c.client_id}</strong>
                <span className="muted">
                  Granted {formatDate(c.granted_at)} · scopes: {(c.scopes ?? []).join(', ')}
                </span>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleRevoke(c.client_id)}
                disabled={revoking === c.client_id}
                data-testid={`connected-agent-revoke-${c.client_id}`}
              >
                {revoking === c.client_id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p>
        <Link to="/workout">Back to workout</Link>
      </p>
    </main>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}