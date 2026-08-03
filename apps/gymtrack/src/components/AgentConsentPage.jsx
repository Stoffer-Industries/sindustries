import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchOAuthClient, submitAgentConsentDecision } from '../lib/connectedAgents.js';
import { useAuth } from '../lib/auth.jsx';

function scopeList(scope) {
  return String(scope)
    .split(/\s+/)
    .filter(Boolean);
}

export default function AgentConsentPage() {
  const [params] = useSearchParams();
  const { session } = useAuth();
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const request = useMemo(
    () => ({
      client_id: params.get('client_id') ?? '',
      redirect_uri: params.get('redirect_uri') ?? '',
      scope: params.get('scope') ?? '',
      state: params.get('state') ?? '',
      code_challenge: params.get('code_challenge') ?? '',
      code_challenge_method: params.get('code_challenge_method') ?? ''
    }),
    [params]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadClient() {
      if (!request.client_id) {
        setError('Missing OAuth client id.');
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data, error: fetchError } = await fetchOAuthClient(request.client_id);
      if (cancelled) return;
      if (fetchError || !data) {
        setError(fetchError?.message ?? 'Unknown OAuth client.');
      } else {
        setClient(data);
      }
      setLoading(false);
    }

    loadClient();
    return () => {
      cancelled = true;
    };
  }, [request.client_id]);

  async function handleDecision(approve) {
    setSubmitting(true);
    setError(null);
    const { data, error: submitError } = await submitAgentConsentDecision({
      accessToken: session.access_token,
      approve,
      ...request
    });
    setSubmitting(false);
    if (submitError) {
      setError(submitError.message);
      return;
    }
    if (data?.redirectTo) {
      window.location.assign(data.redirectTo);
    }
  }

  return (
    <main className="container agent-consent-screen" data-testid="agent-consent-screen">
      <h1>Authorize agent access</h1>
      <p className="subtitle">
        {client?.client_name ?? request.client_id} wants permission to read your workout history and plan workouts in GymTrack.
      </p>

      {loading ? <p data-testid="agent-consent-loading">Loading consent details…</p> : null}

      {error ? (
        <div className="status show error" role="alert" data-testid="agent-consent-error">
          {error}
        </div>
      ) : null}

      {!loading && !error ? (
        <section className="workout-card connected-agent-card" data-testid="agent-consent-card">
          <h2>{client?.client_name ?? request.client_id}</h2>
          <p className="workout-card-meta">Redirect: {request.redirect_uri}</p>
          <ul>
            {scopeList(request.scope).map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
          <div className="btn-row">
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={() => handleDecision(false)}
              data-testid="agent-consent-deny"
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting}
              onClick={() => handleDecision(true)}
              data-testid="agent-consent-approve"
            >
              {submitting ? 'Authorizing…' : 'Approve access'}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
