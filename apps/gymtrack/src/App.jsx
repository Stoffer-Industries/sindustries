import { Navigate, Route, Routes } from 'react-router-dom';
import AgentConsentPage from './components/AgentConsentPage.jsx';
import AgentOAuthCallbackPage from './components/AgentOAuthCallbackPage.jsx';
import AuthGate from './components/AuthGate.jsx';
import ConnectedAgentsPage from './components/ConnectedAgentsPage.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import SignUpPage from './components/SignUpPage.jsx';
import WorkoutLogger from './components/WorkoutLogger.jsx';
import HistoryList from './components/HistoryList.jsx';
import WorkoutsTab from './components/WorkoutsTab.jsx';
import { useAuth } from './lib/auth.jsx';

function Home() {
  const { session } = useAuth();
  if (!session) return <Navigate to="/login" replace />;
  return <Navigate to="/workout" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route
        path="/workout"
        element={
          <AuthGate>
            <WorkoutLogger />
          </AuthGate>
        }
      />
      <Route
        path="/history"
        element={
          <AuthGate>
            <HistoryList />
          </AuthGate>
        }
      />
      <Route
        path="/workouts"
        element={
          <AuthGate>
            <WorkoutsTab />
          </AuthGate>
        }
      />
      <Route
        path="/agent-consent"
        element={
          <AuthGate>
            <AgentConsentPage />
          </AuthGate>
        }
      />
      <Route
        path="/settings/agents"
        element={
          <AuthGate>
            <ConnectedAgentsPage />
          </AuthGate>
        }
      />
      {/* Hosted OAuth callback — intentionally NOT wrapped in <AuthGate>.
          The user lands here from the external MCP client after a redirect,
          possibly on a different device than the one that started the flow.
          The page is stateless (no server callback); the connecting app is
          responsible for exchanging the code at /oauth/token. See
          docs/runbooks/gymtrack-agent-connect.md for the loopback-vs-hosted
          split rationale. */}
      <Route path="/oauth/callback" element={<AgentOAuthCallbackPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}