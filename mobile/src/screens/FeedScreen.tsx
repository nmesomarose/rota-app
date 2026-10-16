import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export function FeedScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Activity Feed</Text>
      <Text style={styles.meta}>Role-scoped events and notifications</Text>
      <View style={styles.card}>
        <Text style={styles.placeholder}>No activity recorded yet.</Text>
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
  placeholder: {
    fontSize: 16,
    color: '#CBD5E1',
  },
});
