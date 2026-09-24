import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { OtpVerificationScreen } from '../src/screens/OtpVerificationScreen';
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

describe('<OtpVerificationScreen />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderOtp = (props?: Partial<React.ComponentProps<typeof OtpVerificationScreen>>) => {
    const onChangePhone = jest.fn();
    const result = render(
      <AuthProvider>
        <OtpVerificationScreen
          phone="+919876543210"
          onChangePhone={onChangePhone}
          cooldownSeconds={0}
          {...props}
        />
      </AuthProvider>
    );
    return { ...result, onChangePhone };
  };

  it('renders phone number and 6 digit cells', async () => {
    const { getByText, getByTestId } = renderOtp();
    await act(async () => {});

    expect(getByText('Enter Verification Code')).toBeTruthy();
    expect(getByText('+919876543210')).toBeTruthy();
    expect(getByTestId('otp-cell-0')).toBeTruthy();
    expect(getByTestId('otp-cell-5')).toBeTruthy();
  });

  it('rejects non-numeric characters and fills cells with digits', async () => {
    const { getByTestId } = renderOtp();
    await act(async () => {});

    const input = getByTestId('otp-hidden-input');
    fireEvent.changeText(input, '1a2b3c4d5e6f');

    // Should only contain 6 digits
    expect(getByTestId('otp-cell-0').props.children).toBe('1');
    expect(getByTestId('otp-cell-1').props.children).toBe('2');
    expect(getByTestId('otp-cell-2').props.children).toBe('3');
    expect(getByTestId('otp-cell-3').props.children).toBe('4');
    expect(getByTestId('otp-cell-4').props.children).toBe('5');
    expect(getByTestId('otp-cell-5').props.children).toBe('6');
  });

  it('rejects incomplete OTP when verify button is disabled', async () => {
    const { getByTestId } = renderOtp();
    await act(async () => {});

    const input = getByTestId('otp-hidden-input');
    fireEvent.changeText(input, '123');

    const verifyBtn = getByTestId('otp-verify-button');
    expect(verifyBtn.props.accessibilityState.disabled).toBe(true);

    fireEvent.press(verifyBtn);
    expect(supabase.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('submits valid 6-digit OTP using authoritative verifyOtp AuthContext method', async () => {
    (supabase.auth.verifyOtp as jest.Mock).mockResolvedValueOnce({
      data: {
        session: { access_token: 'auth-session-token', user: { id: 'u1' } },
        user: { id: 'u1' },
      },
      error: null,
    });

    const { getByTestId } = renderOtp();
    await act(async () => {});

    const input = getByTestId('otp-hidden-input');
    fireEvent.changeText(input, '654321');

    const verifyBtn = getByTestId('otp-verify-button');
    expect(verifyBtn.props.accessibilityState.disabled).toBe(false);
    fireEvent.press(verifyBtn);

    await waitFor(() => {
      expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
        phone: '+919876543210',
        token: '654321',
        type: 'sms',
      });
    });
  });

  it('handles incorrect OTP with safe user-facing message', async () => {
    (supabase.auth.verifyOtp as jest.Mock).mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { message: 'Token is invalid', status: 400 },
    });

    const { getByTestId, getByText } = renderOtp();
    await act(async () => {});

    fireEvent.changeText(getByTestId('otp-hidden-input'), '000000');
    fireEvent.press(getByTestId('otp-verify-button'));

    await waitFor(() => {
      expect(
        getByText('Invalid verification code. Please check the code and try again.')
      ).toBeTruthy();
    });
  });

  it('handles expired OTP with safe message', async () => {
    (supabase.auth.verifyOtp as jest.Mock).mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { message: 'Otp expired', status: 400 },
    });

    const { getByTestId, getByText } = renderOtp();
    await act(async () => {});

    fireEvent.changeText(getByTestId('otp-hidden-input'), '111111');
    fireEvent.press(getByTestId('otp-verify-button'));

    await waitFor(() => {
      expect(
        getByText('The verification code has expired. Please request a new one.')
      ).toBeTruthy();
    });
  });

  it('handles network failure during verification safely', async () => {
    (supabase.auth.verifyOtp as jest.Mock).mockRejectedValueOnce(
      new Error('fetch failed: network error')
    );

    const { getByTestId, getByText } = renderOtp();
    await act(async () => {});

    fireEvent.changeText(getByTestId('otp-hidden-input'), '999999');
    fireEvent.press(getByTestId('otp-verify-button'));

    await waitFor(() => {
      expect(
        getByText('Network connection error. Please check your internet connection and try again.')
      ).toBeTruthy();
    });
  });

  it('prevents duplicate verification submissions', async () => {
    let resolveVerify: (val: unknown) => void;
    const verifyPromise = new Promise((resolve) => {
      resolveVerify = resolve;
    });
    (supabase.auth.verifyOtp as jest.Mock).mockReturnValueOnce(verifyPromise);

    const { getByTestId } = renderOtp();
    await act(async () => {});

    fireEvent.changeText(getByTestId('otp-hidden-input'), '123456');
    const verifyBtn = getByTestId('otp-verify-button');

    fireEvent.press(verifyBtn);
    expect(getByTestId('otp-verifying-indicator')).toBeTruthy();

    // Duplicate press while in flight
    fireEvent.press(verifyBtn);
    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveVerify!({ data: { session: null, user: null }, error: null });
    });
  });

  it('resends OTP via AuthContext signInWithOtp and displays feedback', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: null,
    });

    const { getByTestId, getByText } = renderOtp({ cooldownSeconds: 0 });
    await act(async () => {});

    const resendBtn = getByTestId('otp-resend-button');
    fireEvent.press(resendBtn);

    await waitFor(() => {
      expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({
        phone: '+919876543210',
      });
      expect(getByText('A new verification code has been sent.')).toBeTruthy();
    });
  });

  it('disables resend button during active cooldown', async () => {
    const { getByTestId, queryByTestId } = renderOtp({ cooldownSeconds: 30 });
    await act(async () => {});

    expect(getByTestId('otp-cooldown-text')).toBeTruthy();
    expect(queryByTestId('otp-resend-button')).toBeNull();
  });

  it('handles rate-limit on resend safely', async () => {
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValueOnce({
      error: { message: 'rate limit exceeded', status: 429 },
    });

    const { getByTestId, getByText } = renderOtp({ cooldownSeconds: 0 });
    await act(async () => {});

    fireEvent.press(getByTestId('otp-resend-button'));

    await waitFor(() => {
      expect(
        getByText('Too many requests. Please wait a moment before requesting another code.')
      ).toBeTruthy();
    });
  });

  it('calls onChangePhone to allow user to return and change phone number', async () => {
    const { getByTestId, onChangePhone } = renderOtp();
    await act(async () => {});

    const changePhoneBtn = getByTestId('otp-change-phone-button');
    fireEvent.press(changePhoneBtn);

    expect(onChangePhone).toHaveBeenCalledTimes(1);
  });

  it('SECURITY: OTP token is NEVER logged to console', async () => {
    const logSpy = jest.spyOn(console, 'log');
    const warnSpy = jest.spyOn(console, 'warn');
    const errorSpy = jest.spyOn(console, 'error');

    (supabase.auth.verifyOtp as jest.Mock).mockResolvedValueOnce({
      data: { session: null, user: null },
      error: null,
    });

    const { getByTestId } = renderOtp();
    await act(async () => {});

    const secretOtp = '849201';
    fireEvent.changeText(getByTestId('otp-hidden-input'), secretOtp);
    fireEvent.press(getByTestId('otp-verify-button'));

    await waitFor(() => {
      expect(supabase.auth.verifyOtp).toHaveBeenCalled();
    });

    const allLoggedArgs = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ].flat();

    expect(allLoggedArgs.some((arg) => typeof arg === 'string' && arg.includes(secretOtp))).toBe(false);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
