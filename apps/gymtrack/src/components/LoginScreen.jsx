import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import {
  DISABLED_OAUTH_PROVIDERS,
  SUPPORTED_OAUTH_PROVIDERS,
  signInWithOAuthRedirect
} from '../lib/authFlow.js';

/**
 * Email + password sign-in. On success, routes to the originally intended
 * destination (or /workout by default). Errors render inline.
 */
const INITIAL_AVAILABLE_PROVIDERS = SUPPORTED_OAUTH_PROVIDERS.filter(
  (provider) => !DISABLED_OAUTH_PROVIDERS.includes(provider)
);

export default function LoginScreen() {
  const { session, signIn } = useAuth();
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
  const [availableProviders, setAvailableProviders] = useState(INITIAL_AVAILABLE_PROVIDERS);

  if (session) {
    return <Navigate to={from} replace />;
  }

  async function handleOAuth(provider) {
    setError(null);
    const { data, error: oauthError, providerDisabled } =
      await signInWithOAuthRedirect(provider, from);
    if (providerDisabled) {
      setAvailableProviders((prev) => prev.filter((value) => value !== provider));
      setError(`Sign-in with ${provider} is not available right now. Try another option.`);
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
    const { error: signInError } = await signIn(email, password);
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    navigate(from, { replace: true });
  }

  return (
    <main className="container login-screen">
      <h1>GymTrack</h1>
      <p className="subtitle">Sign in to continue</p>

      <div className="oauth-row" data-testid="login-oauth-row">
        {availableProviders.includes('google') ? (
          <button
            type="button"
            className="btn-primary oauth-google"
            onClick={() => handleOAuth('google')}
            data-testid="login-google"
          >
            Continue with Google
          </button>
        ) : null}

        {availableProviders.includes('apple') ? (
          <button
            type="button"
            className="btn-primary oauth-apple"
            onClick={() => handleOAuth('apple')}
            data-testid="login-apple"
          >
            Continue with Apple
          </button>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="login-form" data-testid="login-form">
        <label className="form-row">
          <span>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="login-email"
          />
        </label>
        <label className="form-row">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="login-password"
          />
        </label>

        {error ? (
          <div className="status show error" role="alert" data-testid="login-error">
            {error}
          </div>
        ) : null}

        <div className="btn-row">
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting}
            data-testid="login-submit"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>

      <p className="auth-alt" data-testid="login-create-account">
        New to GymTrack? <Link to="/signup" state={{ from: fromState }}>Create an account</Link>
      </p>
    </main>
  );
}