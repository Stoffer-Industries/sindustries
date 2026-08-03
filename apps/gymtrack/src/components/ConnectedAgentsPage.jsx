import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listConnectedAgents, revokeConnectedAgent } from '../lib/connectedAgents.js';

function scopeSummary(scope) {
  return String(scope)
    .split(/\s+/)
    .filter(Boolean)
    .join(' · ');
}

export default function ConnectedAgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error: fetchError } = await listConnectedAgents();
    if (fetchError) {
      setError(fetchError.message);
      setAgents([]);
    } else {
      setAgents(data ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRevoke(consentId) {
    setBusyId(consentId);
    setError(null);
    const { error: revokeError } = await revokeConnectedAgent(consentId);
    setBusyId(null);
    if (revokeError) {
      setError(revokeError.message);
      return;
    }
    await load();
  }

  return (
    <main className="container connected-agents-screen" data-testid="connected-agents-screen">
      <header className="screen-header">
        <h1>Connected agents</h1>
        <nav className="screen-tabs">
          <Link to="/workout" className="tab" data-testid="tab-workout">
            Log
          </Link>
          <Link to="/history" className="tab" data-testid="tab-history">
            History
          </Link>
          <Link to="/workouts" className="tab" data-testid="tab-workouts">
            Workouts
          </Link>
          <Link to="/settings/agents" className="tab active" data-testid="tab-agents">
            Agents
          </Link>
        </nav>
      </header>

      <p className="subtitle">Review which external MCP clients can act on your behalf.</p>

      {loading ? <p data-testid="connected-agents-loading">Loading connected agents…</p> : null}

      {error ? (
        <div className="status show error" role="alert" data-testid="connected-agents-error">
          {error}
        </div>
      ) : null}

      {!loading && !error && agents.length === 0 ? (
        <p data-testid="connected-agents-empty">
          No agents connected yet. Start from Claude or ChatGPT and approve the GymTrack consent screen.
        </p>
      ) : null}

      {!loading && !error && agents.length > 0 ? (
        <ul className="workout-cards" data-testid="connected-agents-list">
          {agents.map((agent) => (
            <li key={agent.id} className="workout-card-item" data-testid={`connected-agent-${agent.id}`}>
              <article className="workout-card connected-agent-card">
                <div className="workout-card-header">
                  <div>
                    <h2>{agent.clientName}</h2>
                    <p className="workout-card-meta">{scopeSummary(agent.scope)}</p>
                    <p className="workout-card-meta">Connected {new Date(agent.grantedAt).toLocaleString()}</p>
                    <p className="workout-card-meta">
                      {agent.lastUsedAt
                        ? `Last used ${new Date(agent.lastUsedAt).toLocaleString()}`
                        : 'Not used yet'}
                    </p>
                  </div>
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busyId === agent.id}
                    onClick={() => handleRevoke(agent.id)}
                    data-testid={`revoke-agent-${agent.id}`}
                  >
                    {busyId === agent.id ? 'Revoking…' : 'Revoke access'}
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
