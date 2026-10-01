import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, ScrollView } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { maskPhone } from '../../utils/phone';
import { LegalDocumentService } from '../../services/legalDocumentService';
import { LegalDocumentModal } from '../../components/LegalDocumentModal';
import type { LegalDocument } from '../../types/legal';

export interface AccountShellScreenProps {
  onboardedAt?: string | null;
}

export function AccountShellScreen({ onboardedAt }: AccountShellScreenProps) {
  const { session, signOut } = useAuth();
  const [activeModalDoc, setActiveModalDoc] = useState<LegalDocument | null>(null);
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);

  const user = session?.user;
  const maskedPhone = maskPhone(user?.phone);
  const legalRegistry = LegalDocumentService.getDocuments();

  const formattedDate = onboardedAt
    ? new Date(onboardedAt).toISOString().split('T')[0]
    : 'Completed';

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <View style={styles.container} testID="account-shell-screen">
      <ScrollView contentContainerStyle={styles.contentContainer}>
        {/* Screen Title */}
        <View style={styles.header}>
          <Text style={styles.screenTitle} testID="account-screen-title">
            Account
          </Text>
          <Text style={styles.screenSubtitle}>
            Manage your profile status and legal agreements
          </Text>
        </View>

        {/* Member Profile Overview Card */}
        <View style={styles.profileCard} testID="account-profile-card">
          <View style={styles.avatarWrapper}>
            <Text style={styles.avatarIcon}>👤</Text>
          </View>
          <View style={styles.profileTextContainer}>
            <Text style={styles.membershipTitle} testID="account-membership-title">
              Onboarded Member
            </Text>
            <View style={styles.statusBadge} testID="account-status-badge">
              <Text style={styles.statusBadgeText}>Account Active</Text>
            </View>
          </View>
        </View>

        {/* Account Details & Privacy Card */}
        <View style={styles.sectionCard} testID="account-details-card">
          <Text style={styles.sectionHeader}>Account Information</Text>

          {/* Masked Phone Number */}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Mobile Phone</Text>
            <Text style={styles.detailValue} testID="account-masked-phone">
              {maskedPhone || 'Not provided'}
            </Text>
            <Text style={styles.privacyNote}>Private • Never shared without consent</Text>
          </View>

          <View style={styles.divider} />

          {/* Onboarding Completed Date */}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Onboarding Date</Text>
            <Text style={styles.detailValue} testID="account-onboarded-date">
              {formattedDate}
            </Text>
          </View>
        </View>

        {/* Legal Agreements Card */}
        <View style={styles.sectionCard} testID="account-legal-card">
          <Text style={styles.sectionHeader}>Legal & Compliance</Text>

          <Pressable
            style={styles.legalRow}
            onPress={() => setActiveModalDoc(legalRegistry.termsOfService)}
            accessibilityRole="button"
            accessibilityLabel="View Terms of Service"
            testID="account-view-tos-button"
          >
            <Text style={styles.legalRowText}>Terms of Service</Text>
            <Text style={styles.legalStatusTag}>
              {legalRegistry.termsOfService.status === 'PENDING_REVIEW'
                ? 'Pending Review'
                : 'Approved'}
            </Text>
          </Pressable>

          <View style={styles.divider} />

          <Pressable
            style={styles.legalRow}
            onPress={() => setActiveModalDoc(legalRegistry.privacyPolicy)}
            accessibilityRole="button"
            accessibilityLabel="View Privacy Policy"
            testID="account-view-privacy-button"
          >
            <Text style={styles.legalRowText}>Privacy Policy</Text>
            <Text style={styles.legalStatusTag}>
              {legalRegistry.privacyPolicy.status === 'PENDING_REVIEW'
                ? 'Pending Review'
                : 'Approved'}
            </Text>
          </Pressable>
        </View>

        {/* Sign Out Button */}
        <Pressable
          style={({ pressed }) => [
            styles.signOutButton,
            pressed ? styles.signOutButtonPressed : null,
          ]}
          onPress={handleSignOut}
          disabled={isSigningOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out of account"
          testID="account-signout-button"
        >
          <Text style={styles.signOutButtonText}>
            {isSigningOut ? 'Signing Out...' : 'Sign Out'}
          </Text>
        </Pressable>
      </ScrollView>

      {/* In-App Legal Document Viewer Modal */}
      <LegalDocumentModal
        visible={activeModalDoc !== null}
        document={activeModalDoc}
        onClose={() => setActiveModalDoc(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 20,
  },
  screenTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 4,
  },
  screenSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 16,
  },
  avatarWrapper: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  avatarIcon: {
    fontSize: 24,
  },
  profileTextContainer: {
    flex: 1,
  },
  membershipTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#166534',
  },
  sectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 16,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 12,
  },
  detailRow: {
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '500',
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  privacyNote: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 12,
  },
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  legalRowText: {
    fontSize: 14,
    color: '#2563EB',
    fontWeight: '500',
  },
  legalStatusTag: {
    fontSize: 11,
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontWeight: '600',
  },
  signOutButton: {
    backgroundColor: '#FEE2E2',
    height: 48,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  signOutButtonPressed: {
    backgroundColor: '#FECACA',
  },
  signOutButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#DC2626',
  },
});
