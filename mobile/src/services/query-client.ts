import { QueryClient } from '@tanstack/react-query';

/**
 * Authoritative TanStack Query Client for Rota Mobile Application.
 * Configures tenant-partitioned caching, background stale-while-revalidate,
 * and deterministic cache purges on context switching and logout.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30 seconds
      gcTime: 1000 * 60 * 60 * 24, // 24 hours (for offline re-hydration)
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * Strictly scoped query key factories guaranteeing zero cross-tenant
 * or cross-user cache collisions (SEC-014, AC-TEN-05, FR-OFF-004).
 */
export const queryKeys = {
  // Activity Feed partitioned by tenant, role tier, and membership
  activityFeed: (businessId: string, role?: string, membershipId?: string) =>
    ['tenant', businessId, 'feed', role || 'all', membershipId || 'all'] as const,

  // Inbox notifications partitioned by tenant and user
  inbox: (businessId: string, userId?: string) =>
    ['tenant', businessId, 'inbox', userId || 'all'] as const,

  // Shifts partitioned by tenant, branch, and department
  shifts: (businessId: string, branchId?: string, departmentId?: string) =>
    ['tenant', businessId, 'branch', branchId || 'all', 'department', departmentId || 'all', 'shifts'] as const,

  // User settings partitioned strictly by user ID
  settings: (userId: string) =>
    ['user', userId, 'settings'] as const,

  // Team directory partitioned by business ID
  team: (businessId: string) =>
    ['tenant', businessId, 'team'] as const,

  // Swaps list partitioned by business ID
  swaps: (businessId: string) =>
    ['tenant', businessId, 'swaps'] as const,
};

/**
 * Deterministically purges all tenant-scoped server state from memory.
 * Invoked immediately upon business switch, branch change, and logout (FR-OFF-004, AC-OFF-01).
 */
export async function clearAllTenantQueries(): Promise<void> {
  // Invalidate and remove all tenant queries
  queryClient.removeQueries({ queryKey: ['tenant'] });
  // Clear any global in-memory caches
  queryClient.clear();
}
