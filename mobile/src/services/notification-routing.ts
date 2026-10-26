/**
 * Pure route resolution and payload types for push notifications and navigation tap routing.
 * Isolates business routing logic from React Native native modules so it can be thoroughly unit tested in any environment.
 */

export type NavigationTarget =
  | { route: 'Billing' }
  | { route: 'Main'; screen: 'Schedule'; params?: { shiftId?: string } }
  | { route: 'Main'; screen: 'Feed'; params?: { tab?: 'inbox' | 'activity'; swapId?: string } }
  | { route: 'Main'; screen: 'Settings'; params?: undefined }
  | { route: 'Main'; screen: 'Team'; params?: undefined };

export interface NotificationPayloadData {
  category?: string;
  shiftId?: string;
  swapId?: string;
  type?: string;
  changeType?: string;
  startsAt?: string;
  endsAt?: string;
  scheduledFor?: string;
  [key: string]: unknown;
}

/**
 * Pure route resolution function mapping backend notification payloads to valid mobile routes.
 *
 * Route Mapping Rules (C-10, FR-NOT-002, PRD 9.2):
 * 1. category === 'billing' or type === 'renewal_failed' -> RootStack 'Billing'
 * 2. category === 'shifts' or shiftId provided -> MainTabs 'Schedule'
 * 3. category === 'swaps' or swapId provided -> MainTabs 'Feed' (Inbox tab)
 * 4. category === 'security' -> MainTabs 'Settings'
 * 5. default/unrecognized -> MainTabs 'Feed' (Inbox tab)
 */
export function resolveNotificationTarget(
  data?: NotificationPayloadData | null
): NavigationTarget {
  if (!data) {
    return { route: 'Main', screen: 'Feed', params: { tab: 'inbox' } };
  }

  const category = (typeof data.category === 'string' ? data.category : '').toLowerCase();
  const type = (typeof data.type === 'string' ? data.type : '').toLowerCase();

  // 1. Billing / Subscription renewal failures
  if (category === 'billing' || type === 'renewal_failed') {
    return { route: 'Billing' };
  }

  // 2. Shift scheduling updates / cancellations
  if (category === 'shifts' || data.shiftId) {
    return {
      route: 'Main',
      screen: 'Schedule',
      params: data.shiftId ? { shiftId: String(data.shiftId) } : undefined,
    };
  }

  // 3. Shift swap requests & peer approvals
  if (category === 'swaps' || data.swapId) {
    return {
      route: 'Main',
      screen: 'Feed',
      params: { tab: 'inbox', swapId: data.swapId ? String(data.swapId) : undefined },
    };
  }

  // 4. Security notices (password resets, session changes)
  if (category === 'security') {
    return { route: 'Main', screen: 'Settings' };
  }

  // 5. Fallback: In-app inbox within the Feed tab
  return { route: 'Main', screen: 'Feed', params: { tab: 'inbox' } };
}
