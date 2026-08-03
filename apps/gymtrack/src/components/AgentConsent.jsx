import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import {
  DISABLED_OAUTH_PROVIDERS,
  SUPPORTED_OAUTH_PROVIDERS,
  signInWithOAuthRedirect,
  getPostOAuthSession
} from '../lib/authFlow.js';
import { supabase } from '../lib/supabase.js';

/**
 * Mounted at `/agent-consent`. Renders the consent screen an MCP client
 * lands on after `/api/oauth/authorize` redirects the user-agent here.
 *
 * Flow:
 *   1. MCP client opens:
 *        GET /api/oauth/authorize?response_type=code&client_id=...&...
 *      which redirects to:
 *        GET /agent-consent?code=<auth-code>&client=<client_id>&redirect=<uri>&state=<state>
 *
 *   2. User sees this page. If not signed in, signs in with Google (or
 *      Apple once wired). After sign-in, the user reviews the requested
 *      scopes and clicks "Allow".
 *
 *   3. We POST to /api/oauth/signin with the code + the user's Supabase
 *      access_token. The server binds user_id onto the code and returns
 *      the redirect_uri (with the same code + state echoed back).
 *
 *   4. We navigate the browser to redirect_uri. The MCP client receives
 *      the code and exchanges it at /api/oauth/token using its PKCE
 *      verifier (browser-side or server-side depending on client type).
 *
 * Failure modes:
 *   - Missing required query params → render an error explaining the URL
 *     is malformed and to retry the OAuth flow from the client.
 *   - Sign-in failure → surface Supabase error inline.
 *   - /api/oauth/signin failure → surface server error inline.
 *   - User clicks "Deny" → navigate to redirect_uri?error=access_denied
 *     (RFC 6749 §4.1.2.1) so the client can handle the refusal.
 */
const INITIAL_AVAILABLE_PROVIDERS = SUPPORTED_OAUTH_PROVIDERS.filter(
  (p) => !DISABLED_OAUTH_PROVIDERS.includes(p)
);

const SCOPE_DESCRIPTIONS = {
  'workouts:read': 'Read your workout history and planned workouts',
  'workouts:write': 'Plan workouts on your behalf',
  'exercises:read': 'Read your exercise progression data'
};

export default function AgentConsent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { session, loading } = useAuth();

  const code = searchParams.get('code');
  const client = searchParams.get('client');
  const redirect = searchParams.get('redirect');
  const state = searchParams.get('state');

  const [scopeList, setScopeList] = useState([]);
  const [scopeError, setScopeError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [availableProviders, setAvailableProviders] = useState(
    INITIAL_AVAILABLE_PROVIDERS
  );
  const [denying, setDenying] = useState(false);

  // Look up the client row to render display_name + scopes. We do this
  // client-side through Supabase so the consent page works without a
  // separate /api/oauth/clients/:id endpoint. RLS on gymtrack_oauth_clients
  // is admin-only by design — we have to use a service-role read. Since
  // we are in the browser, we use the adminClient via a small serverless
  // lookup instead. For simplicity we ship the scopes embedded in the
  // /authorize redirect query string as a fallback.
  useEffect(() => {
    if (!code || !client) {
      setScopeError('This consent URL is missing required parameters. Restart the agent authorization flow.');
      return;
    }
    // The /authorize handler includes the requested scope in the
    // redirect query so the consent page can render the allowlist
    // without a separate lookup. Format: scope=<space-separated scopes>.
    const scopeParam = searchParams.get('scope');
    if (scopeParam) {
      setScopeList(scopeParam.split(/\s+/).filter(Boolean));
    } else {
      setScopeList([]);
    }
  }, [code, client, searchParams]);

  if (loading) {
    return (
      <main className="container agent-consent" data-testid="agent-consent-loading">
        <p>Loading…</p>
      </main>
    );
  }

  if (scopeError) {
    return (
      <main className="container agent-consent" data-testid="agent-consent-error">
        <h1>Cannot complete authorization</h1>
        <p className="status show error" role="alert">{scopeError}</p>
        <p>
          <a href="/">Return to GymTrack</a>
        </p>
      </main>
    );
  }

  if (!session) {
    return (
      <ConsentSignIn
        client={client}
        availableProviders={availableProviders}
        setAvailableProviders={setAvailableProviders}
        setError={setError}
        error={error}
        onSignedIn={() => {
          // After OAuth round-trip, the auth context will update and this
          // component re-renders with `session` set.
          void getPostOAuthSession();
        }}
      />
    );
  }

  async function handleApprove() {
    setError(null);
    setSubmitting(true);
    try {
      // Use the user's current Supabase access token. The Supabase SDK
      // exposes this via session.access_token; we refresh defensively in
      // case the page has been open for >1h.
      const { data: refreshed, error: refreshErr } = await supabase.auth.getSession();
      if (refreshErr || !refreshed?.session?.access_token) {
        setError('Your sign-in has expired. Please sign in again.');
        setSubmitting(false);
        return;
      }
      const accessToken = refreshed.session.access_token;

      const resp = await fetch('/api/oauth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, access_token: accessToken })
      });
      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(payload?.message ?? `Approval failed (HTTP ${resp.status}).`);
        setSubmitting(false);
        return;
      }
      // payload.redirect_uri already has code + state echoed back.
      window.location.assign(payload.redirect_uri);
    } catch (err) {
      setError(err?.message ?? 'Approval failed.');
      setSubmitting(false);
    }
  }

  function handleDeny() {
    setDenying(true);
    if (!redirect) {
      // No redirect to send the error to — render inline.
      setError('Authorization denied.');
      return;
    }
    try {
      const url = new URL(redirect);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      window.location.assign(url.toString());
    } catch {
      setError('Authorization denied.');
    }
  }

  return (
    <main className="container agent-consent" data-testid="agent-consent-pending">
      <h1>Authorize an agent</h1>
      <p className="subtitle">
        <strong data-testid="agent-consent-client">{client}</strong> wants to access your GymTrack account.
      </p>

      <section className="scopes" data-testid="agent-consent-scopes">
        <h2>This agent will be able to:</h2>
        {scopeList.length === 0 ? (
          <p className="status">No scopes requested.</p>
        ) : (
          <ul>
            {scopeList.map((s) => (
              <li key={s} data-testid={`agent-consent-scope-${s}`}>
                {SCOPE_DESCRIPTIONS[s] ?? s}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted">
        You can revoke this access anytime from Settings → Connected Agents.
      </p>

      {error ? (
        <div className="status show error" role="alert" data-testid="agent-consent-error">
          {error}
        </div>
      ) : null}

      <div className="btn-row">
        <button
          type="button"
          className="btn-primary"
          onClick={handleApprove}
          disabled={submitting || denying}
          data-testid="agent-consent-approve"
        >
          {submitting ? 'Authorizing…' : 'Allow'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleDeny}
          disabled={submitting || denying}
          data-testid="agent-consent-deny"
        >
          Deny
        </button>
      </div>
    </main>
  );
}

function ConsentSignIn({ client, availableProviders, setAvailableProviders, setError, error, onSignedIn }) {
  async function handleOAuth(provider) {
    setError(null);
    const { data, error: oauthError, providerDisabled } =
      await signInWithOAuthRedirect(provider);
    if (providerDisabled) {
      setAvailableProviders((prev) => prev.filter((p) => p !== provider));
      setError(`Sign-in with ${provider} is not available right now. Try another option.`);
      return;
    }
    if (oauthError) {
      setError(oauthError.message);
      return;
    }
    if (data?.url) {
      // Supabase sends the browser to the provider, then back to our
      // redirect URL. The auth context picks up the session on return.
      window.location.assign(data.url);
      onSignedIn();
    }
  }

  return (
    <main className="container agent-consent" data-testid="agent-consent-signin">
      <h1>Sign in to authorize</h1>
      <p className="subtitle">
        <strong>{client}</strong> is requesting access to your GymTrack account.
        Sign in to continue.
      </p>

      <div className="oauth-row" data-testid="agent-consent-oauth-row">
        {availableProviders.length === 0 ? (
          <p className="status show error" role="alert">
            Social sign-in is temporarily unavailable. Please use a different device.
          </p>
        ) : (
          availableProviders.map((provider) => (
            <button
              key={provider}
              type="button"
              className="btn-primary oauth-btn"
              onClick={() => handleOAuth(provider)}
              data-testid={`agent-consent-oauth-${provider}`}
            >
              Continue with {provider === 'google' ? 'Google' : provider === 'apple' ? 'Apple' : provider}
            </button>
          ))
        )}
      </div>

      {error ? (
        <div className="status show error" role="alert" data-testid="agent-consent-signin-error">
          {error}
        </div>
      ) : null}
    </main>
  );
}