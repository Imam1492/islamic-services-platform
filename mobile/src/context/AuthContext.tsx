import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
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

export function isAuthCallbackUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = Linking.parse(url);
    const hostname = parsed.hostname || '';
    const path = parsed.path ? parsed.path.replace(/^\/+|\/+$/g, '') : '';
    const combined = [hostname, path].filter(Boolean).join('/');
    return (
      combined === 'auth/callback' ||
      combined.startsWith('auth/callback') ||
      url.includes('auth/callback') ||
      (url.startsWith('islamicservices://auth') &&
        (url.includes('code=') || url.includes('error=')))
    );
  } catch {
    return (
      url.includes('auth/callback') ||
      (url.startsWith('islamicservices://') && url.includes('code='))
    );
  }
}

export function extractCodeFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = Linking.parse(url);
    const code = parsed.queryParams?.code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code.trim();
    }
  } catch {}
  const match = url.match(/[?&#]code=([^&#]+)/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return null;
}

export function extractErrorFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = Linking.parse(url);
    const err = parsed.queryParams?.error_description || parsed.queryParams?.error;
    if (typeof err === 'string' && err.trim().length > 0) {
      return err.trim();
    }
  } catch {}
  const match = url.match(/[?&#]error(?:_description)?=([^&#]+)/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return null;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const processedCodesRef = useRef<Set<string>>(new Set());
  const inFlightExchangesRef = useRef<
    Map<string, Promise<{ error: Error | AuthError | null }>>
  >(new Map());
  const activeCallbackListenerRef = useRef<
    | ((res: {
        error: Error | AuthError | null;
        isCancelled?: boolean;
      }) => void)
    | null
  >(null);
  const callbackReceivedRef = useRef<boolean>(false);

  const exchangeAuthCode = useCallback(
    async (code: string): Promise<{ error: Error | AuthError | null }> => {
      // Deduplicate: avoid re-exchanging already consumed codes
      if (processedCodesRef.current.has(code)) {
        return { error: null };
      }

      // Reuse active exchange if already in flight
      const existingPromise = inFlightExchangesRef.current.get(code);
      if (existingPromise) {
        return existingPromise;
      }

      const promise = (async () => {
        try {
          console.log('[AuthContext] Exchanging OAuth authorization code for session');
          const { error: exchangeError } =
            await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) {
            console.warn('[AuthContext] exchangeCodeForSession failed:', exchangeError.message);
            return { error: exchangeError };
          }
          processedCodesRef.current.add(code);
          console.log('[AuthContext] Successfully exchanged code and established session');
          return { error: null };
        } catch (err: any) {
          console.warn('[AuthContext] Unexpected error during code exchange');
          return {
            error:
              err instanceof Error
                ? err
                : new Error('Failed to exchange authorization code'),
          };
        } finally {
          inFlightExchangesRef.current.delete(code);
        }
      })();

      inFlightExchangesRef.current.set(code, promise);
      return promise;
    },
    []
  );

  const processIncomingUrl = useCallback(
    async (
      url: string | null
    ): Promise<{ error: Error | AuthError | null; handled: boolean }> => {
      if (!url || !isAuthCallbackUrl(url)) {
        return { error: null, handled: false };
      }

      console.log('[AuthContext] Detected auth callback URL');
      callbackReceivedRef.current = true;

      const queryError = extractErrorFromUrl(url);
      if (queryError) {
        console.warn('[AuthContext] OAuth callback contains provider error');
        const err = new Error(queryError);
        if (activeCallbackListenerRef.current) {
          activeCallbackListenerRef.current({
            error: err,
            isCancelled: false,
          });
          activeCallbackListenerRef.current = null;
        }
        return { error: err, handled: true };
      }

      const code = extractCodeFromUrl(url);
      if (!code) {
        console.warn('[AuthContext] Auth callback URL missing code parameter');
        return { error: null, handled: true };
      }

      const res = await exchangeAuthCode(code);
      if (activeCallbackListenerRef.current) {
        activeCallbackListenerRef.current({
          error: res.error,
          isCancelled: false,
        });
        activeCallbackListenerRef.current = null;
      }
      return { error: res.error, handled: true };
    },
    [exchangeAuthCode]
  );

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
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      if (isMounted) {
        setSession(currentSession);
        setLoading(false);
      }
    });

    // Persistent Linking URL listener for warm app callback handling
    let linkingSubscription: { remove: () => void } | null = null;
    if (typeof Linking.addEventListener === 'function') {
      linkingSubscription = Linking.addEventListener('url', ({ url }) => {
        if (isMounted) {
          processIncomingUrl(url).catch(() => {});
        }
      });
    }

    // Cold-start URL check
    if (typeof Linking.getInitialURL === 'function') {
      Linking.getInitialURL()
        .then((initialUrl) => {
          if (isMounted && initialUrl) {
            processIncomingUrl(initialUrl).catch(() => {});
          }
        })
        .catch(() => {});
    }

    return () => {
      isMounted = false;
      authSubscription.unsubscribe();
      if (linkingSubscription && typeof linkingSubscription.remove === 'function') {
        linkingSubscription.remove();
      }
    };
  }, [processIncomingUrl]);

  const signInWithGoogle = useCallback(async (): Promise<{
    error: Error | AuthError | null;
    isCancelled?: boolean;
  }> => {
    try {
      callbackReceivedRef.current = false;
      const redirectUrl = Linking.createURL('auth/callback', {
        scheme: 'islamicservices',
      });

      console.log('[AuthContext] Initiating Google OAuth with redirect:', redirectUrl);
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

      // Coordinate callback receipt between WebBrowser and persistent Linking listener
      let callbackResult: {
        error: Error | AuthError | null;
        isCancelled?: boolean;
      } | null = null;

      const callbackPromise = new Promise<{
        error: Error | AuthError | null;
        isCancelled?: boolean;
      }>((resolve) => {
        activeCallbackListenerRef.current = (res) => {
          callbackResult = res;
          resolve(res);
        };
      });

      // Launch the browser authentication session
      const browserResult = await WebBrowser.openAuthSessionAsync(
        data.url,
        redirectUrl
      );

      console.log('[AuthContext] WebBrowser finished with type:', browserResult.type);

      // Scenario 1: WebBrowser directly returns { type: 'success', url }
      if (browserResult.type === 'success' && browserResult.url) {
        activeCallbackListenerRef.current = null;
        const res = await processIncomingUrl(browserResult.url);
        return { error: res.error, isCancelled: false };
      }

      // If callback was already processed during this time, return immediately
      if (callbackResult) {
        activeCallbackListenerRef.current = null;
        return callbackResult;
      }

      // Scenario 2: Explicit cancellation on platforms that report 'cancel'
      if (browserResult.type === 'cancel' && !callbackReceivedRef.current) {
        activeCallbackListenerRef.current = null;
        return { error: null, isCancelled: true };
      }

      // Scenario 3: Android Chrome Custom Tabs 'dismiss'
      // On Android, openAuthSessionAsync resolves with 'dismiss' prematurely
      // when MainActivity resumes from Chrome Custom Tabs, often before Linking dispatches.
      // Allow a generous grace period for the incoming deep-link callback.
      const gracePeriodMs = process.env.NODE_ENV === 'test' ? 60 : 3500;
      const graceTimeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), gracePeriodMs)
      );

      const raceWinner = await Promise.race([callbackPromise, graceTimeout]);

      if (raceWinner !== 'timeout') {
        activeCallbackListenerRef.current = null;
        return raceWinner;
      }

      // If a callback was received and code exchange is in flight, wait for completion
      if (callbackReceivedRef.current) {
        const finalResult = await callbackPromise;
        activeCallbackListenerRef.current = null;
        return finalResult;
      }

      // Check if the intent URL was captured as initialURL during activity transition
      if (typeof Linking.getInitialURL === 'function') {
        try {
          const fallbackUrl = await Linking.getInitialURL();
          if (fallbackUrl && isAuthCallbackUrl(fallbackUrl)) {
            activeCallbackListenerRef.current = null;
            const res = await processIncomingUrl(fallbackUrl);
            return { error: res.error, isCancelled: false };
          }
        } catch {}
      }

      // Genuine cancellation: No OAuth callback was received during the grace window
      console.log('[AuthContext] No auth callback received; treating as user cancellation');
      activeCallbackListenerRef.current = null;
      return { error: null, isCancelled: true };
    } catch (err: any) {
      activeCallbackListenerRef.current = null;
      return {
        error:
          err instanceof Error
            ? err
            : new Error('Unexpected authentication error'),
        isCancelled: false,
      };
    }
  }, [processIncomingUrl]);

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

