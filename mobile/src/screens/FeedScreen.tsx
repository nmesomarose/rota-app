import React, { useEffect, useState, useCallback } from 'react';
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
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadInbox = useCallback(async (isPull = false) => {
    if (isPull) setRefreshing(true);
    else setLoading(true);
    setErrorMessage(null);

    try {
      const data = await api.notifications.getInbox();
      setItems(data.inbox as InboxNotification[]);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load notifications. Please check your connection.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const handleMarkAsRead = async (id: string) => {
    try {
      await api.notifications.markAsRead(id);
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, read_at: new Date().toISOString() } : item
        )
      );
    } catch {
      // Ignore background read failure
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

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Inbox & Activity</Text>
        <Text style={styles.meta}>Schedule updates, shift changes, and announcements</Text>
      </View>

      {errorMessage && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#38BDF8" />
          <Text style={styles.loadingText}>Loading notifications...</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>Inbox Zero</Text>
          <Text style={styles.emptySubtitle}>You have no notifications or schedule alerts.</Text>
          <TouchableOpacity style={styles.refreshButton} onPress={() => loadInbox()}>
            <Text style={styles.refreshButtonText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadInbox(true)}
              tintColor="#38BDF8"
              colors={['#38BDF8']}
            />
          }
          contentContainerStyle={styles.listContainer}
          renderItem={({ item }) => {
            const isRead = !!item.read_at;
            return (
              <TouchableOpacity
                style={[
                  styles.notificationCard,
                  item.urgent && styles.cardUrgent,
                  !isRead && styles.cardUnread,
                ]}
                onPress={() => !isRead && handleMarkAsRead(item.id)}
                activeOpacity={0.8}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.titleRow}>
                    {item.urgent && (
                      <View style={styles.urgentBadge}>
                        <Text style={styles.urgentText}>URGENT</Text>
                      </View>
                    )}
                    <Text style={[styles.itemTitle, !isRead && styles.titleBold]}>
                      {item.title}
                    </Text>
                  </View>
                  <Text style={styles.itemTime}>{formatTime(item.created_at)}</Text>
                </View>

                <Text style={styles.itemBody}>{item.body}</Text>

                <View style={styles.cardFooter}>
                  <Text style={styles.categoryText}>Category: {item.category}</Text>
                  {!isRead && (
                    <Text style={styles.markReadText}>Tap to mark read</Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    padding: 16,
  },
  header: {
    marginTop: 8,
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  meta: {
    fontSize: 14,
    color: '#94A3B8',
    marginTop: 2,
  },
  errorBanner: {
    backgroundColor: '#451A1A',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 13,
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#94A3B8',
    marginTop: 10,
  },
  emptyBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#F1F5F9',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#94A3B8',
    marginTop: 6,
    textAlign: 'center',
  },
  refreshButton: {
    marginTop: 14,
    backgroundColor: '#0284C7',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  refreshButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  listContainer: {
    paddingBottom: 24,
  },
  notificationCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardUnread: {
    borderColor: '#38BDF8',
    backgroundColor: '#1E293B',
  },
  cardUrgent: {
    borderColor: '#EF4444',
    backgroundColor: '#27191E',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  urgentBadge: {
    backgroundColor: '#EF4444',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  urgentText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  itemTitle: {
    fontSize: 15,
    color: '#F8FAFC',
    fontWeight: '500',
  },
  titleBold: {
    fontWeight: '700',
  },
  itemTime: {
    fontSize: 11,
    color: '#64748B',
    marginLeft: 8,
  },
  itemBody: {
    fontSize: 13,
    color: '#CBD5E1',
    lineHeight: 18,
    marginVertical: 4,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 6,
  },
  categoryText: {
    fontSize: 11,
    color: '#64748B',
    textTransform: 'capitalize',
  },
  markReadText: {
    fontSize: 11,
    color: '#38BDF8',
    fontWeight: '600',
  },
});
