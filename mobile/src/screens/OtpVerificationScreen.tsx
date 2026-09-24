import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { getSafeAuthErrorMessage } from '../utils/phone';

export interface OtpVerificationScreenProps {
  phone: string; // Canonical E.164
  onChangePhone: () => void;
  cooldownSeconds?: number;
}

const DEFAULT_COOLDOWN = 30;

export function OtpVerificationScreen({
  phone,
  onChangePhone,
  cooldownSeconds = DEFAULT_COOLDOWN,
}: OtpVerificationScreenProps) {
  const { verifyOtp, signInWithOtp } = useAuth();

  const [otp, setOtp] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [isResending, setIsResending] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number>(cooldownSeconds);

  const inputRef = useRef<TextInput>(null);

  // Cooldown timer effect
  useEffect(() => {
    if (cooldown <= 0) return;

    const timer = setInterval(() => {
      setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldown]);

  const handleOtpChange = (text: string) => {
    // Only numeric digits, max 6 characters
    const numeric = text.replace(/[^0-9]/g, '').slice(0, 6);
    setOtp(numeric);
    if (errorMessage) setErrorMessage(null);
    if (infoMessage) setInfoMessage(null);
  };

  const handleVerify = useCallback(
    async (codeToVerify?: string) => {
      const token = codeToVerify ?? otp;

      if (isVerifying) return;

      if (token.length !== 6) {
        setErrorMessage('Please enter the complete 6-digit verification code.');
        return;
      }

      setIsVerifying(true);
      setErrorMessage(null);
      setInfoMessage(null);

      try {
        // Authoritative verification via existing AuthContext
        const { error } = await verifyOtp({
          phone,
          token,
        });

        if (error) {
          const safeMessage = getSafeAuthErrorMessage(error, 'otp_verify');
          setErrorMessage(safeMessage);
          return;
        }

        // On success: Supabase updates session and AuthContext receives the auth state change.
      } catch (err) {
        const safeMessage = getSafeAuthErrorMessage(err, 'otp_verify');
        setErrorMessage(safeMessage);
      } finally {
        setIsVerifying(false);
      }
    },
    [isVerifying, otp, verifyOtp, phone]
  );

  const handleResend = useCallback(async () => {
    if (cooldown > 0 || isResending || isVerifying) return;

    setIsResending(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const { error } = await signInWithOtp({ phone });

      if (error) {
        const safeMessage = getSafeAuthErrorMessage(error, 'otp_resend');
        setErrorMessage(safeMessage);
        return;
      }

      setCooldown(cooldownSeconds);
      setInfoMessage('A new verification code has been sent.');
      setOtp('');
    } catch (err) {
      const safeMessage = getSafeAuthErrorMessage(err, 'otp_resend');
      setErrorMessage(safeMessage);
    } finally {
      setIsResending(false);
    }
  }, [cooldown, isResending, isVerifying, signInWithOtp, phone, cooldownSeconds]);

  const handleChangeNumber = () => {
    // Clear pending OTP state and notify parent navigator to switch to phone entry
    setOtp('');
    setErrorMessage(null);
    setInfoMessage(null);
    onChangePhone();
  };

  // Focus hidden input when tapping cell area
  const focusInput = () => {
    if (!isVerifying) {
      inputRef.current?.focus();
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Enter Verification Code</Text>
          <Text style={styles.subtitle}>
            We have sent a 6-digit SMS verification code to{' '}
            <Text style={styles.phoneHighlight}>{phone}</Text>.
          </Text>
          <Pressable
            onPress={handleChangeNumber}
            disabled={isVerifying}
            accessibilityRole="button"
            accessibilityLabel="Change phone number"
            style={styles.changePhoneButton}
            testID="otp-change-phone-button"
          >
            <Text style={styles.changePhoneText}>Edit phone number</Text>
          </Pressable>
        </View>

        <View style={styles.form}>
          {/* OTP Digit Boxes */}
          <Pressable
            style={styles.otpGrid}
            onPress={focusInput}
            accessibilityRole="none"
            testID="otp-cell-container"
          >
            {[0, 1, 2, 3, 4, 5].map((index) => {
              const char = otp[index] || '';
              const isFocused = otp.length === index;
              return (
                <View
                  key={index}
                  style={[
                    styles.otpCell,
                    char ? styles.otpCellFilled : null,
                    isFocused ? styles.otpCellFocused : null,
                    errorMessage ? styles.otpCellError : null,
                  ]}
                >
                  <Text style={styles.otpCellText} testID={`otp-cell-${index}`}>
                    {char}
                  </Text>
                </View>
              );
            })}
          </Pressable>

          {/* Hidden but accessible input */}
          <TextInput
            ref={inputRef}
            style={styles.hiddenInput}
            value={otp}
            onChangeText={handleOtpChange}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            maxLength={6}
            editable={!isVerifying}
            accessibilityLabel="6-digit verification code"
            accessibilityHint="Enter the 6-digit code received via SMS"
            aria-invalid={!!errorMessage}
            testID="otp-hidden-input"
            autoFocus
          />

          {errorMessage ? (
            <View
              style={styles.errorBanner}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              testID="otp-error-banner"
            >
              <Text style={styles.errorBannerText}>{errorMessage}</Text>
            </View>
          ) : null}

          {infoMessage ? (
            <View
              style={styles.infoBanner}
              accessibilityLiveRegion="polite"
              testID="otp-info-banner"
            >
              <Text style={styles.infoBannerText}>{infoMessage}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.verifyButton,
              otp.length !== 6 || isVerifying ? styles.verifyButtonDisabled : null,
              pressed ? styles.verifyButtonPressed : null,
            ]}
            onPress={() => handleVerify()}
            disabled={otp.length !== 6 || isVerifying}
            accessibilityRole="button"
            accessibilityLabel={
              isVerifying
                ? 'Verifying code, please wait'
                : 'Verify code and sign in'
            }
            accessibilityState={{ disabled: otp.length !== 6 || isVerifying }}
            testID="otp-verify-button"
          >
            {isVerifying ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                testID="otp-verifying-indicator"
              />
            ) : (
              <Text style={styles.verifyButtonText}>Verify & Sign In</Text>
            )}
          </Pressable>

          {/* Resend Section */}
          <View style={styles.resendContainer}>
            <Text style={styles.resendPrompt}>Didn&apos;t receive the code?</Text>
            {cooldown > 0 ? (
              <Text
                style={styles.cooldownText}
                testID="otp-cooldown-text"
                accessibilityLabel={`Resend code available in ${cooldown} seconds`}
              >
                Resend code in {cooldown}s
              </Text>
            ) : (
              <Pressable
                onPress={handleResend}
                disabled={isResending || isVerifying}
                accessibilityRole="button"
                accessibilityLabel="Resend verification code"
                testID="otp-resend-button"
              >
                {isResending ? (
                  <ActivityIndicator size="small" color="#2563EB" />
                ) : (
                  <Text style={styles.resendButtonText}>Resend Code</Text>
                )}
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  header: {
    marginBottom: 28,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#4B5563',
    lineHeight: 22,
  },
  phoneHighlight: {
    fontWeight: '600',
    color: '#111827',
  },
  changePhoneButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  changePhoneText: {
    color: '#2563EB',
    fontSize: 14,
    fontWeight: '600',
  },
  form: {
    backgroundColor: '#FFFFFF',
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  otpGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  otpCell: {
    width: 44,
    height: 52,
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
  },
  otpCellFilled: {
    borderColor: '#2563EB',
    backgroundColor: '#FFFFFF',
  },
  otpCellFocused: {
    borderColor: '#2563EB',
    borderWidth: 2,
    backgroundColor: '#FFFFFF',
  },
  otpCellError: {
    borderColor: '#EF4444',
  },
  otpCellText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0.01,
    width: 1,
    height: 1,
  },
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    fontSize: 14,
    color: '#B91C1C',
    lineHeight: 20,
  },
  infoBanner: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#86EFAC',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  infoBannerText: {
    fontSize: 14,
    color: '#166534',
    lineHeight: 20,
  },
  verifyButton: {
    backgroundColor: '#2563EB',
    height: 50,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  verifyButtonDisabled: {
    backgroundColor: '#93C5FD',
  },
  verifyButtonPressed: {
    backgroundColor: '#1D4ED8',
  },
  verifyButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  resendContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    gap: 6,
  },
  resendPrompt: {
    fontSize: 14,
    color: '#6B7280',
  },
  cooldownText: {
    fontSize: 14,
    color: '#9CA3AF',
    fontWeight: '500',
  },
  resendButtonText: {
    fontSize: 14,
    color: '#2563EB',
    fontWeight: '600',
  },
});
