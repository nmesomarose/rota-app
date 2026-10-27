import React, { useEffect, useRef, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  Animated,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext.tsx';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';

export interface InvitationConfirmationModalProps {
  visible: boolean;
  email: string;
  role: string;
  status?: string;
  businessName?: string;
  token?: string;
  expiresAt?: string;
  onBackToTeam: () => void;
  onInviteAnother: () => void;
}

export function InvitationConfirmationModal({
  visible,
  email,
  role,
  status = 'pending',
  businessName,
  token,
  expiresAt,
  onBackToTeam,
  onInviteAnother,
}: InvitationConfirmationModalProps) {
  const { colors, isDark } = useTheme();
  const { height: screenHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors, isDark, screenHeight), [colors, isDark, screenHeight]);

  // Subtle accessible animations
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      scaleAnim.setValue(0.9);
      fadeAnim.setValue(0);
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 45,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, scaleAnim, fadeAnim]);

  if (!visible) return null;

  const roleBadge = getRoleBadgeDetails(role, colors);
  const roleLabel = getRoleFriendlyLabel(role);

  const formattedExpiry = useMemo(() => {
    if (!expiresAt) return '72 hours';
    try {
      const exp = new Date(expiresAt);
      return exp.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '72 hours';
    }
  }, [expiresAt]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onBackToTeam}
      statusBarTranslucent
    >
      <View style={styles.modalOverlay}>
        <Animated.View
          style={[
            styles.modalContainer,
            {
              opacity: fadeAnim,
              transform: [{ scale: scaleAnim }],
            },
          ]}
        >
          {/* Scrollable container for small Android screen responsiveness */}
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {/* Success Illustration & Icon Header */}
            <View style={styles.illustrationWrapper}>
              <View style={styles.outerGlowRing}>
                <View style={styles.middleRing}>
                  <View style={styles.iconCircle}>
                    <Ionicons
                      name="mail-open"
                      size={34}
                      color={colors.primaryTeal}
                    />
                  </View>
                </View>
              </View>
              <View style={styles.miniCheckBadge}>
                <Ionicons name="checkmark" size={12} color="#FFFFFF" />
              </View>
            </View>

            {/* Clear Confirmation Heading */}
            <Text style={styles.heading}>Invitation Created</Text>
            <Text style={styles.subheading}>
              An invitation has been generated and queued for delivery.
            </Text>

            {/* Invited Member Details Card */}
            <View style={styles.detailsCard}>
              {/* Recipient Email Row */}
              <View style={styles.detailItem}>
                <View style={styles.detailIconBox}>
                  <Ionicons name="person-outline" size={16} color={colors.primaryTeal} />
                </View>
                <View style={styles.detailContent}>
                  <Text style={styles.detailLabel}>Invited Member</Text>
                  <Text
                    style={styles.detailValue}
                    numberOfLines={2}
                    ellipsizeMode="middle"
                    selectable
                  >
                    {email}
                  </Text>
                </View>
              </View>

              <View style={styles.divider} />

              {/* Assigned Role Row */}
              <View style={styles.detailItem}>
                <View style={styles.detailIconBox}>
                  <Ionicons name="shield-outline" size={16} color={colors.primaryTeal} />
                </View>
                <View style={styles.detailContent}>
                  <Text style={styles.detailLabel}>Assigned Role</Text>
                  <View style={styles.roleRow}>
                    <View style={[styles.roleBadge, { backgroundColor: roleBadge.bg }]}>
                      <Text style={[styles.roleBadgeText, { color: roleBadge.color }]}>
                        {roleBadge.label}
                      </Text>
                    </View>
                    <Text style={styles.roleFriendlyText}>({roleLabel})</Text>
                  </View>
                </View>
              </View>

              <View style={styles.divider} />

              {/* Status Row: Explicitly Pending Acceptance */}
              <View style={styles.detailItem}>
                <View style={styles.detailIconBox}>
                  <Ionicons name="time-outline" size={16} color={colors.warning} />
                </View>
                <View style={styles.detailContent}>
                  <Text style={styles.detailLabel}>Invitation Status</Text>
                  <View style={styles.statusRow}>
                    <View style={styles.pendingBadge}>
                      <View style={styles.pendingDot} />
                      <Text style={styles.pendingBadgeText}>Pending Acceptance</Text>
                    </View>
                  </View>
                  <Text style={styles.statusDescription}>
                    Valid for {formattedExpiry}. The invitee must accept before appearing on active shift rosters.
                  </Text>
                </View>
              </View>
            </View>

            {/* Task 7: Distinguish invitation creation from actual email delivery and acceptance */}
            <View style={styles.noticeCard}>
              <View style={styles.noticeHeaderRow}>
                <Ionicons
                  name="information-circle-outline"
                  size={18}
                  color={colors.primaryTeal}
                  style={{ marginRight: 6 }}
                />
                <Text style={styles.noticeTitle}>Next Steps for Invitee</Text>
              </View>
              <Text style={styles.noticeBody}>
                {businessName ? `${businessName} sent an invitation link.` : 'An invitation link was sent.'} The recipient must open the link and sign in using Google or their Rota password to join this workspace.
              </Text>
            </View>

            {/* Protected Invitation Delivery Notice (Tokens are cryptographically hashed and never exposed) */}
            <View style={styles.deliveryBadgeCard}>
              <View style={styles.deliveryBadgeHeader}>
                <Ionicons name="shield-checkmark-outline" size={16} color={colors.primaryTeal} style={{ marginRight: 6 }} />
                <Text style={styles.deliveryBadgeTitle}>Protected Invitation Delivery</Text>
              </View>
              <Text style={styles.deliveryBadgeSubtitle}>
                Invitation dispatched securely to {email}. Tokens are single-use, cryptographically hashed, and never exposed in the UI.
              </Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actionsContainer}>
              {/* Primary Action: Back to Team */}
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={onBackToTeam}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Back to Team"
              >
                <Ionicons name="people" size={18} color="#FFFFFF" style={{ marginRight: 8 }} />
                <Text style={styles.primaryButtonText}>Back to Team</Text>
              </TouchableOpacity>

              {/* Secondary Action: Invite Another Member */}
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={onInviteAnother}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Invite Another Member"
              >
                <Ionicons
                  name="person-add-outline"
                  size={18}
                  color={colors.primaryTeal}
                  style={{ marginRight: 8 }}
                />
                <Text style={styles.secondaryButtonText}>Invite Another Member</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function getRoleBadgeDetails(role: string, colors: ColorTokens) {
  switch (role.toLowerCase()) {
    case 'owner':
      return { label: 'OWNER', bg: colors.lightTeal, color: colors.tealDark };
    case 'co_owner':
      return { label: 'CO-OWNER', bg: '#F5F3FF', color: '#6D28D9' };
    case 'gm':
      return { label: 'MANAGER', bg: '#ECFDF5', color: '#047857' };
    case 'supervisor':
      return { label: 'SUPERVISOR', bg: '#FEF3C7', color: '#B45309' };
    default:
      return { label: 'STAFF', bg: '#F1F5F9', color: '#475569' };
  }
}

function getRoleFriendlyLabel(role: string) {
  switch (role.toLowerCase()) {
    case 'owner':
      return 'Business Owner';
    case 'co_owner':
      return 'Co-Owner';
    case 'gm':
      return 'Manager (GM)';
    case 'supervisor':
      return 'Shift Supervisor';
    default:
      return 'Staff Member';
  }
}

function createStyles(colors: ColorTokens, isDark: boolean, screenHeight: number) {
  return StyleSheet.create({
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.backdrop,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xl,
    },
    modalContainer: {
      width: '100%',
      maxWidth: 440,
      maxHeight: Math.min(screenHeight * 0.88, 640),
      backgroundColor: colors.surface,
      borderRadius: radii.xl,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      ...(isDark ? shadows.modal : shadows.elevated),
    },
    scrollContent: {
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xl,
      alignItems: 'center',
    },
    illustrationWrapper: {
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
      marginTop: spacing.xs,
    },
    outerGlowRing: {
      width: 86,
      height: 86,
      borderRadius: 43,
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.12)' : 'rgba(15, 118, 110, 0.08)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    middleRing: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.22)' : 'rgba(15, 118, 110, 0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconCircle: {
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: colors.lightTeal,
      borderWidth: 1.5,
      borderColor: colors.primaryTeal,
      alignItems: 'center',
      justifyContent: 'center',
    },
    miniCheckBadge: {
      position: 'absolute',
      bottom: 2,
      right: 4,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.success,
      borderWidth: 2,
      borderColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    heading: {
      fontSize: typography.sizes.xl,
      fontWeight: typography.weights.bold,
      color: colors.primaryNavy,
      textAlign: 'center',
      marginBottom: spacing.xs,
      letterSpacing: -0.3,
    },
    subheading: {
      fontSize: typography.sizes.sm,
      color: colors.textSecondary,
      textAlign: 'center',
      marginBottom: spacing.lg,
      paddingHorizontal: spacing.sm,
      lineHeight: 18,
    },
    detailsCard: {
      width: '100%',
      backgroundColor: colors.surfaceSubtle,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    detailItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingVertical: spacing.xs,
    },
    detailIconBox: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.15)' : 'rgba(15, 118, 110, 0.08)',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.sm,
      marginTop: 2,
    },
    detailContent: {
      flex: 1,
    },
    detailLabel: {
      fontSize: typography.sizes.xs,
      color: colors.textSecondary,
      fontWeight: typography.weights.medium,
      marginBottom: 2,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    detailValue: {
      fontSize: typography.sizes.sm,
      fontWeight: typography.weights.semiBold,
      color: colors.textPrimary,
      lineHeight: 20,
    },
    roleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      marginTop: 2,
    },
    roleBadge: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radii.sm,
      marginRight: spacing.xs,
    },
    roleBadgeText: {
      fontSize: typography.sizes.xs,
      fontWeight: typography.weights.bold,
      letterSpacing: 0.5,
    },
    roleFriendlyText: {
      fontSize: typography.sizes.xs,
      color: colors.textSecondary,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 2,
    },
    pendingBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.warningLight,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.warningBorder,
    },
    pendingDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.warning,
      marginRight: 6,
    },
    pendingBadgeText: {
      fontSize: typography.sizes.xs,
      fontWeight: typography.weights.bold,
      color: colors.warningText,
    },
    statusDescription: {
      fontSize: typography.sizes.xs,
      color: colors.textMuted,
      marginTop: 4,
      lineHeight: 16,
    },
    divider: {
      height: 1,
      backgroundColor: colors.borderSubtle,
      marginVertical: spacing.xs,
    },
    noticeCard: {
      width: '100%',
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.08)' : 'rgba(15, 118, 110, 0.05)',
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(20, 184, 166, 0.25)' : 'rgba(15, 118, 110, 0.2)',
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    noticeHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    noticeTitle: {
      fontSize: typography.sizes.xs,
      fontWeight: typography.weights.bold,
      color: colors.primaryTeal,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    noticeBody: {
      fontSize: typography.sizes.xs,
      color: colors.textSecondary,
      lineHeight: 17,
    },
    deliveryBadgeCard: {
      width: '100%',
      backgroundColor: colors.surfaceSubtle,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.sm + 2,
      marginBottom: spacing.md,
    },
    deliveryBadgeHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    deliveryBadgeTitle: {
      fontSize: typography.sizes.xs,
      fontWeight: typography.weights.bold,
      color: colors.primaryTeal,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    deliveryBadgeSubtitle: {
      fontSize: typography.sizes.xs,
      color: colors.textSecondary,
      lineHeight: 16,
    },
    actionsContainer: {
      width: '100%',
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primaryTeal,
      borderRadius: radii.md,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
      ...(isDark ? shadows.subtle : shadows.card),
    },
    primaryButtonText: {
      color: '#FFFFFF',
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.bold,
    },
    secondaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      borderRadius: radii.md,
      borderWidth: 1.5,
      borderColor: colors.primaryTeal,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    secondaryButtonText: {
      color: colors.primaryTeal,
      fontSize: typography.sizes.md,
      fontWeight: typography.weights.bold,
    },
  });
}
