import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listPendingPlannedWorkouts } from '../lib/plans.js';
import { listConnectedAgents } from '../lib/connectedAgents.js';
import { useAuth } from '../lib/auth.jsx';
import ConnectAgentCta from './ConnectAgentCta.jsx';
import WorkoutCard from './WorkoutCard.jsx';

/**
 * `/workouts` tab — lists the signed-in user's pending planned workouts
 * (status `planned` or `started`), soonest-first, with a Today/Overdue
 * visual distinction. Tapping a card lands on the log screen with the
 * workout's date pre-selected via `?date=`. Users without an active OAuth
 * consent also get provider-specific links into Claude or ChatGPT's real MCP
 * connector setup, where the agent initiates the PKCE authorization flow.
 */
export default function WorkoutsTab() {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const [workouts, setWorkouts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connectedAgents, setConnectedAgents] = useState(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState(null);

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

  useEffect(() => {
    let cancelled = false;
    async function loadAgents() {
      setAgentsLoading(true);
      setAgentsError(null);
      const { data, error: fetchErr } = await listConnectedAgents();
      if (cancelled) return;
      if (fetchErr) {
        setAgentsError(fetchErr.message);
        setConnectedAgents(null);
      } else {
        setConnectedAgents(data ?? []);
      }
      setAgentsLoading(false);
    }
    loadAgents();
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
          <Link to="/settings/agents" className="tab" data-testid="tab-agents">
            Agents
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

      {!agentsLoading && !agentsError && connectedAgents?.length === 0 ? (
        <ConnectAgentCta />
      ) : null}

      {agentsError ? (
        <div className="status show error" role="alert" data-testid="agents-status-error">
          Could not check agent connections: {agentsError}
        </div>
      ) : null}

      <h2 className="section-title">Pending workouts</h2>

      {loading ? <p data-testid="workouts-loading">Loading planned workouts…</p> : null}

      {error ? (
        <div className="status show error" role="alert" data-testid="workouts-error">
          {error}
        </div>
      ) : null}

      {!loading && !error && workouts && workouts.length === 0 ? (
        <p className="empty-hint" data-testid="workouts-empty">
          No upcoming workouts yet. Once connected, your agent can plan one for you.
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
