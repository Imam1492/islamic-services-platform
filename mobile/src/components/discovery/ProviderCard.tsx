import React from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import type { DiscoveryItem, BadgeType } from '../../types/discovery';

export interface ProviderCardProps {
  provider: DiscoveryItem;
  onPress: (providerId: string) => void;
}

export const BADGE_CONFIG: Record<
  BadgeType,
  { label: string; bg: string; color: string; border: string }
> = {
  identity_verified: {
    label: 'Identity verified',
    bg: '#EFF6FF',
    color: '#1D4ED8',
    border: '#BFDBFE',
  },
  skill_verified: {
    label: 'Skill verified',
    bg: '#EEF2FF',
    color: '#4338CA',
    border: '#C7D2FE',
  },
  community_vouched: {
    label: 'Community vouched',
    bg: '#ECFDF5',
    color: '#047857',
    border: '#A7F3D0',
  },
  background_checked: {
    label: 'Background checked',
    bg: '#FFFBEB',
    color: '#B45309',
    border: '#FDE68A',
  },
};

export const ProviderCard = React.memo(function ProviderCard({
  provider,
  onPress,
}: ProviderCardProps) {
  const genderLabel = provider.gender === 'female' ? 'Female' : 'Male';
  const experienceLabel = `${provider.years_experience} years of experience`;
  const badgesAnnouncement =
    provider.badges.length > 0
      ? `, Badges: ${provider.badges.map((b) => BADGE_CONFIG[b]?.label || b).join(', ')}`
      : '';

  return (
    <Pressable
      style={styles.card}
      onPress={() => onPress(provider.provider_id)}
      accessibilityRole="button"
      accessibilityLabel={`${provider.display_name}, ${genderLabel}, ${experienceLabel}${badgesAnnouncement}`}
      testID={`provider-card-${provider.provider_id}`}
    >
      {/* Header: Name & Gender Badge */}
      <View style={styles.headerRow}>
        <View style={styles.nameContainer}>
          <Text
            style={styles.displayName}
            numberOfLines={1}
            testID={`provider-name-${provider.provider_id}`}
          >
            {provider.display_name}
          </Text>
          <Text
            style={styles.experienceText}
            testID={`provider-exp-${provider.provider_id}`}
          >
            {experienceLabel}
          </Text>
        </View>

        <View
          style={styles.genderBadge}
          testID={`provider-gender-${provider.provider_id}`}
        >
          <Text style={styles.genderText}>{genderLabel}</Text>
        </View>
      </View>

      {/* Bio Excerpt (strictly two lines max) */}
      {provider.bio ? (
        <Text
          style={styles.bioText}
          numberOfLines={2}
          testID={`provider-bio-${provider.provider_id}`}
        >
          {provider.bio}
        </Text>
      ) : null}

      {/* Verification Badges */}
      {provider.badges.length > 0 && (
        <View
          style={styles.badgesContainer}
          testID={`provider-badges-${provider.provider_id}`}
        >
          {provider.badges.map((badge) => {
            const config = BADGE_CONFIG[badge];
            if (!config) return null;
            return (
              <View
                key={badge}
                style={[
                  styles.badgeChip,
                  { backgroundColor: config.bg, borderColor: config.border },
                ]}
                testID={`badge-${badge}-${provider.provider_id}`}
              >
                <Text style={[styles.badgeText, { color: config.color }]}>
                  {config.label}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  nameContainer: {
    flex: 1,
    marginRight: 10,
  },
  displayName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 2,
  },
  experienceText: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '500',
  },
  genderBadge: {
    backgroundColor: '#F3F4F6',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  genderText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4B5563',
  },
  bioText: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
    marginBottom: 10,
  },
  badgesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  badgeChip: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
