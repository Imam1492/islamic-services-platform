import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { LoginScreen } from '../src/screens/LoginScreen';
import { AuthProvider } from '../src/context/AuthContext';
import { supabase } from '../src/lib/supabase';

jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: jest.fn().mockReturnValue({
        data: { subscription: { unsubscribe: jest.fn() } },
      }),
      signInWithOtp: jest.fn(),
      verifyOtp: jest.fn(),
      signOut: jest.fn(),
      refreshSession: jest.fn(),
    },
  },
}));

describe('<LoginScreen />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderLogin = (onOtpSent = jest.fn()) => {
    return {
      ...render(
        <AuthProvider>
          <LoginScreen onOtpSent={onOtpSent} />
        </AuthProvider>
      ),
      onOtpSent,
    };
  };

  it('submits valid Indian phone number and triggers onOtpSent with canonical E.164', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    const { getByTestId, onOtpSent } = renderLogin();
    await act(async () => {});

    const input = getByTestId('login-phone-input');
    fireEvent.changeText(input, '9876543210');

    const submitBtn = getByTestId('login-submit-button');
    fireEvent.press(submitBtn);

    await waitFor(() => {
      expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
        phone: '+919876543210',
      });
      expect(onOtpSent).toHaveBeenCalledWith('+919876543210');
    });
  });

  it('prevents Auth API call when phone number is invalid and shows validation error', async () => {
    const { getByTestId, getByText, onOtpSent } = renderLogin();
    await act(async () => {});

    const input = getByTestId('login-phone-input');
    fireEvent.changeText(input, '12345'); // too short

    const submitBtn = getByTestId('login-submit-button');
    fireEvent.press(submitBtn);

    await waitFor(() => {
      expect(supabase.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(onOtpSent).not.toHaveBeenCalled();
      expect(getByText('Please enter a valid 10-digit mobile number.')).toBeTruthy();
    });
  });

  it('prevents Auth API call when phone number is empty', async () => {
    const { getByTestId, getByText, onOtpSent } = renderLogin();
    await act(async () => {});

    const submitBtn = getByTestId('login-submit-button');
    fireEvent.press(submitBtn);

    await waitFor(() => {
      expect(supabase.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(onOtpSent).not.toHaveBeenCalled();
      expect(getByText('Please enter your mobile phone number.')).toBeTruthy();
    });
  });

  it('shows loading indicator and prevents duplicate submission while submitting', async () => {
    let resolveAuth: (val: unknown) => void;
    const authPromise = new Promise((resolve) => {
      resolveAuth = resolve;
    });

    (supabase.auth.signInWithOtp as jest.Mock).mockReturnValueOnce(authPromise);

    const { getByTestId } = renderLogin();
    await act(async () => {});

    const input = getByTestId('login-phone-input');
    fireEvent.changeText(input, '9876543210');

    const submitBtn = getByTestId('login-submit-button');
    fireEvent.press(submitBtn);

    // Should show loading spinner
    expect(getByTestId('login-loading-indicator')).toBeTruthy();

    // Duplicate press while in flight
    fireEvent.press(submitBtn);
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledTimes(1);

    // Resolve request
    await act(async () => {
      resolveAuth!({ error: null });
    });
  });

  it('handles network failure with safe user message', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockRejectedValueOnce(
      new Error('Failed to fetch: network down')
    );

    const { getByTestId, getByText } = renderLogin();
    await act(async () => {});

    fireEvent.changeText(getByTestId('login-phone-input'), '9876543210');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(
        getByText('Network connection error. Please check your internet connection and try again.')
      ).toBeTruthy();
    });
  });

  it('handles rate limiting (429) with safe user message and does not expose internals', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: {
        message: 'Too Many Requests: exceeded rate limit of 3 requests per hour',
        status: 429,
        name: 'AuthApiError',
      },
    });

    const { getByTestId, getByText, queryByText } = renderLogin();
    await act(async () => {});

    fireEvent.changeText(getByTestId('login-phone-input'), '9876543210');
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      // Safe error displayed
      expect(
        getByText('Too many requests. Please wait a moment before trying again.')
      ).toBeTruthy();
      // Raw internal backend detail MUST NOT be leaked
      expect(queryByText(/AuthApiError/i)).toBeNull();
      expect(queryByText(/exceeded rate limit of 3 requests/i)).toBeNull();
    });
  });

  it('does not log user phone numbers to console during submission', async () => {
    const logSpy = jest.spyOn(console, 'log');
    const warnSpy = jest.spyOn(console, 'warn');
    const errorSpy = jest.spyOn(console, 'error');

    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    const { getByTestId } = renderLogin();
    await act(async () => {});

    const sensitiveNumber = '9876543210';
    fireEvent.changeText(getByTestId('login-phone-input'), sensitiveNumber);
    fireEvent.press(getByTestId('login-submit-button'));

    await waitFor(() => {
      expect(supabase.auth.signInWithOtp).toHaveBeenCalled();
    });

    const allLoggedArgs = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ].flat();

    expect(allLoggedArgs.some((arg) => typeof arg === 'string' && arg.includes(sensitiveNumber))).toBe(false);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
