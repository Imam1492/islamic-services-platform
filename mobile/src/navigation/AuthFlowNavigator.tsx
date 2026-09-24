import React, { useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Text } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { LoginScreen } from '../screens/LoginScreen';
import { OtpVerificationScreen } from '../screens/OtpVerificationScreen';
import { AuthenticatedPlaceholderScreen } from '../screens/AuthenticatedPlaceholderScreen';

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
  if (session) {
    return <AuthenticatedPlaceholderScreen />;
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
});
