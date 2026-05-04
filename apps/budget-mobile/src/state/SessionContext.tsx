import React, { createContext, useContext, useMemo, useState } from 'react';

export type Session = {
  token: string;
  user: { id: string; email: string };
};

type SessionCtx = {
  session: Session | null;
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
};

const Ctx = createContext<SessionCtx>({
  session: null,
  // Default no-op; real setter comes from provider.
  setSession: () => {
    /* no-op */
  }
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const value = useMemo(() => ({ session, setSession }), [session]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}

