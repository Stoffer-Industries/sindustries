import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listPendingPlannedWorkouts } from '../lib/plans.js';
import { useAuth } from '../lib/auth.jsx';
import WorkoutCard from './WorkoutCard.jsx';

/**
 * `/workouts` tab — lists the signed-in user's pending planned workouts
 * (status `planned` or `started`), soonest-first, with a Today/Overdue
 * visual distinction. Tapping a card lands on the log screen with the
 * workout's date pre-selected via `?date=`. The "Connect to your agent"
 * CTA (AC3/AC4) ships in a separate WS2 PR — it depends on the OAuth flow
 * from sibling task `1474d515`.
 */
export default function WorkoutsTab() {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [workouts, setWorkouts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const { data, error: fetchErr } = await listPendingPlannedWorkouts();
      if (cancelled) return;
      if (fetchErr) {
        setError(fetchErr.message);
        setWorkouts(null);
      } else {
        setWorkouts(data ?? []);
      }
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <main className="container workouts-tab" data-testid="workouts-tab">
      <header className="screen-header">
        <h1>Workouts</h1>
        <nav className="screen-tabs">
          <Link to="/workout" className="tab" data-testid="tab-workout">
            Log
          </Link>
          <Link to="/history" className="tab" data-testid="tab-history">
            History
          </Link>
          <Link to="/workouts" className="tab active" data-testid="tab-workouts">
            Workouts
          </Link>
          <button
            type="button"
            className="btn-ghost"
            onClick={handleSignOut}
            data-testid="sign-out"
          >
            Sign out
          </button>
        </nav>
      </header>

      <h2 className="section-title">Pending workouts</h2>

      {loading ? <p data-testid="workouts-loading">Loading planned workouts…</p> : null}

      {error ? (
        <div className="status show error" role="alert" data-testid="workouts-error">
          {error}
        </div>
      ) : null}

      {!loading && !error && workouts && workouts.length === 0 ? (
        <p className="empty-hint" data-testid="workouts-empty">
          No upcoming workouts. Connect an agent (coming soon) to have your training
          planned here.
        </p>
      ) : null}

      {!loading && !error && workouts && workouts.length > 0 ? (
        <ul className="workout-cards" data-testid="workout-cards">
          {workouts.map((w) => (
            <li key={w.id} className="workout-card-item">
              <WorkoutCard workout={w} />
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
