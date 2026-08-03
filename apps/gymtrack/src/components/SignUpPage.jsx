import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import {
  DISABLED_OAUTH_PROVIDERS,
  SUPPORTED_OAUTH_PROVIDERS,
  signInWithOAuthRedirect
} from '../lib/authFlow.js';

/**
 * The set of OAuth buttons rendered on first paint. Excludes any provider
 * that is currently in `DISABLED_OAUTH_PROVIDERS` (i.e. known to be
 * unconfigured on the Supabase project — Apple today). This is the fix for
 * the authFlow.js directive: the Apple button MUST NOT render until Apple
 * is wired up.
 *
 * `useState` with this as the initial value lets us drop a provider from
 * the list at click time if the `providerDisabled` heuristic catches a
 * provider failing at the Supabase call (e.g. config drift between deploys).
 */
const INITIAL_AVAILABLE_PROVIDERS = SUPPORTED_OAUTH_PROVIDERS.filter(
  (p) => !DISABLED_OAUTH_PROVIDERS.includes(p)
);

/**
 * Public sign-up page. Mounted at `/signup`.
 *
 * Layout:
 *   - Two OAuth CTAs (Google, Apple) as the primary path — Apple is hidden
 *     on first paint because it is in `DISABLED_OAUTH_PROVIDERS`.
 *   - Collapsed "Use email + password" panel as the secondary path.
 *
 * On success (OAuth redirect lands back authenticated, or email signUp
 * resolves with a session), redirects to `/workout`. The `/workout` route
 * already exists; an empty-history state is rendered for fresh users.
 */
export default function SignUpPage() {
  const { session, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = location.state?.from;
  const from = fromState
    ? `${fromState.pathname ?? '/workout'}${fromState.search ?? ''}`
    : '/workout';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [emailPanelOpen, setEmailPanelOpen] = useState(false);
  const [availableProviders, setAvailableProviders] = useState(
    INITIAL_AVAILABLE_PROVIDERS
  );

  if (session) {
    return <Navigate to={from} replace />;
  }

  async function handleOAuth(provider) {
    setError(null);
    const { data, error: oauthError, providerDisabled } =
      await signInWithOAuthRedirect(provider, from);
    if (providerDisabled) {
      // Mark this provider as disabled in the UI by removing it from the
      // available list so the button disappears on re-render.
      setAvailableProviders((prev) => prev.filter((p) => p !== provider));
      setError(`Sign-up with ${provider} is not available right now. Try another option.`);
      return;
    }
    if (oauthError) {
      setError(oauthError.message);
      return;
    }
    if (data?.url) {
      window.location.assign(data.url);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signUpError } = await signUp(email, password);
    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    navigate(from, { replace: true });
  }

  return (
    <main className="container signup-screen">
      <h1>Create your GymTrack account</h1>
      <p className="subtitle">Pick the easiest way to get started.</p>

      <div className="oauth-row" data-testid="signup-oauth-row">
        {availableProviders.length === 0 ? (
          <p className="status show error" role="alert" data-testid="signup-no-providers">
            Social sign-up is temporarily unavailable. Please use email + password below.
          </p>
        ) : null}

        {availableProviders.includes('google') ? (
          <button
            type="button"
            className="btn-primary oauth-google"
            onClick={() => handleOAuth('google')}
            data-testid="signup-google"
          >
            Continue with Google
          </button>
        ) : null}

        {availableProviders.includes('apple') ? (
          <button
            type="button"
            className="btn-primary oauth-apple"
            onClick={() => handleOAuth('apple')}
            data-testid="signup-apple"
          >
            Continue with Apple
          </button>
        ) : null}
      </div>

      {emailPanelOpen ? (
        <form onSubmit={handleSubmit} className="signup-form" data-testid="signup-form">
          <label className="form-row">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="signup-email"
            />
          </label>
          <label className="form-row">
            <span>Password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="signup-password"
            />
          </label>

          {error ? (
            <div className="status show error" role="alert" data-testid="signup-error">
              {error}
            </div>
          ) : null}

          <div className="btn-row">
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting}
              data-testid="signup-submit"
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setEmailPanelOpen(true)}
          data-testid="signup-show-email"
        >
          Use email + password instead
        </button>
      )}

      <p className="auth-alt" data-testid="signup-signin-link">
        Already have an account? <Link to="/login" state={{ from: fromState }}>Sign in</Link>
      </p>
    </main>
  );
}