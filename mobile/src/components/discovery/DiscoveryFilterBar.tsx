import React from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import type { ProviderGender, BadgeType } from '../../types/discovery';

export interface DiscoveryFilterBarProps {
  activeFilterCount: number;
  onPressFilters: () => void;
  onClearFilters: () => void;
  gender?: ProviderGender;
  minExperience?: number;
  requiredBadges?: BadgeType[];
}

export function DiscoveryFilterBar({
  activeFilterCount,
  onPressFilters,
  onClearFilters,
  gender,
  minExperience,
  requiredBadges,
}: DiscoveryFilterBarProps) {
  return (
    <View style={styles.container} testID="discovery-filter-bar">
      <View style={styles.controlsRow}>
        <Pressable
          style={[styles.filterButton, activeFilterCount > 0 && styles.filterButtonActive]}
          onPress={onPressFilters}
          accessibilityRole="button"
          accessibilityLabel={`Filter providers, ${activeFilterCount} active filters`}
          testID="discovery-filter-button"
        >
          <Text style={styles.filterIcon}>⚙️</Text>
          <Text
            style={[
              styles.filterButtonText,
              activeFilterCount > 0 && styles.filterButtonTextActive,
            ]}
          >
            Filters
          </Text>
          {activeFilterCount > 0 && (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText} testID="filter-count-badge">
                {activeFilterCount}
              </Text>
            </View>
          )}
        </Pressable>

        {activeFilterCount > 0 && (
          <Pressable
            style={styles.clearButton}
            onPress={onClearFilters}
            accessibilityRole="button"
            accessibilityLabel="Clear optional filters"
            testID="quick-clear-filters-button"
          >
            <Text style={styles.clearButtonText}>Clear</Text>
          </Pressable>
        )}
      </View>

      {/* Active Filter Summary Chips */}
      {activeFilterCount > 0 && (
        <View style={styles.chipsContainer} testID="active-filter-chips">
          {gender && (
            <View style={styles.chip} testID="active-chip-gender">
              <Text style={styles.chipText}>Gender: {gender === 'male' ? 'Male' : 'Female'}</Text>
            </View>
          )}
          {typeof minExperience === 'number' && minExperience > 0 && (
            <View style={styles.chip} testID="active-chip-exp">
              <Text style={styles.chipText}>Exp: {minExperience}+ yrs</Text>
            </View>
          )}
          {requiredBadges &&
            requiredBadges.map((b) => (
              <View key={b} style={styles.chip} testID={`active-chip-badge-${b}`}>
                <Text style={styles.chipText}>
                  {b
                    .split('_')
                    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                    .join(' ')}
                </Text>
              </View>
            ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterButtonActive: {
    borderColor: '#2563EB',
    backgroundColor: '#EFF6FF',
  },
  filterIcon: {
    fontSize: 14,
    marginRight: 6,
  },
  filterButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  filterButtonTextActive: {
    color: '#1D4ED8',
  },
  countBadge: {
    backgroundColor: '#2563EB',
    borderRadius: 10,
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 6,
  },
  countBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  clearButtonText: {
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '500',
  },
  chipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  chip: {
    backgroundColor: '#F3F4F6',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  chipText: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '500',
  },
});
