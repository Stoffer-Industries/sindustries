import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClerkProvider } from '@clerk/react';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { getActiveProvider, getClerkPublishableKey } from './lib/clerkConfig.js';
import './styles/index.css';

/**
 * Read the provider flag once at module load. Vite inlines the env var
 * into the bundle at build time, so the branch below is deterministic
 * per deployment — no runtime env inspection needed.
 */
const activeProvider = getActiveProvider();
const clerkPublishableKey =
  activeProvider === 'clerk' ? getClerkPublishableKey() : '';

/**
 * When the provider is Clerk, wrap the entire app in <ClerkProvider> so
 * the ClerkAuthProvider inside <AuthProvider> can call useSession() /
 * useUser() / useSignIn() / etc. without throwing. When the provider is
 * Supabase, ClerkProvider is omitted entirely — keeps Clerk out of the
 * runtime graph on existing deployments.
 *
 * The Clerk `routerPush` / `routerReplace` hooks are left at their
 * defaults (window.location navigation) for this slice; once the cutover
 * is permanent we can pass `routerPush` / `routerReplace` from
 * react-router's useNavigate to keep client-side transitions during the
 * hosted account portal round-trip. Out of scope for Slice A.
 */
const root = (
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);

createRoot(document.getElementById('root')).render(
  activeProvider === 'clerk' ? (
    <ClerkProvider publishableKey={clerkPublishableKey}>{root}</ClerkProvider>
  ) : (
    root
  )
);
