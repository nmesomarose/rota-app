import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, addConnectivityListener } from '../services/api.ts';
import {
  getCachedSchedule,
  setCachedSchedule,
  type CachedShift,
} from '../services/offline-cache.ts';
import { getActiveBusiness, getUserProfile, type StoredBusiness, type StoredUser } from '../services/storage.ts';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';
import { queryClient, queryKeys } from '../services/query-client.ts';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  departmentId: string | null;
}

export function ScheduleScreen() {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const [shifts, setShifts] = useState<CachedShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [business, setBusiness] = useState<StoredBusiness | null>(null);
  const [user, setUser] = useState<StoredUser | null>(null);

  // Management controls
  const [members, setMembers] = useState<TeamMember[]>([]);

  // Create Shift Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [shiftStartHours, setShiftStartHours] = useState('09:00');
  const [shiftEndHours, setShiftEndHours] = useState('17:00');
  const [shiftDateOffset, setShiftDateOffset] = useState('1'); // days from today
  const [shiftStatus, setShiftStatus] = useState<'draft' | 'published'>('published');
  const [creatingShift, setCreatingShift] = useState(false);

  // Assign Worker Modal
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedShift, setSelectedShift] = useState<CachedShift | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  // Shift Swap Request Modal (Staff & Team)
  const [showSwapModal, setShowSwapModal] = useState(false);
  const [swapShift, setSwapShift] = useState<CachedShift | null>(null);
  const [selectedCounterpartShiftId, setSelectedCounterpartShiftId] = useState<string | null>(null);
  const [selectedCounterpartMembershipId, setSelectedCounterpartMembershipId] = useState<string | null>(null);
  const [swapNotes, setSwapNotes] = useState('');
  const [submittingSwap, setSubmittingSwap] = useState(false);

  const loadSchedule = useCallback(async (isPullToRefresh = false) => {
    if (isPullToRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setErrorMessage(null);

    const activeBiz = await getActiveBusiness();
    const u = await getUserProfile();

    setBusiness(activeBiz);
    setUser(u);

    if (!activeBiz || !u) {
      setLoading(false);
      setRefreshing(false);
      setErrorMessage('No active organization context found.');
      return;
    }

    try {
      // 1. Attempt live network fetch
      const response = await api.scheduling.getShifts();
      const liveShifts: CachedShift[] = response.shifts.map((s: any) => {
        const rawAssignments = s.assignments || s.assignedStaffIds || [];
        const assignedStaffIds: string[] = Array.isArray(rawAssignments)
          ? rawAssignments
              .map((a: any) => (typeof a === 'string' ? a : a.membershipId || a.membership_id))
              .filter(Boolean)
          : [];

        return {
          id: s.id,
          branchId: s.branchId || s.branch_id,
          departmentId: s.departmentId || s.department_id,
          startsAt: s.startsAt || s.starts_at,
          endsAt: s.endsAt || s.ends_at,
          timeZone: s.timeZone || s.time_zone,
          status: s.status,
          version: s.version,
          assignedStaffIds,
        };
      });

      // 2. Persist to offline cache and TanStack Query cache (PRD 12.1, FR-OFF-001, AC-OFF-02)
      queryClient.setQueryData(queryKeys.shifts(activeBiz.id, activeBiz.branchId, activeBiz.departmentId), liveShifts);
      const cached = await setCachedSchedule(activeBiz.id, u.id, liveShifts);
      setShifts(liveShifts);
      setIsOffline(false);
      setLastUpdated(cached.lastUpdated);

      // 3. Load team members for assignments and swap colleague lookup
      try {
        const membersRes = await api.organizations.getMembers(activeBiz.id);
        setMembers(
          membersRes.members.map((m) => ({
            id: m.id,
            name: m.name,
            email: m.email,
            role: m.role,
            departmentId: m.departmentId,
          }))
        );
      } catch {
        // ignore background member load error
      }
    } catch (err: unknown) {
      // 3. Fall back to read-only offline cache
      console.warn('[ScheduleScreen] Live fetch failed, falling back to cache:', err);
      const cached = await getCachedSchedule(activeBiz.id, u.id);

      if (cached && cached.shifts) {
        setShifts(cached.shifts);
        setIsOffline(true);
        setLastUpdated(cached.lastUpdated);
      } else {
        if (err instanceof ApiError) {
          setErrorMessage(err.message);
        } else {
          setErrorMessage('Unable to load schedule and no cached data is available.');
        }
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  // Auto-sync when connectivity is restored after working offline
  useEffect(() => {
    const unsub = addConnectivityListener((online) => {
      if (online && isOffline) {
        loadSchedule();
      }
    });
    return unsub;
  }, [loadSchedule, isOffline]);

  const canManageShifts = ['owner', 'co_owner', 'gm', 'supervisor'].includes(
    (business?.role || '').toLowerCase()
  );

  const sanitizeTime = (t: string): string => {
    const trimmed = t.trim();
    const parts = trimmed.split(':');
    if (parts.length === 1) {
      const h = parseInt(parts[0], 10);
      if (!isNaN(h) && h >= 0 && h < 24) {
        return `${String(h).padStart(2, '0')}:00`;
      }
    } else if (parts.length === 2) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!isNaN(h) && !isNaN(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    }
    return trimmed;
  };

  const handleCreateShift = async () => {
    if (!business?.id) {
      Alert.alert('Organization Required', 'Please select or create an organization first.');
      return;
    }

    const startTimeStr = sanitizeTime(shiftStartHours);
    const endTimeStr = sanitizeTime(shiftEndHours);
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (!timeRegex.test(startTimeStr)) {
      Alert.alert('Invalid Start Time', 'Start time must be in 24-hour HH:MM format (e.g. 09:00).');
      return;
    }

    if (!timeRegex.test(endTimeStr)) {
      Alert.alert('Invalid End Time', 'End time must be in 24-hour HH:MM format (e.g. 17:00).');
      return;
    }

    setCreatingShift(true);

    try {
      const offset = parseInt(shiftDateOffset || '1', 10);
      const safeOffset = isNaN(offset) ? 1 : Math.max(0, offset);

      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + safeOffset);
      const yyyy = targetDate.getFullYear();
      const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
      const dd = String(targetDate.getDate()).padStart(2, '0');

      const endDate = new Date(targetDate);
      // If end time is <= start time (e.g., 22:00 to 06:00), shift spans into next day
      if (endTimeStr <= startTimeStr) {
        endDate.setDate(endDate.getDate() + 1);
      }
      const endYyyy = endDate.getFullYear();
      const endMm = String(endDate.getMonth() + 1).padStart(2, '0');
      const endDd = String(endDate.getDate()).padStart(2, '0');

      const startsAt = `${yyyy}-${mm}-${dd}T${startTimeStr}:00.000Z`;
      const endsAt = `${endYyyy}-${endMm}-${endDd}T${endTimeStr}:00.000Z`;

      // Use real branch/department IDs if already known, or resolve from organization
      let branchId = shifts[0]?.branchId || business.branchId;
      let departmentId = shifts[0]?.departmentId || business.departmentId;

      if (!branchId || !departmentId) {
        try {
          const orgDetails = await api.organizations.get(business.id);
          branchId = branchId || orgDetails.branches?.[0]?.id;
          departmentId = departmentId || orgDetails.departments?.[0]?.id;
        } catch {
          // fallback to backend auto-resolution
        }
      }

      await api.scheduling.createShift({
        ...(branchId ? { branchId } : {}),
        ...(departmentId ? { departmentId } : {}),
        startsAt,
        endsAt,
        timeZone: 'UTC',
        status: shiftStatus,
      });

      setShowCreateModal(false);
      if (business?.id) {
        queryClient.invalidateQueries({ queryKey: ['tenant', business.id, 'branch'] });
      }
      Alert.alert('Shift Created', `Shift scheduled for ${yyyy}-${mm}-${dd} (${startTimeStr} - ${endTimeStr}).`);
      loadSchedule();
    } catch (err: unknown) {
      let msg = 'Failed to create shift';
      if (err instanceof ApiError) {
        msg = err.message;
        if (err.details && typeof err.details === 'object' && 'errors' in err.details) {
          const fieldErrors = (err.details as any).errors;
          const firstKey = Object.keys(fieldErrors)[0];
          if (firstKey && fieldErrors[firstKey]?.[0]) {
            msg = `${firstKey}: ${fieldErrors[firstKey][0]}`;
          }
        }
      }
      Alert.alert('Validation Error', msg);
    } finally {
      setCreatingShift(false);
    }
  };

  const handleAssignWorker = async (membershipId: string) => {
    if (!selectedShift) return;
    setAssigning(true);

    try {
      await api.scheduling.assignWorker(selectedShift.id, membershipId);
      setShowAssignModal(false);
      setSelectedShift(null);
      if (business?.id) {
        queryClient.invalidateQueries({ queryKey: ['tenant', business.id, 'branch'] });
      }
      Alert.alert('Assigned', 'Team member assigned to shift.');
      loadSchedule();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to assign worker';
      Alert.alert('Assignment Error', msg);
    } finally {
      setAssigning(false);
    }
  };

  const handlePublishShift = async (shiftId: string) => {
    setPublishingId(shiftId);
    try {
      await api.scheduling.publishSchedule([shiftId]);
      if (business?.id) {
        queryClient.invalidateQueries({ queryKey: ['tenant', business.id, 'branch'] });
      }
      Alert.alert('Published', 'Shift published and notified to assigned team members.');
      loadSchedule();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to publish shift';
      Alert.alert('Error', msg);
    } finally {
      setPublishingId(null);
    }
  };

  const handleOpenSwapModal = (shift: CachedShift) => {
    setSwapShift(shift);
    setSelectedCounterpartShiftId(null);
    setSelectedCounterpartMembershipId(null);
    setSwapNotes('');
    setShowSwapModal(true);
  };

  const handleCloseSwapModal = () => {
    setShowSwapModal(false);
    setSwapShift(null);
    setSelectedCounterpartShiftId(null);
    setSelectedCounterpartMembershipId(null);
    setSwapNotes('');
  };

  const handleRequestSwapSubmit = async () => {
    if (!swapShift || !selectedCounterpartShiftId || !selectedCounterpartMembershipId) {
      Alert.alert('Incomplete', 'Please select a colleague shift and tag a colleague to swap with.');
      return;
    }
    setSubmittingSwap(true);
    try {
      await api.swaps.requestSwap({
        requesterShiftId: swapShift.id,
        counterpartShiftId: selectedCounterpartShiftId,
        counterpartMembershipId: selectedCounterpartMembershipId,
        notes: swapNotes.trim() || undefined,
      });
      handleCloseSwapModal();
      Alert.alert(
        'Swap Requested! 🔄',
        'Your shift swap request has been submitted. Your colleague can review and accept it in Team > Shift Swaps.'
      );
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to submit shift swap request';
      Alert.alert('Swap Request Error', msg);
    } finally {
      setSubmittingSwap(false);
    }
  };

  const formatDateTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const formatLastUpdated = (isoString: string | null) => {
    if (!isoString) return 'Never';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  };

  return (
    <View style={styles.container}>
      {/* Context status bar */}
      <View style={styles.statusBar}>
        <Text style={styles.businessBadge}>{business?.name || 'Rota'}</Text>
        <View style={styles.statusDivider} />
        <View style={[styles.statusDot, isOffline ? styles.dotOffline : styles.dotOnline]} />
        <Text style={styles.statusText}>
          {isOffline ? 'Offline Cache' : 'Live Connected'} • Updated {formatLastUpdated(lastUpdated)}
        </Text>
      </View>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={16} color="#92400E" style={{ marginRight: 6 }} />
          <Text style={styles.offlineBannerText}>Offline mode active. Showing cached shifts.</Text>
        </View>
      )}

      {errorMessage && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => loadSchedule()}>
            <Text style={styles.retryButtonText}>Retry Connection</Text>
          </TouchableOpacity>
        </View>
      )}

      {canManageShifts && (
        <View style={styles.toolbarRow}>
          <TouchableOpacity
            style={styles.addShiftBtn}
            onPress={() => setShowCreateModal(true)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Create a new shift"
          >
            <Ionicons name="add" size={18} color="#FFFFFF" style={{ marginRight: 4 }} />
            <Text style={styles.addShiftBtnText}>Add Shift</Text>
          </TouchableOpacity>
        </View>
      )}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.primaryTeal} />
          <Text style={styles.loadingText}>Loading upcoming shifts...</Text>
        </View>
      ) : shifts.length === 0 ? (
        <View style={styles.emptyBox}>
          <Ionicons name="calendar-outline" size={56} color="#94A3B8" style={styles.emptyIcon} />
          <Text style={styles.emptyTitle}>No Shifts Scheduled</Text>
          <Text style={styles.emptySubtitle}>There are no shifts scheduled for the next 14 days.</Text>
          <TouchableOpacity style={styles.refreshButton} onPress={() => loadSchedule()} activeOpacity={0.8}>
            <Ionicons name="refresh-outline" size={16} color="#FFFFFF" style={{ marginRight: 6 }} />
            <Text style={styles.refreshButtonText}>Refresh Schedule</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={shifts}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadSchedule(true)}
              tintColor={colors.primaryTeal}
              colors={[colors.primaryTeal]}
            />
          }
          contentContainerStyle={styles.listContainer}
          renderItem={({ item }) => {
            const hasAssignments = item.assignedStaffIds && item.assignedStaffIds.length > 0;
            const isDraft = item.status === 'draft';
            const isPublishing = publishingId === item.id;

            return (
              <View style={styles.shiftCard}>
                <View style={styles.shiftHeader}>
                  <Text style={styles.shiftTime}>
                    {formatDateTime(item.startsAt)} – {formatDateTime(item.endsAt)}
                  </Text>
                  <View
                    style={[
                      styles.statusBadge,
                      item.status === 'published' ? styles.badgePublished : styles.badgeDraft,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusBadgeText,
                        item.status === 'published'
                          ? styles.statusBadgeTextPublished
                          : styles.statusBadgeTextDraft,
                      ]}
                    >
                      {item.status.toUpperCase()}
                    </Text>
                  </View>
                </View>

                <View style={styles.shiftDetails}>
                  {(() => {
                    const assignedNames = (item.assignedStaffIds || [])
                      .map((mId) => {
                        const found = members.find((m) => m.id === mId);
                        return found ? `${found.name || found.email} (${found.role})` : null;
                      })
                      .filter(Boolean);

                    const staffingLabel =
                      assignedNames.length > 0
                        ? assignedNames.join(', ')
                        : hasAssignments
                        ? `${item.assignedStaffIds!.length} Assigned`
                        : 'Unassigned';

                    return (
                      <Text style={styles.detailText}>
                        Staffing:{' '}
                        <Text
                          style={[
                            styles.detailValue,
                            hasAssignments && { color: colors.tealDark, fontWeight: '700' },
                          ]}
                        >
                          {staffingLabel}
                        </Text>
                      </Text>
                    );
                  })()}
                  <Text style={styles.detailText}>
                    Version: <Text style={styles.detailValue}>v{item.version}</Text>
                  </Text>
                </View>

                <View style={styles.cardActionRow}>
                  {canManageShifts && (
                    <TouchableOpacity
                      style={styles.cardActionBtn}
                      onPress={() => {
                        setSelectedShift(item);
                        setShowAssignModal(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Assign team member"
                    >
                      <Ionicons name="person-add-outline" size={14} color={colors.primaryTeal} style={{ marginRight: 4 }} />
                      <Text style={styles.cardActionBtnText}>Assign Member</Text>
                    </TouchableOpacity>
                  )}

                  {canManageShifts && isDraft && (
                    <TouchableOpacity
                      style={[styles.publishBtn, isPublishing && { opacity: 0.6 }]}
                      onPress={() => handlePublishShift(item.id)}
                      disabled={isPublishing}
                      accessibilityRole="button"
                      accessibilityLabel="Publish shift"
                    >
                      <Ionicons name="checkmark-circle-outline" size={14} color="#059669" style={{ marginRight: 4 }} />
                      <Text style={styles.publishBtnText}>Publish</Text>
                    </TouchableOpacity>
                  )}

                  {!isDraft && item.status === 'published' && (
                    <TouchableOpacity
                      style={styles.swapActionBtn}
                      onPress={() => handleOpenSwapModal(item)}
                      accessibilityRole="button"
                      accessibilityLabel="Request to swap shift"
                    >
                      <Ionicons name="repeat-outline" size={14} color="#D97706" style={{ marginRight: 4 }} />
                      <Text style={styles.swapActionBtnText}>Swap Shift</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          }}
        />
      )}

      {/* Create Shift Modal */}
      <Modal visible={showCreateModal} transparent animationType="slide" onRequestClose={() => setShowCreateModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowCreateModal(false)}
          />
          <View style={styles.modalCard} pointerEvents="auto">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create New Shift</Text>
              <TouchableOpacity
                onPress={() => setShowCreateModal(false)}
                style={styles.modalCloseBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Close create shift dialog"
              >
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.inputLabel}>Quick Shift Presets</Text>
              <View style={styles.presetRow}>
                <TouchableOpacity
                  style={styles.presetBadge}
                  onPress={() => {
                    setShiftStartHours('09:00');
                    setShiftEndHours('17:00');
                  }}
                >
                  <Text style={styles.presetBadgeText}>Day (09:00 - 17:00)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.presetBadge}
                  onPress={() => {
                    setShiftStartHours('17:00');
                    setShiftEndHours('01:00');
                  }}
                >
                  <Text style={styles.presetBadgeText}>Evening (17:00 - 01:00)</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>Days from Today</Text>
              <TextInput
                style={styles.textInput}
                keyboardType="numeric"
                value={shiftDateOffset}
                onChangeText={setShiftDateOffset}
                placeholder="1 (tomorrow)"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={styles.inputLabel}>Start Time (24h HH:MM format)</Text>
              <TextInput
                style={styles.textInput}
                value={shiftStartHours}
                onChangeText={setShiftStartHours}
                placeholder="09:00"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={styles.inputLabel}>End Time (24h HH:MM format)</Text>
              <TextInput
                style={styles.textInput}
                value={shiftEndHours}
                onChangeText={setShiftEndHours}
                placeholder="17:00"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={styles.inputLabel}>Initial Lifecycle Status</Text>
              <View style={styles.toggleRow}>
                <TouchableOpacity
                  style={[styles.toggleBtn, shiftStatus === 'published' && styles.toggleBtnActive]}
                  onPress={() => setShiftStatus('published')}
                >
                  <Text style={[styles.toggleBtnText, shiftStatus === 'published' && styles.toggleBtnTextActive]}>
                    Published (Live)
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.toggleBtn, shiftStatus === 'draft' && styles.toggleBtnActive]}
                  onPress={() => setShiftStatus('draft')}
                >
                  <Text style={[styles.toggleBtnText, shiftStatus === 'draft' && styles.toggleBtnTextActive]}>
                    Draft (Review)
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.modalSubmitBtn, creatingShift && { opacity: 0.6 }]}
                onPress={handleCreateShift}
                disabled={creatingShift}
              >
                {creatingShift ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.modalSubmitBtnText}>Create Shift</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Assign Worker Modal */}
      <Modal visible={showAssignModal} transparent animationType="fade" onRequestClose={() => setShowAssignModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setShowAssignModal(false)}
          />
          <View style={styles.modalCard} pointerEvents="auto">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Assign Team Member</Text>
              <TouchableOpacity
                onPress={() => setShowAssignModal(false)}
                style={styles.modalCloseBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Close assign member dialog"
              >
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              Select a team member to assign to this shift:
            </Text>

            {(() => {
              const userRole = (business?.role || '').toLowerCase();
              const eligibleMembers = members.filter((m) => {
                const targetRole = (m.role || '').toLowerCase();
                if (userRole === 'supervisor') {
                  return targetRole === 'staff';
                }
                if (userRole === 'gm') {
                  return ['gm', 'supervisor', 'staff'].includes(targetRole);
                }
                if (userRole === 'co_owner') {
                  return ['co_owner', 'gm', 'supervisor', 'staff'].includes(targetRole);
                }
                if (userRole === 'owner') {
                  return true;
                }
                return false;
              });

              if (members.length === 0) {
                return (
                  <Text style={styles.emptyMembersText}>
                    No team members loaded. Make sure members have been invited.
                  </Text>
                );
              }

              if (eligibleMembers.length === 0) {
                return (
                  <View style={styles.hierarchyNoticeBox}>
                    <Ionicons name="information-circle-outline" size={20} color={colors.primaryNavy} style={{ marginRight: 8 }} />
                    <Text style={styles.hierarchyNoticeText}>
                      {userRole === 'supervisor'
                        ? 'No eligible assignees found. Supervisors may only assign shifts to Staff.'
                        : 'No eligible team members found for assignment under your role.'}
                    </Text>
                  </View>
                );
              }

              return (
                <>
                  {userRole === 'supervisor' && members.length > eligibleMembers.length && (
                    <View style={styles.hierarchyNoticeBox}>
                      <Ionicons name="shield-checkmark-outline" size={16} color={colors.primaryTeal} style={{ marginRight: 6 }} />
                      <Text style={styles.hierarchyNoticeText}>
                        Showing eligible Staff members (Supervisor role hierarchy).
                      </Text>
                    </View>
                  )}
                  <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
                    {eligibleMembers.map((m) => (
                      <TouchableOpacity
                        key={m.id}
                        style={styles.memberSelectRow}
                        onPress={() => handleAssignWorker(m.id)}
                        disabled={assigning}
                      >
                        <View style={styles.memberSelectInfo}>
                          <Text style={styles.memberSelectName}>{m.name}</Text>
                          <Text style={styles.memberSelectRole}>{m.role.toUpperCase()}</Text>
                        </View>
                        <Ionicons name="add-circle-outline" size={22} color={colors.primaryTeal} />
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </>
              );
            })()}

            {assigning && <ActivityIndicator size="small" color={colors.primaryTeal} style={{ marginTop: 12 }} />}
          </View>
        </View>
      </Modal>

      {/* Shift Swap Modal (Staff) */}
      <Modal visible={showSwapModal} transparent animationType="slide" onRequestClose={handleCloseSwapModal}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={handleCloseSwapModal}
          />
          <View style={styles.modalCard} pointerEvents="auto">
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
                <Ionicons name="repeat-outline" size={20} color="#D97706" style={{ marginRight: 8 }} />
                <Text style={styles.modalTitle} numberOfLines={1}>Request Shift Swap</Text>
              </View>
              <TouchableOpacity
                onPress={handleCloseSwapModal}
                style={styles.modalCloseBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel="Close shift swap dialog"
                testID="close-swap-modal-btn"
              >
                <Ionicons name="close" size={24} color="#64748B" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {swapShift && (
                <View style={styles.swapSourceCard}>
                  <Text style={styles.swapSourceLabel}>YOUR SHIFT TO TRADE</Text>
                  <Text style={styles.swapSourceTime}>
                    {formatDateTime(swapShift.startsAt)} – {formatDateTime(swapShift.endsAt)}
                  </Text>
                </View>
              )}

              <Text style={styles.inputLabel}>Tag Colleague to Swap With *</Text>
              {members.length === 0 ? (
                <Text style={styles.emptySwapText}>Loading team members...</Text>
              ) : (
                <View style={styles.colleagueList}>
                  {members.map((m) => {
                    const isSelected = selectedCounterpartMembershipId === m.id;
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.colleagueBadge, isSelected && styles.colleagueBadgeSelected]}
                        onPress={() => {
                          if (isSelected) {
                            setSelectedCounterpartMembershipId(null);
                          } else {
                            setSelectedCounterpartMembershipId(m.id);
                          }
                        }}
                        activeOpacity={0.8}
                      >
                        <Ionicons
                          name={isSelected ? 'person' : 'person-outline'}
                          size={14}
                          color={isSelected ? colors.tealDark : '#64748B'}
                          style={{ marginRight: 6 }}
                        />
                        <Text
                          style={[
                            styles.colleagueBadgeText,
                            isSelected && styles.colleagueBadgeTextSelected,
                          ]}
                        >
                          {m.name || m.email} ({m.role.toUpperCase()})
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              <Text style={styles.inputLabel}>Choose Colleague's Shift to Swap With *</Text>
              {shifts.filter((s) => s.id !== swapShift?.id && s.status === 'published').length === 0 ? (
                <Text style={styles.emptySwapText}>
                  No other published shifts available to swap with at this time.
                </Text>
              ) : (
                shifts
                  .filter((s) => s.id !== swapShift?.id && s.status === 'published')
                  .map((otherShift) => {
                    const assignedMemberId = otherShift.assignedStaffIds?.[0];
                    const assignedMember = members.find((m) => m.id === assignedMemberId);
                    const isSelected = selectedCounterpartShiftId === otherShift.id;

                    return (
                      <TouchableOpacity
                        key={otherShift.id}
                        style={[styles.swapCandidateRow, isSelected && styles.swapCandidateRowSelected]}
                        onPress={() => {
                          if (isSelected) {
                            setSelectedCounterpartShiftId(null);
                            setSelectedCounterpartMembershipId(null);
                          } else {
                            setSelectedCounterpartShiftId(otherShift.id);
                            if (assignedMemberId) {
                              setSelectedCounterpartMembershipId(assignedMemberId);
                            }
                          }
                        }}
                        activeOpacity={0.8}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.swapCandidateTime, isSelected && styles.swapCandidateTimeSelected]}>
                            {formatDateTime(otherShift.startsAt)} – {formatDateTime(otherShift.endsAt)}
                          </Text>
                          <Text style={styles.swapCandidateMember}>
                            Assigned to: {assignedMember ? `${assignedMember.name || assignedMember.email} (${assignedMember.role})` : 'Unassigned'}
                          </Text>
                        </View>
                        <Ionicons
                          name={isSelected ? 'close-circle' : 'radio-button-off'}
                          size={22}
                          color={isSelected ? '#EF4444' : '#94A3B8'}
                        />
                      </TouchableOpacity>
                    );
                  })
              )}

              <Text style={styles.inputLabel}>Reason / Note (Optional)</Text>
              <TextInput
                style={[styles.textInput, { height: 60, textAlignVertical: 'top' }]}
                placeholder="e.g. Doctor appointment, family obligation..."
                placeholderTextColor={colors.textMuted}
                value={swapNotes}
                onChangeText={setSwapNotes}
                multiline
              />

              <View style={styles.modalActionRow}>
                <TouchableOpacity
                  style={styles.modalCancelBtn}
                  onPress={handleCloseSwapModal}
                  activeOpacity={0.8}
                  disabled={submittingSwap}
                >
                  <Text style={styles.modalCancelBtnText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modalSubmitBtn,
                    { flex: 1, marginTop: 0 },
                    (submittingSwap || !selectedCounterpartShiftId) && { opacity: 0.6 },
                  ]}
                  onPress={handleRequestSwapSubmit}
                  disabled={submittingSwap || !selectedCounterpartShiftId}
                  activeOpacity={0.8}
                >
                  {submittingSwap ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.modalSubmitBtnText}>Submit Swap</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function createStyles(colors: ColorTokens, isDark: boolean) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 16,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 10,
  },
  businessBadge: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  statusDivider: {
    width: 1,
    height: 12,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  dotOnline: {
    backgroundColor: colors.success,
  },
  dotOffline: {
    backgroundColor: colors.warning,
  },
  statusText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#78350F33' : '#FEF3C7',
    borderWidth: 1,
    borderColor: isDark ? '#92400E' : '#FDE68A',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  offlineBannerText: {
    color: isDark ? '#FCD34D' : '#92400E',
    fontSize: 12,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: colors.errorLight,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    alignItems: 'center',
  },
  errorText: {
    color: colors.errorText,
    fontSize: 12,
    marginBottom: 8,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: colors.error,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
  toolbarRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 10,
  },
  addShiftBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primaryTeal,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  addShiftBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  listContainer: {
    gap: 12,
    paddingBottom: 20,
  },
  shiftCard: {
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
  shiftHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  shiftTime: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgePublished: {
    backgroundColor: isDark ? '#064E3B33' : '#ECFDF5',
  },
  badgeDraft: {
    backgroundColor: isDark ? '#33415555' : '#F1F5F9',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusBadgeTextPublished: {
    color: isDark ? '#34D399' : '#047857',
  },
  statusBadgeTextDraft: {
    color: colors.textSecondary,
  },
  shiftDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  detailText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  detailValue: {
    fontWeight: '600',
    color: colors.textPrimary,
  },
  cardActionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  cardActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  cardActionBtnText: {
    color: colors.primaryTeal,
    fontSize: 12,
    fontWeight: '600',
  },
  publishBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.successLight,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  publishBtnText: {
    color: colors.successText,
    fontSize: 12,
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
  emptyBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIcon: {
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 20,
    maxWidth: 280,
  },
  refreshButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primaryTeal,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  refreshButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0, 0, 0, 0.75)' : 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 1,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '85%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: isDark ? 0.4 : 0.1,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 10,
  },
  modalCloseBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: isDark ? colors.surfaceSubtle : '#F1F5F9',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 30,
    elevation: 10,
  },
  modalActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    marginBottom: 6,
  },
  modalCancelBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelBtnText: {
    color: colors.textSecondary,
    fontWeight: '600',
    fontSize: 14,
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
  modalSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 12,
  },
  emptyMembersText: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    marginVertical: 20,
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
    paddingVertical: 8,
    fontSize: 14,
    color: colors.textPrimary,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
    marginBottom: 12,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleBtnActive: {
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    borderColor: colors.primaryTeal,
  },
  toggleBtnText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  toggleBtnTextActive: {
    color: colors.primaryTeal,
    fontWeight: '700',
  },
  modalSubmitBtn: {
    backgroundColor: colors.primaryTeal,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  modalSubmitBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  memberSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSubtle,
    borderRadius: 8,
    marginBottom: 8,
  },
  memberSelectInfo: {
    flex: 1,
  },
  memberSelectName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  memberSelectRole: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    marginTop: 4,
  },
  presetBadge: {
    flex: 1,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    borderWidth: 1,
    borderColor: isDark ? '#0F766E' : '#99F6E4',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  presetBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: isDark ? '#2DD4BF' : colors.tealDark,
  },
  hierarchyNoticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 10,
  },
  hierarchyNoticeText: {
    flex: 1,
    fontSize: 12,
    color: colors.textPrimary,
    fontWeight: '500',
    lineHeight: 16,
  },
  swapActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: isDark ? '#78350F33' : '#FEF3C7',
    borderWidth: 1,
    borderColor: isDark ? '#92400E' : '#FDE68A',
  },
  swapActionBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: isDark ? '#FCD34D' : '#D97706',
  },
  swapSourceCard: {
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  swapSourceLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  swapSourceTime: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  swapCandidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  swapCandidateRowSelected: {
    borderColor: colors.primaryTeal,
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
  },
  swapCandidateTime: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  swapCandidateTimeSelected: {
    color: isDark ? '#2DD4BF' : colors.tealDark,
  },
  swapCandidateMember: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
  },
  emptySwapText: {
    fontSize: 12,
    color: colors.textMuted,
    fontStyle: 'italic',
    marginVertical: 8,
  },
  colleagueList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
    marginTop: 4,
  },
  colleagueBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  colleagueBadgeSelected: {
    backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
    borderColor: colors.primaryTeal,
  },
  colleagueBadgeText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  colleagueBadgeTextSelected: {
    color: isDark ? '#2DD4BF' : colors.tealDark,
    fontWeight: '700',
  },
  });
}
