import { useEffect, useState } from 'react';
import { useAuth, useClerk } from '@clerk/react';
import { fetchAuthSession } from '../tasksApi.js';
import { clearTokenGetter, setTokenGetter } from './token.js';

export function AuthBoundary({ children }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const [authorization, setAuthorization] = useState('checking');

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      void clerk.redirectToSignIn({
        redirectUrl: window.location.href,
        withSignUp: false
      });
    }
  }, [clerk, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return undefined;
    let cancelled = false;
    const getter = () => getToken();
    setTokenGetter(getter);
    setAuthorization('checking');
    fetchAuthSession()
      .then(() => { if (!cancelled) setAuthorization('authorized'); })
      .catch((error) => {
        if (!cancelled) setAuthorization(error?.status === 403 ? 'forbidden' : 'error');
      });
    return () => {
      cancelled = true;
      clearTokenGetter(getter);
    };
  }, [getToken, isLoaded, isSignedIn]);

  if (!isLoaded || !isSignedIn || authorization === 'checking') {
    return <main role="status" aria-live="polite">Loading…</main>;
  }
  if (authorization === 'forbidden') {
    return <main role="alert"><h1>Not authorized</h1><p>This account does not have access to Mission Control.</p></main>;
  }
  if (authorization === 'error') {
    return <main role="alert"><h1>Unable to verify access</h1><p>Refresh the page to try again.</p></main>;
  }
  return children;
}
