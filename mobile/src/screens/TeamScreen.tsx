import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError } from '../services/api.ts';
import { getActiveBusiness, type StoredBusiness } from '../services/storage.ts';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';
import { InvitationConfirmationModal } from '../components/InvitationConfirmationModal.tsx';

interface SwapRequest {
  id: string;
  business_id: string;
  branch_id: string;
  department_id: string;
  requester_membership_id: string;
  requester_shift_id: string;
  counterpart_membership_id: string;
  counterpart_shift_id: string;
  status: 'pending' | 'peer_accepted' | 'peer_rejected' | 'approved' | 'cancelled' | 'stale';
  notes: string | null;
  created_at: string;
}

interface TeamMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  createdAt: string;
}

export function TeamScreen() {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const [activeTab, setActiveTab] = useState<'members' | 'swaps'>('members');
  const [currentBusiness, setCurrentBusiness] = useState<StoredBusiness | null>(null);

  // Team members state
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [refreshingMembers, setRefreshingMembers] = useState(false);

  // Swaps state
  const [swaps, setSwaps] = useState<SwapRequest[]>([]);
  const [loadingSwaps, setLoadingSwaps] = useState(false);
  const [refreshingSwaps, setRefreshingSwaps] = useState(false);
  const [processingSwapId, setProcessingSwapId] = useState<string | null>(null);

  // Common error state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Invite Member Modal state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<'owner' | 'co_owner' | 'gm' | 'supervisor' | 'staff'>('staff');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Invitation Confirmation Modal state
  const [confirmedInvite, setConfirmedInvite] = useState<{
    email: string;
    role: string;
    status: string;
    token?: string;
    expiresAt?: string;
    deliveryStatus?: 'queued' | 'unconfigured';
  } | null>(null);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);

  // Role Change Modal state
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [updatingRole, setUpdatingRole] = useState(false);

  useEffect(() => {
    initScreen();
  }, []);

  const initScreen = async () => {
    const biz = await getActiveBusiness();
    setCurrentBusiness(biz);
    if (biz?.id) {
      loadMembers(biz.id);
      loadSwaps();
    }
  };

  const loadMembers = useCallback(async (businessId?: string, isPull = false) => {
    const bId = businessId || currentBusiness?.id;
    if (!bId) return;

    if (isPull) setRefreshingMembers(true);
    else setLoadingMembers(true);
    setErrorMessage(null);

    try {
      const res = await api.organizations.getMembers(bId);
      setMembers(res.members || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load team members. Please check connection.');
      }
    } finally {
      setLoadingMembers(false);
      setRefreshingMembers(false);
    }
  }, [currentBusiness?.id]);

  const loadSwaps = useCallback(async (isPull = false) => {
    if (isPull) setRefreshingSwaps(true);
    else setLoadingSwaps(true);
    setErrorMessage(null);

    try {
      const res = await api.swaps.listSwaps();
      setSwaps(res.swaps || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load shift swaps. Please check connection.');
      }
    } finally {
      setLoadingSwaps(false);
      setRefreshingSwaps(false);
    }
  }, []);

  const handleInviteSubmit = async () => {
    if (!currentBusiness?.id) return;
    const trimmedEmail = inviteEmail.trim();
    if (!trimmedEmail) {
      setInviteError('Please enter a valid email address.');
      return;
    }

    setInviting(true);
    setInviteError(null);

    try {
      const res = await api.organizations.inviteMember(currentBusiness.id, {
        email: trimmedEmail,
        name: inviteName.trim() || undefined,
        role: inviteRole,
      });

      setShowInviteModal(false);
      setConfirmedInvite({
        email: trimmedEmail,
        role: inviteRole,
        status: res.invitation?.status || 'pending',
        token: res.invitation?.token,
        expiresAt: res.invitation?.expiresAt,
        deliveryStatus: res.invitation?.deliveryStatus,
      });
      setShowConfirmationModal(true);
      loadMembers(currentBusiness.id);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to invite team member';
      setInviteError(msg);
    } finally {
      setInviting(false);
    }
  };

  const handleBackToTeamFromConfirmation = () => {
    setShowConfirmationModal(false);
    setConfirmedInvite(null);
    setInviteEmail('');
    setInviteName('');
    setInviteRole('staff');
    if (currentBusiness?.id) {
      loadMembers(currentBusiness.id);
    }
  };

  const handleInviteAnotherFromConfirmation = () => {
    setShowConfirmationModal(false);
    setConfirmedInvite(null);
    setInviteEmail('');
    setInviteName('');
    setInviteRole('staff');
    setInviteError(null);
    setShowInviteModal(true);
  };

  const handleUpdateRole = async (newRole: string) => {
    if (!currentBusiness?.id || !selectedMember) return;
    setUpdatingRole(true);

    try {
      await api.organizations.updateMemberRole(currentBusiness.id, selectedMember.id, newRole);
      setShowRoleModal(false);
      setSelectedMember(null);
      Alert.alert('Role Updated', `Updated role to ${getRoleLabel(newRole)}.`);
      loadMembers(currentBusiness.id);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to update member role';
      Alert.alert('Error', msg);
    } finally {
      setUpdatingRole(false);
    }
  };

  const handleRemoveMember = (member: TeamMember) => {
    if (!currentBusiness?.id) return;

    Alert.alert(
      'Remove Member',
      `Are you sure you want to remove ${member.name} (${member.email}) from ${currentBusiness.name}? They will be unassigned from future shifts.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.organizations.removeMember(currentBusiness.id, member.id);
              Alert.alert('Member Removed', `${member.name} has been removed.`);
              loadMembers(currentBusiness.id);
            } catch (err: unknown) {
              const msg = err instanceof ApiError ? err.message : 'Failed to remove member';
              Alert.alert('Error', msg);
            }
          },
        },
      ]
    );
  };

  // Swaps handlers
  const handleAcceptSwap = async (swapId: string) => {
    const prevSwaps = [...swaps];
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'peer_accepted' } : s))
    );
    setProcessingSwapId(swapId);

    try {
      await api.swaps.acceptSwap(swapId);
    } catch (err: unknown) {
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to accept swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingSwapId(null);
    }
  };

  const handleRejectSwap = async (swapId: string) => {
    const prevSwaps = [...swaps];
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'peer_rejected' } : s))
    );
    setProcessingSwapId(swapId);

    try {
      await api.swaps.rejectSwap(swapId);
    } catch (err: unknown) {
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to reject swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingSwapId(null);
    }
  };

  const handleApproveSwap = async (swapId: string) => {
    const prevSwaps = [...swaps];
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'approved' } : s))
    );
    setProcessingSwapId(swapId);

    try {
      await api.swaps.approveSwap(swapId);
    } catch (err: unknown) {
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to approve swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingSwapId(null);
    }
  };

  const handleCancelSwap = async (swapId: string) => {
    const prevSwaps = [...swaps];
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'cancelled' } : s))
    );
    setProcessingSwapId(swapId);

    try {
      await api.swaps.cancelSwap(swapId);
    } catch (err: unknown) {
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to cancel swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingSwapId(null);
    }
  };

  const currentUserRole = (currentBusiness?.role || 'staff').toLowerCase();
  const canManageTeam = ['owner', 'co_owner', 'gm'].includes(currentUserRole);

  const getRoleBadge = (role: string) => {
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
  };

  const getRoleLabel = (role: string) => {
    switch (role.toLowerCase()) {
      case 'owner': return 'Business Owner';
      case 'co_owner': return 'Co-Owner';
      case 'gm': return 'Manager (GM)';
      case 'supervisor': return 'Shift Supervisor';
      default: return 'Staff Member';
    }
  };

  const renderMemberItem = ({ item }: { item: TeamMember }) => {
    const badge = getRoleBadge(item.role);
    const initials = item.name
      .split(' ')
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();

    return (
      <View style={styles.memberCard}>
        <View style={styles.memberTopRow}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initials || 'U'}</Text>
          </View>
          <View style={styles.memberInfo}>
            <Text style={styles.memberName} numberOfLines={2}>{item.name}</Text>
            <Text style={styles.memberEmail} numberOfLines={2}>{item.email}</Text>
          </View>
          <View style={[styles.roleBadge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.roleBadgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>
        </View>

        {item.departmentName && (
          <View style={styles.metaRow}>
            <Ionicons name="briefcase-outline" size={13} color="#64748B" style={{ marginRight: 4 }} />
            <Text style={styles.metaText}>{item.departmentName}</Text>
          </View>
        )}

        {canManageTeam && (
          <View style={styles.memberActionRow}>
            <TouchableOpacity
              style={styles.actionBtnSecondary}
              onPress={() => {
                setSelectedMember(item);
                setShowRoleModal(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Change role for ${item.name}`}
            >
              <Ionicons name="shield-outline" size={14} color={colors.primaryTeal} style={{ marginRight: 4 }} />
              <Text style={styles.actionBtnSecondaryText}>Change Role</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionBtnDanger}
              onPress={() => handleRemoveMember(item)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.name}`}
            >
              <Ionicons name="trash-outline" size={14} color="#DC2626" style={{ marginRight: 4 }} />
              <Text style={styles.actionBtnDangerText}>Remove</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  const renderSwapItem = ({ item }: { item: SwapRequest }) => {
    let badge = { label: item.status.toUpperCase(), bg: colors.surfaceSelected, color: colors.textSecondary };
    if (item.status === 'pending') badge = { label: 'PENDING PEER', bg: colors.warningLight, color: colors.warningText };
    else if (item.status === 'peer_accepted') badge = { label: 'AWAITING MANAGER', bg: colors.lightTeal, color: colors.tealDark };
    else if (item.status === 'approved') badge = { label: 'APPROVED', bg: colors.successLight, color: colors.successText };
    else if (item.status === 'peer_rejected') badge = { label: 'REJECTED', bg: colors.errorLight, color: colors.errorText };

    const isProcessing = processingSwapId === item.id;

    return (
      <View style={styles.swapCard}>
        <View style={styles.swapCardHeader}>
          <View style={[styles.roleBadge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.roleBadgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>
          <Text style={styles.dateText}>{new Date(item.created_at).toLocaleDateString()}</Text>
        </View>

        <Text style={styles.shiftRef}>Swap Ref: {item.id.slice(0, 8)}...</Text>
        {item.notes && <Text style={styles.notesText}>{item.notes}</Text>}

        <View style={styles.swapActionRow}>
          {item.status === 'pending' && (
            <>
              <TouchableOpacity
                style={[styles.btn, styles.btnAccept, isProcessing && styles.btnDisabled]}
                onPress={() => handleAcceptSwap(item.id)}
                disabled={isProcessing}
                activeOpacity={0.8}
              >
                <Text style={styles.btnText}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnReject, isProcessing && styles.btnDisabled]}
                onPress={() => handleRejectSwap(item.id)}
                disabled={isProcessing}
                activeOpacity={0.8}
              >
                <Text style={styles.btnText}>Reject</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnCancel, isProcessing && styles.btnDisabled]}
                onPress={() => handleCancelSwap(item.id)}
                disabled={isProcessing}
                activeOpacity={0.8}
              >
                <Text style={styles.btnCancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}

          {item.status === 'peer_accepted' && (
            <>
              <TouchableOpacity
                style={[styles.btn, styles.btnApprove, isProcessing && styles.btnDisabled]}
                onPress={() => handleApproveSwap(item.id)}
                disabled={isProcessing}
                activeOpacity={0.8}
              >
                <Text style={styles.btnText}>Manager Approve</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnCancel, isProcessing && styles.btnDisabled]}
                onPress={() => handleCancelSwap(item.id)}
                disabled={isProcessing}
                activeOpacity={0.8}
              >
                <Text style={styles.btnCancelText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Top Segmented Tab Switcher */}
      <View style={styles.segmentContainer}>
        <TouchableOpacity
          style={[styles.segmentBtn, activeTab === 'members' && styles.segmentBtnActive]}
          onPress={() => setActiveTab('members')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'members' }}
        >
          <Ionicons
            name="people"
            size={16}
            color={activeTab === 'members' ? colors.primaryTeal : '#64748B'}
            style={{ marginRight: 6 }}
          />
          <Text style={[styles.segmentBtnText, activeTab === 'members' && styles.segmentBtnTextActive]}>
            Team Members ({members.length})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.segmentBtn, activeTab === 'swaps' && styles.segmentBtnActive]}
          onPress={() => setActiveTab('swaps')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'swaps' }}
        >
          <Ionicons
            name="repeat"
            size={16}
            color={activeTab === 'swaps' ? colors.primaryTeal : '#64748B'}
            style={{ marginRight: 6 }}
          />
          <Text style={[styles.segmentBtnText, activeTab === 'swaps' && styles.segmentBtnTextActive]}>
            Shift Swaps ({swaps.length})
          </Text>
        </TouchableOpacity>
      </View>

      {errorMessage && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}

      {/* Main Content Area */}
      {activeTab === 'members' ? (
        <View style={{ flex: 1 }}>
          {canManageTeam && (
            <View style={styles.toolbarRow}>
              <TouchableOpacity
                style={styles.inviteButton}
                onPress={() => setShowInviteModal(true)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Invite new team member"
              >
                <Ionicons name="person-add" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={styles.inviteButtonText}>Invite Member</Text>
              </TouchableOpacity>
            </View>
          )}

          {loadingMembers ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={colors.primaryTeal} />
              <Text style={styles.loadingText}>Loading team directory...</Text>
            </View>
          ) : members.length === 0 ? (
            <View style={styles.centerBox}>
              <Ionicons name="people-outline" size={56} color="#94A3B8" style={{ marginBottom: 12 }} />
              <Text style={styles.emptyTitle}>No Team Members Found</Text>
              <Text style={styles.emptyText}>Invite team members to begin building schedules together.</Text>
            </View>
          ) : (
            <FlatList
              data={members}
              keyExtractor={(item) => item.id}
              renderItem={renderMemberItem}
              contentContainerStyle={styles.listContent}
              refreshControl={
                <RefreshControl
                  refreshing={refreshingMembers}
                  onRefresh={() => loadMembers(undefined, true)}
                  tintColor={colors.primaryTeal}
                  colors={[colors.primaryTeal]}
                />
              }
            />
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {loadingSwaps ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={colors.primaryTeal} />
              <Text style={styles.loadingText}>Loading shift swaps...</Text>
            </View>
          ) : swaps.length === 0 ? (
            <View style={styles.centerBox}>
              <Ionicons name="repeat-outline" size={56} color="#94A3B8" style={{ marginBottom: 12 }} />
              <Text style={styles.emptyTitle}>No Active Swaps</Text>
              <Text style={styles.emptyText}>Shift swap requests from your department will appear here.</Text>
              <View style={styles.swapHelpBox}>
                <Ionicons name="information-circle-outline" size={18} color={colors.primaryTeal} style={{ marginRight: 6 }} />
                <Text style={styles.swapHelpText}>
                  To swap a shift: Open the Schedule tab and tap the amber "Swap Shift" button on any published shift.
                </Text>
              </View>
            </View>
          ) : (
            <FlatList
              data={swaps}
              keyExtractor={(item) => item.id}
              renderItem={renderSwapItem}
              contentContainerStyle={styles.listContent}
              refreshControl={
                <RefreshControl
                  refreshing={refreshingSwaps}
                  onRefresh={() => loadSwaps(true)}
                  tintColor={colors.primaryTeal}
                  colors={[colors.primaryTeal]}
                />
              }
            />
          )}
        </View>
      )}

      {/* Invite Member Modal */}
      <Modal visible={showInviteModal} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Invite Team Member</Text>
              <TouchableOpacity onPress={() => setShowInviteModal(false)}>
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            {inviteError && (
              <View style={styles.modalError}>
                <Text style={styles.modalErrorText}>{inviteError}</Text>
              </View>
            )}

            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.inputLabel}>Email Address *</Text>
              <TextInput
                style={styles.textInput}
                placeholder="colleague@example.com"
                placeholderTextColor={colors.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                value={inviteEmail}
                onChangeText={setInviteEmail}
              />

              <Text style={styles.inputLabel}>Full Name (Optional)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Jane Doe"
                placeholderTextColor={colors.textMuted}
                value={inviteName}
                onChangeText={setInviteName}
              />

              <Text style={styles.inputLabel}>Role & Permissions *</Text>
              <View style={styles.rolePickerContainer}>
                {(['staff', 'supervisor', 'gm', ...(currentUserRole === 'owner' ? ['co_owner' as const] : [])] as const).map(
                  (r) => (
                    <TouchableOpacity
                      key={r}
                      style={[styles.roleOption, inviteRole === r && styles.roleOptionSelected]}
                      onPress={() => setInviteRole(r)}
                    >
                      <Ionicons
                        name={inviteRole === r ? 'radio-button-on' : 'radio-button-off'}
                        size={16}
                        color={inviteRole === r ? colors.primaryTeal : '#94A3B8'}
                        style={{ marginRight: 8 }}
                      />
                      <Text style={[styles.roleOptionText, inviteRole === r && styles.roleOptionTextSelected]}>
                        {getRoleLabel(r)}
                      </Text>
                    </TouchableOpacity>
                  )
                )}
              </View>

              <TouchableOpacity
                style={[styles.submitButton, inviting && styles.btnDisabled]}
                onPress={handleInviteSubmit}
                disabled={inviting}
              >
                {inviting ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.submitButtonText}>Send Invitation</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Role Change Modal */}
      <Modal visible={showRoleModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Change Member Role</Text>
              <TouchableOpacity onPress={() => setShowRoleModal(false)}>
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <Text style={styles.subheadText}>
              Modify role and permissions for {selectedMember?.name} ({selectedMember?.email})
            </Text>

            <View style={{ marginVertical: 12 }}>
              {(['staff', 'supervisor', 'gm', ...(currentUserRole === 'owner' ? ['co_owner' as const, 'owner' as const] : [])] as const).map(
                (r) => (
                  <TouchableOpacity
                    key={r}
                    style={[
                      styles.roleOption,
                      selectedMember?.role.toLowerCase() === r && styles.roleOptionSelected,
                    ]}
                    onPress={() => handleUpdateRole(r)}
                    disabled={updatingRole}
                  >
                    <Ionicons
                      name={selectedMember?.role.toLowerCase() === r ? 'checkmark-circle' : 'ellipse-outline'}
                      size={18}
                      color={selectedMember?.role.toLowerCase() === r ? colors.primaryTeal : '#94A3B8'}
                      style={{ marginRight: 8 }}
                    />
                    <Text style={styles.roleOptionText}>{getRoleLabel(r)}</Text>
                  </TouchableOpacity>
                )
              )}
            </View>

            {updatingRole && (
              <ActivityIndicator size="small" color={colors.primaryTeal} style={{ marginTop: 8 }} />
            )}
          </View>
        </View>
      </Modal>

      {/* Polished Invitation Confirmation Modal */}
      {confirmedInvite && (
        <InvitationConfirmationModal
          visible={showConfirmationModal}
          email={confirmedInvite.email}
          role={confirmedInvite.role}
          status={confirmedInvite.status}
          businessName={currentBusiness?.name}
          token={confirmedInvite.token}
          expiresAt={confirmedInvite.expiresAt}
          deliveryStatus={confirmedInvite.deliveryStatus}
          onBackToTeam={handleBackToTeamFromConfirmation}
          onInviteAnother={handleInviteAnotherFromConfirmation}
        />
      )}
    </View>
  );
}

function createStyles(colors: ColorTokens, isDark: boolean) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  segmentBtnActive: {
    borderBottomColor: colors.primaryTeal,
  },
  segmentBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  segmentBtnTextActive: {
    color: colors.primaryTeal,
    fontWeight: '700',
  },
  toolbarRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  inviteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primaryTeal,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    shadowColor: colors.primaryTeal,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
  },
  inviteButtonText: {
    color: colors.white,
    fontWeight: '600',
    fontSize: 13,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  memberCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.3 : 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  memberTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  avatarCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    borderWidth: 1,
    borderColor: isDark ? '#0F766E' : '#99F6E4',
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: isDark ? '#2DD4BF' : colors.tealDark,
  },
  memberInfo: {
    flex: 1,
    marginRight: 8,
  },
  memberName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 18,
  },
  memberEmail: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
    lineHeight: 16,
  },
  roleBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    flexShrink: 0,
  },
  roleBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  metaText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  memberActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  actionBtnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  actionBtnSecondaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primaryTeal,
  },
  actionBtnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.errorLight,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  actionBtnDangerText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.errorText,
  },
  swapCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: isDark ? 0.3 : 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  swapCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  dateText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  shiftRef: {
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: 4,
  },
  notesText: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 12,
    lineHeight: 18,
  },
  swapActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  btn: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  btnDisabled: {
    opacity: 0.6,
  },
  btnAccept: {
    backgroundColor: colors.primaryTeal,
    flex: 1,
  },
  btnReject: {
    backgroundColor: colors.error,
    flex: 1,
  },
  btnApprove: {
    backgroundColor: colors.success,
    flex: 1,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  btnCancel: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    flex: 1,
  },
  btnCancelText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    color: colors.textSecondary,
    marginTop: 12,
    fontSize: 14,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 280,
  },
  errorBanner: {
    backgroundColor: colors.errorLight,
    borderColor: colors.errorBorder,
    borderWidth: 1,
    padding: 12,
    margin: 16,
    marginBottom: 0,
    borderRadius: 8,
  },
  errorText: {
    color: colors.errorText,
    fontSize: 13,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0, 0, 0, 0.75)' : 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: isDark ? 0.4 : 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  subheadText: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 8,
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
    marginTop: 10,
    marginBottom: 4,
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
  },
  rolePickerContainer: {
    gap: 6,
    marginTop: 4,
    marginBottom: 12,
  },
  roleOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roleOptionSelected: {
    borderColor: colors.primaryTeal,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
  },
  roleOptionText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  roleOptionTextSelected: {
    color: isDark ? '#2DD4BF' : colors.tealDark,
    fontWeight: '600',
  },
  submitButton: {
    backgroundColor: colors.primaryTeal,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  swapHelpBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 16,
    maxWidth: 320,
    borderWidth: 1,
    borderColor: isDark ? '#0F766E' : '#CCFBF1',
  },
  swapHelpText: {
    flex: 1,
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 17,
    fontWeight: '500',
  },
  });
}
