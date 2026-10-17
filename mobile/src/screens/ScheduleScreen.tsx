import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { api, ApiError } from '../services/api.ts';
import {
  getCachedSchedule,
  setCachedSchedule,
  type CachedShift,
} from '../services/offline-cache.ts';
import { getActiveBusiness, getUserProfile } from '../services/storage.ts';

export function ScheduleScreen() {
  const [shifts, setShifts] = useState<CachedShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>('Rota');

  const loadSchedule = useCallback(async (isPullToRefresh = false) => {
    if (isPullToRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setErrorMessage(null);

    const activeBiz = await getActiveBusiness();
    const user = await getUserProfile();

    if (!activeBiz || !user) {
      setLoading(false);
      setRefreshing(false);
      setErrorMessage('No active organization context found.');
      return;
    }

    setBusinessName(activeBiz.name);

    try {
      // 1. Attempt live network fetch
      const response = await api.scheduling.getShifts();
      const liveShifts: CachedShift[] = response.shifts.map((s) => ({
        id: s.id,
        branchId: s.branchId,
        departmentId: s.departmentId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        timeZone: s.timeZone,
        status: s.status,
        version: s.version,
        assignedStaffIds: s.assignedStaffIds,
      }));

      // 2. Persist to offline cache (PRD 12.1, FR-OFF-001, AC-OFF-02)
      const cached = await setCachedSchedule(activeBiz.id, user.id, liveShifts);
      setShifts(liveShifts);
      setIsOffline(false);
      setLastUpdated(cached.lastUpdated);
    } catch (err: unknown) {
      // 3. Network or connection failure -> Fall back to read-only offline cache
      console.warn('[ScheduleScreen] Live fetch failed, falling back to cache:', err);
      const cached = await getCachedSchedule(activeBiz.id, user.id);

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
      <View style={styles.header}>
        <Text style={styles.title}>{businessName} Schedule</Text>
        <Text style={styles.meta}>Upcoming Shifts (Next 14 Days)</Text>

        {/* Visible Last Updated Status (FR-OFF-001, AC-OFF-02) */}
        <View style={styles.statusBar}>
          <View style={[styles.statusDot, isOffline ? styles.dotOffline : styles.dotOnline]} />
          <Text style={styles.statusText}>
            {isOffline ? 'Offline Mode (Read-Only)' : 'Live Connected'} • Last updated: {formatLastUpdated(lastUpdated)}
          </Text>
        </View>
      </View>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            You are offline. Showing cached schedule. Read-only.
          </Text>
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

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#38BDF8" />
          <Text style={styles.loadingText}>Loading upcoming shifts...</Text>
        </View>
      ) : shifts.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>No Shifts Scheduled</Text>
          <Text style={styles.emptySubtitle}>
            There are no published shifts for the next 14 days.
          </Text>
          <TouchableOpacity style={styles.refreshButton} onPress={() => loadSchedule()}>
            <Text style={styles.refreshButtonText}>Refresh</Text>
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
              tintColor="#38BDF8"
              colors={['#38BDF8']}
            />
          }
          contentContainerStyle={styles.listContainer}
          renderItem={({ item }) => (
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
                  <Text style={styles.statusBadgeText}>{item.status.toUpperCase()}</Text>
                </View>
              </View>

              <View style={styles.shiftDetails}>
                <Text style={styles.detailText}>
                  Time Zone: <Text style={styles.detailValue}>{item.timeZone}</Text>
                </Text>
                <Text style={styles.detailText}>
                  Version: <Text style={styles.detailValue}>v{item.version}</Text>
                </Text>
              </View>
            </View>
          )}
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
    marginBottom: 12,
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
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotOnline: {
    backgroundColor: '#10B981',
  },
  dotOffline: {
    backgroundColor: '#F59E0B',
  },
  statusText: {
    fontSize: 12,
    color: '#94A3B8',
  },
  offlineBanner: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  offlineBannerText: {
    color: '#FEF3C7',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  errorBanner: {
    backgroundColor: '#451A1A',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 14,
  },
  retryButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: '#EF4444',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  centerBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#94A3B8',
    marginTop: 12,
    fontSize: 14,
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
    marginTop: 16,
    backgroundColor: '#0284C7',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
  },
  refreshButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  listContainer: {
    paddingBottom: 24,
  },
  shiftCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  shiftHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  shiftTime: {
    fontSize: 15,
    fontWeight: '600',
    color: '#F8FAFC',
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: 8,
  },
  badgePublished: {
    backgroundColor: '#065F46',
  },
  badgeDraft: {
    backgroundColor: '#374151',
  },
  statusBadgeText: {
    color: '#D1FAE5',
    fontSize: 11,
    fontWeight: '700',
  },
  shiftDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 8,
  },
  detailText: {
    fontSize: 12,
    color: '#94A3B8',
  },
  detailValue: {
    color: '#CBD5E1',
    fontWeight: '500',
  },
});
