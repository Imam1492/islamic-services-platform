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
import { LargeSecureStoreAdapter } from '../lib/secureStorage';

// Ensure browser session completes properly on Android and web
WebBrowser.maybeCompleteAuthSession();

export type AuthNavigationGate = 'loading' | 'ready' | 'password-recovery' | 'storage-error';

export interface AuthContextValue {
  session: Session | null;
  authNavigationGate: AuthNavigationGate;
  authStorageFailure: boolean;
  clearLocalAuthState: () => Promise<{ error: AuthError | null }>;
  user: User | null;
  loading: boolean;
  passwordRecovery: boolean;
  passwordRecoveryPersistenceFailed: boolean;
  signInWithGoogle: () => Promise<{
    error: Error | AuthError | null;
    isCancelled?: boolean;
  }>;
  signUpWithEmail: (
    email: string,
    password: string
  ) => Promise<{ error: AuthError | null; needsEmailVerification: boolean }>;
  signInWithEmail: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  requestPasswordReset: (email: string) => Promise<{ error: AuthError | null }>;
  updatePassword: (password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<{ error: AuthError | null }>;
  refreshSession: () => Promise<{
    session: Session | null;
    user: User | null;
    error: AuthError | null;
  }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const MOBILE_AUTH_CALLBACK_URL = 'islamicservices://auth/callback';
const PASSWORD_RECOVERY_PENDING_KEY = 'islamicservices.auth.password-recovery-pending';

function recoveryStorageAuthError(): AuthError {
  return {
    name: 'RecoveryStatePersistenceError',
    message: 'Unable to safely verify local authentication state',
    status: 500,
  } as AuthError;
}

export interface AuthProviderProps {
  children: React.ReactNode;
}

export function isAuthCallbackUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'islamicservices:' &&
      parsed.hostname === 'auth' &&
      parsed.pathname === '/callback' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    );
  } catch {
    return false;
  }
}

export function extractCodeFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    if (!isAuthCallbackUrl(url)) return null;
    const parsed = new URL(url);
    const codes = parsed.searchParams.getAll('code');
    return codes.length === 1 && codes[0].trim() ? codes[0].trim() : null;
  } catch {
    return null;
  }
}

export function extractErrorFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    if (!isAuthCallbackUrl(url)) return null;
    const parsed = new URL(url);
    const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
    return parsed.searchParams.has('error') || fragmentParams.has('error')
      ? 'Google sign-in was denied or cancelled.'
      : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [authNavigationGateState, setAuthNavigationGateState] =
    useState<AuthNavigationGate>('loading');
  const authNavigationGateRef = useRef<AuthNavigationGate>('loading');
  const setAuthNavigationGate = useCallback((gate: AuthNavigationGate) => {
    authNavigationGateRef.current = gate;
    setAuthNavigationGateState(gate);
  }, []);
  const loading = authNavigationGateState === 'loading';
  const authStorageFailure = authNavigationGateState === 'storage-error';
  const [passwordRecovery, setPasswordRecovery] = useState<boolean>(false);
  const [passwordRecoveryPersistenceFailed, setPasswordRecoveryPersistenceFailed] = useState(false);
  const passwordRecoveryRef = useRef(false);
  const authStateVersionRef = useRef(0);
  const recoveryMarkerWriteRef = useRef<Promise<void>>(Promise.resolve());
  const recoveryMarkerRevisionRef = useRef(0);
  const authProviderMountedRef = useRef(false);
  const authInitializationResolvedRef = useRef(false);

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

  const setPasswordRecoveryPending = useCallback(
    async (pending: boolean) => {
      const revision = ++recoveryMarkerRevisionRef.current;
      if (pending) {
        passwordRecoveryRef.current = true;
        setPasswordRecovery(true);
        setPasswordRecoveryPersistenceFailed(false);
        setAuthNavigationGate('password-recovery');
      }

      // Serialize writes so an older pending write cannot override a later clear.
      const markerWrite = recoveryMarkerWriteRef.current
        .catch(() => {})
        .then(() =>
          pending
            ? LargeSecureStoreAdapter.setItem(PASSWORD_RECOVERY_PENDING_KEY, 'true')
            : LargeSecureStoreAdapter.removeItem(PASSWORD_RECOVERY_PENDING_KEY)
        );
      recoveryMarkerWriteRef.current = markerWrite;

      try {
        await markerWrite;
      } catch {
        if (
          authProviderMountedRef.current &&
          revision === recoveryMarkerRevisionRef.current
        ) {
          setPasswordRecoveryPersistenceFailed(true);
          setSession(null);
          setAuthNavigationGate('storage-error');

          // If recording recovery mode fails, try to remove the local session and
          // marker. The gate remains closed unless both operations are confirmed.
          if (pending) {
            try {
              const { error } = await supabase.auth.signOut({ scope: 'local' });
              if (error) throw error;
              await LargeSecureStoreAdapter.removeItem(PASSWORD_RECOVERY_PENDING_KEY);
              if (
                authProviderMountedRef.current &&
                revision === recoveryMarkerRevisionRef.current
              ) {
                setSession(null);
                passwordRecoveryRef.current = false;
                setPasswordRecovery(false);
                setPasswordRecoveryPersistenceFailed(false);
                setAuthNavigationGate('ready');
              }
            } catch {
              // Storage state remains uncertain; only the explicit cleanup action
              // can release the fail-closed navigation gate.
            }
          }
        }
        throw recoveryStorageAuthError();
      }

      if (
        !authProviderMountedRef.current ||
        revision !== recoveryMarkerRevisionRef.current
      ) {
        return;
      }
      setPasswordRecoveryPersistenceFailed(false);
      passwordRecoveryRef.current = pending;
      setPasswordRecovery(pending);
      if (pending) {
        setAuthNavigationGate('password-recovery');
      } else {
        setAuthNavigationGate('ready');
      }
    },
    [setAuthNavigationGate]
  );

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
            console.warn('[AuthContext] Code exchange failed');
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
    authProviderMountedRef.current = true;

    // Do not expose restored sessions until both the session and recovery marker
    // have been read successfully. A storage error is not equivalent to absence.
    const initialAuthStateVersion = authStateVersionRef.current;
    Promise.all([
      supabase.auth.getSession(),
      LargeSecureStoreAdapter.getItem(PASSWORD_RECOVERY_PENDING_KEY),
    ])
      .then(([{ data: { session: initialSession }, error }, recoveryMarker]) => {
        if (!isMounted) return;
        if (error || (recoveryMarker !== null && recoveryMarker !== 'true')) {
          throw recoveryStorageAuthError();
        }

        authInitializationResolvedRef.current = true;
        if (authStateVersionRef.current === initialAuthStateVersion) {
          setSession(initialSession);
          if (recoveryMarker === 'true') {
            passwordRecoveryRef.current = true;
            setPasswordRecovery(true);
            setAuthNavigationGate('password-recovery');
          } else {
            passwordRecoveryRef.current = false;
            setPasswordRecovery(false);
            setAuthNavigationGate('ready');
          }
        } else if (
          recoveryMarker === 'true' &&
          authNavigationGateRef.current !== 'ready'
        ) {
          passwordRecoveryRef.current = true;
          setPasswordRecovery(true);
          setAuthNavigationGate('password-recovery');
        } else if (!passwordRecoveryRef.current && authNavigationGateRef.current === 'loading') {
          setAuthNavigationGate('ready');
        }
      })
      .catch(() => {
        if (isMounted) {
          authInitializationResolvedRef.current = true;
          setSession(null);
          setPasswordRecoveryPersistenceFailed(true);
          setAuthNavigationGate('storage-error');
        }
      });

    // INITIAL_SESSION is emitted asynchronously by Supabase. Startup restoration
    // above is authoritative because it checks the recovery marker alongside it.
    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((event, currentSession) => {
      if (!isMounted || event === 'INITIAL_SESSION') return;

      authStateVersionRef.current += 1;
      if (
        authNavigationGateRef.current === 'storage-error' &&
        event !== 'PASSWORD_RECOVERY' &&
        event !== 'SIGNED_OUT'
      ) {
        setSession(null);
        return;
      }
      setSession(currentSession);
      if (event === 'PASSWORD_RECOVERY') {
        void setPasswordRecoveryPending(true).catch(() => {});
      } else if (event === 'SIGNED_OUT') {
        // Keep any recovery/storage gate until marker cleanup is confirmed.
        if (!passwordRecoveryRef.current && authNavigationGateRef.current !== 'storage-error') {
          setPasswordRecoveryPersistenceFailed(false);
        }
      } else if (
        event === 'SIGNED_IN' &&
        !passwordRecoveryRef.current &&
        authNavigationGateRef.current !== 'storage-error' &&
        authInitializationResolvedRef.current
      ) {
        setPasswordRecoveryPersistenceFailed(false);
        setAuthNavigationGate('ready');
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
      authProviderMountedRef.current = false;
      authSubscription.unsubscribe();
      if (linkingSubscription && typeof linkingSubscription.remove === 'function') {
        linkingSubscription.remove();
      }
    };
  }, [processIncomingUrl, setAuthNavigationGate, setPasswordRecoveryPending]);

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: MOBILE_AUTH_CALLBACK_URL },
    });
    return { error, needsEmailVerification: !error && !data.session };
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: MOBILE_AUTH_CALLBACK_URL,
    });
    return { error };
  }, []);

  const clearLocalAuthState = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      const markerRemoval = recoveryMarkerWriteRef.current
        .catch(() => {})
        .then(() => LargeSecureStoreAdapter.removeItem(PASSWORD_RECOVERY_PENDING_KEY));
      recoveryMarkerWriteRef.current = markerRemoval;
      await markerRemoval;
      setSession(null);
      passwordRecoveryRef.current = false;
      setPasswordRecovery(false);
      setPasswordRecoveryPersistenceFailed(false);
      authInitializationResolvedRef.current = true;
      setAuthNavigationGate('ready');
      return { error: null };
    } catch {
      setPasswordRecoveryPersistenceFailed(true);
      setSession(null);
      setAuthNavigationGate('storage-error');
      return { error: recoveryStorageAuthError() };
    }
  }, [setAuthNavigationGate]);

  const signOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        setPasswordRecoveryPersistenceFailed(true);
        setSession(null);
        setAuthNavigationGate('storage-error');
        return { error };
      }
      await setPasswordRecoveryPending(false);
      return { error: null };
    } catch {
      setPasswordRecoveryPersistenceFailed(true);
      setSession(null);
      setAuthNavigationGate('storage-error');
      return { error: recoveryStorageAuthError() };
    }
  }, [setAuthNavigationGate, setPasswordRecoveryPending]);

  const updatePassword = useCallback(async (password: string) => {
    try {
      await recoveryMarkerWriteRef.current;
    } catch {
      return { error: recoveryStorageAuthError() };
    }

    const { error } = await supabase.auth.updateUser({ password });
    if (!error) {
      try {
        await setPasswordRecoveryPending(false);
      } catch {
        return { error: recoveryStorageAuthError() };
      }
    } else if (
      error.name === 'AuthSessionMissingError' ||
      error.status === 401 ||
      error.status === 403
    ) {
      const signOutResult = await signOut();
      if (signOutResult.error) return { error: signOutResult.error };
    }
    return { error };
  }, [setPasswordRecoveryPending, signOut]);

  const signInWithGoogle = useCallback(async (): Promise<{
    error: Error | AuthError | null;
    isCancelled?: boolean;
  }> => {
    try {
      callbackReceivedRef.current = false;
      const redirectUrl = Linking.createURL('auth/callback', {
        scheme: 'islamicservices',
      });

      console.log('[AuthContext] Initiating Google OAuth');
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



  const refreshSession = useCallback(async () => {
    const { data, error } = await supabase.auth.refreshSession();
    return { session: data.session, user: data.user, error };
  }, []);

  const user = session?.user ?? null;

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      authNavigationGate: authNavigationGateState,
      authStorageFailure,
      clearLocalAuthState,
      loading,
      passwordRecovery,
      passwordRecoveryPersistenceFailed,
      signInWithGoogle,
      signUpWithEmail,
      signInWithEmail,
      requestPasswordReset,
      updatePassword,
      signOut,
      refreshSession,
    }),
    [
      session,
      user,
      authNavigationGateState,
      authStorageFailure,
      clearLocalAuthState,
      loading,
      passwordRecovery,
      passwordRecoveryPersistenceFailed,
      signInWithGoogle,
      signUpWithEmail,
      signInWithEmail,
      requestPasswordReset,
      updatePassword,
      signOut,
      refreshSession,
    ]
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

