import { Navigate, Route, Routes } from 'react-router-dom';
import AuthGate from './components/AuthGate.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import SignUpPage from './components/SignUpPage.jsx';
import WorkoutLogger from './components/WorkoutLogger.jsx';
import HistoryList from './components/HistoryList.jsx';
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}