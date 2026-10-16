import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function SettingsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.meta}>Business, Branch, and Notification Preferences</Text>
      <View style={styles.card}>
        <Text style={styles.itemTitle}>Active Business</Text>
        <Text style={styles.itemSubtitle}>Switching business context cleanly resets navigation history.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginTop: 16,
    marginBottom: 4,
  },
  meta: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 20,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#F1F5F9',
    marginBottom: 4,
  },
  itemSubtitle: {
    fontSize: 13,
    color: '#94A3B8',
  },
});
