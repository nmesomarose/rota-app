import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Offline Shift Cache Service
 * PRD Reference: 12.1, FR-OFF-001..005, AC-OFF-01, AC-OFF-02.
 * Stores upcoming shifts for the next 14 days, scoped by business_id and user_id.
 * Read-only offline; refreshed on reconnect.
 * IMPORTANT: Auth tokens are strictly forbidden in AsyncStorage (AC-AUTH-07).
 * This file handles ONLY non-sensitive cached shift representations.
 */

export interface CachedShift {
  id: string;
  branchId: string;
  departmentId: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  status: 'draft' | 'review' | 'published' | 'cancelled';
  version: number;
  assignedStaffIds?: string[];
  isAssignedToUser?: boolean;
}

export interface CachedSchedule {
  businessId: string;
  userId: string;
  shifts: CachedShift[];
  lastUpdated: string; // ISO 8601 timestamp
}

const CACHE_PREFIX = 'rota_shifts_cache_';

function getCacheKey(businessId: string, userId: string): string {
  return `${CACHE_PREFIX}${businessId}_${userId}`;
}

/**
 * Retrieves cached upcoming shifts for the specified business and user.
 */
export async function getCachedSchedule(
  businessId: string,
  userId: string
): Promise<CachedSchedule | null> {
  try {
    const raw = await AsyncStorage.getItem(getCacheKey(businessId, userId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedSchedule;
  } catch (err) {
    console.warn('[OfflineCache] Failed to read cached schedule:', err);
    return null;
  }
}

/**
 * Saves upcoming shifts into local cache with a fresh lastUpdated timestamp (FR-OFF-001, FR-OFF-002).
 */
export async function setCachedSchedule(
  businessId: string,
  userId: string,
  shifts: CachedShift[]
): Promise<CachedSchedule> {
  const schedule: CachedSchedule = {
    businessId,
    userId,
    shifts,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(getCacheKey(businessId, userId), JSON.stringify(schedule));
  } catch (err) {
    console.warn('[OfflineCache] Failed to save schedule to cache:', err);
  }

  return schedule;
}

/**
 * Clears cached shifts for a specific business (e.g. on business switch).
 * PRD Reference: 12.1, FR-OFF-004, AC-OFF-01.
 */
export async function clearBusinessCache(businessId: string, userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(getCacheKey(businessId, userId));
  } catch (err) {
    console.warn('[OfflineCache] Failed to clear business cache:', err);
  }
}

/**
 * Clears ALL offline schedule cache keys across all businesses (on logout, revocation, deletion).
 * PRD Reference: 12.1, FR-OFF-004, AC-OFF-01.
 */
export async function clearAllOfflineCache(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const rotaKeys = allKeys.filter((k) => k.startsWith(CACHE_PREFIX));
    if (rotaKeys.length > 0) {
      await Promise.all(rotaKeys.map((k) => AsyncStorage.removeItem(k)));
    }
  } catch (err) {
    console.warn('[OfflineCache] Failed to clear all offline caches:', err);
  }
}
