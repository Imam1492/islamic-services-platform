import React from 'react';
import { StyleSheet, View, Text, ScrollView } from 'react-native';

export function MessagesShellScreen() {
  return (
    <View style={styles.container} testID="messages-shell-screen">
      <ScrollView contentContainerStyle={styles.contentContainer}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.screenTitle} testID="messages-screen-title">
            Messages
          </Text>
          <Text style={styles.screenSubtitle}>
            Direct communication with assigned providers
          </Text>
        </View>

        {/* Empty State */}
        <View style={styles.emptyCard} testID="messages-empty-state">
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyTitle}>No conversations yet</Text>
          <Text style={styles.emptyDescription}>
            Conversations become available after a service provider accepts your service request.
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
