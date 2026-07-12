import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

/**
 * Email + password sign-in. On success, routes to the originally intended
 * destination (or /workout by default). Errors render inline.
 */
export default function LoginScreen() {
  const { session, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname ?? '/workout';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (session) {
    return <Navigate to={from} replace />;
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
      <p className="subtitle">Sign in to log a workout</p>

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
    </main>
  );
}