import React from 'react';
import { render, act, renderHook, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import {
  AuthProvider,
  extractErrorFromUrl,
  isAuthCallbackUrl,
  useAuth,
} from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';
import { LargeSecureStoreAdapter } from '../src/lib/secureStorage';

jest.mock('../src/lib/secureStorage', () => ({
  LargeSecureStoreAdapter: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock WebBrowser and Linking
jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(),
}));

let mockUrlListener: ((event: { url: string }) => void) | null = null;
const mockLinkingRemove = jest.fn();

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `islamicservices://${path}`),
  parse: jest.fn((url: string) => {
    if (!url) return { queryParams: {} };
    if (url.includes('code=')) {
      const match = url.match(/code=([^&]+)/);
      return {
        hostname: 'auth',
        path: 'callback',
        queryParams: { code: match ? match[1] : undefined },
      };
    }
    if (url.includes('error=')) {
      return {
        hostname: 'auth',
        path: 'callback',
        queryParams: {
          error: 'access_denied',
          error_description: 'User denied access',
        },
      };
    }
    return { hostname: 'auth', path: 'callback', queryParams: {} };
  }),
  addEventListener: jest.fn((event: string, cb: (event: { url: string }) => void) => {
    if (event === 'url') {
      mockUrlListener = cb;
    }
    return {
      remove: mockLinkingRemove,
    };
  }),
  getInitialURL: jest.fn().mockResolvedValue(null),
}));

// Mock Supabase client
jest.mock('../src/lib/supabase', () => {
  return {
    supabase: {
      auth: {
        getSession: jest.fn(),
        onAuthStateChange: jest.fn(),
        signInWithOAuth: jest.fn(),
        signUp: jest.fn(),
        signInWithPassword: jest.fn(),
        resetPasswordForEmail: jest.fn(),
        updateUser: jest.fn(),
        exchangeCodeForSession: jest.fn(),
        signOut: jest.fn(),
        refreshSession: jest.fn(),
        startAutoRefresh: jest.fn(),
        stopAutoRefresh: jest.fn(),
      },
    },
  };
});

describe('Mobile AuthContext — Google OAuth V1', () => {
  let mockUnsubscribe: jest.Mock;
  let authStateCallback: ((event: string, session: Session | null) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    (LargeSecureStoreAdapter.getItem as jest.Mock).mockResolvedValue(null);
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockResolvedValue(undefined);
    (LargeSecureStoreAdapter.removeItem as jest.Mock).mockResolvedValue(undefined);
    mockUnsubscribe = jest.fn();
    authStateCallback = null;
    mockUrlListener = null;
    (Linking.getInitialURL as jest.Mock).mockResolvedValue(null);

    (supabase.auth.onAuthStateChange as jest.Mock).mockImplementation(
      (cb: (event: string, session: Session | null) => void) => {
        authStateCallback = cb;
        return {
          data: {
            subscription: {
              unsubscribe: mockUnsubscribe,
            },
          },
        };
      }
    );
  });

  it('accepts only the exact mobile OAuth callback scheme, host, and path', () => {
    expect(isAuthCallbackUrl('islamicservices://auth/callback?code=valid')).toBe(true);
    expect(isAuthCallbackUrl('http://auth/callback?code=valid')).toBe(false);
    expect(isAuthCallbackUrl('islamicservices://other/callback?code=valid')).toBe(false);
    expect(isAuthCallbackUrl('islamicservices://auth/callback/extra?code=valid')).toBe(false);
    expect(isAuthCallbackUrl('https://example.test/?next=islamicservices://auth/callback')).toBe(false);
    expect(isAuthCallbackUrl('islamicservices://user@auth/callback?code=valid')).toBe(false);
    expect(
      extractErrorFromUrl('islamicservices://auth/callback#error=access_denied&error_description=private')
    ).toBe('Google sign-in was denied or cancelled.');
  });

  it('session restoration: initializes with loading state and resolves initial session', async () => {
    const mockSession = {
      access_token: 'valid-token',
      user: { id: 'user-123', email: 'test@example.com' },
    } as unknown as Session;

    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: mockSession },
      error: null,
    });

    function Consumer() {
      const { session, loading, user } = useAuth();
      return (
        <Text testID="state">
          {loading ? 'loading' : `ready:${user?.id || 'none'}:${session?.access_token || 'none'}`}
        </Text>
      );
    }

    const { getByTestId } = render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    );

    expect(getByTestId('state').props.children).toBe('loading');

    await act(async () => {});

    expect(getByTestId('state').props.children).toBe('ready:user-123:valid-token');
  });

  it('restores password-recovery mode only when both the session and recovery marker exist', async () => {
    const mockSession = {
      access_token: 'valid-token',
      user: { id: 'recovery-user', email: 'test@example.com' },
    } as unknown as Session;
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: mockSession },
      error: null,
    });
    (LargeSecureStoreAdapter.getItem as jest.Mock).mockResolvedValueOnce('true');

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await act(async () => {});

    expect(result.current.session).toBe(mockSession);
    expect(result.current.passwordRecovery).toBe(true);
  });

  it('orders recovery-marker writes so a late pending write cannot override a clear', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    let finishPendingWrite!: () => void;
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishPendingWrite = resolve; })
    );
    (supabase.auth.updateUser as jest.Mock).mockResolvedValueOnce({ error: null });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await act(async () => {});
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockClear();
    (LargeSecureStoreAdapter.removeItem as jest.Mock).mockClear();

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
      await Promise.resolve();
    });
    expect(LargeSecureStoreAdapter.setItem).toHaveBeenCalled();

    let updatePromise!: ReturnType<typeof result.current.updatePassword>;
    await act(async () => {
      updatePromise = result.current.updatePassword('new-password-123');
      await Promise.resolve();
    });
    expect(LargeSecureStoreAdapter.removeItem).not.toHaveBeenCalled();

    await act(async () => {
      finishPendingWrite();
      await Promise.resolve();
      await Promise.resolve();
      await updatePromise;
    });
    expect(LargeSecureStoreAdapter.removeItem).toHaveBeenCalled();
  });

  it('fails closed when the recovery marker and local session clear both fail', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({
      error: { name: 'AuthUnknownError', status: 500 },
    });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await act(async () => {});

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
    });
    await waitFor(() => expect(result.current.passwordRecoveryPersistenceFailed).toBe(true));

    expect(result.current.passwordRecovery).toBe(true);
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    const updateResult = await result.current.updatePassword('new-password-123');
    expect(updateResult.error?.name).toBe('RecoveryStatePersistenceError');
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();

    await act(async () => {
      authStateCallback!('SIGNED_IN', { user: { id: 'normal-user' } } as Session);
    });
    expect(result.current.passwordRecoveryPersistenceFailed).toBe(true);
    expect(result.current.authNavigationGate).toBe('storage-error');
    expect(result.current.authStorageFailure).toBe(true);
  });

  it('clears the recovery gate when local sign-out succeeds after a marker failure', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({ error: null });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await act(async () => {});

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
    });
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    await waitFor(() => expect(result.current.authNavigationGate).toBe('ready'));

    expect(result.current.passwordRecoveryPersistenceFailed).toBe(false);
    expect(result.current.session).toBeNull();
    expect(result.current.passwordRecovery).toBe(false);
  });

  it('blocks restored sessions when the recovery-marker read fails during startup', async () => {
    const restoredSession = {
      access_token: 'valid-token',
      user: { id: 'restored-user', email: 'test@example.com' },
    } as unknown as Session;
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: restoredSession },
      error: null,
    });
    (LargeSecureStoreAdapter.getItem as jest.Mock).mockRejectedValueOnce(
      new Error('secure storage unavailable')
    );

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.authNavigationGate).toBe('storage-error'));

    expect(result.current.session).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.authStorageFailure).toBe(true);
  });

  it('surfaces persisted-session removal failure during logout', async () => {
    const restoredSession = {
      access_token: 'valid-token',
      user: { id: 'logout-user', email: 'test@example.com' },
    } as unknown as Session;
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: restoredSession },
      error: null,
    });
    (supabase.auth.signOut as jest.Mock).mockRejectedValueOnce(new Error('secure delete failed'));

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await act(async () => {});

    let logoutResult: Awaited<ReturnType<typeof result.current.signOut>>;
    await act(async () => {
      logoutResult = await result.current.signOut();
    });

    expect(logoutResult!.error).toBeTruthy();
    expect(result.current.session).toBeNull();
    expect(result.current.authNavigationGate).toBe('storage-error');
  });

  it('clears uncertain local session and marker only after both removals succeed', async () => {
    (supabase.auth.getSession as jest.Mock).mockRejectedValueOnce(new Error('session read failed'));
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.authNavigationGate).toBe('storage-error'));
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({ error: null });
    (LargeSecureStoreAdapter.removeItem as jest.Mock).mockRejectedValueOnce(new Error('marker delete failed'));

    let clearResult: Awaited<ReturnType<typeof result.current.clearLocalAuthState>>;
    await act(async () => {
      clearResult = await result.current.clearLocalAuthState();
    });

    expect(clearResult!.error).toBeTruthy();
    expect(result.current.authNavigationGate).toBe('storage-error');
  });

  it('does not let a stale startup marker read undo a completed logout', async () => {
    let resolveMarker!: (value: string | null) => void;
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: { user: { id: 'logout-race-user' } } as Session },
      error: null,
    });
    (LargeSecureStoreAdapter.getItem as jest.Mock).mockImplementationOnce(
      () => new Promise<string | null>((resolve) => { resolveMarker = resolve; })
    );
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({ error: null });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });

    await act(async () => {
      authStateCallback!('SIGNED_OUT', null);
      await result.current.signOut();
    });
    expect(result.current.authNavigationGate).toBe('ready');
    expect(result.current.session).toBeNull();

    await act(async () => {
      resolveMarker('true');
      await Promise.resolve();
    });
    expect(result.current.authNavigationGate).toBe('ready');
    expect(result.current.passwordRecovery).toBe(false);
  });

  it('uses the exact mobile callback for signup verification and password recovery', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signUp as jest.Mock).mockResolvedValueOnce({
      data: { session: null, user: { id: 'verify-user' } },
      error: null,
    });
    (supabase.auth.resetPasswordForEmail as jest.Mock).mockResolvedValueOnce({
      data: {},
      error: null,
    });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });

    let signupResult: Awaited<ReturnType<typeof result.current.signUpWithEmail>>;
    await act(async () => {
      signupResult = await result.current.signUpWithEmail(' person@example.com ', 'password123');
    });
    await act(async () => {
      await result.current.requestPasswordReset('person@example.com');
    });

    expect(signupResult!.needsEmailVerification).toBe(true);
    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: ' person@example.com ',
      password: 'password123',
      options: { emailRedirectTo: 'islamicservices://auth/callback' },
    });
    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('person@example.com', {
      redirectTo: 'islamicservices://auth/callback',
    });
  });

  it('enters password recovery mode on PASSWORD_RECOVERY and clears it after a successful update or logout', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.updateUser as jest.Mock).mockResolvedValue({ error: null });
    (supabase.auth.signOut as jest.Mock).mockResolvedValue({ error: null });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
    });
    expect(result.current.passwordRecovery).toBe(true);

    await act(async () => {
      await result.current.updatePassword('new-password-123');
    });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-123' });
    expect(result.current.passwordRecovery).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(LargeSecureStoreAdapter.removeItem).toHaveBeenCalled();

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
      await result.current.signOut();
    });
    expect(result.current.passwordRecovery).toBe(false);
  });

  it('clears an expired recovery session but leaves retryable password errors in recovery mode', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.updateUser as jest.Mock)
      .mockResolvedValueOnce({ error: { name: 'AuthSessionMissingError', status: 400 } })
      .mockResolvedValueOnce({ error: { name: 'AuthWeakPasswordError', status: 422 } });
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({ error: null });
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <AuthProvider>{children}</AuthProvider>,
    });

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
      await result.current.updatePassword('new-password-123');
    });
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(result.current.passwordRecovery).toBe(false);

    await act(async () => {
      authStateCallback!('PASSWORD_RECOVERY', { user: { id: 'recovery-user' } } as Session);
      await result.current.updatePassword('weak');
    });
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(result.current.passwordRecovery).toBe(true);
  });

  it('updates state when onAuthStateChange fires and cleans up subscription on unmount', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });

    const { unmount } = render(
      <AuthProvider>
        <Text>Content</Text>
      </AuthProvider>
    );

    await act(async () => {});

    expect(authStateCallback).toBeDefined();

    const newSession = {
      access_token: 'new-token',
      user: { id: 'user-456', email: 'oauth@example.com' },
    } as unknown as Session;

    await act(async () => {
      authStateCallback!('SIGNED_IN', newSession);
    });

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockLinkingRemove).toHaveBeenCalled();
  });

  it('Google OAuth initiation: generates correct redirect URI and initiates OAuth with Supabase', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth?client_id=xyz' },
      error: null,
    });
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'success',
      url: 'islamicservices://auth/callback?code=mock_auth_code_123',
    });
    (supabase.auth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
      data: { session: { access_token: 'jwt' }, user: { id: 'usr-1' } },
      error: null,
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: Error | null; isCancelled?: boolean };
    await act(async () => {
      res = await result.current.signInWithGoogle();
    });

    expect(Linking.createURL).toHaveBeenCalledWith('auth/callback', {
      scheme: 'islamicservices',
    });
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'islamicservices://auth/callback',
        skipBrowserRedirect: true,
      },
    });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/auth?client_id=xyz',
      'islamicservices://auth/callback'
    );
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('mock_auth_code_123');
    expect(res!.error).toBeNull();
    expect(res!.isCancelled).toBe(false);
  });

  it('Android race condition fix: handles browserResult.type === "dismiss" followed by Linking callback URL', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });

    // Simulate Android Chrome Custom Tab premature dismiss
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockImplementationOnce(async () => {
      // Simulate intent arrival via Linking slightly after or during dismiss
      setTimeout(() => {
        if (mockUrlListener) {
          mockUrlListener({ url: 'islamicservices://auth/callback?code=android_code_789' });
        }
      }, 10);
      return { type: 'dismiss' };
    });

    (supabase.auth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
      data: { session: { access_token: 'token-789' }, user: { id: 'usr-789' } },
      error: null,
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: Error | null; isCancelled?: boolean };
    await act(async () => {
      res = await result.current.signInWithGoogle();
    });

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('android_code_789');
    expect(res!.error).toBeNull();
    expect(res!.isCancelled).toBe(false);
  });

  it('handles genuine user cancellation cleanly without error when no callback is delivered', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'cancel',
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: Error | null; isCancelled?: boolean };
    await act(async () => {
      res = await result.current.signInWithGoogle();
    });

    expect(res!.error).toBeNull();
    expect(res!.isCancelled).toBe(true);
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('handles provider failure during signInWithOAuth initiation', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: new Error('Provider not configured'),
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: Error | null; isCancelled?: boolean };
    await act(async () => {
      res = await result.current.signInWithGoogle();
    });

    expect(res!.error).toBeDefined();
    expect(res!.error?.message).toContain('Provider not configured');
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it('handles PKCE exchange failure safely', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'success',
      url: 'islamicservices://auth/callback?code=bad_code',
    });
    (supabase.auth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null, user: null },
      error: new Error('Invalid authorization code'),
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: Error | null; isCancelled?: boolean };
    await act(async () => {
      res = await result.current.signInWithGoogle();
    });

    expect(res!.error).toBeDefined();
    expect(res!.error?.message).toContain('Invalid authorization code');
    expect(res!.isCancelled).toBe(false);
  });

  it('cold-start callback: exchanges authorization code from getInitialURL on startup', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (Linking.getInitialURL as jest.Mock).mockResolvedValueOnce(
      'islamicservices://auth/callback?code=cold_start_code_999'
    );
    (supabase.auth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
      data: { session: { access_token: 'cold-jwt' }, user: { id: 'cold-usr' } },
      error: null,
    });

    render(
      <AuthProvider>
        <Text>Cold Start Test</Text>
      </AuthProvider>
    );

    await act(async () => {});

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('cold_start_code_999');
  });

  it('deduplication: exchanges the same authorization code exactly once even if duplicate events fire', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.exchangeCodeForSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'dup-jwt' }, user: { id: 'dup-usr' } },
      error: null,
    });

    render(
      <AuthProvider>
        <Text>Deduplication Test</Text>
      </AuthProvider>
    );

    await act(async () => {});

    // Fire duplicate deep-link events
    await act(async () => {
      mockUrlListener!({ url: 'islamicservices://auth/callback?code=duplicate_code_555' });
    });
    await act(async () => {
      mockUrlListener!({ url: 'islamicservices://auth/callback?code=duplicate_code_555' });
    });

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('duplicate_code_555');
  });

  it('malformed callback: safely ignores irrelevant routes or URLs without code', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });

    render(
      <AuthProvider>
        <Text>Malformed Callback Test</Text>
      </AuthProvider>
    );

    await act(async () => {});

    // Irrelevant route
    await act(async () => {
      mockUrlListener!({ url: 'islamicservices://other/path?id=123' });
    });
    // Callback without code parameter
    await act(async () => {
      mockUrlListener!({ url: 'islamicservices://auth/callback' });
    });

    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('error callback: reports OAuth error without exposing secrets', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockImplementationOnce(async () => {
      setTimeout(() => {
        if (mockUrlListener) {
          mockUrlListener({
            url: 'islamicservices://auth/callback?error=access_denied&error_description=User%20denied%20access',
          });
        }
      }, 10);
      return { type: 'dismiss' };
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: Error | null; isCancelled?: boolean };
    await act(async () => {
      res = await result.current.signInWithGoogle();
    });

    expect(res!.error).toBeDefined();
    expect(res!.error?.message).toBe('Google sign-in was denied or cancelled.');
    expect(res!.error?.message).not.toContain('User denied access');
    expect(res!.isCancelled).toBe(false);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('User denied access');
    warnSpy.mockRestore();
  });

  it('invokes signOut cleanly', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: unknown };
    await act(async () => {
      res = await result.current.signOut();
    });

    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(res!.error).toBeNull();
  });

  it('throws error when useAuth is consumed outside AuthProvider', () => {
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');
  });
});

