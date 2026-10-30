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
  deliveryStatus?: 'queued' | 'unconfigured';
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
  deliveryStatus,
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
            {/* Compact Success Icon & Header */}
            <View style={styles.illustrationWrapper}>
              <View style={styles.outerGlowRing}>
                <View style={styles.middleRing}>
                  <View style={styles.iconCircle}>
                    <Ionicons
                      name="mail-open"
                      size={20}
                      color={colors.primaryTeal}
                    />
                  </View>
                </View>
              </View>
              <View style={styles.miniCheckBadge}>
                <Ionicons name="checkmark" size={10} color="#FFFFFF" />
              </View>
            </View>

            {/* Clear Confirmation Heading */}
            <Text style={styles.heading}>Invitation Created</Text>
            <Text style={styles.subheading}>
              Staff invitation is registered and ready.
            </Text>

            {/* Compact Invited Member Details Card */}
            <View style={styles.detailsCard}>
              {/* Recipient Email Row */}
              <View style={styles.detailItem}>
                <View style={styles.detailIconBox}>
                  <Ionicons name="person-outline" size={14} color={colors.primaryTeal} />
                </View>
                <View style={styles.detailContent}>
                  <Text style={styles.detailLabel}>Invited Member</Text>
                  <Text
                    style={styles.detailValue}
                    numberOfLines={1}
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
                  <Ionicons name="shield-outline" size={14} color={colors.primaryTeal} />
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
                  <Ionicons name="time-outline" size={14} color={colors.warning} />
                </View>
                <View style={styles.detailContent}>
                  <Text style={styles.detailLabel}>Invitation Status</Text>
                  <View style={styles.statusRow}>
                    <View style={styles.pendingBadge}>
                      <View style={styles.pendingDot} />
                      <Text style={styles.pendingBadgeText}>Pending Acceptance</Text>
                    </View>
                    <Text style={styles.expiryNote}>• Valid for {formattedExpiry}</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Next Steps: Short, accurate instruction */}
            <View style={styles.noticeCard}>
              <View style={styles.noticeHeaderRow}>
                <Ionicons
                  name="information-circle-outline"
                  size={15}
                  color={colors.primaryTeal}
                  style={{ marginRight: 6 }}
                />
                <Text style={styles.noticeTitle}>Next Steps for Invitee</Text>
              </View>
              <Text style={styles.noticeBody}>
                The recipient must open the link and sign in using Google or their Rota password to join this workspace.
              </Text>
            </View>

            {/* Protected Invitation Delivery Notice (Tokens are cryptographically hashed and never exposed) */}
            <View
              style={[
                styles.deliveryBadgeCard,
                deliveryStatus === 'unconfigured' && styles.deliveryBadgeWarningCard,
              ]}
            >
              <View style={styles.deliveryBadgeHeader}>
                <Ionicons
                  name={
                    deliveryStatus === 'unconfigured'
                      ? 'alert-circle-outline'
                      : deliveryStatus === 'queued'
                      ? 'mail-outline'
                      : 'shield-checkmark-outline'
                  }
                  size={14}
                  color={deliveryStatus === 'unconfigured' ? colors.warning : colors.primaryTeal}
                  style={{ marginRight: 6 }}
                />
                <Text
                  style={[
                    styles.deliveryBadgeTitle,
                    deliveryStatus === 'unconfigured' && { color: colors.warningText },
                  ]}
                >
                  {deliveryStatus === 'queued'
                    ? 'Email Delivery Queued'
                    : deliveryStatus === 'unconfigured'
                    ? 'Email Delivery Unconfigured'
                    : 'Protected Invitation Delivery'}
                </Text>
              </View>
              <Text style={styles.deliveryBadgeSubtitle}>
                {deliveryStatus === 'queued'
                  ? 'Automated invitation email is queued for delivery. Tokens are single-use and cryptographically protected.'
                  : deliveryStatus === 'unconfigured'
                  ? 'Server email delivery is not configured on this environment. The invitation was created in the system, but no email was sent.'
                  : 'Invitation token is cryptographically protected and never exposed in the UI.'}
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
                <Ionicons name="people" size={17} color="#FFFFFF" style={{ marginRight: 8 }} />
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
                  size={17}
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
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.lg,
    },
    modalContainer: {
      width: '100%',
      maxWidth: 400,
      maxHeight: Math.min(screenHeight * 0.85, 500),
      backgroundColor: colors.surface,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      ...(isDark ? shadows.modal : shadows.elevated),
    },
    scrollContent: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      alignItems: 'center',
    },
    illustrationWrapper: {
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
      marginTop: 0,
    },
    outerGlowRing: {
      width: 50,
      height: 50,
      borderRadius: 25,
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.12)' : 'rgba(15, 118, 110, 0.08)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    middleRing: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.22)' : 'rgba(15, 118, 110, 0.14)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconCircle: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.lightTeal,
      borderWidth: 1.5,
      borderColor: colors.primaryTeal,
      alignItems: 'center',
      justifyContent: 'center',
    },
    miniCheckBadge: {
      position: 'absolute',
      bottom: -1,
      right: -1,
      width: 15,
      height: 15,
      borderRadius: 7.5,
      backgroundColor: colors.success,
      borderWidth: 1.5,
      borderColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    heading: {
      fontSize: typography.sizes.lg,
      fontWeight: typography.weights.bold,
      color: colors.primaryNavy,
      textAlign: 'center',
      marginBottom: 2,
      letterSpacing: -0.3,
    },
    subheading: {
      fontSize: typography.sizes.xs,
      color: colors.textSecondary,
      textAlign: 'center',
      marginBottom: spacing.sm + 2,
      paddingHorizontal: spacing.xs,
      lineHeight: 16,
    },
    detailsCard: {
      width: '100%',
      backgroundColor: colors.surfaceSubtle,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.sm,
    },
    detailItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 3,
    },
    detailIconBox: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.15)' : 'rgba(15, 118, 110, 0.08)',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: spacing.sm,
    },
    detailContent: {
      flex: 1,
    },
    detailLabel: {
      fontSize: 10,
      color: colors.textSecondary,
      fontWeight: typography.weights.medium,
      marginBottom: 1,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    detailValue: {
      fontSize: 13,
      fontWeight: typography.weights.semiBold,
      color: colors.textPrimary,
      lineHeight: 18,
    },
    roleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
    },
    roleBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1.5,
      borderRadius: radii.sm,
      marginRight: spacing.xs,
    },
    roleBadgeText: {
      fontSize: 10,
      fontWeight: typography.weights.bold,
      letterSpacing: 0.5,
    },
    roleFriendlyText: {
      fontSize: 11,
      color: colors.textSecondary,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
    },
    pendingBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.warningLight,
      paddingHorizontal: 6,
      paddingVertical: 1.5,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.warningBorder,
    },
    pendingDot: {
      width: 5,
      height: 5,
      borderRadius: 2.5,
      backgroundColor: colors.warning,
      marginRight: 5,
    },
    pendingBadgeText: {
      fontSize: 10,
      fontWeight: typography.weights.bold,
      color: colors.warningText,
    },
    expiryNote: {
      fontSize: 11,
      color: colors.textMuted,
      marginLeft: 6,
    },
    divider: {
      height: 1,
      backgroundColor: colors.borderSubtle,
      marginVertical: 3,
    },
    noticeCard: {
      width: '100%',
      backgroundColor: isDark ? 'rgba(20, 184, 166, 0.08)' : 'rgba(15, 118, 110, 0.05)',
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(20, 184, 166, 0.25)' : 'rgba(15, 118, 110, 0.2)',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.md,
    },
    noticeHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    noticeTitle: {
      fontSize: 10,
      fontWeight: typography.weights.bold,
      color: colors.primaryTeal,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    noticeBody: {
      fontSize: 11,
      color: colors.textSecondary,
      lineHeight: 16,
    },
    deliveryBadgeCard: {
      width: '100%',
      backgroundColor: colors.surfaceSubtle,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      marginBottom: spacing.md,
    },
    deliveryBadgeWarningCard: {
      borderColor: colors.warningBorder,
      backgroundColor: colors.warningLight,
    },
    deliveryBadgeHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    deliveryBadgeTitle: {
      fontSize: 10,
      fontWeight: typography.weights.bold,
      color: colors.primaryTeal,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    deliveryBadgeSubtitle: {
      fontSize: 11,
      color: colors.textSecondary,
      lineHeight: 15,
    },
    actionsContainer: {
      width: '100%',
      gap: spacing.xs + 2,
      marginTop: 0,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primaryTeal,
      borderRadius: radii.md,
      minHeight: 48,
      paddingHorizontal: spacing.md,
      ...(isDark ? shadows.subtle : shadows.card),
    },
    primaryButtonText: {
      color: '#FFFFFF',
      fontSize: 14,
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
      paddingHorizontal: spacing.md,
    },
    secondaryButtonText: {
      color: colors.primaryTeal,
      fontSize: 14,
      fontWeight: typography.weights.bold,
    },
  });
}
