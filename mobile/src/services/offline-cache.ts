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

export interface CachedActivityEvent {
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

export interface CachedActivityFeed {
  businessId: string;
  userId: string;
  events: CachedActivityEvent[];
  lastUpdated: string; // ISO 8601 timestamp
}

export interface CachedInboxNotification {
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

export interface CachedInbox {
  businessId: string;
  userId: string;
  notifications: CachedInboxNotification[];
  lastUpdated: string; // ISO 8601 timestamp
}

const SCHEDULE_CACHE_PREFIX = 'rota_shifts_cache_';
const FEED_CACHE_PREFIX = 'rota_feed_cache_';
const INBOX_CACHE_PREFIX = 'rota_inbox_cache_';

function getScheduleCacheKey(businessId: string, userId: string): string {
  return `${SCHEDULE_CACHE_PREFIX}${businessId}_${userId}`;
}

function getFeedCacheKey(businessId: string, userId: string): string {
  return `${FEED_CACHE_PREFIX}${businessId}_${userId}`;
}

function getInboxCacheKey(businessId: string, userId: string): string {
  return `${INBOX_CACHE_PREFIX}${businessId}_${userId}`;
}

/**
 * Retrieves cached upcoming shifts for the specified business and user.
 */
export async function getCachedSchedule(
  businessId: string,
  userId: string
): Promise<CachedSchedule | null> {
  try {
    const raw = await AsyncStorage.getItem(getScheduleCacheKey(businessId, userId));
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
    await AsyncStorage.setItem(getScheduleCacheKey(businessId, userId), JSON.stringify(schedule));
  } catch (err) {
    console.warn('[OfflineCache] Failed to save schedule to cache:', err);
  }

  return schedule;
}

/**
 * Retrieves cached activity feed events for the specified business and user.
 */
export async function getCachedActivityFeed(
  businessId: string,
  userId: string
): Promise<CachedActivityFeed | null> {
  try {
    const raw = await AsyncStorage.getItem(getFeedCacheKey(businessId, userId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedActivityFeed;
  } catch (err) {
    console.warn('[OfflineCache] Failed to read cached activity feed:', err);
    return null;
  }
}

/**
 * Saves activity feed events into local cache with a fresh lastUpdated timestamp.
 */
export async function setCachedActivityFeed(
  businessId: string,
  userId: string,
  events: CachedActivityEvent[]
): Promise<CachedActivityFeed> {
  const feed: CachedActivityFeed = {
    businessId,
    userId,
    events,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(getFeedCacheKey(businessId, userId), JSON.stringify(feed));
  } catch (err) {
    console.warn('[OfflineCache] Failed to save activity feed to cache:', err);
  }

  return feed;
}

/**
 * Retrieves cached inbox notifications for the specified business and user.
 */
export async function getCachedInbox(
  businessId: string,
  userId: string
): Promise<CachedInbox | null> {
  try {
    const raw = await AsyncStorage.getItem(getInboxCacheKey(businessId, userId));
    if (!raw) return null;
    return JSON.parse(raw) as CachedInbox;
  } catch (err) {
    console.warn('[OfflineCache] Failed to read cached inbox:', err);
    return null;
  }
}

/**
 * Saves inbox notifications into local cache with a fresh lastUpdated timestamp.
 */
export async function setCachedInbox(
  businessId: string,
  userId: string,
  notifications: CachedInboxNotification[]
): Promise<CachedInbox> {
  const inbox: CachedInbox = {
    businessId,
    userId,
    notifications,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await AsyncStorage.setItem(getInboxCacheKey(businessId, userId), JSON.stringify(inbox));
  } catch (err) {
    console.warn('[OfflineCache] Failed to save inbox to cache:', err);
  }

  return inbox;
}

/**
 * Clears cached shifts, feed, and inbox for a specific business (e.g. on business switch).
 * PRD Reference: 12.1, FR-OFF-004, AC-OFF-01.
 */
export async function clearBusinessCache(businessId: string, userId: string): Promise<void> {
  try {
    await Promise.all([
      AsyncStorage.removeItem(getScheduleCacheKey(businessId, userId)),
      AsyncStorage.removeItem(getFeedCacheKey(businessId, userId)),
      AsyncStorage.removeItem(getInboxCacheKey(businessId, userId)),
    ]);
  } catch (err) {
    console.warn('[OfflineCache] Failed to clear business cache:', err);
  }
}

/**
 * Clears ALL offline schedule, feed, and inbox cache keys across all businesses (on logout, revocation, deletion).
 * PRD Reference: 12.1, FR-OFF-004, AC-OFF-01.
 */
export async function clearAllOfflineCache(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const rotaKeys = allKeys.filter(
      (k) =>
        k.startsWith(SCHEDULE_CACHE_PREFIX) ||
        k.startsWith(FEED_CACHE_PREFIX) ||
        k.startsWith(INBOX_CACHE_PREFIX)
    );
    if (rotaKeys.length > 0) {
      await Promise.all(rotaKeys.map((k) => AsyncStorage.removeItem(k)));
    }
  } catch (err) {
    console.warn('[OfflineCache] Failed to clear all offline caches:', err);
  }
}
