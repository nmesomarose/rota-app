import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  getUserProfile,
  getActiveBusiness,
  clearSession,
  type StoredUser,
  type StoredBusiness,
} from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';
import { api } from '../services/api.ts';
import { connectivityManager } from '../services/connectivity.ts';
import { typography, spacing, radii, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';

interface Props {
  visible: boolean;
  onClose: () => void;
  navigation: any;
  currentRoute?: string;
}

export function HamburgerDrawer({ visible, onClose, navigation, currentRoute }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [user, setUser] = useState<StoredUser | null>(null);
  const [business, setBusiness] = useState<StoredBusiness | null>(null);
  const [isOnline, setIsOnline] = useState<boolean | null>(connectivityManager.getState().isOnline);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (visible) {
      loadDetails();
      const unsub = connectivityManager.addListener((state) => {
        setIsOnline(state.isOnline);
        setCheckingHealth(state.isChecking);
      });
      return () => {
        unsub();
      };
    }
  }, [visible]);

  const loadDetails = async () => {
    const u = await getUserProfile();
    const b = await getActiveBusiness();
    setUser(u);
    setBusiness(b);
  };

  const verifyStatus = async () => {
    setCheckingHealth(true);
    await connectivityManager.retry();
    setCheckingHealth(false);
  };

  const handleNavigate = (screenName: string, params?: any) => {
    onClose();
    if (['Schedule', 'Feed', 'Team', 'Settings'].includes(screenName)) {
      navigation.navigate('Main', { screen: screenName, params });
    } else {
      navigation.navigate(screenName, params);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.auth.logout();
    } catch {
      // Offline or network error: force local cleanup
    } finally {
      await clearSession();
      await clearAllOfflineCache();
      setLoggingOut(false);
      onClose();
      navigation.reset({
        index: 0,
        routes: [{ name: 'Auth' }],
      });
    }
  };

  const getInitials = (name?: string, email?: string) => {
    if (name) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
      return name.slice(0, 2).toUpperCase();
    }
    if (email) return email.slice(0, 2).toUpperCase();
    return 'RO';
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Backdrop dismiss */}
        <Pressable style={styles.backdrop} onPress={onClose} />

        {/* Drawer Panel */}
        <View style={styles.drawer}>
          <ScrollView
            contentContainerStyle={styles.drawerContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Header Close */}
            <View style={styles.topBar}>
              <Text style={styles.brandTitle}>Rota</Text>
              <TouchableOpacity
                onPress={onClose}
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
              >
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* User Account & Context Card */}
            <View style={styles.profileCard}>
              <View style={styles.avatarRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {getInitials(user?.name, user?.email)}
                  </Text>
                </View>
                <View style={styles.profileText}>
                  <Text style={styles.userName} numberOfLines={1}>
                    {user?.name || user?.email?.split('@')[0] || 'Team Member'}
                  </Text>
                  <Text style={styles.userEmail} numberOfLines={1}>
                    {user?.email || 'user@rotascheduling.com'}
                  </Text>
                </View>
              </View>

              {/* Active Business & Role */}
              <View style={styles.businessContext}>
                <View style={styles.bizHeader}>
                  <Text style={styles.contextLabel}>ACTIVE BUSINESS</Text>
                  <View style={styles.roleBadge}>
                    <Text style={styles.roleText}>
                      {(business?.role || 'MEMBER').toUpperCase()}
                    </Text>
                  </View>
                </View>
                <Text style={styles.businessName} numberOfLines={1}>
                  {business?.name || 'No Business Selected'}
                </Text>
              </View>

              {/* Online / Offline Status Indicator */}
              <TouchableOpacity
                style={[
                  styles.statusPill,
                  isOnline === true ? styles.statusPillOnline : styles.statusPillOffline,
                ]}
                onPress={verifyStatus}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Connection status"
              >
                <View
                  style={[
                    styles.statusDot,
                    isOnline === true ? styles.statusDotOnline : styles.statusDotOffline,
                  ]}
                />
                <Text
                  style={[
                    styles.statusPillText,
                    isOnline === true ? styles.statusTextOnline : styles.statusTextOffline,
                  ]}
                >
                  {checkingHealth
                    ? 'Checking connection...'
                    : isOnline === true
                    ? 'Connected (Online)'
                    : 'Offline Mode (Cached)'}
                </Text>
                <Ionicons
                  name="refresh-outline"
                  size={14}
                  color={isOnline === true ? '#059669' : '#D97706'}
                />
              </TouchableOpacity>
            </View>

            {/* Navigation Links */}
            <View style={styles.navSection}>
              <Text style={styles.sectionHeading}>NAVIGATION</Text>

              <TouchableOpacity
                style={[styles.navItem, currentRoute === 'Schedule' && styles.navItemActive]}
                onPress={() => handleNavigate('Schedule')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={currentRoute === 'Schedule' ? 'calendar' : 'calendar-outline'}
                  size={22}
                  color={currentRoute === 'Schedule' ? colors.primaryTeal : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.navItemText,
                    currentRoute === 'Schedule' && styles.navItemTextActive,
                  ]}
                >
                  Schedule
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.navItem, currentRoute === 'Team' && styles.navItemActive]}
                onPress={() => handleNavigate('Team')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={currentRoute === 'Team' ? 'people' : 'people-outline'}
                  size={22}
                  color={currentRoute === 'Team' ? colors.primaryTeal : colors.textSecondary}
                />
                <Text
                  style={[styles.navItemText, currentRoute === 'Team' && styles.navItemTextActive]}
                >
                  Team & Swaps
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.navItem, currentRoute === 'Feed' && styles.navItemActive]}
                onPress={() => handleNavigate('Feed')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={currentRoute === 'Feed' ? 'notifications' : 'notifications-outline'}
                  size={22}
                  color={currentRoute === 'Feed' ? colors.primaryTeal : colors.textSecondary}
                />
                <Text
                  style={[styles.navItemText, currentRoute === 'Feed' && styles.navItemTextActive]}
                >
                  Inbox & Notifications
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.navItem, currentRoute === 'Settings' && styles.navItemActive]}
                onPress={() => handleNavigate('Settings')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={currentRoute === 'Settings' ? 'settings' : 'settings-outline'}
                  size={22}
                  color={currentRoute === 'Settings' ? colors.primaryTeal : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.navItemText,
                    currentRoute === 'Settings' && styles.navItemTextActive,
                  ]}
                >
                  Settings & Profile
                </Text>
              </TouchableOpacity>

              <Text style={[styles.sectionHeading, { marginTop: 18 }]}>WORKSPACE</Text>

              <TouchableOpacity
                style={styles.navItem}
                onPress={() => handleNavigate('BusinessSelect')}
                activeOpacity={0.7}
              >
                <Ionicons name="swap-horizontal-outline" size={22} color={colors.textSecondary} />
                <Text style={styles.navItemText}>Switch Organization</Text>
              </TouchableOpacity>

              {business?.role?.toLowerCase() === 'owner' && (
                <TouchableOpacity
                  style={styles.navItem}
                  onPress={() => handleNavigate('Billing')}
                  activeOpacity={0.7}
                >
                  <Ionicons name="card-outline" size={22} color={colors.textSecondary} />
                  <Text style={styles.navItemText}>Subscription & Plan</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Sign Out Footer */}
            <View style={styles.footerSection}>
              <TouchableOpacity
                style={[styles.signOutButton, loggingOut && styles.buttonDisabled]}
                onPress={handleLogout}
                disabled={loggingOut}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Sign out of Rota"
              >
                {loggingOut ? (
                  <ActivityIndicator color="#DC2626" size="small" />
                ) : (
                  <>
                    <Ionicons name="log-out-outline" size={20} color="#DC2626" />
                    <Text style={styles.signOutText}>Sign Out of Rota</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ColorTokens) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      flexDirection: 'row',
    },
    backdrop: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.backdrop,
    },
    drawer: {
      width: '84%',
      maxWidth: 340,
      backgroundColor: colors.surface,
      height: '100%',
      shadowColor: '#000',
      shadowOffset: { width: 4, height: 0 },
      shadowOpacity: 0.25,
      shadowRadius: 20,
      elevation: 10,
      paddingTop: Platform.OS === 'ios' ? 54 : 32,
    },
    drawerContent: {
      paddingHorizontal: 20,
      paddingBottom: 40,
    },
    topBar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 20,
    },
    brandTitle: {
      fontSize: 22,
      fontWeight: '800',
      color: colors.textPrimary,
      letterSpacing: -0.5,
    },
    closeButton: {
      padding: 6,
    },
    profileCard: {
      backgroundColor: colors.surfaceSubtle,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 24,
    },
    avatarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 14,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.primaryNavy,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    avatarText: {
      color: '#FFFFFF',
      fontWeight: '700',
      fontSize: 16,
    },
    profileText: {
      flex: 1,
    },
    userName: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    userEmail: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
    },
    businessContext: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 10,
    },
    bizHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    contextLabel: {
      fontSize: 10,
      fontWeight: '700',
      color: colors.textMuted,
      letterSpacing: 0.5,
    },
    roleBadge: {
      backgroundColor: colors.lightTeal,
      borderColor: colors.borderFocus,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    roleText: {
      fontSize: 10,
      fontWeight: '700',
      color: colors.tealDark,
    },
    businessName: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: 1,
      justifyContent: 'space-between',
    },
    statusPillOnline: {
      backgroundColor: colors.lightTeal,
      borderColor: colors.borderFocus,
    },
    statusPillOffline: {
      backgroundColor: colors.warningLight,
      borderColor: colors.warningBorder,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginRight: 6,
    },
    statusDotOnline: {
      backgroundColor: colors.success,
    },
    statusDotOffline: {
      backgroundColor: colors.warning,
    },
    statusPillText: {
      fontSize: 12,
      fontWeight: '600',
      flex: 1,
    },
    statusTextOnline: {
      color: colors.tealDark,
    },
    statusTextOffline: {
      color: colors.warningText,
    },
    navSection: {
      marginBottom: 20,
    },
    sectionHeading: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
      letterSpacing: 0.8,
      marginBottom: 10,
      paddingHorizontal: 6,
    },
    navItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 10,
      marginBottom: 4,
      gap: 12,
    },
    navItemActive: {
      backgroundColor: colors.lightTeal,
    },
    navItemText: {
      fontSize: 15,
      fontWeight: '500',
      color: colors.textSecondary,
    },
    navItemTextActive: {
      color: colors.primaryTeal,
      fontWeight: '700',
    },
    footerSection: {
      marginTop: 20,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 16,
    },
    signOutButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 10,
      backgroundColor: colors.errorLight,
      gap: 10,
      justifyContent: 'center',
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    signOutText: {
      color: colors.errorText,
      fontSize: 14,
      fontWeight: '700',
    },
  });
