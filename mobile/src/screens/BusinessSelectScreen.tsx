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
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError } from '../services/api.ts';
import {
  setAccessToken,
  setActiveBusiness,
  clearSession,
  getUserProfile,
  type StoredUser,
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

  const [currentUser, setCurrentUser] = useState<StoredUser | null>(null);
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
      const [data, profile] = await Promise.all([
        api.organizations.getMemberships(),
        getUserProfile().catch(() => null),
      ]);
      setMemberships(data.memberships);
      if (profile) {
        setCurrentUser(profile);
      }
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
          <Text style={styles.title}>
            {memberships.length === 0 ? 'Welcome to Rota' : 'Your Organizations'}
          </Text>
          <Text style={styles.subtitle}>
            {memberships.length === 0
              ? "Choose how you'd like to get started."
              : 'Select a workspace to manage schedules or create a new organization.'}
          </Text>
        </View>

        {errorMessage && !showCreateModal && (
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
            showsVerticalScrollIndicator={false}
          >
            {/* Compact Signed-in Account Indicator */}
            <View style={styles.signedInCard}>
              <View style={styles.signedInRow}>
                <View style={styles.userInitialsCircle}>
                  <Text style={styles.userInitialsText}>
                    {(currentUser?.name || currentUser?.email || 'U').charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.signedInMeta}>
                  <View style={styles.signedInBadgeRow}>
                    <View style={styles.statusDot} />
                    <Text style={styles.signedInBadgeText}>Signed In</Text>
                  </View>
                  <Text style={styles.signedInEmailText} numberOfLines={1}>
                    {currentUser?.email || 'Authenticated User'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.signedInSignOutBtn}
                  onPress={handleLogout}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Sign out"
                >
                  <Ionicons name="log-out-outline" size={16} color={colors.textSecondary} />
                  <Text style={styles.signedInSignOutText}>Sign out</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.signedInHelpText} numberOfLines={1}>
                Your account is active, but you are not currently a member of any workspace.
              </Text>
            </View>

            {/* Action 1: Join a Team */}
            <View style={styles.actionCard}>
              <View style={styles.actionCardHeader}>
                <View style={styles.actionIconContainer}>
                  <Ionicons name="people" size={20} color={colors.primaryTeal} />
                </View>
                <View style={styles.actionTitleContainer}>
                   <Text style={styles.actionTitle}>Received an Invitation?</Text>
                   <Text style={styles.actionDescription}>
                    Have an invitation from your employer?
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.primaryActionButton}
                onPress={() => navigation.navigate('AcceptInvitation', {})}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Enter Invitation Code"
              >
                <Text style={styles.primaryActionButtonText}>Enter Invitation Code →</Text>
                <Ionicons name="arrow-forward" size={16} color="#FFFFFF" style={styles.buttonIconRight} />
              </TouchableOpacity>
            </View>

            {/* Action 2: Create a Business */}
            <View style={styles.actionCard}>
              <View style={styles.actionCardHeader}>
                <View style={[styles.actionIconContainer, styles.actionIconNavy]}>
                  <Ionicons name="business" size={20} color={isDark ? colors.primaryNavy : '#17324D'} />
                </View>
                <View style={styles.actionTitleContainer}>
                  <Text style={styles.actionTitle}>Create a Business</Text>
                  <Text style={styles.actionDescription}>
                    Set up your workspace and start scheduling.
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.secondaryActionButton}
                onPress={() => {
                  setErrorMessage(null);
                  setNewOrgName('');
                  setShowCreateModal(true);
                }}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Create Workspace"
              >
                <Ionicons
                  name="add-circle-outline"
                  size={18}
                  color={colors.primaryTeal}
                  style={styles.buttonIconLeft}
                />
                <Text style={styles.secondaryActionButtonText}>Create Workspace</Text>
              </TouchableOpacity>
            </View>
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
                    <View style={styles.cardFooter}>
                      <Text style={styles.statusText}>Status: {item.status}</Text>
                      <Ionicons
                        name="chevron-forward"
                        size={18}
                        color={colors.textMuted}
                      />
                    </View>
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
                    style={styles.joinInviteButton}
                    onPress={() => navigation.navigate('AcceptInvitation', {})}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Have an invite code? Join another team"
                  >
                    <Ionicons
                      name="mail-open-outline"
                      size={18}
                      color={colors.primaryTeal}
                      style={{ marginRight: 8 }}
                    />
                    <Text style={styles.joinInviteButtonText}>
                      Have an invite code? Join another team
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.addBizButton}
                    onPress={() => {
                      setErrorMessage(null);
                      setNewOrgName('');
                      setShowCreateModal(true);
                    }}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Add another organization"
                  >
                    <Ionicons
                      name="add-circle-outline"
                      size={18}
                      color={colors.primaryTeal}
                      style={{ marginRight: 6 }}
                    />
                    <Text style={styles.addBizButtonText}>Add Another Organization</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.secondaryLogout}
                    onPress={handleLogout}
                    accessibilityRole="button"
                    accessibilityLabel="Sign out"
                  >
                    <Ionicons
                      name="log-out-outline"
                      size={16}
                      color={colors.textSecondary}
                      style={{ marginRight: 6 }}
                    />
                    <Text style={styles.secondaryLogoutText}>Sign out</Text>
                  </TouchableOpacity>
                </View>
              }
            />
          </View>
        )}
      </View>

      {/* Modal for Creating Workspace */}
      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowCreateModal(false);
          setErrorMessage(null);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleRow}>
                <Ionicons
                  name="business-outline"
                  size={20}
                  color={colors.primaryTeal}
                  style={{ marginRight: 8 }}
                />
                <Text style={styles.modalTitle}>Create Workspace</Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setShowCreateModal(false);
                  setErrorMessage(null);
                }}
                style={styles.modalCloseButton}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              Set up your workspace and start scheduling as the Owner.
            </Text>

            {errorMessage && (
              <View style={styles.modalErrorBanner}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.errorText} />
                <Text style={styles.modalErrorText}>{errorMessage}</Text>
              </View>
            )}

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
                returnKeyType="done"
                onSubmitEditing={handleCreateBusiness}
                accessibilityLabel="Organization name input"
              />
            </View>

            <TouchableOpacity
              style={[styles.createButton, creating && styles.buttonDisabled]}
              onPress={handleCreateBusiness}
              disabled={creating}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Create Workspace"
            >
              {creating ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.createButtonText}>Create Workspace</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
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
      marginBottom: 16,
    },
    title: {
      fontSize: 26,
      fontWeight: '800',
      color: colors.textPrimary,
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      marginTop: 4,
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
    paddingBottom: 24,
  },
  inputGroup: {
    width: '100%',
    marginBottom: 16,
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
    minHeight: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
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
    padding: 22,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: colors.border,
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
  modalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalCloseButton: {
    padding: 6,
  },
  modalSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 14,
    lineHeight: 18,
  },
  modalErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.errorLight,
    borderColor: colors.errorBorder,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
    gap: 6,
  },
  modalErrorText: {
    flex: 1,
    color: colors.errorText,
    fontSize: 12.5,
    fontWeight: '500',
  },
  // Signed-in banner styles
  signedInCard: {
    backgroundColor: isDark ? 'rgba(30, 41, 59, 0.7)' : colors.surfaceSubtle,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(51, 65, 85, 0.6)' : colors.border,
  },
  signedInRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userInitialsCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primaryTeal,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  userInitialsText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  signedInMeta: {
    flex: 1,
  },
  signedInBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: isDark ? '#2DD4BF' : '#0D9488',
    marginRight: 5,
  },
  signedInBadgeText: {
    color: isDark ? '#2DD4BF' : '#0D9488',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  signedInEmailText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  signedInHelpText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  // Invitation card styles (Task 4)
  signedInSignOutBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    gap: 4,
  },
  signedInSignOutText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500' as const,
  },
  invitationCard: {
    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1.5,
    borderColor: colors.primaryTeal,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: isDark ? 0.3 : 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  invitationHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  invitationIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: isDark ? 'rgba(45, 212, 191, 0.15)' : '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  invitationTextContainer: {
    flex: 1,
  },
  invitationCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  invitationCardSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  invitationActionButton: {
    backgroundColor: colors.primaryTeal,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  invitationActionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  sectionDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
    gap: 12,
  },
  sectionDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: isDark ? '#334155' : '#E2E8F0',
  },
  sectionDividerText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
  },
  joinInviteButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.primaryTeal,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    backgroundColor: isDark ? 'rgba(45, 212, 191, 0.08)' : '#F0FDFA',
    marginBottom: 12,
  },
  joinInviteButtonText: {
    color: colors.primaryTeal,
    fontSize: 14,
    fontWeight: '600',
  },
  // Task 4 onboarding action-card styles
  actionCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.2 : 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  actionCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  actionIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: isDark ? 'rgba(45, 212, 191, 0.15)' : '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  actionIconNavy: {
    backgroundColor: isDark ? 'rgba(23, 50, 77, 0.5)' : '#E0EBF5',
  },
  actionTitleContainer: {
    flex: 1,
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  actionDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  primaryActionButton: {
    backgroundColor: colors.primaryTeal,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexDirection: 'row' as const,
    shadowColor: colors.primaryTeal,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  primaryActionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700' as const,
  },
  buttonIconRight: {
    marginLeft: 8,
  },
  buttonIconLeft: {
    marginRight: 8,
  },
  secondaryActionButton: {
    backgroundColor: 'transparent',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexDirection: 'row' as const,
    borderWidth: 1.5,
    borderColor: colors.primaryTeal,
  },
  secondaryActionButtonText: {
    color: colors.primaryTeal,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  cardFooter: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    marginTop: 8,
  },
  });
}
