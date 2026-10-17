import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api } from '../services/api.ts';
import {
  getActiveBusiness,
  getUserProfile,
  type StoredBusiness,
  type StoredUser,
  clearSession,
} from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';

export function SettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [business, setBusiness] = useState<StoredBusiness | null>(null);
  const [user, setUser] = useState<StoredUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    loadInfo();
  }, []);

  const loadInfo = async () => {
    const biz = await getActiveBusiness();
    const u = await getUserProfile();
    setBusiness(biz);
    setUser(u);
  };

  const handleSwitchOrganization = () => {
    navigation.navigate('BusinessSelect');
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.auth.logout();
    } catch {
      // Force local logout even if network request fails
      await clearSession();
      await clearAllOfflineCache();
    } finally {
      setLoggingOut(false);
      navigation.reset({
        index: 0,
        routes: [{ name: 'Auth' }],
      });
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.meta}>Business, Identity, and Account Management</Text>

      {/* Current User Card */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>User Account</Text>
        <Text style={styles.itemLabel}>Email Address</Text>
        <Text style={styles.itemValue}>{user?.email || 'Loading...'}</Text>
        {user?.name && (
          <>
            <Text style={styles.itemLabel}>Name</Text>
            <Text style={styles.itemValue}>{user.name}</Text>
          </>
        )}
      </View>

      {/* Active Organization Card */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>Active Organization</Text>
        <Text style={styles.itemLabel}>Organization Name</Text>
        <Text style={styles.itemValue}>{business?.name || 'None Selected'}</Text>

        <Text style={styles.itemLabel}>Assigned Role</Text>
        <Text style={styles.itemValue}>{business?.role?.toUpperCase() || 'N/A'}</Text>

        <TouchableOpacity
          style={styles.switchButton}
          onPress={handleSwitchOrganization}
          activeOpacity={0.8}
        >
          <Text style={styles.switchButtonText}>Switch Organization</Text>
        </TouchableOpacity>
      </View>

      {/* Subscription & Billing (Owner-Accessible) */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>Subscription & Entitlements</Text>
        <Text style={styles.itemLabel}>Billing & Plan Tier</Text>
        <Text style={styles.itemValue}>Manage subscription, proration quotes & ledger</Text>
        <TouchableOpacity
          style={styles.billingButton}
          onPress={() => navigation.navigate('Billing')}
          activeOpacity={0.8}
        >
          <Text style={styles.billingButtonText}>Manage Subscription</Text>
        </TouchableOpacity>
      </View>

      {/* Sign Out Action (AC-AUTH-02, AC-OFF-01) */}
      <TouchableOpacity
        style={[styles.logoutButton, loggingOut && styles.buttonDisabled]}
        onPress={handleLogout}
        disabled={loggingOut}
        activeOpacity={0.8}
      >
        {loggingOut ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.logoutButtonText}>Sign Out</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.footnote}>
        Signing out completely clears local session tokens and cached schedules (AC-OFF-01).
      </Text>
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
    fontSize: 26,
    fontWeight: '700',
    color: '#F8FAFC',
    marginTop: 8,
  },
  meta: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 20,
    marginTop: 2,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    fontSize: 16,
    fontWeight: '700',
    color: '#38BDF8',
    marginBottom: 12,
  },
  itemLabel: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 6,
  },
  itemValue: {
    fontSize: 15,
    color: '#F1F5F9',
    fontWeight: '500',
    marginBottom: 4,
  },
  switchButton: {
    marginTop: 14,
    backgroundColor: '#0369A1',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  switchButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  billingButton: {
    marginTop: 14,
    backgroundColor: '#0D9488',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  billingButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  logoutButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  logoutButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
  },
  footnote: {
    fontSize: 12,
    color: '#64748B',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },
});
