import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';

const AuthContext = createContext(null);

/**
 * AuthProvider exposes { session, user, loading, signIn, signUp, signOut }.
 * - session: current Supabase session or null
 * - user: current authenticated user (session.user) or null
 * - loading: true until the initial session has been resolved
 * - signIn(email, password): returns { data, error } from Supabase
 * - signUp(email, password): returns { data, error } from Supabase
 * - signOut(): returns { error } from Supabase
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;
      setSession(newSession ?? null);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      async signIn(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        return { data, error };
      },
      async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        return { data, error };
      },
      async signOut() {
        const { error } = await supabase.auth.signOut();
        return { error };
      }
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}