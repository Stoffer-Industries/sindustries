import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

/**
 * Wraps protected routes. While loading, renders a small placeholder.
 * If no session, redirects to /login and preserves the intended destination.
 */
export default function AuthGate({ children }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="auth-gate-loading" data-testid="auth-gate-loading">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}