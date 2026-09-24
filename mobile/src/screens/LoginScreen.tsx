import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { PhoneInput } from '../components/PhoneInput';
import {
  DEFAULT_COUNTRY_CODE,
  validatePhoneInput,
  getSafeAuthErrorMessage,
} from '../utils/phone';

export interface LoginScreenProps {
  onOtpSent: (canonicalPhone: string) => void;
  initialPhone?: string;
}

export function LoginScreen({ onOtpSent }: LoginScreenProps) {
  const { signInWithOtp } = useAuth();

  const [countryCode, setCountryCode] = useState<string>(DEFAULT_COUNTRY_CODE);
  const [nationalNumber, setNationalNumber] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const handlePhoneChange = (text: string) => {
    setNationalNumber(text);
    if (validationError) setValidationError(null);
    if (authError) setAuthError(null);
  };

  const handleCountryCodeChange = (code: string) => {
    setCountryCode(code);
    if (validationError) setValidationError(null);
    if (authError) setAuthError(null);
  };

  const handleSubmit = useCallback(async () => {
    // Guard against duplicate/concurrent submission
    if (isSubmitting) return;

    setValidationError(null);
    setAuthError(null);

    // 1. Client-side UX validation
    const validation = validatePhoneInput(countryCode, nationalNumber);
    if (!validation.isValid) {
      setValidationError(validation.error || 'Please enter a valid phone number.');
      return;
    }

    setIsSubmitting(true);

    try {
      // 2. Call authoritative existing AuthContext method with canonical E.164 phone
      const { error } = await signInWithOtp({ phone: validation.e164 });

      if (error) {
        // Map error to safe user-facing message; never expose raw backend/system details or PII
        const safeMessage = getSafeAuthErrorMessage(error, 'phone_entry');
        setAuthError(safeMessage);
        return;
      }

      // 3. On success, proceed to OTP verification screen with the canonical phone value
      onOtpSent(validation.e164);
    } catch (unexpectedError) {
      // Safe generic message on unexpected network/runtime failure
      const safeMessage = getSafeAuthErrorMessage(unexpectedError, 'phone_entry');
      setAuthError(safeMessage);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, countryCode, nationalNumber, signInWithOtp, onOtpSent]);

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
          <Text style={styles.title}>Sign In / Register</Text>
          <Text style={styles.subtitle}>
            Enter your mobile phone number. We will send you a 6-digit verification code.
          </Text>
        </View>

        <View style={styles.form}>
          <PhoneInput
            countryCode={countryCode}
            onCountryCodeChange={handleCountryCodeChange}
            value={nationalNumber}
            onChangeText={handlePhoneChange}
            error={validationError}
            disabled={isSubmitting}
            loading={isSubmitting}
            onSubmitEditing={handleSubmit}
            testID="login-phone-input"
          />

          {authError ? (
            <View
              style={styles.errorBanner}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              testID="login-auth-error"
            >
              <Text style={styles.errorBannerText}>{authError}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.submitButton,
              isSubmitting ? styles.submitButtonDisabled : null,
              pressed ? styles.submitButtonPressed : null,
            ]}
            onPress={handleSubmit}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel={
              isSubmitting
                ? 'Sending verification code, please wait'
                : 'Send verification code'
            }
            accessibilityState={{ disabled: isSubmitting }}
            testID="login-submit-button"
          >
            {isSubmitting ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                testID="login-loading-indicator"
              />
            ) : (
              <Text style={styles.submitButtonText}>Send Code</Text>
            )}
          </Pressable>
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
    marginBottom: 32,
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
  submitButton: {
    backgroundColor: '#2563EB',
    height: 50,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonDisabled: {
    backgroundColor: '#93C5FD',
  },
  submitButtonPressed: {
    backgroundColor: '#1D4ED8',
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
