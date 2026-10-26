import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Modal,
  TextInput,
  Switch,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import {
  api,
  ApiError,
  type UserSettingsData,
  type NotificationCategoriesSettings,
} from '../services/api.ts';
import {
  getActiveBusiness,
  getUserProfile,
  type StoredBusiness,
  type StoredUser,
  clearSession,
} from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';
import { queryClient, queryKeys, clearAllTenantQueries } from '../services/query-client.ts';
import { colors, typography, spacing, radii, shadows, useTheme, type ColorTokens } from '../theme/index.ts';

export function SettingsScreen() {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [business, setBusiness] = useState<StoredBusiness | null>(null);
  const [user, setUser] = useState<StoredUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  // Account deletion modal state
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

  // Business deletion state
  const [deletingBusiness, setDeletingBusiness] = useState(false);

  // Settings Synchronization state (FR-SET-001..005)
  const [settings, setSettings] = useState<UserSettingsData>({
    timeZone: 'UTC',
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    language: 'en',
    theme: 'system',
    notificationCategories: {
      shifts: true,
      swaps: true,
      approvals: true,
      attendance: true,
      billing: true,
      security: true,
    },
  });
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSyncTime, setSettingsSyncTime] = useState<string | null>(null);

  useEffect(() => {
    loadInfo();

    // Refresh settings whenever the app transitions back to the foreground (active state)
    // without interfering with automatic device-controlled Light/Dark appearance (Phase 2 Requirement 7).
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        loadInfo();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const loadInfo = async () => {
    const biz = await getActiveBusiness();
    const u = await getUserProfile();
    setBusiness(biz);
    setUser(u);

    try {
      const sRes = await api.settings.getSettings();
      if (sRes?.data?.settings) {
        setSettings(sRes.data.settings);
        setSettingsSyncTime(sRes.data.updatedAt);
      }
    } catch (err) {
      console.warn('[SettingsScreen] Failed to load settings:', err);
    } finally {
      setLoadingSettings(false);
    }
  };

  const handleUpdateSetting = async <K extends keyof UserSettingsData>(
    field: K,
    val: UserSettingsData[K]
  ) => {
    const previous = { ...settings };
    setSettings((prev) => ({ ...prev, [field]: val }));
    setSavingSettings(true);

    const userKey = user?.id ? queryKeys.settings(user.id) : null;
    if (userKey) {
      queryClient.setQueryData(userKey, (old: any) => ({
        ...old,
        settings: {
          ...(old?.settings || previous),
          [field]: val,
        },
      }));
    }

    try {
      const nowIso = new Date().toISOString();
      const res = await api.settings.updateSettings({
        [field]: val,
        clientTimestamps: {
          [field]: nowIso,
        },
      });
      if (res?.data?.settings) {
        setSettings(res.data.settings);
        setSettingsSyncTime(res.data.updatedAt);
        if (userKey) {
          queryClient.setQueryData(userKey, res.data);
        }
      }
    } catch (err: unknown) {
      // Rollback to previous state on failure (FR-SET-004, AC-SET-02)
      setSettings(previous);
      if (userKey) {
        queryClient.setQueryData(userKey, (old: any) => ({
          ...old,
          settings: previous,
        }));
      }
      const msg = err instanceof ApiError ? err.message : 'Failed to save setting';
      Alert.alert('Settings Save Error', msg);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleToggleCategory = (categoryKey: keyof NotificationCategoriesSettings) => {
    const updated = {
      ...settings.notificationCategories,
      [categoryKey]: !settings.notificationCategories[categoryKey],
    };
    handleUpdateSetting('notificationCategories', updated);
  };

  const handleToggleQuietHours = () => {
    const updated = {
      ...settings.quietHours,
      enabled: !settings.quietHours.enabled,
    };
    handleUpdateSetting('quietHours', updated);
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
    } finally {
      await clearSession();
      await clearAllOfflineCache();
      await clearAllTenantQueries();
      setLoggingOut(false);
      navigation.reset({
        index: 0,
        routes: [{ name: 'Auth' }],
      });
    }
  };

  const handleLogoutAllPress = () => {
    Alert.alert(
      'Sign Out of All Devices',
      'Are you sure you want to sign out of all devices? This will close your active sessions across all devices and web browsers. You will need to log in again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out All Devices',
          style: 'destructive',
          onPress: performLogoutAll,
        },
      ]
    );
  };

  const performLogoutAll = async () => {
    setLoggingOutAll(true);
    try {
      await api.auth.logoutAll();
      await clearAllTenantQueries();
      setLoggingOutAll(false);
      navigation.reset({
        index: 0,
        routes: [{ name: 'Auth' }],
      });
    } catch (err: unknown) {
      setLoggingOutAll(false);
      if (err instanceof ApiError && (err.statusCode === 401 || err.code === 'SESSION_EXPIRED')) {
        await clearSession({ isExpired: true });
        await clearAllOfflineCache();
        await clearAllTenantQueries();
        navigation.reset({
          index: 0,
          routes: [{ name: 'Auth' }],
        });
        return;
      }

      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Unable to revoke sessions across all devices. Please verify your connection.';
      Alert.alert('Sign Out All Devices Failed', msg);
    }
  };

  const handleDeleteBusiness = () => {
    if (!business?.id) return;

    Alert.alert(
      'Delete Organization',
      `Are you sure you want to delete and deactivate "${business.name}"? This will cancel future shifts and deactivate memberships. Only an Owner can perform this action.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Organization',
          style: 'destructive',
          onPress: async () => {
            setDeletingBusiness(true);
            try {
              await api.organizations.deleteOrganization(business.id);
              await clearAllOfflineCache();
              Alert.alert('Organization Deleted', `"${business.name}" has been deleted.`);
              navigation.replace('BusinessSelect');
            } catch (err: unknown) {
              const msg = err instanceof ApiError ? err.message : 'Failed to delete organization';
              Alert.alert('Error', msg);
            } finally {
              setDeletingBusiness(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccountSubmit = async () => {
    if (!deletePassword) {
      setDeleteAccountError('Please enter your password to confirm deletion.');
      return;
    }

    setDeletingAccount(true);
    setDeleteAccountError(null);

    try {
      await api.auth.deleteAccount(deletePassword);
      await clearSession();
      await clearAllOfflineCache();
      setShowDeleteAccountModal(false);
      Alert.alert('Account Deleted', 'Your account has been deleted and all active sessions revoked.');
      navigation.reset({
        index: 0,
        routes: [{ name: 'Auth' }],
      });
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to delete account';
      setDeleteAccountError(msg);
    } finally {
      setDeletingAccount(false);
    }
  };

  const isOwner = business?.role?.toLowerCase() === 'owner';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Current User Card: Account & Security */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>Account & Security</Text>
        <Text style={styles.itemLabel}>Email Address</Text>
        <Text style={styles.itemValue}>{user?.email || 'Loading...'}</Text>
        {user?.name && (
          <>
            <Text style={styles.itemLabel}>Name</Text>
            <Text style={styles.itemValue}>{user.name}</Text>
          </>
        )}

        <View style={styles.separator} />
        {/* Session Security (AUTH-11, AUTH-12) */}
        <Text style={styles.sectionSubhead}>Active Sessions</Text>
        <Text style={styles.fieldNote}>
          Sign out everywhere if a device is lost, stolen, or no longer in use.
        </Text>

        <TouchableOpacity
          style={[styles.logoutAllButton, loggingOutAll && styles.buttonDisabled]}
          onPress={handleLogoutAllPress}
          disabled={loggingOutAll}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Sign Out of All Devices"
          accessibilityHint="Signs out of all active devices and web browsers"
        >
          {loggingOutAll ? (
            <ActivityIndicator size="small" color={colors.primaryTeal} />
          ) : (
            <>
              <Ionicons name="shield-outline" size={16} color={colors.primaryTeal} style={{ marginRight: 6 }} />
              <Text style={styles.logoutAllButtonText}>Sign Out of All Devices</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Active Organization Card */}
      <View style={styles.card}>
        <Text style={styles.cardHeader}>Active Organization</Text>
        <Text style={styles.itemLabel}>Organization Name</Text>
        <Text style={styles.itemValue}>{business?.name || 'None Selected'}</Text>

        <Text style={styles.itemLabel}>Assigned Role</Text>
        <View style={styles.roleBadgeContainer}>
          <Text style={styles.roleBadgeText}>{business?.role?.toUpperCase() || 'N/A'}</Text>
        </View>

        <TouchableOpacity
          style={styles.switchButton}
          onPress={handleSwitchOrganization}
          activeOpacity={0.8}
        >
          <Text style={styles.switchButtonText}>Switch Organization</Text>
        </TouchableOpacity>

        {isOwner && (
          <TouchableOpacity
            style={styles.deleteBusinessButton}
            onPress={handleDeleteBusiness}
            disabled={deletingBusiness}
            activeOpacity={0.8}
          >
            {deletingBusiness ? (
              <ActivityIndicator color="#DC2626" />
            ) : (
              <Text style={styles.deleteBusinessButtonText}>Delete Organization</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Preferences & Device Synchronization (PRD 6.10, FR-SET-001..005, AC-SET-01, AC-017) */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardHeader}>Preferences & Device Sync</Text>
          {savingSettings && <ActivityIndicator size="small" color={colors.primaryTeal} />}
        </View>
        <Text style={styles.itemDescription}>
          Preferences sync automatically across all your active devices.
        </Text>

        {loadingSettings ? (
          <ActivityIndicator color={colors.primaryTeal} style={{ marginVertical: 16 }} />
        ) : (
          <>
            {/* User Time Zone */}
            <Text style={styles.sectionSubhead}>Time Zone</Text>
            <Text style={styles.fieldNote}>Used for schedule notifications and quiet hours.</Text>
            <View style={styles.pillRow}>
              {['UTC', 'Africa/Lagos', 'Europe/London', 'America/New_York'].map((tz) => (
                <TouchableOpacity
                  key={tz}
                  style={[styles.pill, settings.timeZone === tz && styles.pillActive]}
                  onPress={() => handleUpdateSetting('timeZone', tz)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pillText, settings.timeZone === tz && styles.pillTextActive]}>
                    {tz}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Quiet Hours (FR-NOT-007) */}
            <View style={styles.separator} />
            <View style={styles.switchRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.rowTitle}>Quiet Hours</Text>
                <Text style={styles.fieldNote}>
                  Mutes routine notifications between {settings.quietHours.start} and {settings.quietHours.end} ({settings.timeZone}). Urgent shift changes still arrive.
                </Text>
              </View>
              <Switch
                value={settings.quietHours.enabled}
                onValueChange={handleToggleQuietHours}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.quietHours.enabled ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            {/* Language Selection */}
            <View style={styles.separator} />
            <Text style={styles.sectionSubhead}>Display Language</Text>
            <View style={styles.pillRow}>
              {[
                { code: 'en', label: 'English' },
                { code: 'fr', label: 'Français' },
                { code: 'es', label: 'Español' },
              ].map((lang) => (
                <TouchableOpacity
                  key={lang.code}
                  style={[styles.pill, settings.language === lang.code && styles.pillActive]}
                  onPress={() => handleUpdateSetting('language', lang.code)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pillText, settings.language === lang.code && styles.pillTextActive]}>
                    {lang.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Appearance (Follows System) */}
            <View style={styles.separator} />
            <Text style={styles.sectionSubhead}>Appearance</Text>
            <Text style={styles.fieldNote}>
              System default. Rota automatically matches your device light or dark appearance.
            </Text>

            {/* Notification Categories (FR-NOT-006) */}
            <View style={styles.separator} />
            <Text style={styles.sectionSubhead}>Notification Categories</Text>
            <Text style={styles.fieldNote}>Choose the notifications you want to receive on your devices.</Text>

            <View style={styles.categoryItem}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.categoryTitle}>Shift Changes & Rosters</Text>
                <Text style={styles.fieldNote}>New shifts, published schedules, and cancellations.</Text>
              </View>
              <Switch
                value={settings.notificationCategories.shifts}
                onValueChange={() => handleToggleCategory('shifts')}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.notificationCategories.shifts ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            <View style={styles.categoryItem}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.categoryTitle}>Shift Swaps</Text>
                <Text style={styles.fieldNote}>Swap requests, peer responses, and manager reviews.</Text>
              </View>
              <Switch
                value={settings.notificationCategories.swaps}
                onValueChange={() => handleToggleCategory('swaps')}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.notificationCategories.swaps ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            <View style={styles.categoryItem}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.categoryTitle}>Manager Approvals</Text>
                <Text style={styles.fieldNote}>Swap approvals, availability requests, and overrides.</Text>
              </View>
              <Switch
                value={settings.notificationCategories.approvals}
                onValueChange={() => handleToggleCategory('approvals')}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.notificationCategories.approvals ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            <View style={styles.categoryItem}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.categoryTitle}>Attendance & Absences</Text>
                <Text style={styles.fieldNote}>Clock-in confirmations and absence notices.</Text>
              </View>
              <Switch
                value={settings.notificationCategories.attendance}
                onValueChange={() => handleToggleCategory('attendance')}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.notificationCategories.attendance ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            <View style={styles.categoryItem}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  <Text style={styles.categoryTitle}>Subscription & Billing</Text>
                  <View style={styles.mandatoryBadge}>
                    <Text style={styles.mandatoryBadgeText}>Required</Text>
                  </View>
                </View>
                <Text style={styles.fieldNote}>Invoices, payment reminders, and renewal notices.</Text>
              </View>
              <Switch
                value={settings.notificationCategories.billing}
                onValueChange={() => handleToggleCategory('billing')}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.notificationCategories.billing ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            <View style={styles.categoryItem}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  <Text style={styles.categoryTitle}>Security & Account</Text>
                  <View style={styles.mandatoryBadge}>
                    <Text style={styles.mandatoryBadgeText}>Required</Text>
                  </View>
                </View>
                <Text style={styles.fieldNote}>New logins, security alerts, and role changes.</Text>
              </View>
              <Switch
                value={settings.notificationCategories.security}
                onValueChange={() => handleToggleCategory('security')}
                trackColor={{ false: '#CBD5E1', true: colors.lightTeal }}
                thumbColor={settings.notificationCategories.security ? colors.primaryTeal : '#94A3B8'}
              />
            </View>

            {savingSettings ? (
              <View style={styles.syncFooter}>
                <Ionicons name="sync-outline" size={14} color={colors.primaryTeal} style={{ marginRight: 5 }} />
                <Text style={styles.syncFooterText}>Syncing changes...</Text>
              </View>
            ) : settingsSyncTime ? (
              <View style={styles.syncFooter}>
                <Ionicons name="cloud-done-outline" size={14} color={colors.primaryTeal} style={{ marginRight: 5 }} />
                <Text style={styles.syncFooterText}>
                  Last synced {new Date(settingsSyncTime).toLocaleTimeString()}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </View>

      {/* Subscription & Billing (Owner-Gated per BR-006, PRD Section 4.5) */}
      {isOwner && (
        <View style={styles.card}>
          <Text style={styles.cardHeader}>Subscription & Plan</Text>
          <Text style={styles.itemLabel}>Plan Details</Text>
          <Text style={styles.itemValue}>View plan tier, payment history, and invoices</Text>
          <TouchableOpacity
            style={styles.billingButton}
            onPress={() => navigation.navigate('Billing')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Manage Subscription"
          >
            <Text style={styles.billingButtonText}>Manage Subscription</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Danger Zone: Personal Account Deletion */}
      <View style={styles.dangerCard}>
        <Text style={styles.dangerCardHeader}>Danger Zone</Text>
        <Text style={styles.dangerDescription}>
          Deleting your account closes all active sessions. Sole business owners must transfer ownership or delete the organization first.
        </Text>

        <TouchableOpacity
          style={styles.deleteAccountButton}
          onPress={() => {
            setDeletePassword('');
            setDeleteAccountError(null);
            setShowDeleteAccountModal(true);
          }}
          activeOpacity={0.8}
        >
          <Ionicons name="trash-outline" size={16} color="#DC2626" style={{ marginRight: 6 }} />
          <Text style={styles.deleteAccountButtonText}>Delete Personal Account</Text>
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
        Signing out clears your session and cached data on this device.
      </Text>

      {/* Delete Account Password Confirmation Modal */}
      <Modal visible={showDeleteAccountModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Confirm Account Deletion</Text>
              <TouchableOpacity onPress={() => setShowDeleteAccountModal(false)}>
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalWarningText}>
              This action cannot be undone. All active sessions will be closed immediately.
            </Text>

            {deleteAccountError && (
              <View style={styles.modalError}>
                <Text style={styles.modalErrorText}>{deleteAccountError}</Text>
              </View>
            )}

            <Text style={styles.inputLabel}>Enter your password to confirm:</Text>
            <TextInput
              style={styles.textInput}
              secureTextEntry
              placeholder="Your current password"
              value={deletePassword}
              onChangeText={setDeletePassword}
            />

            <View style={styles.modalActionRow}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setShowDeleteAccountModal(false)}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.confirmDeleteBtn, deletingAccount && { opacity: 0.6 }]}
                onPress={handleDeleteAccountSubmit}
                disabled={deletingAccount}
              >
                {deletingAccount ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmDeleteBtnText}>Delete Account</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const createStyles = (colors: ColorTokens, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      padding: 16,
      paddingBottom: 40,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.primaryNavy,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 3,
      elevation: 1,
    },
    cardHeader: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textPrimary,
      marginBottom: 12,
    },
    itemLabel: {
      fontSize: 12,
      fontWeight: '500',
      color: colors.textSecondary,
      marginTop: 6,
    },
    itemValue: {
      fontSize: 15,
      color: colors.textPrimary,
      fontWeight: '600',
      marginTop: 2,
      marginBottom: 4,
    },
    roleBadgeContainer: {
      alignSelf: 'flex-start',
      backgroundColor: colors.lightTeal,
      borderColor: colors.borderFocus,
      borderWidth: 1,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      marginTop: 3,
      marginBottom: 4,
    },
    roleBadgeText: {
      color: colors.tealDark,
      fontSize: 12,
      fontWeight: '700',
    },
    switchButton: {
      marginTop: 14,
      backgroundColor: colors.surfaceSubtle,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
    },
    switchButtonText: {
      color: colors.textPrimary,
      fontWeight: '600',
      fontSize: 14,
    },
    deleteBusinessButton: {
      marginTop: 10,
      backgroundColor: isDark ? '#450A0A' : '#FFF1F2',
      borderWidth: 1,
      borderColor: isDark ? '#7F1D1D' : '#FECDD3',
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
    },
    deleteBusinessButtonText: {
      color: '#E11D48',
      fontWeight: '600',
      fontSize: 13,
    },
    billingButton: {
      marginTop: 14,
      backgroundColor: colors.primaryTeal,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
    },
    billingButtonText: {
      color: '#FFFFFF',
      fontWeight: '600',
      fontSize: 14,
    },
    restrictedNotice: {
      marginTop: 12,
      backgroundColor: colors.surfaceSubtle,
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    restrictedNoticeText: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    dangerCard: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: isDark ? '#7F1D1D' : '#FECDD3',
    },
    dangerCardHeader: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.error,
      marginBottom: 6,
    },
    dangerDescription: {
      fontSize: 12,
      color: colors.textSecondary,
      lineHeight: 18,
      marginBottom: 12,
    },
    deleteAccountButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: isDark ? '#450A0A' : '#FEF2F2',
      borderWidth: 1,
      borderColor: isDark ? '#7F1D1D' : '#FECACA',
      borderRadius: 8,
      paddingVertical: 10,
    },
    deleteAccountButtonText: {
      color: colors.error,
      fontWeight: '600',
      fontSize: 13,
    },
    logoutButton: {
      backgroundColor: colors.error,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
      marginTop: 4,
    },
    logoutAllButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: isDark ? '#1E293B' : '#F1F5F9',
      borderWidth: 1,
      borderColor: isDark ? '#334155' : '#CBD5E1',
      borderRadius: 8,
      paddingVertical: 11,
      marginTop: 10,
    },
    logoutAllButtonText: {
      color: colors.textPrimary,
      fontWeight: '600',
      fontSize: 14,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    logoutButtonText: {
      color: '#FFFFFF',
      fontWeight: '700',
      fontSize: 15,
    },
    footnote: {
      fontSize: 11,
      color: colors.textMuted,
      textAlign: 'center',
      marginTop: 12,
      lineHeight: 15,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.backdrop,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    modalCard: {
      width: '100%',
      maxWidth: 400,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 4,
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 10,
    },
    modalTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    modalWarningText: {
      fontSize: 13,
      color: colors.textSecondary,
      marginBottom: 12,
      lineHeight: 18,
    },
    modalError: {
      backgroundColor: colors.errorLight,
      padding: 10,
      borderRadius: 8,
      marginBottom: 12,
    },
    modalErrorText: {
      color: colors.errorText,
      fontSize: 12,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
      marginBottom: 6,
    },
    textInput: {
      backgroundColor: colors.surfaceSubtle,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 14,
      color: colors.textPrimary,
      marginBottom: 16,
    },
    modalActionRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
      gap: 10,
    },
    cancelBtn: {
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: 8,
      backgroundColor: colors.surfaceSubtle,
    },
    cancelBtnText: {
      color: colors.textSecondary,
      fontWeight: '600',
      fontSize: 13,
    },
    confirmDeleteBtn: {
      paddingVertical: 9,
      paddingHorizontal: 14,
      borderRadius: 8,
      backgroundColor: colors.error,
      minWidth: 110,
      alignItems: 'center',
    },
    confirmDeleteBtnText: {
      color: '#FFFFFF',
      fontWeight: '700',
      fontSize: 13,
    },
    cardHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    itemDescription: {
      fontSize: 12,
      color: colors.textSecondary,
      marginBottom: 12,
      lineHeight: 16,
    },
    sectionSubhead: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textPrimary,
      marginTop: 6,
      marginBottom: 4,
    },
    fieldNote: {
      fontSize: 11,
      color: colors.textSecondary,
      lineHeight: 15,
    },
    pillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 8,
      marginBottom: 4,
    },
    pill: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: colors.surfaceSubtle,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pillActive: {
      backgroundColor: colors.lightTeal,
      borderColor: colors.primaryTeal,
    },
    pillText: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    pillTextActive: {
      color: colors.primaryTeal,
      fontWeight: '700',
    },
    separator: {
      height: 1,
      backgroundColor: colors.border,
      marginVertical: 12,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    rowTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
      marginBottom: 2,
    },
    categoryItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle,
    },
    categoryTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    mandatoryBadge: {
      backgroundColor: colors.infoLight,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 4,
      marginLeft: 6,
    },
    mandatoryBadgeText: {
      fontSize: 10,
      fontWeight: '600',
      color: colors.infoText,
    },
    syncFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 12,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.borderSubtle,
    },
    syncFooterText: {
      fontSize: 11,
      color: colors.textSecondary,
    },
  });
