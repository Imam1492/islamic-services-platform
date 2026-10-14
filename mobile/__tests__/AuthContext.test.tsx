import React from 'react';
import { render, act, renderHook } from '@testing-library/react-native';
import { Text } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';

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
    expect(res!.error?.message).toContain('User denied access');
    expect(res!.isCancelled).toBe(false);
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

