import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomTabBar, type AuthenticatedTab } from '../components/BottomTabBar';
import { DiscoverShellScreen } from '../screens/authenticated/DiscoverShellScreen';
import { RequestsShellScreen } from '../screens/authenticated/RequestsShellScreen';
import { MessagesShellScreen } from '../screens/authenticated/MessagesShellScreen';
import { AccountShellScreen } from '../screens/authenticated/AccountShellScreen';

export interface AuthenticatedTabNavigatorProps {
  onboardedAt?: string | null;
}

export function AuthenticatedTabNavigator({ onboardedAt }: AuthenticatedTabNavigatorProps) {
  const [activeTab, setActiveTab] = useState<AuthenticatedTab>('discover');

  return (
    <View style={styles.container} testID="authenticated-tab-navigator">
      <View style={styles.contentArea} testID="tab-content-area">
        {activeTab === 'discover' && <DiscoverShellScreen />}
        {activeTab === 'requests' && <RequestsShellScreen />}
        {activeTab === 'messages' && <MessagesShellScreen />}
        {activeTab === 'account' && <AccountShellScreen onboardedAt={onboardedAt} />}
      </View>
      <BottomTabBar activeTab={activeTab} onTabPress={setActiveTab} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  contentArea: {
    flex: 1,
  },
});
