import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useAuth } from '../context/AuthContext';
import { LegalDocumentService } from '../services/legalDocumentService';
import { LegalDocumentModal } from '../components/LegalDocumentModal';
import type { LegalDocument } from '../types/legal';

export interface GeneralUserOnboardingScreenProps {
  onSubmit: (fullName: string) => Promise<{ success: boolean; error: any }>;
  isSubmitting: boolean;
  externalError?: string | null;
}

export function GeneralUserOnboardingScreen({
  onSubmit,
  isSubmitting,
  externalError,
}: GeneralUserOnboardingScreenProps) {
  const { signOut } = useAuth();

  const [fullName, setFullName] = useState<string>('');
  const [adultAcknowledged, setAdultAcknowledged] = useState<boolean>(false);
  const [tosAccepted, setTosAccepted] = useState<boolean>(false);
  const [privacyAccepted, setPrivacyAccepted] = useState<boolean>(false);

  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);

  // Legal modal state
  const [activeModalDoc, setActiveModalDoc] = useState<LegalDocument | null>(null);

  const legalRegistry = LegalDocumentService.getDocuments();
  const { termsOfService, privacyPolicy, allApproved } = legalRegistry;

  const trimmedName = fullName.trim();
  const isNameValid = trimmedName.length >= 2 && trimmedName.length <= 100;

  // Submit button enables ONLY if:
  // 1. Name is valid (2..100 characters)
  // 2. Adult is affirmatively acknowledged
  // 3. Terms of Service is accepted AND approved
  // 4. Privacy Policy is accepted AND approved
  // 5. Not currently submitting
  const canSubmit =
    isNameValid &&
    adultAcknowledged &&
    tosAccepted &&
    privacyAccepted &&
    allApproved &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!isNameValid) {
      setValidationError('Full name must be between 2 and 100 characters.');
      return;
    }

    if (!adultAcknowledged) {
      setValidationError('You must confirm that you are at least 18 years of age.');
      return;
    }

    if (!allApproved) {
      setValidationError(
        'Onboarding cannot be completed because legal documents are pending compliance review.'
      );
      return;
    }

    if (!tosAccepted || !privacyAccepted) {
      setValidationError('You must review and accept the Terms of Service and Privacy Policy.');
      return;
    }

    setValidationError(null);
    await onSubmit(trimmedName);
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  const displayError = validationError || externalError;

  return (
    <View style={styles.safeArea}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Complete Your Profile</Text>
          <Text style={styles.subtitle}>
            Please provide your name and acknowledge our legal terms to complete account setup.
          </Text>
        </View>

        {/* Global Compliance Warning Banner when documents are in review */}
        {!allApproved ? (
          <View style={styles.complianceNoticeCard} testID="compliance-pending-banner">
            <Text style={styles.complianceNoticeTitle}>⚠️ Compliance Review in Progress</Text>
            <Text style={styles.complianceNoticeText}>
              Official Terms of Service and Privacy Policy documents are undergoing compliance review. Onboarding acceptance is suspended until approved prose is published.
            </Text>
          </View>
        ) : null}

        {/* Full Name Input */}
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>Full Name</Text>
          <TextInput
            style={[
              styles.textInput,
              displayError && !isNameValid && fullName.length > 0 ? styles.textInputError : null,
            ]}
            placeholder="Enter your full name"
            placeholderTextColor="#9CA3AF"
            value={fullName}
            onChangeText={(text) => {
              setFullName(text);
              if (validationError) setValidationError(null);
            }}
            editable={!isSubmitting}
            maxLength={100}
            autoCapitalize="words"
            autoCorrect={false}
            testID="onboarding-fullname-input"
          />
          <Text style={styles.inputHelpText}>2 to 100 characters</Text>
        </View>

        {/* Legal Agreements Section */}
        <View style={styles.agreementsContainer}>
          <Text style={styles.agreementsHeader}>Legal Consents & Confirmations</Text>

          {/* 1. Adult Acknowledgement Checkbox */}
          <Pressable
            style={styles.checkboxRow}
            onPress={() => {
              if (isSubmitting) return;
              setAdultAcknowledged(!adultAcknowledged);
              if (validationError) setValidationError(null);
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: adultAcknowledged }}
            testID="checkbox-adult-ack"
          >
            <View
              style={[
                styles.checkbox,
                adultAcknowledged ? styles.checkboxChecked : styles.checkboxUnchecked,
              ]}
            >
              {adultAcknowledged ? <Text style={styles.checkboxTick}>✓</Text> : null}
            </View>
            <Text style={styles.checkboxLabel}>
              I confirm that I am at least 18 years of age.
            </Text>
          </Pressable>

          {/* 2. Terms of Service Checkbox / Review Row */}
          <View style={styles.agreementRow}>
            <Pressable
              style={styles.checkboxRow}
              onPress={() => {
                if (isSubmitting || termsOfService.status === 'PENDING_REVIEW') return;
                setTosAccepted(!tosAccepted);
                if (validationError) setValidationError(null);
              }}
              disabled={termsOfService.status === 'PENDING_REVIEW' || isSubmitting}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: tosAccepted }}
              testID="checkbox-tos"
            >
              <View
                style={[
                  styles.checkbox,
                  termsOfService.status === 'PENDING_REVIEW' ? styles.checkboxDisabled : null,
                  tosAccepted ? styles.checkboxChecked : styles.checkboxUnchecked,
                ]}
              >
                {tosAccepted ? <Text style={styles.checkboxTick}>✓</Text> : null}
              </View>
              <Text
                style={[
                  styles.checkboxLabel,
                  termsOfService.status === 'PENDING_REVIEW' ? styles.checkboxLabelDisabled : null,
                ]}
              >
                I agree to the Terms of Service
              </Text>
            </Pressable>

            <Pressable
              style={styles.viewDocLink}
              onPress={() => setActiveModalDoc(termsOfService)}
              testID="view-tos-button"
            >
              <Text style={styles.viewDocLinkText}>
                View ({termsOfService.version}
                {termsOfService.status === 'PENDING_REVIEW' ? ' • Pending Review' : ''})
              </Text>
            </Pressable>
          </View>

          {/* 3. Privacy Policy Checkbox / Review Row */}
          <View style={styles.agreementRow}>
            <Pressable
              style={styles.checkboxRow}
              onPress={() => {
                if (isSubmitting || privacyPolicy.status === 'PENDING_REVIEW') return;
                setPrivacyAccepted(!privacyAccepted);
                if (validationError) setValidationError(null);
              }}
              disabled={privacyPolicy.status === 'PENDING_REVIEW' || isSubmitting}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: privacyAccepted }}
              testID="checkbox-privacy"
            >
              <View
                style={[
                  styles.checkbox,
                  privacyPolicy.status === 'PENDING_REVIEW' ? styles.checkboxDisabled : null,
                  privacyAccepted ? styles.checkboxChecked : styles.checkboxUnchecked,
                ]}
              >
                {privacyAccepted ? <Text style={styles.checkboxTick}>✓</Text> : null}
              </View>
              <Text
                style={[
                  styles.checkboxLabel,
                  privacyPolicy.status === 'PENDING_REVIEW' ? styles.checkboxLabelDisabled : null,
                ]}
              >
                I agree to the Privacy Policy
              </Text>
            </Pressable>

            <Pressable
              style={styles.viewDocLink}
              onPress={() => setActiveModalDoc(privacyPolicy)}
              testID="view-privacy-button"
            >
              <Text style={styles.viewDocLinkText}>
                View ({privacyPolicy.version}
                {privacyPolicy.status === 'PENDING_REVIEW' ? ' • Pending Review' : ''})
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Error Message Display */}
        {displayError ? (
          <View style={styles.errorContainer} testID="onboarding-error-banner">
            <Text style={styles.errorText}>{displayError}</Text>
          </View>
        ) : null}

        {/* Submit Button */}
        <Pressable
          style={({ pressed }) => [
            styles.submitButton,
            !canSubmit ? styles.submitButtonDisabled : null,
            pressed && canSubmit ? styles.submitButtonPressed : null,
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Complete onboarding"
          testID="onboarding-submit-button"
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text
              style={[
                styles.submitButtonText,
                !canSubmit ? styles.submitButtonTextDisabled : null,
              ]}
            >
              Complete Onboarding
            </Text>
          )}
        </Pressable>

        {/* Sign Out Option */}
        <Pressable
          style={styles.signOutButton}
          onPress={handleSignOut}
          disabled={isSigningOut || isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          testID="onboarding-signout-button"
        >
          <Text style={styles.signOutButtonText}>Sign Out</Text>
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
  safeArea: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 24,
  },
  header: {
    marginBottom: 24,
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
    lineHeight: 20,
  },
  complianceNoticeCard: {
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#FCD34D',
    marginBottom: 20,
  },
  complianceNoticeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#92400E',
    marginBottom: 4,
  },
  complianceNoticeText: {
    fontSize: 13,
    color: '#78350F',
    lineHeight: 18,
  },
  inputGroup: {
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    height: 48,
    paddingHorizontal: 16,
    fontSize: 15,
    color: '#111827',
  },
  textInputError: {
    borderColor: '#EF4444',
  },
  inputHelpText: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 6,
  },
  agreementsContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 24,
  },
  agreementsHeader: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  agreementRow: {
    marginBottom: 16,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  checkboxUnchecked: {
    borderColor: '#9CA3AF',
    backgroundColor: '#FFFFFF',
  },
  checkboxChecked: {
    borderColor: '#2563EB',
    backgroundColor: '#2563EB',
  },
  checkboxDisabled: {
    borderColor: '#D1D5DB',
    backgroundColor: '#F3F4F6',
  },
  checkboxTick: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
    color: '#374151',
    lineHeight: 20,
  },
  checkboxLabelDisabled: {
    color: '#9CA3AF',
  },
  viewDocLink: {
    marginLeft: 34,
    paddingVertical: 2,
  },
  viewDocLinkText: {
    fontSize: 12,
    color: '#2563EB',
    fontWeight: '500',
  },
  errorContainer: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    marginBottom: 16,
  },
  errorText: {
    color: '#DC2626',
    fontSize: 13,
    lineHeight: 18,
  },
  submitButton: {
    backgroundColor: '#2563EB',
    height: 48,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  submitButtonDisabled: {
    backgroundColor: '#E5E7EB',
  },
  submitButtonPressed: {
    backgroundColor: '#1D4ED8',
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  submitButtonTextDisabled: {
    color: '#9CA3AF',
  },
  signOutButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  signOutButtonText: {
    color: '#6B7280',
    fontSize: 14,
    fontWeight: '500',
  },
});
