import React, { useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { usePublicProviderProfile } from '../../hooks/usePublicProviderProfile';
import { BADGE_CONFIG } from './ProviderCard';

export interface PublicProviderProfileModalProps {
  providerId: string | null;
  visible: boolean;
  onClose: () => void;
  isAuthenticated?: boolean;
}

export function PublicProviderProfileModal({
  providerId,
  visible,
  onClose,
  isAuthenticated = true,
}: PublicProviderProfileModalProps) {
  const { profile, isLoading, error, fetchProfile, reset } = usePublicProviderProfile(
    providerId || undefined,
    isAuthenticated
  );

  useEffect(() => {
    if (visible && providerId) {
      fetchProfile(providerId);
    } else if (!visible) {
      reset();
    }
  }, [visible, providerId, fetchProfile, reset]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
      testID="public-provider-profile-modal"
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Provider Details</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close provider details"
            style={styles.closeButton}
            testID="close-profile-modal"
          >
            <Text style={styles.closeButtonText}>✕</Text>
          </Pressable>
        </View>

        {isLoading ? (
          <View style={styles.stateContainer}>
            <ActivityIndicator
              size="large"
              color="#2563EB"
              testID="profile-loading-indicator"
            />
            <Text style={styles.loadingText}>Loading provider profile...</Text>
          </View>
        ) : error ? (
          <View style={styles.stateContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorText} testID="profile-error-message">
              {error.userMessage}
            </Text>
            <Pressable
              style={styles.retryButton}
              onPress={() => providerId && fetchProfile(providerId)}
              accessibilityRole="button"
              accessibilityLabel="Retry loading profile"
              testID="profile-retry-button"
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : profile ? (
          <ScrollView contentContainerStyle={styles.content}>
            {/* Identity Card */}
            <View style={styles.card}>
              <View style={styles.identityRow}>
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarInitial}>
                    {profile.display_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.identityTextContainer}>
                  <Text
                    style={styles.displayName}
                    testID="profile-display-name"
                  >
                    {profile.display_name}
                  </Text>
                  <Text style={styles.gender} testID="profile-gender">
                    {profile.gender === 'female' ? 'Female' : 'Male'}
                  </Text>
                </View>
              </View>

              <View style={styles.divider} />

              <View style={styles.experienceContainer}>
                <Text style={styles.experienceLabel}>Experience</Text>
                <Text
                  style={styles.experienceValue}
                  testID="profile-experience"
                >
                  {`${profile.years_experience} years of experience`}
                </Text>
              </View>

              {profile.bio ? (
                <View style={styles.bioContainer}>
                  <Text style={styles.bioLabel}>About</Text>
                  <Text style={styles.bioValue} testID="profile-bio">
                    {profile.bio}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Verification Badges Section */}
            {profile.badges && profile.badges.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Verification Badges</Text>
                <View
                  style={styles.badgesList}
                  testID="profile-badges-list"
                >
                  {profile.badges.map((badgeItem) => {
                    const config = BADGE_CONFIG[badgeItem.badge_type];
                    return (
                      <View
                        key={badgeItem.badge_type}
                        style={[
                          styles.badgeRow,
                          config && {
                            backgroundColor: config.bg,
                            borderColor: config.border,
                          },
                        ]}
                        testID={`profile-badge-${badgeItem.badge_type}`}
                      >
                        <Text style={styles.badgeCheck}>✓</Text>
                        <Text
                          style={[
                            styles.badgeLabel,
                            config && { color: config.color },
                          ]}
                        >
                          {config?.label || badgeItem.badge_type}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Services Offered Section */}
            {profile.services && profile.services.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Services Offered</Text>
                <View
                  style={styles.tagsContainer}
                  testID="profile-services-list"
                >
                  {profile.services.map((srv) => (
                    <View
                      key={srv.id}
                      style={styles.tag}
                      testID={`profile-service-${srv.id}`}
                    >
                      <Text style={styles.tagText}>{srv.name}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Service Areas Section */}
            {profile.areas && profile.areas.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Service Areas</Text>
                <View
                  style={styles.tagsContainer}
                  testID="profile-areas-list"
                >
                  {profile.areas.map((area) => (
                    <View
                      key={area.id}
                      style={[styles.tag, styles.areaTag]}
                      testID={`profile-area-${area.id}`}
                    >
                      <Text style={styles.tagText}>📍 {area.name}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        ) : (
          <View style={styles.stateContainer}>
            <Text style={styles.emptyText} testID="profile-not-found">
              Provider profile not available.
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    paddingTop: 50,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    color: '#4B5563',
    fontWeight: '600',
  },
  content: {
    padding: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 16,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  avatarInitial: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1D4ED8',
  },
  identityTextContainer: {
    flex: 1,
  },
  displayName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  gender: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 2,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 14,
  },
  experienceContainer: {
    marginBottom: 12,
  },
  experienceLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  experienceValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  bioContainer: {
    marginTop: 8,
  },
  bioLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  bioValue: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 22,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  badgesList: {
    gap: 8,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeCheck: {
    fontSize: 14,
    fontWeight: '700',
    color: '#059669',
    marginRight: 8,
  },
  badgeLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  areaTag: {
    backgroundColor: '#EFF6FF',
    borderColor: '#DBEAFE',
  },
  tagText: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '500',
  },
  stateContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#6B7280',
  },
  errorIcon: {
    fontSize: 36,
    marginBottom: 10,
  },
  errorText: {
    fontSize: 15,
    color: '#DC2626',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 22,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
  },
});
