import {
  getAccessToken,
  setAccessToken,
  getRefreshToken,
  setRefreshToken,
  clearSession,
} from './storage.ts';
import { clearAllOfflineCache } from './offline-cache.ts';

// Android emulator uses 10.0.2.2 to reach host localhost; Expo Web / iOS uses localhost
const DEFAULT_API_URL = 'http://localhost:3000';
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL;

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
    public requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let isRefreshing = false;
let refreshSubscribers: ((token: string | null) => void)[] = [];

function onRefreshed(token: string | null) {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
}

function addRefreshSubscriber(cb: (token: string | null) => void) {
  refreshSubscribers.push(cb);
}

/**
 * Base fetch wrapper with JWT attachment and automatic 401 refresh retry.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  // Attach access token if available
  const token = await getAccessToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err: unknown) {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Unable to connect to Rota backend. Please verify your connection or offline mode.',
      err
    );
  }

  // Handle 401 UNAUTHENTICATED / SESSION_REVOKED -> attempt refresh
  if (response.status === 401 && !path.includes('/auth/login') && !path.includes('/auth/refresh')) {
    if (!isRefreshing) {
      isRefreshing = true;
      const refreshToken = await getRefreshToken();

      if (refreshToken) {
        try {
          const refreshRes = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          });

          if (refreshRes.ok) {
            const data = await refreshRes.json();
            await setAccessToken(data.accessToken);
            if (data.refreshToken) {
              await setRefreshToken(data.refreshToken);
            }
            isRefreshing = false;
            onRefreshed(data.accessToken);

            // Retry original request with new token
            headers.set('Authorization', `Bearer ${data.accessToken}`);
            const retryRes = await fetch(url, { ...options, headers });
            if (!retryRes.ok) {
              const errBody = (await retryRes.json().catch(() => ({}))) as ApiErrorResponse;
              throw new ApiError(
                retryRes.status,
                errBody.error?.code || 'REQUEST_FAILED',
                errBody.error?.message || 'Request failed',
                errBody.error?.details,
                errBody.error?.requestId
              );
            }
            return (await retryRes.json()) as T;
          }
        } catch {
          // Refresh failed
        }
      }

      // If refresh failed or was revoked: clean up session and cache (AC-AUTH-02, AC-OFF-01)
      isRefreshing = false;
      onRefreshed(null);
      await clearSession();
      await clearAllOfflineCache();
      throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
    } else {
      // Wait for existing refresh to resolve
      return new Promise<T>((resolve, reject) => {
        addRefreshSubscriber(async (newToken) => {
          if (!newToken) {
            return reject(new ApiError(401, 'SESSION_EXPIRED', 'Session expired. Please log in again.'));
          }
          headers.set('Authorization', `Bearer ${newToken}`);
          try {
            const retryRes = await fetch(url, { ...options, headers });
            if (!retryRes.ok) {
              const errBody = (await retryRes.json().catch(() => ({}))) as ApiErrorResponse;
              return reject(
                new ApiError(
                  retryRes.status,
                  errBody.error?.code || 'REQUEST_FAILED',
                  errBody.error?.message || 'Request failed',
                  errBody.error?.details,
                  errBody.error?.requestId
                )
              );
            }
            resolve((await retryRes.json()) as T);
          } catch (err) {
            reject(err);
          }
        });
      });
    }
  }

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    throw new ApiError(
      response.status,
      errBody.error?.code || 'REQUEST_FAILED',
      errBody.error?.message || `HTTP ${response.status} Error`,
      errBody.error?.details,
      errBody.error?.requestId
    );
  }

  return (await response.json()) as T;
}

// Typed API modules
export const api = {
  auth: {
    login: async (email: string, password: string) =>
      apiRequest<{
        user: { id: string; email: string; name?: string };
        tokens: {
          accessToken: string;
          refreshToken: string;
          expiresIn: number;
        };
        activeBusinessId: string | null;
        businesses: Array<{
          business_id: string;
          business_name: string;
          role: string;
          status: string;
        }>;
        requiresBusinessSelection?: boolean;
      }>('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),

    logout: async () => {
      const refreshToken = await getRefreshToken();
      try {
        await apiRequest('/v1/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
      } finally {
        await clearSession();
        await clearAllOfflineCache();
      }
    },
  },

  organizations: {
    getMemberships: async () =>
      apiRequest<{
        memberships: Array<{
          businessId: string;
          businessName: string;
          role: string;
          status: string;
          branchId?: string;
          departmentId?: string;
        }>;
      }>('/v1/organizations/memberships', {
        method: 'GET',
      }),

    switchBusiness: async (businessId: string) =>
      apiRequest<{
        accessToken: string;
        business: {
          id: string;
          name: string;
          role: string;
          branchId?: string;
          departmentId?: string;
        };
      }>('/v1/organizations/switch-business', {
        method: 'POST',
        body: JSON.stringify({ businessId }),
      }),
  },

  scheduling: {
    getShifts: async (params?: { departmentId?: string; branchId?: string; status?: string }) => {
      const query = new URLSearchParams();
      if (params?.departmentId) query.set('departmentId', params.departmentId);
      if (params?.branchId) query.set('branchId', params.branchId);
      if (params?.status) query.set('status', params.status);

      const qs = query.toString() ? `?${query.toString()}` : '';
      return apiRequest<{
        shifts: Array<{
          id: string;
          branchId: string;
          departmentId: string;
          startsAt: string;
          endsAt: string;
          timeZone: string;
          status: 'draft' | 'review' | 'published' | 'cancelled';
          version: number;
          assignedStaffIds?: string[];
        }>;
        count: number;
      }>(`/v1/scheduling/shifts${qs}`, {
        method: 'GET',
      });
    },
  },

  notifications: {
    registerPushToken: async (token: string, deviceId: string, platform = 'expo') =>
      apiRequest<{ pushToken: { id: string; token: string } }>('/v1/notifications/push-token', {
        method: 'POST',
        body: JSON.stringify({ token, deviceId, platform }),
      }),

    getInbox: async () =>
      apiRequest<{
        inbox: Array<{
          id: string;
          category: string;
          title: string;
          body: string;
          payload: unknown;
          mandatory: boolean;
          urgent: boolean;
          read_at: string | null;
          created_at: string;
        }>;
        count: number;
      }>('/v1/notifications/inbox', {
        method: 'GET',
      }),

    markAsRead: async (id: string) =>
      apiRequest<{ item: { id: string; read_at: string } }>(`/v1/notifications/inbox/${id}/read`, {
        method: 'POST',
      }),
  },

  swaps: {
    requestSwap: async (data: {
      requesterShiftId: string;
      counterpartMembershipId: string;
      counterpartShiftId: string;
      notes?: string;
    }) =>
      apiRequest<{ swap: any }>('/v1/swaps', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    listSwaps: async () =>
      apiRequest<{ swaps: any[] }>('/v1/swaps', {
        method: 'GET',
      }),

    acceptSwap: async (id: string) =>
      apiRequest<{ swap: any }>(`/v1/swaps/${id}/accept`, {
        method: 'POST',
      }),

    rejectSwap: async (id: string) =>
      apiRequest<{ swap: any }>(`/v1/swaps/${id}/reject`, {
        method: 'POST',
      }),

    approveSwap: async (id: string) =>
      apiRequest<{ swap: any }>(`/v1/swaps/${id}/approve`, {
        method: 'POST',
      }),

    cancelSwap: async (id: string) =>
      apiRequest<{ swap: any }>(`/v1/swaps/${id}/cancel`, {
        method: 'POST',
      }),
  },

  attendance: {
    record: async (data: {
      shiftAssignmentId: string;
      state: 'present' | 'late' | 'absent';
      notes?: string;
    }) =>
      apiRequest<{ attendance: any }>('/v1/attendance', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    list: async (params?: { shiftId?: string; membershipId?: string; departmentId?: string }) => {
      const query = new URLSearchParams();
      if (params?.shiftId) query.set('shiftId', params.shiftId);
      if (params?.membershipId) query.set('membershipId', params.membershipId);
      if (params?.departmentId) query.set('departmentId', params.departmentId);
      const qs = query.toString() ? `?${query.toString()}` : '';
      return apiRequest<{ attendance: any[] }>(`/v1/attendance${qs}`, {
        method: 'GET',
      });
    },
  },

  activity: {
    getFeed: async (params?: { limit?: number; cursor?: string }) => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.cursor) query.set('cursor', params.cursor);
      const qs = query.toString() ? `?${query.toString()}` : '';
      return apiRequest<{
        events: Array<{
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
        }>;
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/v1/activity${qs}`, {
        method: 'GET',
      });
    },
  },
};
