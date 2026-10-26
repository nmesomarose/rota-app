import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Modal,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError } from '../services/api.ts';
import {
  setAccessToken,
  setActiveBusiness,
  clearSession,
} from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';
import { clearAllTenantQueries } from '../services/query-client.ts';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';

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
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const [memberships, setMemberships] = useState<MembershipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Business onboarding creation state
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

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
      // 1. Clear previous tenant offline cache & TanStack Query cache on business switch (FR-OFF-004, AC-OFF-01)
      await clearAllOfflineCache();
      await clearAllTenantQueries();

      // 2. Request new tenant-scoped access token
      const data = await api.organizations.switchBusiness(item.businessId);

      // 3. Store new token and active business context in SecureStore
      await setAccessToken(data.tokens.accessToken);
      await setActiveBusiness({
        id: item.businessId,
        name: item.businessName,
        role: data.role,
        branchId: item.branchId,
        departmentId: item.departmentId,
      });

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

  const handleCreateBusiness = async () => {
    const trimmed = newOrgName.trim();
    if (trimmed.length < 2) {
      setErrorMessage('Business name must be at least 2 characters.');
      return;
    }

    setCreating(true);
    setErrorMessage(null);
    try {
      await clearAllOfflineCache();
      await clearAllTenantQueries();
      const res = await api.organizations.create({ name: trimmed });

      // Save scoped token and active business context
      await setAccessToken(res.tokens.accessToken);
      await setActiveBusiness({
        id: res.business.id,
        name: res.business.name,
        role: res.membership.role,
        branchId: res.branch.id,
      });

      setShowCreateModal(false);
      navigation.replace('Main', { screen: 'Schedule' });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create organization. Please verify your connection.');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await clearSession();
    await clearAllOfflineCache();
    navigation.replace('Auth');
  };

  return (
    <KeyboardAvoidingView
      style={styles.keyboardContainer}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <View
        style={[
          styles.container,
          {
            paddingTop: Math.max(insets.top + 16, 40),
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Your Organizations</Text>
          <Text style={styles.subtitle}>
            Select a workspace to manage schedules or create a new organization.
          </Text>
        </View>

        {errorMessage && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={colors.primaryTeal} />
            <Text style={styles.loadingText}>Loading organizations...</Text>
          </View>
        ) : memberships.length === 0 ? (
          /* Empty State: First-time Onboarding */
          <ScrollView
            contentContainerStyle={styles.onboardScroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.onboardCard}>
              <View style={styles.iconCircle}>
                <Text style={styles.iconText}>🏢</Text>
              </View>
              <Text style={styles.onboardTitle}>Create Your Business</Text>
              <Text style={styles.onboardSubtitle}>
                You don't have any active organizations yet. Set up your business now to start scheduling shifts as the Owner.
              </Text>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Business or Organization Name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Apex Health, Downtown Cafe"
                  placeholderTextColor={colors.textMuted}
                  value={newOrgName}
                  onChangeText={setNewOrgName}
                  autoCapitalize="words"
                  autoCorrect={false}
                  editable={!creating}
                  returnKeyType="done"
                  onSubmitEditing={handleCreateBusiness}
                  accessibilityLabel="Business name input"
                />
              </View>

              <TouchableOpacity
                style={[styles.createButton, creating && styles.buttonDisabled]}
                onPress={handleCreateBusiness}
                disabled={creating}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Create Business & Continue"
              >
                {creating ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.createButtonText}>Create Business & Continue</Text>
                )}
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
              <Text style={styles.logoutButtonText}>Sign out to use a different account</Text>
            </TouchableOpacity>
          </ScrollView>
        ) : (
          /* Existing Memberships List */
          <View style={styles.listWrapper}>
            <FlatList
              data={memberships}
              keyExtractor={(item) => item.businessId}
              contentContainerStyle={styles.listContainer}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                const isSwitching = switchingId === item.businessId;
                return (
                  <TouchableOpacity
                    style={[styles.businessCard, isSwitching && styles.cardActive]}
                    onPress={() => handleSelectBusiness(item)}
                    disabled={switchingId !== null}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Switch to ${item.businessName}`}
                  >
                    <View style={styles.cardHeader}>
                      <Text style={styles.businessName} numberOfLines={2}>
                        {item.businessName}
                      </Text>
                      <View style={styles.roleBadge}>
                        <Text style={styles.roleText}>{item.role.toUpperCase()}</Text>
                      </View>
                    </View>
                    <Text style={styles.statusText}>Status: {item.status}</Text>
                    {isSwitching && (
                      <View style={styles.switchingRow}>
                        <ActivityIndicator size="small" color={colors.primaryTeal} />
                        <Text style={styles.switchingText}>Switching context...</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              }}
              ListFooterComponent={
                <View style={styles.listFooter}>
                  <TouchableOpacity
                    style={styles.addBizButton}
                    onPress={() => {
                      setNewOrgName('');
                      setShowCreateModal(true);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.addBizButtonText}>+ Add Another Organization</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.secondaryLogout} onPress={handleLogout}>
                    <Text style={styles.secondaryLogoutText}>Sign out</Text>
                  </TouchableOpacity>
                </View>
              }
            />
          </View>
        )}
      </View>

      {/* Modal for Creating Additional Organizations */}
      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCreateModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Organization</Text>
              <TouchableOpacity
                onPress={() => setShowCreateModal(false)}
                style={styles.modalCloseButton}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              You will be assigned the Owner role for this new organization.
            </Text>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Organization Name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Westside Branch"
                placeholderTextColor={colors.textMuted}
                value={newOrgName}
                onChangeText={setNewOrgName}
                autoCapitalize="words"
                autoCorrect={false}
                editable={!creating}
              />
            </View>

            <TouchableOpacity
              style={[styles.createButton, creating && styles.buttonDisabled]}
              onPress={handleCreateBusiness}
              disabled={creating}
            >
              {creating ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.createButtonText}>Create & Enter</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ColorTokens, isDark: boolean) {
  return StyleSheet.create({
  keyboardContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 60,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 6,
    lineHeight: 20,
  },
  errorBanner: {
    backgroundColor: colors.errorLight,
    borderColor: colors.errorBorder,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: colors.errorText,
    fontSize: 13,
    fontWeight: '500',
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: colors.textSecondary,
    marginTop: 12,
    fontSize: 14,
  },
  onboardScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingBottom: 40,
  },
  onboardCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: isDark ? 0.3 : 0.06,
    shadowRadius: 16,
    elevation: 3,
    alignItems: 'center',
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  iconText: {
    fontSize: 30,
  },
  onboardTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
  },
  onboardSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  inputGroup: {
    width: '100%',
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.surfaceSubtle,
    borderColor: colors.border,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.textPrimary,
    fontSize: 15,
  },
  createButton: {
    width: '100%',
    backgroundColor: colors.primaryTeal,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    shadowColor: colors.primaryTeal,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  createButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  logoutButton: {
    marginTop: 20,
    alignItems: 'center',
    paddingVertical: 10,
  },
  logoutButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  listWrapper: {
    flex: 1,
  },
  listContainer: {
    paddingBottom: 24,
  },
  businessCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.25 : 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  cardActive: {
    borderColor: colors.primaryTeal,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  businessName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
    marginRight: 8,
  },
  roleBadge: {
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    borderColor: isDark ? '#0F766E' : '#99F6E4',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    flexShrink: 0,
  },
  roleText: {
    color: isDark ? '#2DD4BF' : colors.tealDark,
    fontSize: 11,
    fontWeight: '700',
  },
  statusText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  switchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 8,
  },
  switchingText: {
    fontSize: 13,
    color: colors.primaryTeal,
    fontWeight: '500',
  },
  listFooter: {
    marginTop: 12,
    alignItems: 'center',
  },
  addBizButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    backgroundColor: colors.surface,
    marginBottom: 16,
  },
  addBizButtonText: {
    color: colors.primaryTeal,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryLogout: {
    paddingVertical: 10,
  },
  secondaryLogoutText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0, 0, 0, 0.75)' : 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.4 : 0.15,
    shadowRadius: 24,
    elevation: 6,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalCloseButton: {
    padding: 4,
  },
  modalCloseText: {
    fontSize: 16,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  modalSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 18,
    lineHeight: 18,
  },
  });
}
