import React from 'react';
import { StyleSheet, View, Text, ScrollView } from 'react-native';

export function DiscoverShellScreen() {
  return (
    <View style={styles.container} testID="discover-shell-screen">
      <ScrollView contentContainerStyle={styles.contentContainer}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.screenTitle} testID="discover-screen-title">
            Discover
          </Text>
          <Text style={styles.screenSubtitle}>
            Find local services and trusted community providers
          </Text>
        </View>

        {/* Neutral Area-Selection Placeholder (Correction 3) */}
        <View style={styles.locationSelectorCard} testID="discover-location-placeholder">
          <View style={styles.locationIconWrapper}>
            <Text style={styles.locationIcon}>📍</Text>
          </View>
          <View style={styles.locationTextContainer}>
            <Text style={styles.locationLabel}>Location</Text>
            <Text style={styles.locationPlaceholderText} testID="discover-location-text">
              Select an area
            </Text>
            <Text style={styles.locationSubtext}>
              Choose your area when discovery is available.
            </Text>
          </View>
        </View>

        {/* Search Input Placeholder */}
        <View style={styles.searchBarPlaceholder} testID="discover-search-placeholder">
          <Text style={styles.searchIcon}>🔍</Text>
          <Text style={styles.searchPlaceholderText}>Search services or providers...</Text>
        </View>

        {/* Discovery Module Placeholder */}
        <View style={styles.placeholderCard} testID="discover-module-placeholder">
          <Text style={styles.placeholderBadge}>Phase 3.4 Roadmap</Text>
          <Text style={styles.placeholderTitle}>Service Catalog Coming Soon</Text>
          <Text style={styles.placeholderBody}>
            Catalog discovery, verified local service categories, and provider listings will become
            available in the upcoming Discovery release.
          </Text>
        </View>
      </ScrollView>
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
  locationSelectorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 16,
  },
  locationIconWrapper: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  locationIcon: {
    fontSize: 18,
  },
  locationTextContainer: {
    flex: 1,
  },
  locationLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  locationPlaceholderText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
    marginTop: 1,
  },
  locationSubtext: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  searchBarPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginBottom: 20,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 10,
    opacity: 0.5,
  },
  searchPlaceholderText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
  placeholderCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'flex-start',
  },
  placeholderBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 12,
    overflow: 'hidden',
  },
  placeholderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  placeholderBody: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 22,
  },
});
