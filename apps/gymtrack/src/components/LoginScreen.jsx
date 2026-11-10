import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { oauthProviderLabel, useOAuthRedirect } from '../lib/useOAuthRedirect.js';
import {
  DISABLED_OAUTH_PROVIDERS,
  SUPPORTED_OAUTH_PROVIDERS
} from '../lib/authFlow.js';

/**
 * Email + password sign-in. On success, routes to the originally intended
 * destination (or /workout by default). Errors render inline.
 */
const INITIAL_AVAILABLE_PROVIDERS = SUPPORTED_OAUTH_PROVIDERS.filter(
  (provider) => !DISABLED_OAUTH_PROVIDERS.includes(provider)
);

export default function LoginScreen() {
  const { session, signIn, verifySignInCode } = useAuth();
  const {
    startOAuth,
    clearError: clearOAuthError,
    pending: oauthPending,
    error: oauthError,
    redirecting,
    provider: oauthProvider
  } = useOAuthRedirect();
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = location.state?.from;
  const from = fromState
    ? `${fromState.pathname ?? '/workout'}${fromState.search ?? ''}`
    : '/workout';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verificationMode, setVerificationMode] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [availableProviders, setAvailableProviders] = useState(INITIAL_AVAILABLE_PROVIDERS);

  if (session) {
    return <Navigate to={from} replace />;
  }

  async function handleOAuth(provider) {
    setError(null);
    // The shared hook owns the whole click contract: it never rejects, so a
    // provider that throws surfaces as a visible message instead of an
    // unhandled rejection (the silent no-op reported in task 7e7826c5).
    const result = await startOAuth(provider, from);
    if (result.providerDisabled) {
      setAvailableProviders((prev) => prev.filter((value) => value !== provider));
      setError(
        `Sign-in with ${oauthProviderLabel(provider)} is not available right now. Try another option.`
      );
      return;
    }
    if (result.error) {
      // The hook owns the provider error and already guarantees a non-empty
      // message, so it is not duplicated into the page-local error state.
      // Keeping the two sources exclusive is what stops a stale OAuth
      // error from shadowing — or outliving — the email flow.
      return;
    }
    if (result.data?.url) {
      window.location.assign(result.data.url);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    // The email flow owns the screen from here: drop any OAuth error so it
    // cannot linger above the email or verification form.
    clearOAuthError();
    const { data, error: signInError } = await signIn(email, password);
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    if (data?.needsVerification) {
      setVerificationMode(data.verificationMode);
      return;
    }
    navigate(from, { replace: true });
  }

  async function handleSecondFactorSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    clearOAuthError();
    const { error: verificationError } = await verifySignInCode(verificationCode, verificationMode);
    setSubmitting(false);
    if (verificationError) {
      setError(verificationError.message);
      return;
    }
    navigate(from, { replace: true });
  }

  const visibleError = error ?? (oauthError ? oauthError.message : null);

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
            disabled={oauthPending || redirecting}
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
            disabled={oauthPending || redirecting}
            data-testid="login-apple"
          >
            Continue with Apple
          </button>
        ) : null}

        {redirecting ? (
          <p className="status show" role="status" data-testid="login-oauth-status">
            Redirecting to {oauthProviderLabel(oauthProvider)}…
          </p>
        ) : null}
      </div>

      {/* Rendered outside the form on purpose: the error must be visible
          regardless of which form step is showing, so a failed OAuth click
          is never a silent no-op (task 7e7826c5). */}
      {visibleError ? (
        <div className="status show error" role="alert" data-testid="login-error">
          {visibleError}
        </div>
      ) : null}

      {verificationMode ? (
        <form onSubmit={handleSecondFactorSubmit} className="login-form" data-testid="login-verification-form">
          <p>
            {verificationMode === 'client_trust_email_code'
              ? 'We emailed you a verification code to confirm this browser.'
              : 'This account uses email verification. Enter the code we emailed you to sign in.'}
          </p>
          <label className="form-row">
            <span>Verification code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              data-testid="login-verification-code"
            />
          </label>
          <div className="btn-row">
            <button type="submit" className="btn-primary" disabled={submitting} data-testid="login-verify-submit">
              {submitting ? 'Verifying…' : 'Verify and sign in'}
            </button>
          </div>
        </form>
      ) : (
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

        <div id="clerk-captcha" data-testid="login-captcha" />
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
      )}

      <p className="auth-alt" data-testid="login-create-account">
        New to GymTrack? <Link to="/signup" state={{ from: fromState }}>Create an account</Link>
      </p>
    </main>
  );
}
