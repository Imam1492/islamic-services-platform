import React from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';

export type AuthenticatedTab = 'discover' | 'requests' | 'messages' | 'account';

export interface TabItem {
  id: AuthenticatedTab;
  label: string;
  iconSymbol: string;
}

export const TABS: TabItem[] = [
  { id: 'discover', label: 'Discover', iconSymbol: '🔍' },
  { id: 'requests', label: 'Requests', iconSymbol: '📋' },
  { id: 'messages', label: 'Messages', iconSymbol: '💬' },
  { id: 'account', label: 'Account', iconSymbol: '👤' },
];

export interface BottomTabBarProps {
  activeTab: AuthenticatedTab;
  onTabPress: (tab: AuthenticatedTab) => void;
}

export function BottomTabBar({ activeTab, onTabPress }: BottomTabBarProps) {
  return (
    <View style={styles.container} testID="bottom-tab-bar" accessibilityRole="tablist">
      {TABS.map((tab) => {
        const isSelected = activeTab === tab.id;

        return (
          <Pressable
            key={tab.id}
            style={[styles.tabButton, isSelected ? styles.tabButtonActive : null]}
            onPress={() => onTabPress(tab.id)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: isSelected }}
            testID={`tab-button-${tab.id}`}
          >
            <Text style={[styles.tabIcon, isSelected ? styles.tabIconActive : null]}>
              {tab.iconSymbol}
            </Text>
            <Text
              style={[styles.tabLabel, isSelected ? styles.tabLabelActive : styles.tabLabelInactive]}
              testID={`tab-label-${tab.id}`}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    height: 64,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderRadius: 8,
  },
  tabButtonActive: {
    backgroundColor: '#EFF6FF',
  },
  tabIcon: {
    fontSize: 18,
    marginBottom: 2,
    opacity: 0.6,
  },
  tabIconActive: {
    opacity: 1,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: '#2563EB',
    fontWeight: '700',
  },
  tabLabelInactive: {
    color: '#6B7280',
  },
});
