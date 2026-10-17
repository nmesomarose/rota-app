import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { api, ApiError } from '../services/api.ts';

interface ActivityEvent {
  id: string;
  business_id: string;
  created_at: string;
  type: string;
  branch_id: string | null;
  department_id: string | null;
  actor_membership_id: string | null;
  subject_membership_id: string | null;
  visibility_class: string;
  payload: Record<string, unknown>;
}

interface InboxNotification {
  id: string;
  category: string;
  title: string;
  body: string;
  payload: unknown;
  mandatory: boolean;
  urgent: boolean;
  read_at: string | null;
  created_at: string;
}

export function FeedScreen() {
  const [activeTab, setActiveTab] = useState<'activity' | 'inbox'>('activity');

  // Activity Feed State (Cursor Pagination per FR-ACT-001..007, AC-014, AC-ACT-04)
  const [feedEvents, setFeedEvents] = useState<ActivityEvent[]>([]);
  const [feedCursor, setFeedCursor] = useState<string | null>(null);
  const [hasMoreFeed, setHasMoreFeed] = useState(false);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const isFetchingFeedRef = useRef(false);

  // Inbox Notifications State
  const [inboxItems, setInboxItems] = useState<InboxNotification[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxRefreshing, setInboxRefreshing] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  /**
   * Loads initial page of activity feed or refreshes feed.
   */
  const loadFeed = useCallback(async (isPull = false) => {
    if (isFetchingFeedRef.current) return;
    isFetchingFeedRef.current = true;

    if (isPull) setFeedRefreshing(true);
    else setFeedLoading(true);
    setFeedError(null);

    try {
      const res = await api.activity.getFeed({ limit: 20 });
      setFeedEvents(res.events);
      setFeedCursor(res.nextCursor);
      setHasMoreFeed(res.hasMore);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setFeedError(err.message);
      } else {
        setFeedError('Unable to connect to activity feed. Check network.');
      }
    } finally {
      setFeedLoading(false);
      setFeedRefreshing(false);
      isFetchingFeedRef.current = false;
    }
  }, []);

  /**
   * Infinite scroll: loads next cursor page (prevents duplicate requests per FR-ACT-003, AC-ACT-04).
   */
  const loadMoreFeed = useCallback(async () => {
    if (!hasMoreFeed || !feedCursor || isFetchingFeedRef.current || feedLoadingMore) return;
    isFetchingFeedRef.current = true;
    setFeedLoadingMore(true);

    try {
      const res = await api.activity.getFeed({ limit: 20, cursor: feedCursor });
      // Deduplicate by ID
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
    else setInboxLoading(true);
    setInboxError(null);

    try {
      const data = await api.notifications.getInbox();
      setInboxItems(data.inbox as InboxNotification[]);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setInboxError(err.message);
      } else {
        setInboxError('Failed to load notifications. Please check your connection.');
      }
    } finally {
      setInboxLoading(false);
      setInboxRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadFeed();
    loadInbox();
  }, [loadFeed, loadInbox]);

  const handleMarkAsRead = async (id: string) => {
    try {
      await api.notifications.markAsRead(id);
      setInboxItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, read_at: new Date().toISOString() } : item
        )
      );
    } catch {
      // Ignore background failure
    }
  };

  const formatTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const getVisibilityBadgeColor = (vClass: string) => {
    switch (vClass) {
      case 'swap':
        return '#38BDF8';
      case 'attendance':
        return '#34D399';
      case 'schedule':
        return '#A78BFA';
      case 'security':
        return '#F87171';
      case 'billing':
        return '#FBBF24';
      default:
        return '#94A3B8';
    }
  };

  const renderActivityItem = ({ item }: { item: ActivityEvent }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.badgeRow}>
          <View
            style={[
              styles.visBadge,
              { backgroundColor: `${getVisibilityBadgeColor(item.visibility_class)}20` },
            ]}
          >
            <Text
              style={[
                styles.visBadgeText,
                { color: getVisibilityBadgeColor(item.visibility_class) },
              ]}
            >
              {item.visibility_class.toUpperCase()}
            </Text>
          </View>
          <Text style={styles.typeText}>{item.type}</Text>
        </View>
        <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>
      </View>

      <View style={styles.cardBody}>
        {item.payload && Object.keys(item.payload).length > 0 ? (
          <Text style={styles.payloadSummary}>
            {JSON.stringify(item.payload, null, 2)}
          </Text>
        ) : (
          <Text style={styles.cardEmptyDesc}>Activity recorded</Text>
        )}
      </View>
    </View>
  );

  const renderInboxItem = ({ item }: { item: InboxNotification }) => (
    <TouchableOpacity
      style={[styles.card, !item.read_at && styles.unreadCard]}
      onPress={() => !item.read_at && handleMarkAsRead(item.id)}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <View style={styles.badgeRow}>
          {item.urgent && (
            <View style={styles.urgentBadge}>
              <Text style={styles.urgentBadgeText}>URGENT</Text>
            </View>
          )}
          <Text style={styles.categoryBadge}>{item.category.toUpperCase()}</Text>
        </View>
        <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>
      </View>

      <Text style={styles.itemTitle}>{item.title}</Text>
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
      <View style={styles.header}>
        <Text style={styles.title}>Activity & Inbox</Text>
        <Text style={styles.meta}>Real-time updates, shift swaps, and audit feeds</Text>

        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'activity' && styles.activeTabButton]}
            onPress={() => setActiveTab('activity')}
          >
            <Text
              style={[styles.tabButtonText, activeTab === 'activity' && styles.activeTabText]}
            >
              Activity Feed
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabButton, activeTab === 'inbox' && styles.activeTabButton]}
            onPress={() => setActiveTab('inbox')}
          >
            <Text
              style={[styles.tabButtonText, activeTab === 'inbox' && styles.activeTabText]}
            >
              Inbox Notifications
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {activeTab === 'activity' ? (
        <View style={styles.feedWrapper}>
          {feedError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{feedError}</Text>
            </View>
          )}

          {feedLoading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color="#38BDF8" />
              <Text style={styles.loadingText}>Loading activity feed...</Text>
            </View>
          ) : feedEvents.length === 0 ? (
            <View style={styles.centerBox}>
              <Text style={styles.emptyIcon}>📋</Text>
              <Text style={styles.emptyTitle}>No Activity Yet</Text>
              <Text style={styles.emptyText}>
                Shift changes, attendance, and swaps will appear here.
              </Text>
            </View>
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
                  tintColor="#38BDF8"
                />
              }
              onEndReached={loadMoreFeed}
              onEndReachedThreshold={0.4}
              ListFooterComponent={
                feedLoadingMore ? (
                  <View style={styles.footerLoader}>
                    <ActivityIndicator size="small" color="#38BDF8" />
                    <Text style={styles.loadingMoreText}>Loading more events...</Text>
                  </View>
                ) : !hasMoreFeed && feedEvents.length > 0 ? (
                  <View style={styles.endOfListContainer}>
                    <Text style={styles.endOfListText}>End of activity feed</Text>
                  </View>
                ) : undefined
              }
            />
          )}
        </View>
      ) : (
        <View style={styles.feedWrapper}>
          {inboxError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{inboxError}</Text>
            </View>
          )}

          {inboxLoading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color="#38BDF8" />
              <Text style={styles.loadingText}>Loading notifications...</Text>
            </View>
          ) : inboxItems.length === 0 ? (
            <View style={styles.centerBox}>
              <Text style={styles.emptyIcon}>🔔</Text>
              <Text style={styles.emptyTitle}>All Caught Up</Text>
              <Text style={styles.emptyText}>You have no unread notifications.</Text>
            </View>
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
                  tintColor="#38BDF8"
                />
              }
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    padding: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginTop: 16,
    marginBottom: 4,
  },
  meta: {
    fontSize: 14,
    color: '#94A3B8',
    marginBottom: 16,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    borderRadius: 8,
    padding: 4,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  activeTabButton: {
    backgroundColor: '#38BDF8',
  },
  tabButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94A3B8',
  },
  activeTabText: {
    color: '#0F172A',
  },
  feedWrapper: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  unreadCard: {
    borderColor: '#38BDF8',
    backgroundColor: '#1E293B',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  visBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  visBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  typeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#CBD5E1',
  },
  timeText: {
    fontSize: 12,
    color: '#64748B',
  },
  cardBody: {
    marginTop: 4,
  },
  payloadSummary: {
    fontSize: 12,
    color: '#94A3B8',
    fontFamily: 'monospace',
    backgroundColor: '#0F172A',
    padding: 8,
    borderRadius: 6,
  },
  cardEmptyDesc: {
    fontSize: 14,
    color: '#94A3B8',
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginBottom: 4,
  },
  itemBody: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 18,
  },
  urgentBadge: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  urgentBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
  categoryBadge: {
    fontSize: 11,
    color: '#38BDF8',
    fontWeight: '600',
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
    backgroundColor: '#38BDF8',
  },
  unreadText: {
    fontSize: 11,
    color: '#38BDF8',
  },
  footerLoader: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  loadingMoreText: {
    fontSize: 13,
    color: '#94A3B8',
  },
  endOfListContainer: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  endOfListText: {
    fontSize: 12,
    color: '#64748B',
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    color: '#94A3B8',
    marginTop: 12,
    fontSize: 14,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#F8FAFC',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
  },
  errorBanner: {
    backgroundColor: '#EF444420',
    borderColor: '#EF4444',
    borderWidth: 1,
    padding: 12,
    margin: 16,
    marginBottom: 0,
    borderRadius: 8,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
    textAlign: 'center',
  },
});
