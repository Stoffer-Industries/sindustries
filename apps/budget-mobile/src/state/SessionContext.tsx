import React, { createContext, useContext, useMemo, useState } from 'react';

export type Session = {
  token: string;
  user: { id: string; email: string };
};

type SessionCtx = {
  session: Session | null;
  setSession: (s: Session | null) => void;
};

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const value = useMemo(() => ({ session, setSession }), [session]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used within SessionProvider');
  return v;
}

