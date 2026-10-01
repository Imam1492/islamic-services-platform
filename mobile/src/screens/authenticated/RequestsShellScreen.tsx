import React, { useState } from 'react';
import { StyleSheet, View, Text, Pressable, ScrollView } from 'react-native';

export type RequestFilter = 'active' | 'past';

export function RequestsShellScreen() {
  const [activeFilter, setActiveFilter] = useState<RequestFilter>('active');

  return (
    <View style={styles.container} testID="requests-shell-screen">
      <ScrollView contentContainerStyle={styles.contentContainer}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.screenTitle} testID="requests-screen-title">
            Requests
          </Text>
          <Text style={styles.screenSubtitle}>
            Track your service requests and updates
          </Text>
        </View>

        {/* Visual Filter Shell */}
        <View style={styles.filterContainer} testID="requests-filter-container">
          <Pressable
            style={[styles.filterButton, activeFilter === 'active' ? styles.filterButtonActive : null]}
            onPress={() => setActiveFilter('active')}
            accessibilityRole="button"
            accessibilityLabel="Show active requests"
            accessibilityState={{ selected: activeFilter === 'active' }}
            testID="requests-filter-active"
          >
            <Text
              style={[
                styles.filterButtonText,
                activeFilter === 'active' ? styles.filterButtonTextActive : null,
              ]}
            >
              Active
            </Text>
          </Pressable>

          <Pressable
            style={[styles.filterButton, activeFilter === 'past' ? styles.filterButtonActive : null]}
            onPress={() => setActiveFilter('past')}
            accessibilityRole="button"
            accessibilityLabel="Show past requests"
            accessibilityState={{ selected: activeFilter === 'past' }}
            testID="requests-filter-past"
          >
            <Text
              style={[
                styles.filterButtonText,
                activeFilter === 'past' ? styles.filterButtonTextActive : null,
              ]}
            >
              Past
            </Text>
          </Pressable>
        </View>

        {/* Empty State */}
        <View style={styles.emptyCard} testID="requests-empty-state">
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTitle}>No service requests yet</Text>
          <Text style={styles.emptyDescription}>
            When you request a service, status updates and details will appear here.
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
  filterContainer: {
    flexDirection: 'row',
    backgroundColor: '#E5E7EB',
    borderRadius: 10,
    padding: 3,
    marginBottom: 24,
  },
  filterButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  filterButtonActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  filterButtonTextActive: {
    color: '#111827',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 32,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginTop: 12,
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 12,
    opacity: 0.7,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyDescription: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
});
