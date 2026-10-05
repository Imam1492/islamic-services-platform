import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { LoginScreen } from '../src/screens/LoginScreen';
import { AuthProvider } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import * as WebBrowser from 'expo-web-browser';

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `islamicservices://${path}`),
  parse: jest.fn((url: string) => ({ queryParams: { code: 'code123' } })),
}));

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: jest.fn().mockReturnValue({
        data: { subscription: { unsubscribe: jest.fn() } },
      }),
      signInWithOAuth: jest.fn(),
      exchangeCodeForSession: jest.fn(),
      signOut: jest.fn(),
      refreshSession: jest.fn(),
    },
  },
}));

describe('<LoginScreen /> — Google OAuth V1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderLogin = (onSignInSuccess = jest.fn()) => {
    return {
      ...render(
        <AuthProvider>
          <LoginScreen onSignInSuccess={onSignInSuccess} />
        </AuthProvider>
      ),
      onSignInSuccess,
    };
  };

  it('renders Sign In / Register title and Continue with Google button', async () => {
    const { getByTestId, getByText, queryByTestId } = renderLogin();
    await act(async () => {});

    expect(getByTestId('login-title')).toBeTruthy();
    expect(getByText('Sign In / Register')).toBeTruthy();
    expect(getByTestId('login-google-button')).toBeTruthy();
    expect(getByText('Continue with Google')).toBeTruthy();

    // Regression: Ensure NO phone input or OTP components are present
    expect(queryByTestId('login-phone-input')).toBeNull();
    expect(queryByTestId('login-submit-button')).toBeNull();
  });

  it('has accessible label and role on the Google button', async () => {
    const { getByTestId } = renderLogin();
    await act(async () => {});

    const button = getByTestId('login-google-button');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Continue with Google');
  });

  it('button invokes signInWithGoogle when pressed', async () => {
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'success',
      url: 'islamicservices://auth/callback?code=mock_code',
    });
    (supabase.auth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
      data: { session: { access_token: 'valid' } },
      error: null,
    });

    const { getByTestId, onSignInSuccess } = renderLogin();
    await act(async () => {});

    const button = getByTestId('login-google-button');
    fireEvent.press(button);

    await waitFor(() => {
      expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: 'islamicservices://auth/callback',
          skipBrowserRedirect: true,
        },
      });
      expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled();
      expect(onSignInSuccess).toHaveBeenCalled();
    });
  });

  it('shows loading indicator and prevents duplicate press while submitting', async () => {
    let resolveOAuth: (val: any) => void;
    const pendingOAuth = new Promise((resolve) => {
      resolveOAuth = resolve;
    });

    (supabase.auth.signInWithOAuth as jest.Mock).mockReturnValueOnce(pendingOAuth);

    const { getByTestId } = renderLogin();
    await act(async () => {});

    const button = getByTestId('login-google-button');
    fireEvent.press(button);

    // Should immediately show loading indicator
    expect(getByTestId('login-loading-indicator')).toBeTruthy();

    // Secondary press should be ignored
    fireEvent.press(button);
    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledTimes(1);

    // Resolve OAuth
    await act(async () => {
      resolveOAuth!({
        data: { url: 'https://accounts.google.com' },
        error: null,
      });
    });
  });

  it('displays safe error banner on OAuth provider failure without leaking sensitive info', async () => {
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: new Error('oauth_provider_internal_error_client_secret_xyz'),
    });

    const { getByTestId, queryByText } = renderLogin();
    await act(async () => {});

    const button = getByTestId('login-google-button');
    fireEvent.press(button);

    await waitFor(() => {
      expect(getByTestId('login-auth-error')).toBeTruthy();
      // Safe user-friendly message
      expect(queryByText('Unable to sign in with Google. Please try again.')).toBeTruthy();
      // Sensitive provider details must NOT leak
      expect(queryByText(/client_secret/i)).toBeNull();
    });
  });

  it('does not display error banner when user cancels the browser sheet', async () => {
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com' },
      error: null,
    });
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'cancel',
    });

    const { getByTestId, queryByTestId } = renderLogin();
    await act(async () => {});

    const button = getByTestId('login-google-button');
    fireEvent.press(button);

    await waitFor(() => {
      expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled();
    });

    // Should reset loading state without showing error banner
    expect(queryByTestId('login-auth-error')).toBeNull();
    expect(queryByTestId('login-loading-indicator')).toBeNull();
  });
});
