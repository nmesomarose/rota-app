import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';

type Props = NativeStackScreenProps<RootStackParamList, 'Auth'>;

export function LoginScreen({ navigation }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rota</Text>
      <Text style={styles.subtitle}>Multi-Tenant Workforce Scheduling</Text>
      <View style={styles.card}>
        <Text style={styles.cardHeader}>Welcome Back</Text>
        <Text style={styles.infoText}>
          Authentication is verified strictly on the backend. This is a scaffold entry point.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => navigation.replace('Main', { screen: 'Schedule' })}
        >
          <Text style={styles.buttonText}>Enter App (Scaffold Demo)</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    padding: 24,
  },
  title: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#94A3B8',
    marginBottom: 32,
    textAlign: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 24,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    fontSize: 20,
    fontWeight: '600',
    color: '#F1F5F9',
    marginBottom: 12,
  },
  infoText: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 24,
    lineHeight: 20,
  },
  button: {
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
  },
});
