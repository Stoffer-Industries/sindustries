import { useAuth, useClerk, useUser } from '@clerk/expo';
import { useHostedAuth } from '@clerk/expo/hosted-auth';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Session = {
  token: string;
  user: { id: string; email: string };
};

type SessionCtx = {
  session: Session | null;
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  startSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  authLoaded: boolean;
};

const Ctx = createContext<SessionCtx>({
  session: null,
  setSession: () => {
    /* no-op */
  },
  startSignIn: async () => {},
  signOut: async () => {},
  authLoaded: false
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user, isLoaded: userLoaded } = useUser();
  const { signOut: clerkSignOut } = useClerk();
  const { startHostedAuth } = useHostedAuth();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let active = true;
    async function refreshSession() {
      if (!authLoaded || !userLoaded || !isSignedIn || !user) {
        if (active) setSession(null);
        return;
      }
      const token = await getToken();
      if (!active) return;
      setSession(token ? {
        token,
        user: { id: user.id, email: user.primaryEmailAddress?.emailAddress ?? '' }
      } : null);
    }
    void refreshSession();
    const timer = setInterval(() => void refreshSession(), 45_000);
    return () => { active = false; clearInterval(timer); };
  }, [authLoaded, getToken, isSignedIn, user, userLoaded]);

  const value = useMemo(() => ({
    session,
    setSession,
    startSignIn: async () => { await startHostedAuth({ mode: 'sign-in' }); },
    signOut: () => clerkSignOut(),
    authLoaded
  }), [authLoaded, clerkSignOut, session, startHostedAuth]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}
