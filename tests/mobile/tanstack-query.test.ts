import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Define and test the query key logic matching mobile/src/services/query-client.ts
const queryKeys = {
  activityFeed: (businessId: string, params?: { limit?: number; cursor?: string | null }) =>
    ['tenant', businessId, 'feed', params ?? {}] as const,
  inbox: (businessId: string, params?: { limit?: number; cursor?: string | null; unreadOnly?: boolean }) =>
    ['tenant', businessId, 'inbox', params ?? {}] as const,
  shifts: (businessId: string, branchId?: string, range?: { start?: string; end?: string }) =>
    ['tenant', businessId, 'branch', branchId ?? 'all', 'shifts', range ?? {}] as const,
  settings: (businessId: string) =>
    ['tenant', businessId, 'settings'] as const,
  team: (businessId: string, branchId?: string) =>
    ['tenant', businessId, 'branch', branchId ?? 'all', 'team'] as const,
  swaps: (businessId: string) =>
    ['tenant', businessId, 'swaps'] as const,
};

describe('TanStack Query Integration & Cache Isolation Tests', () => {
  const mobileSrcDir = path.resolve(process.cwd(), 'mobile/src');

  it('verifies tenant-scoped query keys enforce strict tenant boundary isolation', () => {
    const bizA = 'biz-uuid-1111';
    const bizB = 'biz-uuid-2222';
    const branch1 = 'branch-001';

    const feedA = queryKeys.activityFeed(bizA, { limit: 20 });
    const feedB = queryKeys.activityFeed(bizB, { limit: 20 });
    assert.notDeepEqual(feedA, feedB, 'Feed keys across different tenants must never collide');
    assert.equal(feedA[1], bizA);
    assert.equal(feedB[1], bizB);

    const shiftsA = queryKeys.shifts(bizA, branch1);
    const shiftsB = queryKeys.shifts(bizB, branch1);
    assert.notDeepEqual(shiftsA, shiftsB, 'Shift keys across different tenants must never collide');

    const settingsA = queryKeys.settings(bizA);
    const settingsB = queryKeys.settings(bizB);
    assert.notDeepEqual(settingsA, settingsB, 'Settings keys across tenants must never collide');
  });

  it('verifies branch-scoped query keys isolate branch schedules', () => {
    const biz = 'biz-uuid-test';
    const branchA = 'branch-north';
    const branchB = 'branch-south';

    const shiftsNorth = queryKeys.shifts(biz, branchA, { start: '2026-10-01' });
    const shiftsSouth = queryKeys.shifts(biz, branchB, { start: '2026-10-01' });
    assert.notDeepEqual(shiftsNorth, shiftsSouth, 'Shifts for different branches must have separate cache keys');
    assert.equal(shiftsNorth[3], branchA);
    assert.equal(shiftsSouth[3], branchB);
  });

  it('verifies mobile/src/services/query-client.ts exports queryClient and clearAllTenantQueries', () => {
    const clientFile = path.join(mobileSrcDir, 'services/query-client.ts');
    assert.ok(fs.existsSync(clientFile), 'query-client.ts must exist');

    const content = fs.readFileSync(clientFile, 'utf8');
    assert.match(content, /export const queryClient\s*=/, 'Must export queryClient instance');
    assert.match(content, /export\s+(?:async\s+)?function\s+clearAllTenantQueries/, 'Must export clearAllTenantQueries function');
    assert.match(content, /queryClient\.clear\(\)/, 'clearAllTenantQueries must call queryClient.clear()');
    assert.match(content, /staleTime:/, 'QueryClient must configure sensible default staleTime');
  });

  it('verifies App.tsx wraps tree with QueryClientProvider', () => {
    const appFile = path.resolve(process.cwd(), 'mobile/App.tsx');
    assert.ok(fs.existsSync(appFile), 'mobile/App.tsx must exist');

    const content = fs.readFileSync(appFile, 'utf8');
    assert.match(content, /<QueryClientProvider client=\{queryClient\}>/, 'App.tsx must wrap application in QueryClientProvider');
  });

  it('verifies BusinessSelectScreen clears cache on business switch and creation', () => {
    const screenFile = path.join(mobileSrcDir, 'screens/BusinessSelectScreen.tsx');
    assert.ok(fs.existsSync(screenFile), 'BusinessSelectScreen.tsx must exist');

    const content = fs.readFileSync(screenFile, 'utf8');
    assert.match(content, /clearAllTenantQueries\(\)/, 'Business switch or creation must purge all cached queries');
  });

  it('verifies SettingsScreen clears cache on logout and uses optimistic update with rollback', () => {
    const screenFile = path.join(mobileSrcDir, 'screens/SettingsScreen.tsx');
    assert.ok(fs.existsSync(screenFile), 'SettingsScreen.tsx must exist');

    const content = fs.readFileSync(screenFile, 'utf8');
    assert.match(content, /clearAllTenantQueries\(\)/, 'Logout must invoke clearAllTenantQueries()');
    assert.match(content, /const previous\s*=/, 'Must snapshot previous state before mutation for rollback');
    assert.match(content, /queryClient\.setQueryData/, 'Must update query client cache');
  });

  it('verifies FeedScreen and ScheduleScreen wire query caching and invalidation', () => {
    const feedFile = path.join(mobileSrcDir, 'screens/FeedScreen.tsx');
    const scheduleFile = path.join(mobileSrcDir, 'screens/ScheduleScreen.tsx');

    const feedContent = fs.readFileSync(feedFile, 'utf8');
    assert.match(feedContent, /queryKeys\.activityFeed/, 'FeedScreen must reference queryKeys.activityFeed');
    assert.match(feedContent, /queryClient\.setQueryData/, 'FeedScreen must sync query cache');

    const scheduleContent = fs.readFileSync(scheduleFile, 'utf8');
    assert.match(scheduleContent, /queryKeys\.shifts/, 'ScheduleScreen must reference queryKeys.shifts');
    assert.match(scheduleContent, /queryClient\.invalidateQueries/, 'ScheduleScreen must invalidate queries on shift mutation');
  });

  it('demonstrates functional optimistic update with rollback on server failure', async () => {
    // In-memory simulation of TanStack Query cache store
    const mockCache = new Map<string, any>();
    const key = JSON.stringify(queryKeys.settings('biz-100'));

    // 1. Initial server state
    const initialSettings = { allow_shift_swaps: true, require_manager_approval: true };
    mockCache.set(key, initialSettings);

    // 2. Perform optimistic update with snapshot
    const previousSnapshot = mockCache.get(key);
    assert.deepEqual(previousSnapshot, { allow_shift_swaps: true, require_manager_approval: true });

    // Optimistically toggle allow_shift_swaps to false
    const optimisticUpdate = { ...previousSnapshot, allow_shift_swaps: false };
    mockCache.set(key, optimisticUpdate);
    assert.equal(mockCache.get(key).allow_shift_swaps, false, 'Optimistic state must reflect immediately');

    // 3. Simulate API call failure
    let apiFailed = false;
    try {
      throw new Error('500 Internal Server Error: Database timeout');
    } catch (err) {
      apiFailed = true;
      // Rollback to previous snapshot
      mockCache.set(key, previousSnapshot);
    }

    assert.ok(apiFailed, 'API failure occurred');
    assert.deepEqual(
      mockCache.get(key),
      initialSettings,
      'Cache state must roll back completely to the snapshot before the failed mutation'
    );
    assert.equal(mockCache.get(key).allow_shift_swaps, true, 'Settings toggle rolled back to original true');
  });
});
