import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
} from 'react-native';
import type { ProviderGender, BadgeType } from '../../types/discovery';

export interface DiscoveryFilterModalProps {
  visible: boolean;
  onClose: () => void;
  initialGender?: ProviderGender;
  initialMinExperience?: number;
  initialRequiredBadges?: BadgeType[];
  onApply: (filters: {
    gender?: ProviderGender;
    minExperience?: number;
    requiredBadges?: BadgeType[];
  }) => void;
  onClear: () => void;
}

const AVAILABLE_BADGES: { type: BadgeType; label: string }[] = [
  { type: 'identity_verified', label: 'Identity verified' },
  { type: 'skill_verified', label: 'Skill verified' },
  { type: 'community_vouched', label: 'Community vouched' },
  { type: 'background_checked', label: 'Background checked' },
];

export function DiscoveryFilterModal({
  visible,
  onClose,
  initialGender,
  initialMinExperience,
  initialRequiredBadges = [],
  onApply,
  onClear,
}: DiscoveryFilterModalProps) {
  const [tempGender, setTempGender] = useState<ProviderGender | undefined>(initialGender);
  const [tempMinExperience, setTempMinExperience] = useState<number | undefined>(
    initialMinExperience
  );
  const [tempBadges, setTempBadges] = useState<BadgeType[]>(initialRequiredBadges);

  const toggleBadge = (badge: BadgeType) => {
    setTempBadges((prev) =>
      prev.includes(badge) ? prev.filter((b) => b !== badge) : [...prev, badge]
    );
  };

  const handleClear = () => {
    setTempGender(undefined);
    setTempMinExperience(undefined);
    setTempBadges([]);
    onClear();
  };

  const handleApply = () => {
    onApply({
      gender: tempGender,
      minExperience: tempMinExperience,
      requiredBadges: tempBadges.length > 0 ? tempBadges : undefined,
    });
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
      testID="discovery-filter-modal"
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Filter Providers</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close filters"
            style={styles.closeButton}
            testID="close-filter-modal"
          >
            <Text style={styles.closeButtonText}>✕</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {/* Section: Gender */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Gender</Text>
            <View style={styles.optionsRow}>
              <Pressable
                style={[
                  styles.optionButton,
                  tempGender === undefined && styles.optionButtonActive,
                ]}
                onPress={() => setTempGender(undefined)}
                accessibilityRole="button"
                accessibilityLabel="All genders"
                accessibilityState={{ selected: tempGender === undefined }}
                testID="filter-gender-all"
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    tempGender === undefined && styles.optionButtonTextActive,
                  ]}
                >
                  All
                </Text>
              </Pressable>

              <Pressable
                style={[
                  styles.optionButton,
                  tempGender === 'male' && styles.optionButtonActive,
                ]}
                onPress={() => setTempGender('male')}
                accessibilityRole="button"
                accessibilityLabel="Male"
                accessibilityState={{ selected: tempGender === 'male' }}
                testID="filter-gender-male"
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    tempGender === 'male' && styles.optionButtonTextActive,
                  ]}
                >
                  Male
                </Text>
              </Pressable>

              <Pressable
                style={[
                  styles.optionButton,
                  tempGender === 'female' && styles.optionButtonActive,
                ]}
                onPress={() => setTempGender('female')}
                accessibilityRole="button"
                accessibilityLabel="Female"
                accessibilityState={{ selected: tempGender === 'female' }}
                testID="filter-gender-female"
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    tempGender === 'female' && styles.optionButtonTextActive,
                  ]}
                >
                  Female
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Section: Minimum Experience */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Minimum Experience</Text>
            <View style={styles.optionsRow}>
              {[
                { value: undefined, label: '0+', testID: 'filter-exp-0' },
                { value: 2, label: '2+ yrs', testID: 'filter-exp-2' },
                { value: 5, label: '5+ yrs', testID: 'filter-exp-5' },
                { value: 10, label: '10+ yrs', testID: 'filter-exp-10' },
              ].map((exp) => {
                const isSelected =
                  exp.value === undefined
                    ? tempMinExperience === undefined || tempMinExperience === 0
                    : tempMinExperience === exp.value;
                return (
                  <Pressable
                    key={exp.label}
                    style={[styles.optionButton, isSelected && styles.optionButtonActive]}
                    onPress={() => setTempMinExperience(exp.value)}
                    accessibilityRole="button"
                    accessibilityLabel={exp.label}
                    accessibilityState={{ selected: isSelected }}
                    testID={exp.testID}
                  >
                    <Text
                      style={[
                        styles.optionButtonText,
                        isSelected && styles.optionButtonTextActive,
                      ]}
                    >
                      {exp.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Section: Verification Badges */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Required Badges</Text>
            <Text style={styles.sectionSubtitle}>
              Only show providers with all selected verifications
            </Text>
            <View style={styles.badgeList}>
              {AVAILABLE_BADGES.map((b) => {
                const isChecked = tempBadges.includes(b.type);
                return (
                  <Pressable
                    key={b.type}
                    style={[styles.badgeOption, isChecked && styles.badgeOptionActive]}
                    onPress={() => toggleBadge(b.type)}
                    accessibilityRole="checkbox"
                    accessibilityLabel={b.label}
                    accessibilityState={{ checked: isChecked }}
                    testID={`filter-badge-${b.type}`}
                  >
                    <View
                      style={[styles.checkbox, isChecked && styles.checkboxChecked]}
                    >
                      {isChecked && <Text style={styles.checkboxCheckmark}>✓</Text>}
                    </View>
                    <Text
                      style={[
                        styles.badgeOptionText,
                        isChecked && styles.badgeOptionTextActive,
                      ]}
                    >
                      {b.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ScrollView>

        {/* Footer Actions */}
        <View style={styles.footer}>
          <Pressable
            style={styles.clearButton}
            onPress={handleClear}
            accessibilityRole="button"
            accessibilityLabel="Clear optional filters"
            testID="clear-filters-button"
          >
            <Text style={styles.clearButtonText}>Clear filters</Text>
          </Pressable>

          <Pressable
            style={styles.applyButton}
            onPress={handleApply}
            accessibilityRole="button"
            accessibilityLabel="Apply filters"
            testID="apply-filters-button"
          >
            <Text style={styles.applyButtonText}>Apply Filters</Text>
          </Pressable>
        </View>
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
    padding: 20,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 12,
  },
  optionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  optionButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  optionButtonActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#2563EB',
  },
  optionButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#4B5563',
  },
  optionButtonTextActive: {
    color: '#1D4ED8',
    fontWeight: '700',
  },
  badgeList: {
    gap: 10,
  },
  badgeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  badgeOptionActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#93C5FD',
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#9CA3AF',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  checkboxChecked: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  checkboxCheckmark: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  badgeOptionText: {
    fontSize: 14,
    color: '#374151',
    fontWeight: '500',
  },
  badgeOptionTextActive: {
    color: '#1E40AF',
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 12,
  },
  clearButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  clearButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#4B5563',
  },
  applyButton: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
