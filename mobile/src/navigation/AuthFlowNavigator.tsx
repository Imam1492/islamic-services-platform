import React, { useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text, Pressable } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useOnboardingStatus } from '../hooks/useOnboardingStatus';
import { LoginScreen } from '../screens/LoginScreen';
import { OtpVerificationScreen } from '../screens/OtpVerificationScreen';
import { GeneralUserOnboardingScreen } from '../screens/GeneralUserOnboardingScreen';
import { AuthenticatedTabNavigator } from './AuthenticatedTabNavigator';

export type AuthFlowStep = 'login' | 'otp';

function UnauthenticatedFlow() {
  const [step, setStep] = useState<AuthFlowStep>('login');
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);

  if (step === 'otp' && pendingPhone) {
    return (
      <OtpVerificationScreen
        phone={pendingPhone}
        onChangePhone={() => {
          setPendingPhone(null);
          setStep('login');
        }}
      />
    );
  }

  return (
    <LoginScreen
      onOtpSent={(canonicalPhone) => {
        setPendingPhone(canonicalPhone);
        setStep('otp');
      }}
    />
  );
}

function AuthenticatedFlow({ userId }: { userId: string }) {
  const { signOut } = useAuth();
  const {
    step,
    onboardedAt,
    error,
    isSubmitting,
    refreshStatus,
    submitOnboarding,
  } = useOnboardingStatus(userId);

  if (step === 'CHECKING') {
    return (
      <View style={styles.loadingContainer} testID="onboarding-checking-container">
        <ActivityIndicator
          size="large"
          color="#2563EB"
          testID="onboarding-checking-spinner"
        />
        <Text style={styles.loadingText}>Checking profile status...</Text>
      </View>
    );
  }

  if (step === 'ERROR') {
    return (
      <View style={styles.errorScreenContainer} testID="onboarding-fatal-error-container">
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Unable to Load Profile</Text>
          <Text style={styles.errorMessage} testID="onboarding-fatal-error-message">
            {error?.userMessage || 'An unexpected error occurred while verifying your account.'}
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.retryButton,
              pressed ? styles.retryButtonPressed : null,
            ]}
            onPress={refreshStatus}
            accessibilityRole="button"
            accessibilityLabel="Retry loading profile"
            testID="onboarding-error-retry-button"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>

          <Pressable
            style={styles.signOutLink}
            onPress={signOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out of account"
            testID="onboarding-error-signout-button"
          >
            <Text style={styles.signOutLinkText}>Sign Out</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (step === 'NOT_ONBOARDED') {
    return (
      <GeneralUserOnboardingScreen
        onSubmit={async (fullName) => {
          return await submitOnboarding(fullName);
        }}
        isSubmitting={isSubmitting}
        externalError={error?.userMessage}
      />
    );
  }

  // step === 'ONBOARDED': Authoritative main app shell
  return <AuthenticatedTabNavigator onboardedAt={onboardedAt} />;
}

export function AuthFlowNavigator() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.loadingContainer} testID="auth-loading-container">
        <ActivityIndicator
          size="large"
          color="#2563EB"
          testID="auth-loading-spinner"
        />
        <Text style={styles.loadingText}>Initializing session...</Text>
      </View>
    );
  }

  // Authoritative authenticated session check
  if (session && session.user) {
    return <AuthenticatedFlow key={session.user.id} userId={session.user.id} />;
  }

  // Unauthenticated flow with isolated state
  return <UnauthenticatedFlow key="unauthenticated-flow" />;
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  errorScreenContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: '#4B5563',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  retryButton: {
    width: '100%',
    backgroundColor: '#2563EB',
    height: 48,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  retryButtonPressed: {
    backgroundColor: '#1D4ED8',
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  signOutLink: {
    paddingVertical: 8,
  },
  signOutLinkText: {
    color: '#6B7280',
    fontSize: 14,
    fontWeight: '500',
  },
});

