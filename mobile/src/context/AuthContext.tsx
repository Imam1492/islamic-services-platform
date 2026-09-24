import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from 'react';
import type { Session, User, AuthError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface SignInWithOtpParams {
  phone: string;
}

export interface VerifyOtpParams {
  phone: string;
  token: string;
}

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithOtp: (params: SignInWithOtpParams) => Promise<{ error: AuthError | null }>;
  verifyOtp: (params: VerifyOtpParams) => Promise<{
    session: Session | null;
    user: User | null;
    error: AuthError | null;
  }>;
  signOut: () => Promise<{ error: AuthError | null }>;
  refreshSession: () => Promise<{
    session: Session | null;
    user: User | null;
    error: AuthError | null;
  }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;

    // Deterministic initial session retrieval
    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession }, error }) => {
        if (!isMounted) return;
        if (error) {
          setSession(null);
        } else {
          setSession(initialSession);
        }
        setLoading(false);
      })
      .catch(() => {
        if (isMounted) {
          setSession(null);
          setLoading(false);
        }
      });

    // Single active auth state change listener
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (isMounted) {
        setSession(currentSession);
        setLoading(false);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signInWithOtp = useCallback(async ({ phone }: SignInWithOtpParams) => {
    const { error } = await supabase.auth.signInWithOtp({
      phone,
    });
    return { error };
  }, []);

  const verifyOtp = useCallback(async ({ phone, token }: VerifyOtpParams) => {
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token,
      type: 'sms',
    });
    return { session: data.session, user: data.user, error };
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  }, []);

  const refreshSession = useCallback(async () => {
    const { data, error } = await supabase.auth.refreshSession();
    return { session: data.session, user: data.user, error };
  }, []);

  const user = session?.user ?? null;

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      loading,
      signInWithOtp,
      verifyOtp,
      signOut,
      refreshSession,
    }),
    [session, user, loading, signInWithOtp, verifyOtp, signOut, refreshSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
