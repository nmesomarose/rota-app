import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError } from '../services/api.ts';
import {
  getAccessToken,
  getUserProfile,
  setActiveBusiness,
  clearSession,
  type StoredUser,
} from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';
import { clearAllTenantQueries } from '../services/query-client.ts';
import {
  typography,
  spacing,
  radii,
  shadows,
  useTheme,
  type ColorTokens,
} from '../theme/index.ts';

type Props = NativeStackScreenProps<RootStackParamList, 'AcceptInvitation'>;

interface InvitationPreview {
  id: string;
  businessId: string;
  businessName: string;
  email: string;
  role: string;
  departmentName: string | null;
  status: string;
  expiresAt: string;
}

export function AcceptInvitationScreen({ navigation, route }: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const initialToken = (route.params?.token || '').trim();
  const [token, setToken] = useState<string>(initialToken);
  const [manualTokenInput, setManualTokenInput] = useState<string>('');

  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [currentUser, setCurrentUser] = useState<StoredUser | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(true);
  const [accepting, setAccepting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Load user session and preview invitation
  const loadInvitationDetails = useCallback(
    async (tokenToFetch: string) => {
      if (!tokenToFetch) {
        setLoading(false);
        setErrorMessage('No invitation token provided. Please paste your invitation link or token.');
        return;
      }

      setLoading(true);
      setErrorMessage(null);
      setErrorCode(null);

      try {
        // Check current session
        const authAccessToken = await getAccessToken();
        const profile = await getUserProfile();
        setIsAuthenticated(Boolean(authAccessToken && profile));
        setCurrentUser(profile);

        // Fetch public invitation preview
        const data = await api.organizations.getInvitation(tokenToFetch);
        setInvitation(data.invitation);
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          setErrorCode(err.code);
          if (err.code === 'NOT_FOUND') {
            setErrorMessage('Invitation not found. Please verify the invitation link.');
          } else if (err.code === 'INVITATION_EXPIRED') {
            setErrorMessage('This invitation link has expired. Please ask your manager for a new invite.');
          } else if (err.code === 'INVITATION_ALREADY_USED') {
            setErrorMessage('This invitation has already been accepted or revoked.');
          } else if (err.code === 'INVALID_TOKEN') {
            setErrorMessage('The invitation token format is invalid.');
          } else {
            setErrorMessage(err.message || 'Failed to retrieve invitation details.');
          }
        } else {
          setErrorMessage('Unable to connect to Rota servers. Please check your network connection.');
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (initialToken) {
      loadInvitationDetails(initialToken);
    } else {
      setLoading(false);
    }
  }, [initialToken, loadInvitationDetails]);

  // Handle accepting invitation
  const handleAccept = async () => {
    if (!token || accepting) return;

    setAccepting(true);
    setErrorMessage(null);
    setErrorCode(null);

    try {
      // 1. Accept invitation on backend
      const result = await api.organizations.acceptInvitation(token);

      // 2. Clear tenant caches to ensure pure isolation
      await clearAllOfflineCache();
      await clearAllTenantQueries();

      // 3. Switch business context to new organization
      const switchRes = await api.organizations.switchBusiness(result.membership.businessId);

      // 4. Update stored active business
      await setActiveBusiness({
        id: result.membership.businessId,
        name: result.membership.businessName,
        role: switchRes.role || result.membership.role,
        branchId: result.membership.branchId || undefined,
        departmentId: result.membership.departmentId || undefined,
      });

      setSuccessMessage(`Welcome to ${result.membership.businessName}!`);

      // 5. Navigate to Main Schedule
      setTimeout(() => {
        navigation.replace('Main', { screen: 'Schedule' });
      }, 1200);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorCode(err.code);
        if (err.code === 'FORBIDDEN') {
          setErrorMessage(
            err.message ||
              `Email mismatch: This invitation is reserved for ${invitation?.email || 'the invited recipient'}.`
          );
        } else if (err.code === 'SEAT_LIMIT_REACHED') {
          setErrorMessage(
            'The organization has reached its maximum seat allowance. Please notify your team administrator.'
          );
        } else if (err.code === 'MEMBER_ALREADY_EXISTS') {
          setErrorMessage('You are already an active member of this organization.');
        } else if (err.code === 'INVITATION_EXPIRED') {
          setErrorMessage('This invitation has expired.');
        } else if (err.code === 'INVITATION_ALREADY_USED') {
          setErrorMessage('This invitation has already been accepted.');
        } else if (err.code === 'INVITATION_REVOKED') {
          setErrorMessage('This invitation has been revoked by the organization.');
        } else {
          setErrorMessage(err.message || 'Failed to accept invitation.');
        }
      } else {
        setErrorMessage('Unable to accept invitation. Please check your connection.');
      }
    } finally {
      setAccepting(false);
    }
  };

  // Switch account action for email mismatch
  const handleSwitchAccount = async () => {
    try {
      await clearSession();
      await clearAllOfflineCache();
      await clearAllTenantQueries();
    } finally {
      navigation.replace('Auth', {
        initialMode: 'login',
        pendingInviteToken: token,
        prefilledEmail: invitation?.email,
      });
    }
  };

  // Manual token submit
  const handleManualSubmit = () => {
    const trimmed = manualTokenInput.trim();
    if (!trimmed) return;
    setToken(trimmed);
    loadInvitationDetails(trimmed);
  };

  const isEmailMatch = useMemo(() => {
    if (!invitation || !currentUser) return false;
    return invitation.email.trim().toLowerCase() === currentUser.email.trim().toLowerCase();
  }, [invitation, currentUser]);

  const formattedExpiration = useMemo(() => {
    if (!invitation?.expiresAt) return null;
    try {
      const exp = new Date(invitation.expiresAt);
      return exp.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return null;
    }
  }, [invitation]);

  // Loading state
  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <ActivityIndicator size="large" color={colors.primaryTeal} />
        <Text style={styles.loadingText}>Verifying invitation details...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <StatusBar style={isDark ? 'light' : 'dark'} />

      {/* Top Header */}
      <View style={styles.header}>
        <View style={styles.badgeIconContainer}>
          <Ionicons name="mail-open-outline" size={32} color={colors.primaryTeal} />
        </View>
        <Text style={styles.title}>Team Invitation</Text>
        <Text style={styles.subtitle}>
          Join your colleagues on the Rota workforce platform
        </Text>
      </View>

      {/* Success Banner */}
      {successMessage && (
        <View style={styles.successCard}>
          <Ionicons name="checkmark-circle" size={28} color={colors.success} />
          <Text style={styles.successTitle}>{successMessage}</Text>
          <Text style={styles.successSubtitle}>Opening schedule workspace...</Text>
        </View>
      )}

      {/* Error Banner */}
      {errorMessage && (
        <View style={styles.errorCard}>
          <View style={styles.errorHeaderRow}>
            <Ionicons name="alert-circle" size={24} color={colors.errorText} />
            <Text style={styles.errorTitle}>
              {errorCode === 'INVITATION_EXPIRED'
                ? 'Invitation Expired'
                : errorCode === 'INVITATION_ALREADY_USED'
                ? 'Already Accepted'
                : errorCode === 'SEAT_LIMIT_REACHED'
                ? 'Seat Limit Reached'
                : 'Invitation Notice'}
            </Text>
          </View>
          <Text style={styles.errorText}>{errorMessage}</Text>

          {errorCode === 'MEMBER_ALREADY_EXISTS' && (
            <TouchableOpacity
              style={styles.errorActionButton}
              onPress={() => navigation.replace('BusinessSelect')}
              activeOpacity={0.8}
            >
              <Text style={styles.errorActionButtonText}>Go to Business Selection →</Text>
            </TouchableOpacity>
          )}

          {errorCode === 'NOT_FOUND' && (
            <TouchableOpacity
              style={styles.errorActionButton}
              onPress={() => {
                setInvitation(null);
                setToken('');
                setErrorMessage(null);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.errorActionButtonText}>Try another link or token</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Manual Token Entry when token is missing */}
      {!token && !invitation && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Enter Invitation Token</Text>
          <Text style={styles.cardDescription}>
            Paste the invitation token or code provided by your organization manager.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. inv_biz123_abc..."
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            autoCorrect={false}
            value={manualTokenInput}
            onChangeText={setManualTokenInput}
            onSubmitEditing={handleManualSubmit}
          />
          <TouchableOpacity
            style={[styles.primaryButton, !manualTokenInput.trim() && styles.buttonDisabled]}
            disabled={!manualTokenInput.trim()}
            onPress={handleManualSubmit}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryButtonText}>Look Up Invitation</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Valid Invitation Preview Card */}
      {invitation && (
        <View style={styles.card}>
          <View style={styles.orgHeader}>
            <View style={styles.orgAvatar}>
              <Text style={styles.orgAvatarText}>
                {invitation.businessName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.orgMeta}>
              <Text style={styles.orgName}>{invitation.businessName}</Text>
              <Text style={styles.roleBadge}>
                {invitation.role.toUpperCase()}
                {invitation.departmentName ? ` • ${invitation.departmentName}` : ''}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.detailsList}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Invited Email</Text>
              <Text style={styles.detailValue}>{invitation.email}</Text>
            </View>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Assigned Role</Text>
              <Text style={styles.detailValue}>
                {invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1)}
              </Text>
            </View>

            {invitation.departmentName && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Department</Text>
                <Text style={styles.detailValue}>{invitation.departmentName}</Text>
              </View>
            )}

            {formattedExpiration && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Expires</Text>
                <Text style={styles.detailValue}>{formattedExpiration}</Text>
              </View>
            )}
          </View>

          <View style={styles.divider} />

          {/* Action states depending on authentication */}
          {!isAuthenticated ? (
            // UNLOADED / UNAUTHENTICATED INVITEE
            <View style={styles.authSection}>
              <Text style={styles.authPromptText}>
                To accept this invitation and access your shifts, please sign in or register with{' '}
                <Text style={styles.boldText}>{invitation.email}</Text>.
              </Text>

              <TouchableOpacity
                style={styles.primaryButton}
                onPress={() =>
                  navigation.replace('Auth', {
                    initialMode: 'login',
                    pendingInviteToken: token,
                    prefilledEmail: invitation.email,
                  })
                }
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Sign in to accept invitation"
              >
                <Text style={styles.primaryButtonText}>Sign In to Accept</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() =>
                  navigation.replace('Auth', {
                    initialMode: 'signup',
                    pendingInviteToken: token,
                    prefilledEmail: invitation.email,
                  })
                }
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Create account to accept invitation"
              >
                <Text style={styles.secondaryButtonText}>Create New Account</Text>
              </TouchableOpacity>
            </View>
          ) : isEmailMatch ? (
            // AUTHENTICATED MATCHING EMAIL
            <View style={styles.authSection}>
              <View style={styles.userMatchBadge}>
                <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} />
                <Text style={styles.userMatchText}>
                  Signed in as <Text style={styles.boldText}>{currentUser?.email}</Text>
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, accepting && styles.buttonDisabled]}
                onPress={handleAccept}
                disabled={accepting}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Accept invitation and join organization"
              >
                {accepting ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>Accept Invitation & Join Team</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            // AUTHENTICATED EMAIL MISMATCH
            <View style={styles.authSection}>
              <View style={styles.mismatchBanner}>
                <Ionicons name="warning-outline" size={20} color={colors.warningText} />
                <View style={styles.mismatchTextContainer}>
                  <Text style={styles.mismatchTitle}>Account Mismatch</Text>
                  <Text style={styles.mismatchBody}>
                    This invitation was sent to{' '}
                    <Text style={styles.boldText}>{invitation.email}</Text>, but you are
                    currently signed in as{' '}
                    <Text style={styles.boldText}>{currentUser?.email}</Text>.
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleSwitchAccount}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Switch account to match invitation"
              >
                <Text style={styles.primaryButtonText}>Switch Account</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => navigation.replace('Main', { screen: 'Schedule' })}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Continue to current workspace"
              >
                <Text style={styles.secondaryButtonText}>Back to Current Workspace</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Return Navigation */}
      <View style={styles.footer}>
        <TouchableOpacity
          onPress={() =>
            isAuthenticated
              ? navigation.replace('Main', { screen: 'Schedule' })
              : navigation.replace('Auth')
          }
          activeOpacity={0.7}
        >
          <Text style={styles.footerLink}>
            {isAuthenticated ? '← Back to Schedule' : '← Back to Sign In'}
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const createStyles = (colors: ColorTokens, isDark: boolean) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scrollContent: {
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xxl + 8,
      flexGrow: 1,
      justifyContent: 'center',
    },
    centerContainer: {
      flex: 1,
      backgroundColor: colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.xl,
    },
    loadingText: {
      marginTop: spacing.md,
      fontSize: typography.sizes.md,
      color: colors.textSecondary,
      fontWeight: typography.weights.medium,
    },
    header: {
      alignItems: 'center',
      marginBottom: spacing.xl,
    },
    badgeIconContainer: {
      width: 64,
      height: 64,
      borderRadius: radii.full,
      backgroundColor: colors.surfaceSubtle,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
      borderWidth: 1.5,
      borderColor: colors.border,
      ...shadows.subtle,
    },
    title: {
      fontSize: typography.sizes.xxl,
      fontWeight: typography.weights.extraBold,
      color: colors.primaryNavy,
      textAlign: 'center',
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: spacing.xs,
      fontWeight: typography.weights.medium,
      maxWidth: 320,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radii.xl,
      padding: spacing.xl,
      borderWidth: 1,
      borderColor: colors.border,
      ...shadows.card,
      marginBottom: spacing.lg,
    },
    orgHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    orgAvatar: {
      width: 52,
      height: 52,
      borderRadius: radii.lg,
      backgroundColor: colors.primaryNavy,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.md,
    },
    orgAvatarText: {
      color: colors.primaryTeal,
      fontSize: typography.sizes.xl,
      fontWeight: typography.weights.bold,
    },
    orgMeta: {
      flex: 1,
    },
    orgName: {
      fontSize: typography.sizes.lg,
      fontWeight: typography.weights.bold,
      color: colors.textPrimary,
      marginBottom: 3,
    },
    roleBadge: {
      fontSize: typography.sizes.xs,
      fontWeight: typography.weights.bold,
      color: colors.primaryTeal,
      letterSpacing: 0.5,
    },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginVertical: spacing.md,
    },
    detailsList: {
      gap: spacing.sm,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    detailLabel: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
      fontWeight: typography.weights.medium,
    },
    detailValue: {
      fontSize: typography.sizes.sm,
      color: colors.textPrimary,
      fontWeight: typography.weights.semiBold,
    },
    authSection: {
      marginTop: spacing.sm,
      gap: spacing.md,
    },
    authPromptText: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
      lineHeight: 20,
      textAlign: 'center',
    },
    userMatchBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: isDark ? '#052E16' : '#F0FDF4',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      gap: spacing.xs,
      borderWidth: 1,
      borderColor: colors.successBorder,
    },
    userMatchText: {
      fontSize: typography.sizes.xs + 1,
      color: colors.successText,
    },
    boldText: {
      fontWeight: typography.weights.bold,
      color: colors.textPrimary,
    },
    mismatchBanner: {
      flexDirection: 'row',
      backgroundColor: colors.warningLight,
      borderColor: colors.warningBorder,
      borderWidth: 1,
      borderRadius: radii.md,
      padding: spacing.md,
      gap: spacing.sm,
      alignItems: 'flex-start',
    },
    mismatchTextContainer: {
      flex: 1,
    },
    mismatchTitle: {
      fontSize: typography.sizes.sm,
      fontWeight: typography.weights.bold,
      color: colors.warningText,
      marginBottom: 3,
    },
    mismatchBody: {
      fontSize: typography.sizes.xs + 1,
      color: colors.warningText,
      lineHeight: 18,
    },
    primaryButton: {
      backgroundColor: colors.primaryTeal,
      borderRadius: radii.md,
      paddingVertical: spacing.md - 1,
      alignItems: 'center',
      justifyContent: 'center',
      ...shadows.subtle,
    },
    primaryButtonText: {
      color: '#FFFFFF',
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.bold,
    },
    secondaryButton: {
      backgroundColor: colors.surfaceSubtle,
      borderRadius: radii.md,
      paddingVertical: spacing.md - 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryButtonText: {
      color: colors.textPrimary,
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.semiBold,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    successCard: {
      backgroundColor: isDark ? '#052E16' : '#F0FDF4',
      borderWidth: 1.5,
      borderColor: colors.successBorder,
      borderRadius: radii.xl,
      padding: spacing.xl,
      alignItems: 'center',
      marginBottom: spacing.lg,
    },
    successTitle: {
      fontSize: typography.sizes.lg,
      fontWeight: typography.weights.bold,
      color: colors.successText,
      marginTop: spacing.sm,
    },
    successSubtitle: {
      fontSize: typography.sizes.sm,
      color: colors.successText,
      marginTop: spacing.xs,
    },
    errorCard: {
      backgroundColor: colors.errorLight,
      borderColor: colors.errorBorder,
      borderWidth: 1.5,
      borderRadius: radii.xl,
      padding: spacing.lg,
      marginBottom: spacing.lg,
    },
    errorHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.xs,
    },
    errorTitle: {
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.bold,
      color: colors.errorText,
    },
    errorText: {
      fontSize: typography.sizes.sm,
      color: colors.errorText,
      lineHeight: 20,
    },
    errorActionButton: {
      marginTop: spacing.md,
      alignSelf: 'flex-start',
    },
    errorActionButtonText: {
      fontSize: typography.sizes.sm,
      fontWeight: typography.weights.bold,
      color: colors.primaryNavy,
      textDecorationLine: 'underline',
    },
    sectionTitle: {
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.bold,
      color: colors.textPrimary,
      marginBottom: spacing.xs,
    },
    cardDescription: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
      marginBottom: spacing.md,
      lineHeight: 18,
    },
    input: {
      backgroundColor: colors.surfaceSubtle,
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm + 2,
      color: colors.textPrimary,
      fontSize: typography.sizes.sm,
      marginBottom: spacing.md,
    },
    footer: {
      alignItems: 'center',
      marginTop: spacing.md,
    },
    footerLink: {
      fontSize: typography.sizes.sm,
      fontWeight: typography.weights.semiBold,
      color: colors.primaryNavy,
      paddingVertical: spacing.sm,
    },
  });
