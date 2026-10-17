import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { api, ApiError } from '../services/api.ts';

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

export function TeamScreen() {
  const [swaps, setSwaps] = useState<SwapRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const loadSwaps = useCallback(async (isPull = false) => {
    if (isPull) setRefreshing(true);
    else setLoading(true);
    setErrorMessage(null);

    try {
      const res = await api.swaps.listSwaps();
      setSwaps(res.swaps);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load shift swaps. Please check connection.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSwaps();
  }, [loadSwaps]);

  /**
   * Peer accepts swap with optimistic update and rollback (FR-SWP-005, AC-SET-02).
   */
  const handleAccept = async (swapId: string) => {
    const prevSwaps = [...swaps];
    // Optimistic update
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'peer_accepted' } : s))
    );
    setProcessingId(swapId);

    try {
      await api.swaps.acceptSwap(swapId);
    } catch (err: unknown) {
      // Rollback to previous state (AC-SET-02)
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to accept swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingId(null);
    }
  };

  /**
   * Peer rejects swap with optimistic update and rollback.
   */
  const handleReject = async (swapId: string) => {
    const prevSwaps = [...swaps];
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'peer_rejected' } : s))
    );
    setProcessingId(swapId);

    try {
      await api.swaps.rejectSwap(swapId);
    } catch (err: unknown) {
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to reject swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingId(null);
    }
  };

  /**
   * Manager approves swap with optimistic update and rollback.
   */
  const handleApprove = async (swapId: string) => {
    const prevSwaps = [...swaps];
    setSwaps((prev) =>
      prev.map((s) => (s.id === swapId ? { ...s, status: 'approved' } : s))
    );
    setProcessingId(swapId);

    try {
      await api.swaps.approveSwap(swapId);
    } catch (err: unknown) {
      setSwaps(prevSwaps);
      const msg = err instanceof ApiError ? err.message : 'Failed to approve swap request';
      Alert.alert('Error', msg);
    } finally {
      setProcessingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return { label: 'PENDING PEER', color: '#FBBF24' };
      case 'peer_accepted':
        return { label: 'AWAITING MANAGER', color: '#38BDF8' };
      case 'approved':
        return { label: 'APPROVED', color: '#34D399' };
      case 'peer_rejected':
        return { label: 'REJECTED', color: '#F87171' };
      case 'stale':
        return { label: 'STALE', color: '#EF4444' };
      case 'cancelled':
        return { label: 'CANCELLED', color: '#64748B' };
      default:
        return { label: status.toUpperCase(), color: '#94A3B8' };
    }
  };

  const renderSwapItem = ({ item }: { item: SwapRequest }) => {
    const badge = getStatusBadge(item.status);
    const isProcessing = processingId === item.id;

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: `${badge.color}20` }]}>
            <Text style={[styles.badgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>
          <Text style={styles.dateText}>
            {new Date(item.created_at).toLocaleDateString()}
          </Text>
        </View>

        <Text style={styles.shiftRef}>Swap Ref: {item.id.slice(0, 8)}...</Text>
        {item.notes && <Text style={styles.notesText}>{item.notes}</Text>}

        {/* Action Buttons */}
        <View style={styles.actionRow}>
          {item.status === 'pending' && (
            <>
              <TouchableOpacity
                style={[styles.btn, styles.btnAccept]}
                onPress={() => handleAccept(item.id)}
                disabled={isProcessing}
              >
                <Text style={styles.btnText}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnReject]}
                onPress={() => handleReject(item.id)}
                disabled={isProcessing}
              >
                <Text style={styles.btnText}>Reject</Text>
              </TouchableOpacity>
            </>
          )}

          {item.status === 'peer_accepted' && (
            <TouchableOpacity
              style={[styles.btn, styles.btnApprove]}
              onPress={() => handleApprove(item.id)}
              disabled={isProcessing}
            >
              <Text style={styles.btnText}>Manager Approve</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Team & Shift Swaps</Text>
        <Text style={styles.meta}>Same-department colleague swaps & approvals</Text>
      </View>

      {errorMessage && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color="#38BDF8" />
          <Text style={styles.loadingText}>Loading shift swaps...</Text>
        </View>
      ) : swaps.length === 0 ? (
        <View style={styles.centerBox}>
          <Text style={styles.emptyIcon}>🔄</Text>
          <Text style={styles.emptyTitle}>No Active Swaps</Text>
          <Text style={styles.emptyText}>
            Shift swap requests from your department will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={swaps}
          keyExtractor={(item) => item.id}
          renderItem={renderSwapItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadSwaps(true)}
              tintColor="#38BDF8"
            />
          }
        />
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
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  dateText: {
    fontSize: 12,
    color: '#64748B',
  },
  shiftRef: {
    fontSize: 14,
    color: '#E2E8F0',
    fontWeight: '600',
    marginBottom: 4,
  },
  notesText: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 12,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  btn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 6,
    alignItems: 'center',
  },
  btnAccept: {
    backgroundColor: '#0284C7',
  },
  btnReject: {
    backgroundColor: '#EF4444',
  },
  btnApprove: {
    backgroundColor: '#10B981',
    flex: 1,
  },
  btnText: {
    color: '#FFFFFF',
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
