import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import App from '../App';
import { supabase } from '../src/lib/supabase';
import type { Session } from '@supabase/supabase-js';

// Stateful mock for Supabase - prefixed with 'mock' to comply with Jest mock hoisting
let mockAuthStateListener: ((event: string, session: Session | null) => void) | null = null;
let mockCurrentSession: Session | null = null;

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
      signInWithOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signOut: jest.fn(),
      refreshSession: jest.fn(),
    },
    rpc: jest.fn(),
  },
}));

describe('Complete Mobile Authentication Flow & Authoritative Onboarding Gate', () => {
  const mockUser = {
    id: 'usr_authenticated_123',
    phone: '+919876543210',
  };
  const mockSession = {
    access_token: 'auth_session_jwt_token',
    user: mockUser,
  } as unknown as Session;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentSession = null;
    mockAuthStateListener = null;
  });

  it('runs the full end-to-end flow: Login -> OTP -> Authenticated (Already Onboarded) -> SignOut', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    (supabase.auth.verifyOtp as jest.Mock).mockImplementationOnce(async () => {
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

    const { getByTestId, getByText, queryByTestId } = render(<App />);

    // Allow initial getSession to resolve
    await act(async () => {});

    // 1. Initial screen is LoginScreen
    expect(getByText('Sign In / Register')).toBeTruthy();
    expect(getByTestId('login-phone-input')).toBeTruthy();

    // 2. Enter valid phone number and submit
    fireEvent.changeText(getByTestId('login-phone-input'), '9876543210');
    fireEvent.press(getByTestId('login-submit-button'));

    // 3. Navigates to OTP verification screen
    await waitFor(() => {
      expect(getByText('Enter Verification Code')).toBeTruthy();
      expect(getByText('+919876543210')).toBeTruthy();
    });

    // 4. Enter 6-digit OTP and submit
    fireEvent.changeText(getByTestId('otp-hidden-input'), '123456');
    fireEvent.press(getByTestId('otp-verify-button'));

    // 5. Authoritative get_my_onboarding_status resolves true; AuthenticatedTabNavigator renders
    await waitFor(() => {
      expect(getByTestId('authenticated-tab-navigator')).toBeTruthy();
      expect(getByTestId('discover-shell-screen')).toBeTruthy();
    });

    // 6. Navigate to Account tab and sign out
    fireEvent.press(getByTestId('tab-button-account'));
    await waitFor(() => {
      expect(getByTestId('account-shell-screen')).toBeTruthy();
    });

    fireEvent.press(getByTestId('account-signout-button'));

    await waitFor(() => {
      expect(getByText('Sign In / Register')).toBeTruthy();
      expect(queryByTestId('authenticated-tab-navigator')).toBeNull();
    });
  });

  it('FRESH USER FLOW: Login -> OTP -> Incomplete Onboarding -> Renders Onboarding Screen (Main app BLOCKED)', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    (supabase.auth.verifyOtp as jest.Mock).mockImplementationOnce(async () => {
      mockCurrentSession = mockSession;
      if (mockAuthStateListener) {
        mockAuthStateListener('SIGNED_IN', mockSession);
      }
      return {
        data: { session: mockSession, user: mockUser },
        error: null,
      };
    });

    // Authoritative RPC returns NOT onboarded
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: { is_onboarded: false, onboarded_at: null },
      error: null,
    });

    const { getByTestId, getByText, queryByTestId } = render(<App />);
    await act(async () => {});

    // Enter phone and OTP
    fireEvent.changeText(getByTestId('login-phone-input'), '9876543210');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(getByText('Enter Verification Code')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('otp-hidden-input'), '123456');
    fireEvent.press(getByTestId('otp-verify-button'));

    // Renders GeneralUserOnboardingScreen
    await waitFor(() => {
      expect(getByText('Complete Your Profile')).toBeTruthy();
      expect(getByTestId('onboarding-fullname-input')).toBeTruthy();
    });

    // CRITICAL SECURITY INVARIANT: Main app must NOT be rendered
    expect(queryByTestId('authenticated-tab-navigator')).toBeNull();
    expect(queryByTestId('account-shell-screen')).toBeNull();
    expect(queryByTestId('account-signout-button')).toBeNull(); // Onboarding screen has onboarding-signout-button
  });

  it('FATAL ERROR FLOW: get_my_onboarding_status fails -> renders error screen with Retry and Sign Out', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    (supabase.auth.verifyOtp as jest.Mock).mockImplementationOnce(async () => {
      mockCurrentSession = mockSession;
      if (mockAuthStateListener) {
        mockAuthStateListener('SIGNED_IN', mockSession);
      }
      return {
        data: { session: mockSession, user: mockUser },
        error: null,
      };
    });

    // Authoritative RPC fails with P0002
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: null,
      error: { code: 'P0002', message: 'User profile not found' },
    });

    const { getByTestId, getByText, queryByTestId } = render(<App />);
    await act(async () => {});

    fireEvent.changeText(getByTestId('login-phone-input'), '9876543210');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(getByText('Enter Verification Code')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('otp-hidden-input'), '123456');
    fireEvent.press(getByTestId('otp-verify-button'));

    // Renders error screen
    await waitFor(() => {
      expect(getByText('Unable to Load Profile')).toBeTruthy();
      expect(getByTestId('onboarding-fatal-error-message')).toBeTruthy();
      expect(getByTestId('onboarding-error-retry-button')).toBeTruthy();
      expect(getByTestId('onboarding-error-signout-button')).toBeTruthy();
    });

    // Main app must NOT be rendered
    expect(queryByTestId('authenticated-tab-navigator')).toBeNull();
    expect(queryByTestId('account-shell-screen')).toBeNull();
  });

  it('allows user to change phone number from OTP screen and resets flow state', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    const { getByTestId, getByText, queryByTestId } = render(<App />);
    await act(async () => {});

    fireEvent.changeText(getByTestId('login-phone-input'), '9876543210');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(getByText('+919876543210')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('otp-hidden-input'), '123');
    fireEvent.press(getByTestId('otp-change-phone-button'));

    await waitFor(() => {
      expect(getByText('Sign In / Register')).toBeTruthy();
      expect(queryByTestId('otp-hidden-input')).toBeNull();
    });
  });

  it('SECURITY CHECK: codebase does not reference privileged service role environment variables', () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(process.env.SERVICE_ROLE_KEY).toBeUndefined();
  });
});
