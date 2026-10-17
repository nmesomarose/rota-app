import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError } from '../services/api.ts';
import {
  setAccessToken,
  setActiveBusiness,
  getUserProfile,
  clearSession,
} from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';

type Props = NativeStackScreenProps<RootStackParamList, 'BusinessSelect'>;

interface MembershipItem {
  businessId: string;
  businessName: string;
  role: string;
  status: string;
  branchId?: string;
  departmentId?: string;
}

export function BusinessSelectScreen({ navigation }: Props) {
  const [memberships, setMemberships] = useState<MembershipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    loadMemberships();
  }, []);

  const loadMemberships = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await api.organizations.getMemberships();
      setMemberships(data.memberships);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load businesses. Check connection.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSelectBusiness = async (item: MembershipItem) => {
    setSwitchingId(item.businessId);
    setErrorMessage(null);

    try {
      // 1. Clear previous tenant offline cache on business switch (FR-OFF-004, AC-OFF-01)
      await clearAllOfflineCache();

      // 2. Request new tenant-scoped access token
      const data = await api.organizations.switchBusiness(item.businessId);

      // 3. Store new token and active business context in SecureStore
      await setAccessToken(data.accessToken);
      await setActiveBusiness(data.business);

      // 4. Navigate into main schedule with fresh tenant scope
      navigation.replace('Main', { screen: 'Schedule' });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to switch business. Please try again.');
      }
    } finally {
      setSwitchingId(null);
    }
  };

  const handleLogout = async () => {
    await clearSession();
    await clearAllOfflineCache();
    navigation.replace('Auth');
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select Organization</Text>
        <Text style={styles.subtitle}>
          Choose the business context you wish to manage or view
        </Text>
      </View>

      {errorMessage && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#38BDF8" />
          <Text style={styles.loadingText}>Loading organizations...</Text>
        </View>
      ) : memberships.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>No Organizations Found</Text>
          <Text style={styles.emptySubtitle}>
            You do not have any active memberships.
          </Text>
          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <Text style={styles.logoutButtonText}>Log Out</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={memberships}
          keyExtractor={(item) => item.businessId}
          contentContainerStyle={styles.listContainer}
          renderItem={({ item }) => {
            const isSwitching = switchingId === item.businessId;
            return (
              <TouchableOpacity
                style={[styles.businessCard, isSwitching && styles.cardActive]}
                onPress={() => handleSelectBusiness(item)}
                disabled={switchingId !== null}
                activeOpacity={0.7}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.businessName}>{item.businessName}</Text>
                  <View style={styles.roleBadge}>
                    <Text style={styles.roleText}>{item.role.toUpperCase()}</Text>
                  </View>
                </View>
                <Text style={styles.statusText}>Status: {item.status}</Text>
                {isSwitching && (
                  <View style={styles.switchingRow}>
                    <ActivityIndicator size="small" color="#38BDF8" />
                    <Text style={styles.switchingText}>Switching context...</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity style={styles.secondaryLogout} onPress={handleLogout}>
        <Text style={styles.secondaryLogoutText}>Sign out to switch account</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    padding: 20,
    paddingTop: 50,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  subtitle: {
    fontSize: 14,
    color: '#94A3B8',
    marginTop: 6,
  },
  errorBanner: {
    backgroundColor: '#451A1A',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 14,
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#94A3B8',
    marginTop: 12,
    fontSize: 15,
  },
  emptyBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#F1F5F9',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#94A3B8',
    marginTop: 8,
    textAlign: 'center',
  },
  listContainer: {
    paddingBottom: 24,
  },
  businessCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardActive: {
    borderColor: '#38BDF8',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  businessName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#F8FAFC',
    flex: 1,
  },
  roleBadge: {
    backgroundColor: '#0369A1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  roleText: {
    color: '#E0F2FE',
    fontSize: 11,
    fontWeight: '700',
  },
  statusText: {
    fontSize: 13,
    color: '#94A3B8',
  },
  switchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 8,
  },
  switchingText: {
    fontSize: 13,
    color: '#38BDF8',
  },
  logoutButton: {
    marginTop: 20,
    backgroundColor: '#DC2626',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  logoutButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  secondaryLogout: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  secondaryLogoutText: {
    color: '#64748B',
    fontSize: 14,
  },
});
