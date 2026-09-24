import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useAuth } from '../context/AuthContext';

export function AuthenticatedPlaceholderScreen() {
  const { user, signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setError(null);
    try {
      const { error: signOutError } = await signOut();
      if (signOutError) {
        setError('Sign out failed. Please try again.');
      }
    } catch {
      setError('Sign out failed. Please try again.');
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>✓ Authenticated</Text>
        </View>

        <Text style={styles.title}>Welcome!</Text>
        <Text style={styles.subtitle}>
          Your phone number has been successfully verified with Supabase Auth.
        </Text>

        <View style={styles.infoBox}>
          <Text style={styles.infoLabel}>User ID</Text>
          <Text style={styles.infoValue} testID="authenticated-user-id">
            {user?.id || 'Unknown'}
          </Text>

          {user?.phone ? (
            <>
              <Text style={[styles.infoLabel, { marginTop: 12 }]}>Phone</Text>
              <Text style={styles.infoValue} testID="authenticated-user-phone">
                {user.phone}
              </Text>
            </>
          ) : null}
        </View>

        <Text style={styles.onboardingNotice}>
          Phase 3.2.1 complete. User onboarding workflows will take over here in Phase 3.2.2.
        </Text>

        {error ? (
          <Text style={styles.errorText} testID="signout-error">
            {error}
          </Text>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.signOutButton,
            isSigningOut ? styles.signOutButtonDisabled : null,
            pressed ? styles.signOutButtonPressed : null,
          ]}
          onPress={handleSignOut}
          disabled={isSigningOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out of account"
          testID="sign-out-button"
        >
          {isSigningOut ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.signOutButtonText}>Sign Out</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    alignItems: 'center',
  },
  badge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    marginBottom: 16,
  },
  badgeText: {
    color: '#15803D',
    fontSize: 13,
    fontWeight: '600',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#4B5563',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  infoBox: {
    width: '100%',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#F3F4F6',
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1F2937',
    marginTop: 2,
  },
  onboardingNotice: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 24,
    fontStyle: 'italic',
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
    marginBottom: 12,
  },
  signOutButton: {
    width: '100%',
    backgroundColor: '#DC2626',
    height: 48,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  signOutButtonDisabled: {
    backgroundColor: '#FCA5A5',
  },
  signOutButtonPressed: {
    backgroundColor: '#B91C1C',
  },
  signOutButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
