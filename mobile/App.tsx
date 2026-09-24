import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { AuthProvider } from './src/context/AuthContext';
import { AuthFlowNavigator } from './src/navigation/AuthFlowNavigator';

export default function App() {
  return (
    <AuthProvider>
      <View style={styles.container}>
        <StatusBar style="dark" />
        <AuthFlowNavigator />
      </View>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
});
