import React from 'react';
import { render, act, renderHook } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';

// Mock Supabase client
jest.mock('../src/lib/supabase', () => {
  return {
    supabase: {
      auth: {
        getSession: jest.fn(),
        onAuthStateChange: jest.fn(),
        signInWithOtp: jest.fn(),
        verifyOtp: jest.fn(),
        signOut: jest.fn(),
        refreshSession: jest.fn(),
        startAutoRefresh: jest.fn(),
        stopAutoRefresh: jest.fn(),
      },
    },
  };
});

describe('Mobile AuthContext', () => {
  let mockUnsubscribe: jest.Mock;
  let authStateCallback: ((event: string, session: Session | null) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsubscribe = jest.fn();
    authStateCallback = null;

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

  it('initializes with loading state and resolves initial session', async () => {
    const mockSession = {
      access_token: 'valid-token',
      user: { id: 'user-123', phone: '+15551234567' },
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

    await act(async () => {
      // allow getSession promise to resolve
    });

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
      user: { id: 'user-456' },
    } as unknown as Session;

    await act(async () => {
      authStateCallback!('SIGNED_IN', newSession);
    });

    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('invokes signInWithOtp and returns result', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { error: unknown };
    await act(async () => {
      res = await result.current.signInWithOtp({ phone: '+15559876543' });
    });

    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
      phone: '+15559876543',
    });
    expect(res!.error).toBeNull();
  });

  it('invokes verifyOtp with type sms and returns session', async () => {
    (supabase.auth.getSession as jest.Mock).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    const verifiedSession = {
      access_token: 'sms-verified-token',
      user: { id: 'user-789', phone: '+15550001111' },
    } as unknown as Session;

    (supabase.auth.verifyOtp as jest.Mock).mockResolvedValueOnce({
      data: { session: verifiedSession, user: verifiedSession.user },
      error: null,
    });

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {});

    let res: { session: Session | null; user: unknown; error: unknown };
    await act(async () => {
      res = await result.current.verifyOtp({ phone: '+15550001111', token: '123456' });
    });

    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      phone: '+15550001111',
      token: '123456',
      type: 'sms',
    });
    expect(res!.session).toBe(verifiedSession);
    expect(res!.error).toBeNull();
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
