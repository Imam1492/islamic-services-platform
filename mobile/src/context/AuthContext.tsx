import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from 'react';
import type { Session, User, AuthError } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase } from '../lib/supabase';

// Ensure browser session completes properly on Android and web
WebBrowser.maybeCompleteAuthSession();

export interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<{
    error: Error | AuthError | null;
    isCancelled?: boolean;
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

  const signInWithGoogle = useCallback(async (): Promise<{
    error: Error | AuthError | null;
    isCancelled?: boolean;
  }> => {
    try {
      const redirectUrl = Linking.createURL('auth/callback', {
        scheme: 'islamicservices',
      });

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUrl,
          skipBrowserRedirect: true,
        },
      });

      if (error) {
        return { error, isCancelled: false };
      }

      if (!data?.url) {
        return {
          error: new Error('Failed to obtain Google authentication URL'),
          isCancelled: false,
        };
      }

      const browserResult = await WebBrowser.openAuthSessionAsync(
        data.url,
        redirectUrl
      );

      if (browserResult.type === 'cancel' || browserResult.type === 'dismiss') {
        return { error: null, isCancelled: true };
      }

      if (browserResult.type === 'success' && browserResult.url) {
        const parsed = Linking.parse(browserResult.url);
        const code = parsed.queryParams?.code;

        if (typeof code === 'string' && code.length > 0) {
          const { error: exchangeError } =
            await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) {
            return { error: exchangeError, isCancelled: false };
          }
          return { error: null, isCancelled: false };
        }

        const queryError = parsed.queryParams?.error_description || parsed.queryParams?.error;
        if (queryError) {
          return {
            error: new Error(String(queryError)),
            isCancelled: false,
          };
        }
      }

      return { error: null, isCancelled: false };
    } catch (err: any) {
      return {
        error: err instanceof Error ? err : new Error('Unexpected authentication error'),
        isCancelled: false,
      };
    }
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
      signInWithGoogle,
      signOut,
      refreshSession,
    }),
    [session, user, loading, signInWithGoogle, signOut, refreshSession]
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
