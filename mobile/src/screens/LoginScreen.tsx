import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { classifyOAuthError } from '../utils/authErrors';

export interface LoginScreenProps {
  onSignInSuccess?: () => void;
}

export function LoginScreen({ onSignInSuccess }: LoginScreenProps) {
  const { signInWithGoogle } = useAuth();
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const handleGoogleSignIn = useCallback(async () => {
    // Guard against duplicate / concurrent submission
    if (isSubmitting) return;

    setAuthError(null);
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
      setIsSubmitting(false);
    }
  }, [isSubmitting, signInWithGoogle, onSignInSuccess]);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        testID="login-screen-scroll"
      >
        <View style={styles.header}>
          <Text style={styles.badge}>COMMUNITY PORTAL</Text>
          <Text style={styles.title} testID="login-title">
            Sign In / Register
          </Text>
          <Text style={styles.subtitle}>
            Welcome to the Islamic Services Platform. Sign in securely with your Google
            account to discover trusted community services, submit requests, and connect
            with verified providers.
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

          <Pressable
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
          </Pressable>

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
