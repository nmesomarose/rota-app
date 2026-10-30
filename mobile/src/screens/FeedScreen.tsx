import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api, ApiError, addConnectivityListener } from '../services/api.ts';
import { getActiveBusiness, getUserProfile } from '../services/storage.ts';
import {
  getCachedActivityFeed,
  setCachedActivityFeed,
  getCachedInbox,
  setCachedInbox,
  CachedActivityEvent,
  CachedInboxNotification,
} from '../services/offline-cache.ts';
import { typography, spacing, radii, shadows, type ColorTokens } from '../theme/tokens.ts';
import { useTheme } from '../theme/ThemeContext.tsx';
import { queryClient, queryKeys } from '../services/query-client.ts';

export function FeedScreen() {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);

  const [activeTab, setActiveTab] = useState<'activity' | 'inbox'>('activity');

  // Activity Feed State (Cursor Pagination per FR-ACT-001..007, AC-014, AC-ACT-04)
  const [feedEvents, setFeedEvents] = useState<CachedActivityEvent[]>([]);
  const [feedCursor, setFeedCursor] = useState<string | null>(null);
  const [hasMoreFeed, setHasMoreFeed] = useState(false);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedNotice, setFeedNotice] = useState<string | null>(null);
  const [isFeedOffline, setIsFeedOffline] = useState(false);
  const isFetchingFeedRef = useRef(false);

  // Inbox Notifications State
  const [inboxItems, setInboxItems] = useState<CachedInboxNotification[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxRefreshing, setInboxRefreshing] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxNotice, setInboxNotice] = useState<string | null>(null);
  const [isInboxOffline, setIsInboxOffline] = useState(false);

  /**
   * Loads initial page of activity feed or refreshes feed.
   */
  const loadFeed = useCallback(async (isPull = false) => {
    if (isFetchingFeedRef.current) return;
    isFetchingFeedRef.current = true;

    if (isPull) setFeedRefreshing(true);
    else if (feedEvents.length === 0) setFeedLoading(true);

    const activeBiz = await getActiveBusiness();
    const u = await getUserProfile();

    if (!activeBiz || !u) {
      setFeedLoading(false);
      setFeedRefreshing(false);
      isFetchingFeedRef.current = false;
      setFeedError('No active business context found. Please select an organization.');
      return;
    }

    // Try reading cached events first if empty in memory
    if (feedEvents.length === 0) {
      const cached = await getCachedActivityFeed(activeBiz.id, u.id);
      if (cached && cached.events.length > 0) {
        setFeedEvents(cached.events);
      }
    }

    try {
      const res = await api.activity.getFeed({ limit: 20 });
      setFeedEvents(res.events);
      setFeedCursor(res.nextCursor);
      setHasMoreFeed(res.hasMore);
      setFeedError(null);
      setIsFeedOffline(false);
      setFeedNotice(null);

      // Persist to offline cache and TanStack Query cache
      queryClient.setQueryData(queryKeys.activityFeed(activeBiz.id, activeBiz.role, u.id), res.events);
      await setCachedActivityFeed(activeBiz.id, u.id, res.events);
    } catch (err: unknown) {
      const cached = await getCachedActivityFeed(activeBiz.id, u.id);
      if (cached && cached.events.length > 0) {
        setFeedEvents(cached.events);
        setIsFeedOffline(true);
        setFeedNotice('Offline mode active. Showing cached activity feed');
        setFeedError(null);
      } else {
        setIsFeedOffline(false);
        setFeedNotice(null);
        if (err instanceof ApiError) {
          setFeedError(err.message);
        } else {
          setFeedError('Unable to connect to Rota backend. Please verify your connection or offline mode.');
        }
      }
    } finally {
      setFeedLoading(false);
      setFeedRefreshing(false);
      isFetchingFeedRef.current = false;
    }
  }, [feedEvents.length]);

  /**
   * Infinite scroll: loads next cursor page (prevents duplicate requests per FR-ACT-003, AC-ACT-04).
   */
  const loadMoreFeed = useCallback(async () => {
    if (!hasMoreFeed || !feedCursor || isFetchingFeedRef.current || feedLoadingMore) return;
    isFetchingFeedRef.current = true;
    setFeedLoadingMore(true);

    try {
      const res = await api.activity.getFeed({ limit: 20, cursor: feedCursor });
      setFeedEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const newEvents = res.events.filter((e) => !existingIds.has(e.id));
        return [...prev, ...newEvents];
      });
      setFeedCursor(res.nextCursor);
      setHasMoreFeed(res.hasMore);
    } catch {
      // Keep existing list on pagination failure
    } finally {
      setFeedLoadingMore(false);
      isFetchingFeedRef.current = false;
    }
  }, [hasMoreFeed, feedCursor, feedLoadingMore]);

  /**
   * Loads inbox notifications
   */
  const loadInbox = useCallback(async (isPull = false) => {
    if (isPull) setInboxRefreshing(true);
    else if (inboxItems.length === 0) setInboxLoading(true);

    const activeBiz = await getActiveBusiness();
    const u = await getUserProfile();

    if (!activeBiz || !u) {
      setInboxLoading(false);
      setInboxRefreshing(false);
      setInboxError('No active business context found.');
      return;
    }

    if (inboxItems.length === 0) {
      const cached = await getCachedInbox(activeBiz.id, u.id);
      if (cached && cached.notifications.length > 0) {
        setInboxItems(cached.notifications);
      }
    }

    try {
      const data = await api.notifications.getInbox();
      const items = data.inbox as CachedInboxNotification[];
      setInboxItems(items);
      setInboxError(null);
      setIsInboxOffline(false);
      setInboxNotice(null);

      queryClient.setQueryData(queryKeys.inbox(activeBiz.id, u.id), items);
      await setCachedInbox(activeBiz.id, u.id, items);
    } catch (err: unknown) {
      const cached = await getCachedInbox(activeBiz.id, u.id);
      if (cached && cached.notifications.length > 0) {
        setInboxItems(cached.notifications);
        setIsInboxOffline(true);
        setInboxNotice('Offline mode active. Showing cached notifications');
        setInboxError(null);
      } else {
        setIsInboxOffline(false);
        setInboxNotice(null);
        if (err instanceof ApiError) {
          setInboxError(err.message);
        } else {
          setInboxError('Unable to connect to Rota backend. Please verify your connection or offline mode.');
        }
      }
    } finally {
      setInboxLoading(false);
      setInboxRefreshing(false);
    }
  }, [inboxItems.length]);

  // Initial load
  useEffect(() => {
    loadFeed();
    loadInbox();
  }, [loadFeed, loadInbox]);

  // Auto-refetch when tab gains focus if there is an error or offline state
  useFocusEffect(
    useCallback(() => {
      if (feedEvents.length === 0 || feedError || isFeedOffline) {
        loadFeed();
      }
      if (inboxItems.length === 0 || inboxError || isInboxOffline) {
        loadInbox();
      }
    }, [feedEvents.length, feedError, isFeedOffline, inboxItems.length, inboxError, isInboxOffline, loadFeed, loadInbox])
  );

  // Auto-refetch when backend connectivity returns
  useEffect(() => {
    const unsub = addConnectivityListener((isOnline) => {
      if (isOnline) {
        loadFeed();
        loadInbox();
      }
    });
    return unsub;
  }, [loadFeed, loadInbox]);

  const handleMarkAsRead = async (id: string) => {
    const prevItems = [...inboxItems];
    // Optimistic UI update
    setInboxItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, read_at: new Date().toISOString() } : item
      )
    );
    try {
      await api.notifications.markAsRead(id);
      const activeBiz = await getActiveBusiness();
      const u = await getUserProfile();
      if (activeBiz && u) {
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox(activeBiz.id, u.id) });
      }
    } catch {
      // Rollback upon server error
      setInboxItems(prevItems);
    }
  };

  const formatTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;

      const now = new Date();
      const isToday =
        d.getDate() === now.getDate() &&
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear();

      const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

      if (isToday) {
        return `Today, ${timeStr}`;
      }

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const isYesterday =
        d.getDate() === yesterday.getDate() &&
        d.getMonth() === yesterday.getMonth() &&
        d.getFullYear() === yesterday.getFullYear();

      if (isYesterday) {
        return `Yesterday, ${timeStr}`;
      }

      const monthStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `${monthStr}, ${timeStr}`;
    } catch {
      return isoString;
    }
  };

  const getVisibilityTheme = (vClass: string) => {
    switch (vClass) {
      case 'swap':
        return { bg: colors.lightTeal, text: colors.tealDark };
      case 'attendance':
        return { bg: colors.successLight, text: colors.successText };
      case 'schedule':
        return { bg: colors.infoLight, text: colors.primaryNavy };
      case 'security':
        return { bg: colors.errorLight, text: colors.errorText };
      case 'billing':
        return { bg: colors.warningLight, text: colors.warningText };
      default:
        return { bg: colors.surfaceSelected, text: colors.textSecondary };
    }
  };

  const formatEventType = (type: string, fallback?: string): string => {
    const raw = (type || fallback || '').trim();
    const lower = raw.toLowerCase();

    switch (lower) {
      case 'schedule.shift_assigned':
      case 'shift_assigned':
        return 'Shift Assigned';
      case 'schedule.published':
      case 'schedule_published':
        return 'Schedule Published';
      case 'schedule.shift_updated':
      case 'shift_updated':
        return 'Shift Updated';
      case 'schedule.shift_cancelled':
      case 'shift_cancelled':
        return 'Shift Cancelled';
      case 'swap.requested':
      case 'swap_requested':
        return 'Shift Swap Requested';
      case 'swap.peer_accepted':
      case 'swap_peer_accepted':
        return 'Swap Awaiting Approval';
      case 'swap.peer_rejected':
      case 'swap_peer_rejected':
        return 'Swap Declined by Peer';
      case 'swap.approved':
      case 'swap_approved':
        return 'Shift Swap Approved';
      case 'swap.rejected':
      case 'swap_rejected':
        return 'Shift Swap Rejected';
      case 'swap.cancelled':
      case 'swap_cancelled':
        return 'Shift Swap Cancelled';
      case 'attendance.recorded':
      case 'attendance_recorded':
        return 'Attendance Logged';
      case 'attendance.clock_in':
      case 'clock_in':
        return 'Clock In Recorded';
      case 'attendance.clock_out':
      case 'clock_out':
        return 'Clock Out Recorded';
      case 'membership.invited':
      case 'member_invited':
        return 'Team Invitation Sent';
      case 'membership.role_changed':
      case 'role_changed':
        return 'Member Role Updated';
      case 'membership.removed':
      case 'member_removed':
        return 'Member Removed';
      case 'business.ownership_transferred':
      case 'ownership_transferred':
        return 'Ownership Transferred';
      case 'billing.payment_succeeded':
      case 'payment_succeeded':
        return 'Subscription Paid';
      case 'billing.subscription_updated':
      case 'subscription_updated':
        return 'Plan Updated';
      case 'billing.invoice_created':
      case 'invoice_created':
        return 'Invoice Ready';
      default: {
        const stripped = raw.includes('.') ? raw.split('.').slice(1).join(' ') : raw;
        const words = stripped.replace(/_/g, ' ').split(/\s+/).filter(Boolean);
        return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Activity Event';
      }
    }
  };

  const getStatusBadgeStyle = (status: any) => {
    const s = String(status || '').toLowerCase().trim();
    if (s === 'approved' || s === 'completed' || s === 'active' || s === 'present') {
      return { bg: colors.successLight, text: colors.successText, label: s.toUpperCase() };
    }
    if (s === 'pending' || s === 'awaiting' || s === 'late') {
      return { bg: colors.warningLight, text: colors.warningText, label: s.toUpperCase() };
    }
    if (s === 'peer_accepted') {
      return { bg: colors.lightTeal, text: colors.tealDark, label: 'AWAITING APPROVAL' };
    }
    if (s === 'peer_rejected' || s === 'rejected' || s === 'absent' || s === 'cancelled') {
      return { bg: colors.errorLight, text: colors.errorText, label: s.toUpperCase() };
    }
    return { bg: colors.surfaceSelected, text: colors.textSecondary, label: s.toUpperCase() };
  };

  const formatCategoryBadge = (cat: string) => {
    const raw = String(cat || '').toUpperCase();
    if (raw === 'SCHEDULE') return 'SCHEDULE';
    if (raw === 'SWAP') return 'SWAP';
    if (raw === 'ATTENDANCE') return 'ATTENDANCE';
    if (raw === 'BILLING') return 'BILLING';
    if (raw === 'SECURITY') return 'SECURITY';
    if (raw === 'MEMBERSHIP') return 'TEAM';
    return raw.slice(0, 12);
  };

  const renderActivityItem = ({ item }: { item: CachedActivityEvent }) => {
    const theme = getVisibilityTheme(item.visibility_class);
    const p = (item.payload || {}) as Record<string, any>;
    const typeLower = (item.type || '').toLowerCase();
    const visLower = (item.visibility_class || '').toLowerCase();

    // Check if event relates to shifts or swaps
    const isSwap =
      visLower === 'swap' ||
      typeLower.includes('swap') ||
      Boolean(p.swap_id || p.swapId || p.counterpart || p.counterpart_name);

    const isShift =
      !isSwap &&
      (visLower === 'schedule' ||
        typeLower.includes('shift') ||
        Boolean(p.shift_id || p.shiftId || p.start_time || p.startTime || p.start));

    const isAttendance = !isSwap && !isShift && (visLower === 'attendance' || typeLower.includes('attendance'));
    const isBilling = !isSwap && !isShift && (visLower === 'billing' || typeLower.includes('billing') || typeLower.includes('payment'));

    const formatClock = (val: any) => {
      if (!val) return '';
      const str = String(val).trim();
      if (str.includes('T')) {
        try {
          const d = new Date(str);
          if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          }
        } catch {
          // fallback
        }
      }
      const match = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (match) {
        let h = parseInt(match[1], 10);
        const m = match[2];
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${h}:${m} ${ampm}`;
      }
      return str;
    };

    const formatDate = (val: any) => {
      if (!val) return '';
      const str = String(val).trim();
      try {
        const d = new Date(str);
        if (!isNaN(d.getTime())) {
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }
      } catch {
        // fallback
      }
      return str.split('T')[0];
    };

    const headline = formatEventType(item.type, item.visibility_class);
    const statusStyle = p.status ? getStatusBadgeStyle(p.status) : null;
    const shiftDate = formatDate(p.date || p.shift_date || p.shiftDate || p.start_time || item.created_at);
    const startClock = formatClock(p.start_time || p.startTime || p.start);
    const endClock = formatClock(p.end_time || p.endTime || p.end);

    return (
      <View style={styles.card}>
        {/* Top Metadata Row: Badge + Status + Timestamp */}
        <View style={styles.cardHeader}>
          <View style={styles.badgeGroup}>
            <View style={[styles.visBadge, { backgroundColor: theme.bg }]}>
              <Text style={[styles.visBadgeText, { color: theme.text }]} numberOfLines={1}>
                {formatCategoryBadge(item.visibility_class)}
              </Text>
            </View>
            {statusStyle && (
              <View style={[styles.inlineStatusBadge, { backgroundColor: statusStyle.bg }]}>
                <Text style={[styles.inlineStatusText, { color: statusStyle.text }]} numberOfLines={1}>
                  {statusStyle.label}
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.timeText} numberOfLines={1}>{formatTime(item.created_at)}</Text>
        </View>

        {/* Clear, Prominent Action Headline */}
        <Text style={styles.eventHeadline} numberOfLines={2}>
          {headline}
        </Text>

        {/* Structured Context Details */}
        <View style={styles.cardBody}>
          {isSwap ? (
            <View style={styles.eventBox}>
              {(p.requester_name || p.requester || p.counterpart_name || p.counterpart) && (
                <View style={styles.membersRow}>
                  <Ionicons name="people-outline" size={14} color={colors.primaryTeal} style={{ marginRight: 6 }} />
                  <Text style={styles.eventMembers} numberOfLines={1} ellipsizeMode="tail">
                    {p.requester_name || p.requester || 'User'} ⇄ {p.counterpart_name || p.counterpart || 'Colleague'}
                  </Text>
                </View>
              )}
              <View style={styles.metaRow}>
                {Boolean(shiftDate) && (
                  <View style={styles.metaItem}>
                    <Ionicons name="calendar-outline" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
                    <Text style={styles.metaText}>{shiftDate}</Text>
                  </View>
                )}
                {Boolean(startClock && endClock) && (
                  <>
                    <Text style={styles.metaDivider}>•</Text>
                    <View style={styles.metaItem}>
                      <Ionicons name="time-outline" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
                      <Text style={styles.metaText}>{startClock} - {endClock}</Text>
                    </View>
                  </>
                )}
              </View>
              {Boolean(p.notes) && (
                <Text style={styles.eventNotes} numberOfLines={2}>"{p.notes}"</Text>
              )}
            </View>
          ) : isShift ? (
            <View style={styles.eventBox}>
              <View style={styles.eventSubHeader}>
                <Ionicons name="calendar-outline" size={14} color={colors.primaryNavy} style={{ marginRight: 6 }} />
                <Text style={styles.eventSubTitle} numberOfLines={1} ellipsizeMode="tail">
                  {p.department || p.department_name || p.role ? `${p.department || p.department_name || p.role} Shift` : 'Scheduled Shift'}
                </Text>
              </View>
              <View style={styles.metaRow}>
                {Boolean(shiftDate) && (
                  <View style={styles.metaItem}>
                    <Ionicons name="calendar-outline" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
                    <Text style={styles.metaText}>{shiftDate}</Text>
                  </View>
                )}
                {Boolean(startClock || endClock) && (
                  <>
                    <Text style={styles.metaDivider}>•</Text>
                    <View style={styles.metaItem}>
                      <Ionicons name="time-outline" size={13} color={colors.textSecondary} style={{ marginRight: 4 }} />
                      <Text style={styles.metaText}>
                        {startClock || 'Scheduled'} - {endClock || 'Scheduled'}
                      </Text>
                    </View>
                  </>
                )}
              </View>
              {Boolean(p.notes) && (
                <Text style={styles.eventNotes} numberOfLines={2}>"{p.notes}"</Text>
              )}
            </View>
          ) : isAttendance ? (
            <View style={styles.eventBox}>
              <View style={styles.eventSubHeader}>
                <Ionicons name="time-outline" size={14} color={colors.tealDark} style={{ marginRight: 6 }} />
                <Text style={styles.eventSubTitle} numberOfLines={1}>
                  Status: {p.state ? String(p.state).toUpperCase() : 'Logged'}
                </Text>
              </View>
              {Boolean(p.note) && (
                <Text style={styles.eventNotes} numberOfLines={2}>"{p.note}"</Text>
              )}
            </View>
          ) : isBilling ? (
            <View style={styles.eventBox}>
              <View style={styles.eventSubHeader}>
                <Ionicons name="card-outline" size={14} color={colors.primaryNavy} style={{ marginRight: 6 }} />
                <Text style={styles.eventSubTitle} numberOfLines={1}>
                  {p.plan ? `${String(p.plan).toUpperCase()} Plan` : 'Billing Update'}
                </Text>
              </View>
              {Boolean(p.message || p.description) && (
                <Text style={styles.eventSimpleSummary} numberOfLines={4}>
                  {p.message || p.description}
                </Text>
              )}
            </View>
          ) : (
            <Text style={styles.eventSimpleSummary} numberOfLines={4}>
              {p.description || p.message || p.title || headline}
            </Text>
          )}
        </View>
      </View>
    );
  };

  const renderInboxItem = ({ item }: { item: CachedInboxNotification }) => (
    <TouchableOpacity
      style={[styles.card, !item.read_at && styles.unreadCard]}
      onPress={() => !item.read_at && handleMarkAsRead(item.id)}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={styles.badgeGroup}>
          {item.urgent && (
            <View style={styles.urgentBadge}>
              <Text style={styles.urgentBadgeText}>URGENT</Text>
            </View>
          )}
          <View style={styles.inboxCatBadge}>
            <Text style={styles.inboxCatText}>{formatCategoryBadge(item.category)}</Text>
          </View>
        </View>
        <Text style={styles.timeText} numberOfLines={1}>{formatTime(item.created_at)}</Text>
      </View>

      <Text style={styles.itemTitle} numberOfLines={2}>{item.title}</Text>
      <Text style={styles.itemBody}>{item.body}</Text>

      {!item.read_at && (
        <View style={styles.unreadIndicator}>
          <View style={styles.unreadDot} />
          <Text style={styles.unreadText}>Tap to mark as read</Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Sleek Segmented Control */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'activity' && styles.activeTabButton]}
          onPress={() => setActiveTab('activity')}
          activeOpacity={0.8}
        >
          <Text style={[styles.tabButtonText, activeTab === 'activity' && styles.activeTabText]}>
            Activity Feed
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'inbox' && styles.activeTabButton]}
          onPress={() => setActiveTab('inbox')}
          activeOpacity={0.8}
        >
          <Text style={[styles.tabButtonText, activeTab === 'inbox' && styles.activeTabText]}>
            Inbox Notifications
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'activity' ? (
        <View style={styles.feedWrapper}>
          {feedNotice && (
            <View style={styles.noticeBanner}>
              <Ionicons name="cloud-offline-outline" size={18} color={colors.primaryTeal} />
              <Text style={styles.noticeText}>{feedNotice}</Text>
            </View>
          )}

          {feedError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{feedError}</Text>
            </View>
          )}

          {feedLoading && feedEvents.length === 0 ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={colors.primaryTeal} />
              <Text style={styles.loadingText}>Loading activity feed...</Text>
            </View>
          ) : feedEvents.length === 0 ? (
            <ScrollView
              contentContainerStyle={styles.emptyScrollContainer}
              refreshControl={
                <RefreshControl
                  refreshing={feedRefreshing}
                  onRefresh={() => loadFeed(true)}
                  tintColor={colors.primaryTeal}
                  colors={[colors.primaryTeal]}
                />
              }
            >
              <Ionicons
                name={feedError ? 'alert-circle-outline' : 'list-outline'}
                size={52}
                color={feedError ? '#EF4444' : '#94A3B8'}
                style={{ marginBottom: 12 }}
              />
              <Text style={styles.emptyTitle}>
                {feedError ? 'Connection Issue' : 'No Activity Yet'}
              </Text>
              <Text style={styles.emptyText}>
                {feedError
                  ? 'Could not reach Rota backend. Pull down or tap below to retry.'
                  : 'Shift changes, attendance, and swaps will appear here.'}
              </Text>
              {feedError ? (
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={() => loadFeed(true)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.retryButtonText}>Retry Connection</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          ) : (
            <FlatList
              data={feedEvents}
              keyExtractor={(item) => item.id}
              renderItem={renderActivityItem}
              contentContainerStyle={styles.listContent}
              refreshControl={
                <RefreshControl
                  refreshing={feedRefreshing}
                  onRefresh={() => loadFeed(true)}
                  tintColor={colors.primaryTeal}
                  colors={[colors.primaryTeal]}
                />
              }
              onEndReached={loadMoreFeed}
              onEndReachedThreshold={0.4}
              ListFooterComponent={
                feedLoadingMore ? (
                  <View style={styles.footerLoader}>
                    <ActivityIndicator size="small" color={colors.primaryTeal} />
                    <Text style={styles.loadingMoreText}>Loading more events...</Text>
                  </View>
                ) : !hasMoreFeed && feedEvents.length > 0 ? (
                  <View style={styles.endOfListContainer}>
                    <Text style={styles.endOfListText}>All activity loaded</Text>
                  </View>
                ) : null
              }
            />
          )}
        </View>
      ) : (
        <View style={styles.feedWrapper}>
          {inboxNotice && (
            <View style={styles.noticeBanner}>
              <Ionicons name="cloud-offline-outline" size={18} color={colors.primaryTeal} />
              <Text style={styles.noticeText}>{inboxNotice}</Text>
            </View>
          )}

          {inboxError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{inboxError}</Text>
            </View>
          )}

          {inboxLoading && inboxItems.length === 0 ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={colors.primaryTeal} />
              <Text style={styles.loadingText}>Loading notifications...</Text>
            </View>
          ) : inboxItems.length === 0 ? (
            <ScrollView
              contentContainerStyle={styles.emptyScrollContainer}
              refreshControl={
                <RefreshControl
                  refreshing={inboxRefreshing}
                  onRefresh={() => loadInbox(true)}
                  tintColor={colors.primaryTeal}
                  colors={[colors.primaryTeal]}
                />
              }
            >
              <Ionicons
                name={inboxError ? 'alert-circle-outline' : 'mail-unread-outline'}
                size={52}
                color={inboxError ? '#EF4444' : '#94A3B8'}
                style={{ marginBottom: 12 }}
              />
              <Text style={styles.emptyTitle}>
                {inboxError ? 'Connection Issue' : 'Inbox Zero'}
              </Text>
              <Text style={styles.emptyText}>
                {inboxError
                  ? 'Could not reach Rota backend. Pull down or tap below to retry.'
                  : 'All caught up. Important schedule announcements and alerts appear here.'}
              </Text>
              {inboxError ? (
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={() => loadInbox(true)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.retryButtonText}>Retry Connection</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          ) : (
            <FlatList
              data={inboxItems}
              keyExtractor={(item) => item.id}
              renderItem={renderInboxItem}
              contentContainerStyle={styles.listContent}
              refreshControl={
                <RefreshControl
                  refreshing={inboxRefreshing}
                  onRefresh={() => loadInbox(true)}
                  tintColor={colors.primaryTeal}
                  colors={[colors.primaryTeal]}
                />
              }
            />
          )}
        </View>
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
    tabContainer: {
      flexDirection: 'row',
      backgroundColor: isDark ? colors.surfaceSubtle : '#E2E8F0',
      borderRadius: 10,
      padding: 3,
      marginHorizontal: 16,
      marginTop: 12,
      marginBottom: 8,
    },
    tabButton: {
      flex: 1,
      paddingVertical: 8,
      alignItems: 'center',
      borderRadius: 8,
    },
    activeTabButton: {
      backgroundColor: colors.surface,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: isDark ? 0.3 : 0.08,
      shadowRadius: 2,
      elevation: 2,
    },
    tabButtonText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    activeTabText: {
      color: colors.textPrimary,
      fontWeight: '700',
    },
    feedWrapper: {
      flex: 1,
    },
    listContent: {
      padding: 16,
      paddingTop: 8,
      gap: 12,
    },
    card: {
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
    unreadCard: {
      borderLeftWidth: 4,
      borderLeftColor: colors.primaryTeal,
      backgroundColor: isDark ? '#0F766E15' : colors.surfaceSubtle,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 6,
    },
    badgeGroup: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexShrink: 1,
      marginRight: 8,
    },
    visBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2.5,
      borderRadius: 5,
      alignSelf: 'flex-start',
    },
    visBadgeText: {
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.4,
    },
    inlineStatusBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    inlineStatusText: {
      fontSize: 9.5,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    timeText: {
      fontSize: 11,
      fontWeight: '500',
      color: colors.textSecondary,
      flexShrink: 0,
    },
    eventHeadline: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.textPrimary,
      lineHeight: 20,
      marginBottom: 8,
      flexShrink: 1,
    },
    cardBody: {
      marginTop: 0,
    },
    eventBox: {
      backgroundColor: colors.surfaceSubtle,
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 4,
    },
    eventSubHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    eventSubTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
      flexShrink: 1,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 2,
    },
    metaItem: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    metaText: {
      fontSize: 12,
      color: colors.textSecondary,
      fontWeight: '500',
    },
    metaDivider: {
      fontSize: 12,
      color: colors.textMuted,
      marginHorizontal: 1,
    },
    eventMembers: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.primaryTeal,
      flexShrink: 1,
    },
    membersRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 3,
    },
    eventNotes: {
      fontSize: 12,
      color: colors.textMuted,
      fontStyle: 'italic',
      marginTop: 3,
      lineHeight: 16,
    },
    eventSimpleSummary: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 18,
      flexShrink: 1,
    },
    payloadSummary: {
      fontSize: 12,
      color: colors.textPrimary,
      fontFamily: 'monospace',
      backgroundColor: colors.surfaceSelected,
      padding: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardEmptyDesc: {
      fontSize: 13,
      color: colors.textSecondary,
    },
    itemTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.textPrimary,
      marginBottom: 4,
      lineHeight: 20,
      flexShrink: 1,
    },
    itemBody: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 18,
      flexShrink: 1,
    },
    urgentBadge: {
      backgroundColor: colors.error,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    urgentBadgeText: {
      color: colors.white,
      fontSize: 10,
      fontWeight: '700',
    },
    inboxCatBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: isDark ? '#0F766E25' : colors.lightTeal,
    },
    inboxCatText: {
      fontSize: 10,
      fontWeight: '700',
      color: isDark ? '#2DD4BF' : colors.tealDark,
      letterSpacing: 0.3,
    },
    unreadIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 10,
      gap: 6,
    },
    unreadDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.primaryTeal,
    },
    unreadText: {
      fontSize: 11,
      color: colors.primaryTeal,
      fontWeight: '600',
    },
    footerLoader: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 16,
      gap: 8,
    },
    loadingMoreText: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    endOfListContainer: {
      alignItems: 'center',
      paddingVertical: 16,
    },
    endOfListText: {
      fontSize: 12,
      color: colors.textSecondary,
    },
    centerBox: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyScrollContainer: {
      flexGrow: 1,
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
    retryButton: {
      marginTop: 16,
      backgroundColor: colors.primaryTeal,
      paddingVertical: 10,
      paddingHorizontal: 20,
      borderRadius: 8,
      shadowColor: colors.primaryTeal,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 4,
      elevation: 3,
    },
    retryButtonText: {
      color: '#FFFFFF',
      fontSize: 14,
      fontWeight: '600',
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
    noticeBanner: {
      backgroundColor: isDark ? '#0F766E33' : colors.lightTeal,
      borderColor: isDark ? '#0F766E' : '#99F6E4',
      borderWidth: 1,
      padding: 12,
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 0,
      borderRadius: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    noticeText: {
      color: isDark ? '#2DD4BF' : colors.tealDark,
      fontSize: 13,
      fontWeight: '600',
      flex: 1,
    },
  });
}
