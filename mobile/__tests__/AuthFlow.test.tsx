import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import App from '../App';
import { supabase } from '../src/lib/supabase';
import { LegalDocumentService } from '../src/services/legalDocumentService';
import { CONTROLLED_TOS_VERSION, CONTROLLED_PRIVACY_VERSION } from '../src/constants/legal';
import * as WebBrowser from 'expo-web-browser';
import type { Session } from '@supabase/supabase-js';
import { LargeSecureStoreAdapter } from '../src/lib/secureStorage';

let mockAuthStateListener: ((event: string, session: Session | null) => void) | null = null;
let mockCurrentSession: Session | null = null;

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(),
}));

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `islamicservices://${path}`),
  parse: jest.fn((url: string) => ({ queryParams: { code: 'auth_code_pkce_123' } })),
}));

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() =>
        Promise.resolve({
          data: { session: mockCurrentSession },
          error: null,
        })
      ),
      onAuthStateChange: jest.fn((cb) => {
        mockAuthStateListener = cb;
        return {
          data: {
            subscription: {
              unsubscribe: jest.fn(),
            },
          },
        };
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
    rpc: jest.fn(),
  },
}));

jest.mock('../src/lib/secureStorage', () => ({
  LargeSecureStoreAdapter: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('Complete Mobile Authentication Flow & Authoritative Onboarding Gate — Google OAuth V1', () => {
  const mockUser = {
    id: 'usr_authenticated_123',
    email: 'community_member@example.com',
    user_metadata: {
      full_name: 'Ahmad Abdullah',
    },
  };
  const mockSession = {
    access_token: 'auth_session_jwt_token',
    user: mockUser,
  } as unknown as Session;

  beforeEach(() => {
    jest.clearAllMocks();
    (LargeSecureStoreAdapter.getItem as jest.Mock).mockResolvedValue(null);
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockResolvedValue(undefined);
    (LargeSecureStoreAdapter.removeItem as jest.Mock).mockResolvedValue(undefined);
    mockCurrentSession = null;
    mockAuthStateListener = null;
  });

  it('runs the full end-to-end flow: Login (Google) -> Authenticated (Already Onboarded) -> Main Tabs -> SignOut', async () => {
    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });

    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'success',
      url: 'islamicservices://auth/callback?code=auth_code_pkce_123',
    });

    (supabase.auth.exchangeCodeForSession as jest.Mock).mockImplementationOnce(async () => {
      mockCurrentSession = mockSession;
      if (mockAuthStateListener) {
        mockAuthStateListener('SIGNED_IN', mockSession);
      }
      return {
        data: { session: mockSession, user: mockUser },
        error: null,
      };
    });

    // Authoritative RPC returns already onboarded
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: { is_onboarded: true, onboarded_at: '2026-09-30T10:00:00Z' },
      error: null,
    });

    (supabase.auth.signOut as jest.Mock).mockImplementationOnce(async () => {
      mockCurrentSession = null;
      if (mockAuthStateListener) {
        mockAuthStateListener('SIGNED_OUT', null);
      }
      return { error: null };
    });

    const { getByTestId, getByText, queryByTestId, queryByText } = render(<App />);

    // Allow initial getSession to resolve
    await act(async () => {});

    // 1. Initial screen is LoginScreen with Google Sign-In
    expect(getByText('Sign In / Register')).toBeTruthy();
    expect(getByTestId('login-google-button')).toBeTruthy();
    // Regression check: No phone OTP elements or routes exist
    expect(queryByTestId('login-phone-input')).toBeNull();
    expect(queryByText('Enter Verification Code')).toBeNull();

    // 2. Press "Continue with Google"
    fireEvent.press(getByTestId('login-google-button'));

    // 3. Navigates directly past onboarding into AuthenticatedTabNavigator
    await waitFor(() => {
      expect(getByTestId('authenticated-tab-navigator')).toBeTruthy();
      expect(getByTestId('tab-button-discover')).toBeTruthy();
      expect(getByTestId('tab-button-account')).toBeTruthy();
    });

    // 4. Navigate to Account tab and check email display
    fireEvent.press(getByTestId('tab-button-account'));
    await waitFor(() => {
      expect(getByTestId('account-shell-screen')).toBeTruthy();
      expect(getByTestId('account-email')).toBeTruthy();
      expect(getByText('community_member@example.com')).toBeTruthy();
      // Phone is absent, displays "Not provided"
      expect(getByText('Not provided')).toBeTruthy();
    });

    // 5. Sign Out returns to LoginScreen
    const signOutButton = getByTestId('account-signout-button');
    fireEvent.press(signOutButton);

    await waitFor(() => {
      expect(getByText('Sign In / Register')).toBeTruthy();
      expect(getByTestId('login-google-button')).toBeTruthy();
      expect(queryByTestId('authenticated-tab-navigator')).toBeNull();
    });
  });

  it('runs new user flow: Login (Google) -> Not Onboarded -> GeneralUserOnboardingScreen -> Complete -> Main Tabs', async () => {
    // Mock approved legal documents so checkboxes are enabled
    jest.spyOn(LegalDocumentService, 'getDocuments').mockReturnValue({
      termsOfService: {
        id: 'terms_of_service',
        title: 'Terms of Service',
        version: CONTROLLED_TOS_VERSION,
        status: 'APPROVED',
        effectiveDate: '2026-09-01',
        content: 'Approved Terms',
      },
      privacyPolicy: {
        id: 'privacy_policy',
        title: 'Privacy Policy',
        version: CONTROLLED_PRIVACY_VERSION,
        status: 'APPROVED',
        effectiveDate: '2026-09-01',
        content: 'Approved Privacy',
      },
      allApproved: true,
    });

    (supabase.auth.signInWithOAuth as jest.Mock).mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });

    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({
      type: 'success',
      url: 'islamicservices://auth/callback?code=auth_code_pkce_123',
    });

    (supabase.auth.exchangeCodeForSession as jest.Mock).mockImplementationOnce(async () => {
      mockCurrentSession = mockSession;
      if (mockAuthStateListener) {
        mockAuthStateListener('SIGNED_IN', mockSession);
      }
      return {
        data: { session: mockSession, user: mockUser },
        error: null,
      };
    });

    // 1. Authoritative RPC check: user profile is not yet onboarded
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: { is_onboarded: false, onboarded_at: null },
      error: null,
    });

    const { getByTestId, queryByTestId } = render(<App />);
    await act(async () => {});

    // Press Continue with Google
    fireEvent.press(getByTestId('login-google-button'));

    // Should render GeneralUserOnboardingScreen with prefilled full name
    await waitFor(() => {
      expect(getByTestId('onboarding-fullname-input')).toBeTruthy();
      expect(getByTestId('onboarding-fullname-input').props.value).toBe('Ahmad Abdullah');
    });

    // Accept Terms, Privacy Policy, and Adult acknowledgement
    fireEvent.press(getByTestId('checkbox-adult-ack'));
    fireEvent.press(getByTestId('checkbox-tos'));
    fireEvent.press(getByTestId('checkbox-privacy'));

    // Mock onboarding completion RPC
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: {
        success: true,
        onboarded_at: '2026-10-05T12:00:00Z',
        consent_id: 'consent_123',
      },
      error: null,
    });

    // Submit onboarding
    fireEvent.press(getByTestId('onboarding-submit-button'));

    // Transitions to authenticated main tabs
    await waitFor(() => {
      expect(getByTestId('authenticated-tab-navigator')).toBeTruthy();
      expect(queryByTestId('onboarding-fullname-input')).toBeNull();
    });
  });

  it('routes PASSWORD_RECOVERY sessions to the reset-password form', async () => {
    (supabase.auth.updateUser as jest.Mock).mockResolvedValueOnce({ error: null });
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: { is_onboarded: true, onboarded_at: '2026-10-05T12:00:00Z' },
      error: null,
    });
    const { getByTestId, getByText } = render(<App />);
    await act(async () => {});

    await act(async () => {
      mockAuthStateListener!('PASSWORD_RECOVERY', mockSession);
    });
    expect(getByText('Choose a new password')).toBeTruthy();

    fireEvent.changeText(getByTestId('auth-password-input'), 'recovered-password-123');
    fireEvent.changeText(getByTestId('auth-confirm-password-input'), 'recovered-password-123');
    fireEvent.press(getByTestId('email-auth-submit-button'));

    await waitFor(() => {
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'recovered-password-123' });
      expect(getByTestId('authenticated-tab-navigator')).toBeTruthy();
    });
  });

  it('fails closed after recovery persistence and sign-out fail, including simulated restart', async () => {
    mockCurrentSession = mockSession;
    (LargeSecureStoreAdapter.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({
      error: { name: 'AuthUnknownError', status: 500 },
    });
    const firstRun = render(<App />);
    await act(async () => {});

    await act(async () => {
      mockAuthStateListener!('PASSWORD_RECOVERY', mockSession);
    });

    await waitFor(() => expect(firstRun.getByTestId('clear-local-auth-state-button')).toBeTruthy());
    expect(firstRun.queryByTestId('authenticated-tab-navigator')).toBeNull();
    firstRun.unmount();

    // Simulate restart while secure storage remains unavailable. The persisted
    // session is present, but the marker cannot be confirmed absent.
    (LargeSecureStoreAdapter.getItem as jest.Mock).mockRejectedValueOnce(
      new Error('secure storage unavailable after restart')
    );
    const restarted = render(<App />);
    await waitFor(() => expect(restarted.getByText('Secure sign-in unavailable')).toBeTruthy());

    expect(restarted.queryByTestId('authenticated-tab-navigator')).toBeNull();
    expect(restarted.queryByTestId('login-google-button')).toBeNull();
    expect(restarted.getByTestId('clear-local-auth-state-button')).toBeTruthy();

    (supabase.auth.signOut as jest.Mock).mockResolvedValueOnce({ error: null });
    (LargeSecureStoreAdapter.removeItem as jest.Mock).mockResolvedValueOnce(undefined);
    fireEvent.press(restarted.getByTestId('clear-local-auth-state-button'));
    await waitFor(() => expect(restarted.getByTestId('login-google-button')).toBeTruthy());
    expect(restarted.queryByTestId('authenticated-tab-navigator')).toBeNull();
  });
});
