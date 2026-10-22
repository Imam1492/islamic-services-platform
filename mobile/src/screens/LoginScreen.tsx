import React, { useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ActivityIndicator,
  ScrollView,
  TextInput,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { classifyOAuthError } from '../utils/authErrors';

export interface LoginScreenProps {
  onSignInSuccess?: () => void;
  passwordRecoveryMode?: boolean;
  authStorageFailureMode?: boolean;
}

type AuthScreenMode = 'signIn' | 'signUp' | 'forgotPassword' | 'resetPassword';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export function LoginScreen({
  onSignInSuccess,
  passwordRecoveryMode = false,
  authStorageFailureMode = false,
}: LoginScreenProps) {
  const {
    signInWithGoogle,
    signUpWithEmail,
    signInWithEmail,
    requestPasswordReset,
    updatePassword,
    signOut,
    clearLocalAuthState,
  } = useAuth();
  const [screenMode, setScreenMode] = useState<AuthScreenMode>('signIn');
  const mode = passwordRecoveryMode ? 'resetPassword' : screenMode;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const submittingRef = useRef(false);

  const setMode = useCallback((nextMode: AuthScreenMode) => {
    setAuthError(null);
    setStatusMessage(null);
    setPassword('');
    setConfirmPassword('');
    setScreenMode(nextMode);
  }, []);

  const handleEmailSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    setAuthError(null);
    setStatusMessage(null);

    const normalizedEmail = email.trim();
    if (mode !== 'resetPassword' && !EMAIL_PATTERN.test(normalizedEmail)) {
      setAuthError('Enter a valid email address.');
      return;
    }
    if ((mode === 'signIn' || mode === 'signUp') && !password) {
      setAuthError('Enter your password.');
      return;
    }
    if ((mode === 'signUp' || mode === 'resetPassword') && password.length < MIN_PASSWORD_LENGTH) {
      setAuthError(`Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if ((mode === 'signUp' || mode === 'resetPassword') && password !== confirmPassword) {
      setAuthError('The passwords do not match.');
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      if (mode === 'signIn') {
        const { error } = await signInWithEmail(normalizedEmail, password);
        if (error) {
          setAuthError('Unable to sign in with that email and password. Check your details and try again.');
          return;
        }
        onSignInSuccess?.();
      } else if (mode === 'signUp') {
        const { error, needsEmailVerification } = await signUpWithEmail(normalizedEmail, password);
        if (error) {
          setAuthError('Unable to create an account with those details. Try signing in or resetting your password.');
          return;
        }
        if (needsEmailVerification) {
          setStatusMessage('If registration is available for this address, check your email to verify your account.');
        } else {
          setStatusMessage('Your account is ready.');
          onSignInSuccess?.();
        }
      } else if (mode === 'forgotPassword') {
        const { error } = await requestPasswordReset(normalizedEmail);
        if (error) {
          setAuthError('Unable to send a reset link right now. Please try again later.');
          return;
        }
        setStatusMessage('If an account matches this address, a password reset link will be sent.');
      } else {
        const { error } = await updatePassword(password);
        if (error) {
          setAuthError('Unable to update your password. Please request a new reset link and try again.');
          return;
        }
        setStatusMessage('Your password has been updated.');
        setPassword('');
        setConfirmPassword('');
      }
    } catch {
      const safeMessages: Record<AuthScreenMode, string> = {
        signIn: 'Unable to sign in with that email and password. Check your details and try again.',
        signUp: 'Unable to create an account with those details. Try signing in or resetting your password.',
        forgotPassword: 'Unable to send a reset link right now. Please try again later.',
        resetPassword: 'Unable to update your password. Please request a new reset link and try again.',
      };
      setAuthError(safeMessages[mode]);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    confirmPassword,
    email,
    mode,
    onSignInSuccess,
    password,
    requestPasswordReset,
    signInWithEmail,
    signUpWithEmail,
    updatePassword,
  ]);

  const handleGoogleSignIn = useCallback(async () => {
    if (submittingRef.current) return;

    setAuthError(null);
    setStatusMessage(null);
    submittingRef.current = true;
    setIsSubmitting(true);

    try {
      const result = await signInWithGoogle();

      if (result.isCancelled) {
        // User dismissed browser session; no error message
        setIsSubmitting(false);
        return;
      }

      if (result.error) {
        const classified = classifyOAuthError(result.error);
        if (!classified.isCancelled && classified.message) {
          setAuthError(classified.message);
        }
        return;
      }

      onSignInSuccess?.();
    } catch (unexpectedError) {
      const classified = classifyOAuthError(unexpectedError);
      setAuthError(classified.message || 'Unable to sign in with Google. Please try again.');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [signInWithGoogle, onSignInSuccess]);

  const handleCancelRecovery = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const { error } = await signOut();
      if (error) setAuthError('Unable to leave password reset. Please try again.');
    } catch {
      setAuthError('Unable to leave password reset. Please try again.');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [signOut]);

  const handleClearLocalAuthState = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setAuthError(null);
    try {
      const { error } = await clearLocalAuthState();
      if (error) setAuthError('Secure sign-in state is still unavailable. Please try again.');
    } catch {
      setAuthError('Secure sign-in state is still unavailable. Please try again.');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [clearLocalAuthState]);

  const title =
    mode === 'signUp'
      ? 'Create your account'
      : mode === 'forgotPassword'
        ? 'Reset your password'
        : mode === 'resetPassword'
          ? 'Choose a new password'
          : authStorageFailureMode
            ? 'Secure sign-in unavailable'
            : 'Sign In / Register';
  const submitLabel =
    mode === 'signUp'
      ? 'Create account'
      : mode === 'forgotPassword'
        ? 'Send reset link'
        : mode === 'resetPassword'
          ? 'Update password'
          : 'Sign in with email';

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="login-screen-scroll"
      >
        <View style={styles.header}>
          <Text style={styles.badge}>COMMUNITY PORTAL</Text>
          <Text style={styles.title} testID="login-title">{title}</Text>
          <Text style={styles.subtitle}>
            {authStorageFailureMode
              ? 'We could not verify the saved sign-in state. Clear the saved local session before signing in again.'
              : mode === 'resetPassword'
              ? 'Enter and confirm your new password to finish resetting your account.'
              : mode === 'forgotPassword'
                ? 'Enter the email address associated with your account.'
                : 'Sign in or create an account to access trusted community services and providers.'}
          </Text>
        </View>

        <View style={styles.formCard}>
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

          {statusMessage ? (
            <View
              style={styles.statusBanner}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              testID="login-auth-status"
            >
              <Text style={styles.statusBannerText}>{statusMessage}</Text>
            </View>
          ) : null}

          {!authStorageFailureMode && mode !== 'resetPassword' && (
            <TextInput
              style={styles.textInput}
              value={email}
              onChangeText={setEmail}
              placeholder="Email address"
              placeholderTextColor="#64748B"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              editable={!isSubmitting}
              accessibilityLabel="Email address"
              testID="auth-email-input"
            />
          )}

          {!authStorageFailureMode && (mode === 'signIn' || mode === 'signUp' || mode === 'resetPassword') && (
            <TextInput
              style={styles.textInput}
              value={password}
              onChangeText={setPassword}
              placeholder={mode === 'resetPassword' ? 'New password' : 'Password'}
              placeholderTextColor="#64748B"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
              editable={!isSubmitting}
              accessibilityLabel={mode === 'resetPassword' ? 'New password' : 'Password'}
              testID="auth-password-input"
            />
          )}

          {!authStorageFailureMode && (mode === 'signUp' || mode === 'resetPassword') && (
            <TextInput
              style={styles.textInput}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Confirm password"
              placeholderTextColor="#64748B"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              editable={!isSubmitting}
              accessibilityLabel="Confirm password"
              testID="auth-confirm-password-input"
            />
          )}

          {!authStorageFailureMode && <Pressable
            style={[styles.emailButton, isSubmitting ? styles.buttonDisabled : null]}
            onPress={handleEmailSubmit}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
            testID="email-auth-submit-button"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" testID="email-auth-loading-indicator" />
            ) : (
              <Text style={styles.emailButtonText}>{submitLabel}</Text>
            )}
          </Pressable>}

          {authStorageFailureMode && (
            <Pressable
              style={[styles.emailButton, isSubmitting ? styles.buttonDisabled : null]}
              onPress={handleClearLocalAuthState}
              disabled={isSubmitting}
              accessibilityRole="button"
              accessibilityLabel="Clear saved sign-in and continue"
              testID="clear-local-auth-state-button"
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.emailButtonText}>Clear saved sign-in and continue</Text>
              )}
            </Pressable>
          )}

          {!authStorageFailureMode && !passwordRecoveryMode && mode === 'signIn' && (
            <>
              <Pressable onPress={() => setMode('forgotPassword')} disabled={isSubmitting} accessibilityRole="button" testID="forgot-password-button">
                <Text style={styles.textLink}>Forgot password?</Text>
              </Pressable>
              <Pressable onPress={() => setMode('signUp')} disabled={isSubmitting} accessibilityRole="button" testID="create-account-button">
                <Text style={styles.textLink}>Create an account</Text>
              </Pressable>
            </>
          )}
          {!authStorageFailureMode && !passwordRecoveryMode && (mode === 'signUp' || mode === 'forgotPassword') && (
            <Pressable onPress={() => setMode('signIn')} disabled={isSubmitting} accessibilityRole="button" testID="return-to-signin-button">
              <Text style={styles.textLink}>{mode === 'signUp' ? 'Already have an account? Sign in' : 'Back to sign in'}</Text>
            </Pressable>
          )}
          {!authStorageFailureMode && passwordRecoveryMode && (
            <Pressable onPress={handleCancelRecovery} disabled={isSubmitting} accessibilityRole="button" testID="cancel-password-reset-button">
              <Text style={styles.textLink}>Cancel password reset</Text>
            </Pressable>
          )}

          {!authStorageFailureMode && !passwordRecoveryMode && mode === 'signIn' && <Pressable
            style={({ pressed }) => [
              styles.googleButton,
              isSubmitting ? styles.googleButtonDisabled : null,
              pressed ? styles.googleButtonPressed : null,
            ]}
            onPress={handleGoogleSignIn}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            accessibilityHint="Opens Google Sign-In in a secure browser window"
            testID="login-google-button"
          >
            {isSubmitting ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                testID="login-loading-indicator"
              />
            ) : (
              <View style={styles.buttonContent}>
                <View style={styles.googleIconWrapper}>
                  <Text style={styles.googleIconText}>G</Text>
                </View>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </View>
            )}
          </Pressable>}

          <View style={styles.infoBox}>
            <Text style={styles.infoText}>
              🔒 Secure authentication provided via Google OAuth.
              Your email and profile are synchronized authoritatively.
            </Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            By continuing, you acknowledge that onboarding agreements (Terms of Service
            and Privacy Policy) will be reviewed upon first sign-in.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
    paddingBottom: 32,
    justifyContent: 'center',
  },
  header: {
    marginBottom: 32,
    alignItems: 'center',
  },
  badge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F766E',
    backgroundColor: '#CCFBF1',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    letterSpacing: 0.8,
    marginBottom: 16,
    overflow: 'hidden',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 15,
    color: '#475569',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 8,
  },
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
    marginBottom: 24,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 12,
    color: '#0F172A',
    fontSize: 16,
    backgroundColor: '#FFFFFF',
  },
  emailButton: {
    backgroundColor: '#0F766E',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    marginBottom: 8,
  },
  emailButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  textLink: {
    color: '#1D4ED8',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 10,
  },
  statusBanner: {
    backgroundColor: '#ECFDF5',
    borderColor: '#6EE7B7',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  statusBannerText: {
    color: '#065F46',
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  googleButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  googleButtonPressed: {
    backgroundColor: '#1D4ED8',
    transform: [{ scale: 0.99 }],
  },
  googleButtonDisabled: {
    backgroundColor: '#93C5FD',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleIconWrapper: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  googleIconText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#2563EB',
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  errorBannerText: {
    color: '#991B1B',
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  infoBox: {
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  infoText: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
  },
  footer: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  footerText: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 18,
  },
});
