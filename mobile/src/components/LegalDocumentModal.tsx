import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  View,
  Pressable,
  ScrollView,
} from 'react-native';
import type { LegalDocument } from '../types/legal';

export interface LegalDocumentModalProps {
  visible: boolean;
  document: LegalDocument | null;
  onClose: () => void;
}

export function LegalDocumentModal({
  visible,
  document,
  onClose,
}: LegalDocumentModalProps) {
  if (!document) return null;

  const isPending = document.status === 'PENDING_REVIEW';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.safeArea}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title} testID="legal-modal-title">
              {document.title}
            </Text>
            <Text style={styles.versionText} testID="legal-modal-version">
              Version: {document.version}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.closeButton,
              pressed ? styles.closeButtonPressed : null,
            ]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close document"
            testID="legal-modal-close-button"
          >
            <Text style={styles.closeButtonText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.contentContainer} contentContainerStyle={styles.contentInner}>
          <View
            style={[
              styles.statusBadge,
              isPending ? styles.statusBadgePending : styles.statusBadgeApproved,
            ]}
          >
            <Text
              style={[
                styles.statusBadgeText,
                isPending ? styles.statusBadgeTextPending : styles.statusBadgeTextApproved,
              ]}
              testID="legal-modal-status-badge"
            >
              {isPending ? '⚠️ Pending Legal Review' : '✓ Approved'}
            </Text>
          </View>

          {isPending ? (
            <View style={styles.pendingNoticeCard} testID="legal-modal-pending-notice">
              <Text style={styles.pendingNoticeTitle}>Notice to Users</Text>
              <Text style={styles.pendingNoticeText}>
                {document.complianceNotice ||
                  'Approved legal text is currently undergoing compliance review. Onboarding acceptance is suspended until binding text is published.'}
              </Text>
            </View>
          ) : (
            <Text style={styles.documentBody} testID="legal-modal-body">
              {document.content}
            </Text>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  versionText: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  closeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  closeButtonPressed: {
    backgroundColor: '#E5E7EB',
  },
  closeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  contentContainer: {
    flex: 1,
  },
  contentInner: {
    padding: 20,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 16,
  },
  statusBadgePending: {
    backgroundColor: '#FEF3C7',
  },
  statusBadgeApproved: {
    backgroundColor: '#DCFCE7',
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusBadgeTextPending: {
    color: '#92400E',
  },
  statusBadgeTextApproved: {
    color: '#15803D',
  },
  pendingNoticeCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  pendingNoticeTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  pendingNoticeText: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
  },
  documentBody: {
    fontSize: 14,
    color: '#1F2937',
    lineHeight: 22,
  },
});
