import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { LoginScreen } from '../src/screens/LoginScreen';
import { AuthProvider } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';
import * as WebBrowser from 'expo-web-browser';

jest.mock('../src/lib/secureStorage', () => ({
  LargeSecureStoreAdapter: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

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
      signUp: jest.fn(),
      signInWithPassword: jest.fn(),
      resetPasswordForEmail: jest.fn(),
      updateUser: jest.fn(),
      exchangeCodeForSession: jest.fn(),
      signOut: jest.fn(),
      refreshSession: jest.fn(),
    },
  },
}));

describe('<LoginScreen /> — authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderLogin = (onSignInSuccess = jest.fn(), passwordRecoveryMode = false) => {
    return {
      ...render(
        <AuthProvider>
          <LoginScreen onSignInSuccess={onSignInSuccess} passwordRecoveryMode={passwordRecoveryMode} />
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
    expect(getByTestId('auth-email-input')).toBeTruthy();
    expect(getByTestId('email-auth-submit-button')).toBeTruthy();

    // Regression: Ensure NO phone input or OTP components are present
    expect(queryByTestId('login-phone-input')).toBeNull();
    expect(queryByTestId('login-submit-button')).toBeNull();
  });

  it('validates malformed email and missing password before making an auth request', async () => {
    const { getByTestId, getByText } = renderLogin();
    await act(async () => {});

    fireEvent.changeText(getByTestId('auth-email-input'), 'not-an-email');
    fireEvent.press(getByTestId('email-auth-submit-button'));
    expect(getByText('Enter a valid email address.')).toBeTruthy();
    expect(supabase.auth.signInWithPassword).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.press(getByTestId('email-auth-submit-button'));
    expect(getByText('Enter your password.')).toBeTruthy();
    expect(supabase.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('signs in with email and password and uses a generic authentication error', async () => {
    (supabase.auth.signInWithPassword as jest.Mock).mockResolvedValueOnce({ error: new Error('user not found') });
    const { getByTestId, getByText, queryByText } = renderLogin();
    await act(async () => {});

    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.changeText(getByTestId('auth-password-input'), 'bad-password');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    await waitFor(() => {
      expect(getByText('Unable to sign in with that email and password. Check your details and try again.')).toBeTruthy();
    });
    expect(queryByText('user not found')).toBeNull();
  });

  it('prevents duplicate email sign-in submissions while a request is pending', async () => {
    let resolveSignIn: (value: { error: null }) => void;
    (supabase.auth.signInWithPassword as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => { resolveSignIn = resolve; })
    );
    const { getByTestId } = renderLogin();
    await act(async () => {});
    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.changeText(getByTestId('auth-password-input'), 'password123');
    fireEvent.press(getByTestId('email-auth-submit-button'));
    fireEvent.press(getByTestId('email-auth-submit-button'));
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSignIn!({ error: null }); });
  });

  it('creates an account and shows a verification message when signup returns no session', async () => {
    (supabase.auth.signUp as jest.Mock).mockResolvedValueOnce({
      data: { user: { id: 'pending-user' }, session: null },
      error: null,
    });
    const { getByTestId, getByText } = renderLogin();
    await act(async () => {});
    fireEvent.press(getByTestId('create-account-button'));
    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.changeText(getByTestId('auth-password-input'), 'password123');
    fireEvent.changeText(getByTestId('auth-confirm-password-input'), 'password123');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    await waitFor(() => expect(getByTestId('login-auth-status')).toBeTruthy());
    expect(getByText('If registration is available for this address, check your email to verify your account.')).toBeTruthy();
    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: 'person@example.com',
      password: 'password123',
      options: { emailRedirectTo: 'islamicservices://auth/callback' },
    });
  });

  it('rejects mismatched signup passwords without calling Supabase', async () => {
    const { getByTestId, getByText } = renderLogin();
    await act(async () => {});
    fireEvent.press(getByTestId('create-account-button'));
    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.changeText(getByTestId('auth-password-input'), 'password123');
    fireEvent.changeText(getByTestId('auth-confirm-password-input'), 'different-password');
    fireEvent.press(getByTestId('email-auth-submit-button'));
    expect(getByText('The passwords do not match.')).toBeTruthy();
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('requires at least eight characters for signup without calling Supabase', async () => {
    const { getByTestId, getByText } = renderLogin();
    await act(async () => {});
    fireEvent.press(getByTestId('create-account-button'));
    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.changeText(getByTestId('auth-password-input'), 'short12');
    fireEvent.changeText(getByTestId('auth-confirm-password-input'), 'short12');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    expect(getByText('Use a password with at least 8 characters.')).toBeTruthy();
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('requires at least eight characters for password reset without calling Supabase', async () => {
    const { getByTestId, getByText } = renderLogin(jest.fn(), true);
    await act(async () => {});
    fireEvent.changeText(getByTestId('auth-password-input'), 'short12');
    fireEvent.changeText(getByTestId('auth-confirm-password-input'), 'short12');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    expect(getByText('Use a password with at least 8 characters.')).toBeTruthy();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('requests recovery using a generic response and the exact callback URL', async () => {
    (supabase.auth.resetPasswordForEmail as jest.Mock).mockResolvedValueOnce({ data: {}, error: null });
    const { getByTestId, getByText } = renderLogin();
    await act(async () => {});
    fireEvent.press(getByTestId('forgot-password-button'));
    fireEvent.changeText(getByTestId('auth-email-input'), 'person@example.com');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    await waitFor(() => expect(getByTestId('login-auth-status')).toBeTruthy());
    expect(getByText('If an account matches this address, a password reset link will be sent.')).toBeTruthy();
    expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith('person@example.com', {
      redirectTo: 'islamicservices://auth/callback',
    });
  });

  it('updates the password from recovery mode and does not request an email or current password', async () => {
    (supabase.auth.updateUser as jest.Mock).mockResolvedValueOnce({ error: null });
    const { getByTestId, getByText, queryByTestId } = renderLogin(jest.fn(), true);
    await act(async () => {});
    expect(queryByTestId('auth-email-input')).toBeNull();
    fireEvent.changeText(getByTestId('auth-password-input'), 'new-password-123');
    fireEvent.changeText(getByTestId('auth-confirm-password-input'), 'new-password-123');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    await waitFor(() => expect(getByText('Your password has been updated.')).toBeTruthy());
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'new-password-123' });
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
