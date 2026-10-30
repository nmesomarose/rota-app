import {
  getAccessToken,
  setAccessToken,
  getRefreshToken,
  setRefreshToken,
  clearSession,
} from './storage.ts';
import { clearAllOfflineCache } from './offline-cache.ts';

import {
  connectivityManager,
  type ConnectivityState,
  type ConnectivityListener,
} from './connectivity.ts';

export { connectivityManager, type ConnectivityState, type ConnectivityListener };

import {
  DEV_DEFAULT_API_URL,
  resolveInitialApiBaseUrl,
  setCustomApiUrl as setConfigCustomApiUrl,
  getApiBaseUrl,
  API_BASE_URL,
} from './api-config.ts';

export {
  DEV_DEFAULT_API_URL,
  resolveInitialApiBaseUrl,
  getApiBaseUrl,
  API_BASE_URL,
};

connectivityManager.setApiBaseUrl(getApiBaseUrl());

export function setCustomApiUrl(url: string): void {
  setConfigCustomApiUrl(url);
  connectivityManager.setApiBaseUrl(url);
}

/**
 * Subscribes to online/offline changes (backwards compatible).
 */
export function addConnectivityListener(listener: (isOnline: boolean) => void): () => void {
  return connectivityManager.addListener((state) => {
    listener(state.isOnline);
  });
}

export function notifyConnectivityListeners(isOnline: boolean): void {
  if (isOnline) {
    connectivityManager.reportApiSuccess();
  } else {
    connectivityManager.reportApiFailure('NETWORK_ERROR');
  }
}

export async function checkBackendHealth(force = false): Promise<boolean> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    connectivityManager.reportApiFailure(
      'NETWORK_ERROR',
      'Production API URL is not configured. Please build the mobile application with EXPO_PUBLIC_API_URL set to your deployed HTTPS API endpoint.'
    );
    return false;
  }
  return connectivityManager.checkBackendHealth(force);
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;
  public requestId?: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

let isRefreshing = false;
let refreshSubscribers: ((token: string | null, error?: ApiError | null) => void)[] = [];

function onRefreshed(token: string | null, error?: ApiError | null) {
  refreshSubscribers.forEach((cb) => cb(token, error));
  refreshSubscribers = [];
}

function addRefreshSubscriber(cb: (token: string | null, error?: ApiError | null) => void) {
  refreshSubscribers.push(cb);
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 25000; // 25-second bounded request timeout
export const AUTH_REQUEST_TIMEOUT_MS = 45000; // 45-second timeout for cold-start resilience during authentication

export interface RequestOptionsWithTimeout extends RequestInit {
  timeoutMs?: number;
}

/**
 * Executes a fetch call bounded by a strict timeout and supporting caller cancellation.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestOptionsWithTimeout = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal: callerSignal, ...restOptions } = options;

  const controller = new AbortController();
  let didTimeout = false;

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  let onCallerAbort: (() => void) | null = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      onCallerAbort = () => {
        clearTimeout(timeoutId);
        controller.abort();
      };
      callerSignal.addEventListener('abort', onCallerAbort);
    }
  }

  try {
    const response = await fetch(url, {
      ...restOptions,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (didTimeout) {
      connectivityManager.reportApiFailure('REQUEST_TIMEOUT');
      throw new ApiError(
        0,
        'REQUEST_TIMEOUT',
        `Request timed out after ${Math.round(timeoutMs / 1000)} seconds. Please verify your connection to the Rota backend.`
      );
    }
    if (callerSignal?.aborted) {
      throw new ApiError(
        0,
        'REQUEST_CANCELLED',
        'Request was cancelled.'
      );
    }
    if (err instanceof ApiError) {
      throw err;
    }
    connectivityManager.reportApiFailure('NETWORK_ERROR');
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Unable to connect to Rota backend. Please verify your connection or offline mode.',
      err
    );
  } finally {
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Base fetch wrapper with bounded timeout, JWT attachment, and automatic 401 refresh retry.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptionsWithTimeout = {}
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    throw new ApiError(
      0,
      'CONFIGURATION_ERROR',
      'Production API URL is not configured. Please build the mobile application with EXPO_PUBLIC_API_URL set to your deployed HTTPS API endpoint or supply a custom endpoint.'
    );
  }
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  // Attach access token if available
  const token = await getAccessToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetchWithTimeout(url, { ...options, headers });

  // Handle 401 UNAUTHENTICATED / SESSION_REVOKED -> attempt refresh
  if (response.status === 401 && !path.includes('/auth/login') && !path.includes('/auth/refresh')) {
    if (!isRefreshing) {
      isRefreshing = true;
      const refreshToken = await getRefreshToken();

      if (refreshToken) {
        try {
          const refreshRes = await fetchWithTimeout(`${baseUrl}/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
            timeoutMs: 15000,
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
            const retryRes = await fetchWithTimeout(url, { ...options, headers });
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
          } else if (refreshRes.status >= 500) {
            const serverError = new ApiError(
              refreshRes.status,
              'SERVER_ERROR',
              'Rota backend error during session refresh. Please try again later.'
            );
            isRefreshing = false;
            onRefreshed(null, serverError);
            throw serverError;
          }
        } catch (refreshErr) {
          if (
            refreshErr instanceof ApiError &&
            (refreshErr.code === 'REQUEST_TIMEOUT' ||
              refreshErr.code === 'NETWORK_ERROR' ||
              refreshErr.code === 'REQUEST_CANCELLED' ||
              refreshErr.code === 'SERVER_ERROR')
          ) {
            isRefreshing = false;
            onRefreshed(null, refreshErr);
            throw refreshErr;
          }
        }
      }

      // If refresh failed or was revoked: clean up session and cache (AC-AUTH-02, AC-OFF-01)
      const expiryError = new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
      isRefreshing = false;
      onRefreshed(null, expiryError);
      await clearSession({ isExpired: true });
      await clearAllOfflineCache();
      throw expiryError;
    } else {
      // Wait for existing refresh to resolve
      return new Promise<T>((resolve, reject) => {
        addRefreshSubscriber(async (newToken, error) => {
          if (!newToken) {
            return reject(error || new ApiError(401, 'SESSION_EXPIRED', 'Session expired. Please log in again.'));
          }
          headers.set('Authorization', `Bearer ${newToken}`);
          try {
            const retryRes = await fetchWithTimeout(url, { ...options, headers });
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

  connectivityManager.reportApiSuccess();
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
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
      }),

    register: async (email: string, password: string, name?: string) =>
      apiRequest<{
        user: { id: string; email: string; name?: string };
        tokens: {
          accessToken: string;
          refreshToken: string;
          expiresIn: number;
        };
      }>('/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name }),
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
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

    logoutAll: async () => {
      const result = await apiRequest<{ success: boolean; message: string }>('/v1/auth/logout-all', {
        method: 'POST',
      });
      await clearSession();
      await clearAllOfflineCache();
      return result;
    },

    deleteAccount: async (password: string) =>
      apiRequest<{ success: boolean; message: string }>('/v1/auth/account', {
        method: 'DELETE',
        body: JSON.stringify({ password }),
      }),

    forgotPassword: async (email: string) =>
      apiRequest<{
        message: string;
        resetToken?: string;
      }>('/v1/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      }),

    resetPassword: async (token: string, password: string) =>
      apiRequest<{
        success: boolean;
        message: string;
      }>('/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim(), password }),
      }),

    googleSignIn: async (idToken: string, deviceId?: string) =>
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
        isNewUser: boolean;
      }>('/v1/auth/google', {
        method: 'POST',
        body: JSON.stringify({ idToken, deviceId }),
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
      }),

    linkGoogleAccount: async (email: string, currentPassword: string, idToken: string) =>
      apiRequest<{
        success: boolean;
        message: string;
      }>('/v1/auth/google/link', {
        method: 'POST',
        body: JSON.stringify({
          email: email ? email.trim().toLowerCase() : undefined,
          currentPassword,
          idToken,
        }),
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
      }),
  },

  organizations: {
    getMemberships: async () => {
      const res = await apiRequest<{
        organizations: Array<{
          business_id: string;
          business_name: string;
          role: string;
          status: string;
          created_at: string;
        }>;
      }>('/v1/organizations', {
        method: 'GET',
      });
      return {
        memberships: (res.organizations || []).map((org) => ({
          businessId: org.business_id,
          businessName: org.business_name,
          role: org.role,
          status: org.status,
        })),
      };
    },

    create: async (data: {
      name: string;
      timezone?: string;
      branchName?: string;
      departments?: string[];
    }) =>
      apiRequest<{
        business: { id: string; name: string; timezone: string };
        branch: { id: string; name: string };
        departments: Array<{ id: string; name: string }>;
        membership: { id: string; role: string; status: string };
        subscription: unknown;
        tokens: {
          accessToken: string;
          expiresIn: number;
        };
      }>('/v1/organizations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    switchBusiness: async (businessId: string) =>
      apiRequest<{
        activeBusinessId: string;
        role: string;
        tokens: {
          accessToken: string;
          expiresIn: number;
        };
      }>('/v1/auth/switch-business', {
        method: 'POST',
        body: JSON.stringify({ businessId }),
      }),

    get: async (businessId: string) =>
      apiRequest<{
        business: { id: string; name: string; timezone: string };
        branches: Array<{ id: string; name: string }>;
        departments: Array<{ id: string; branch_id: string; name: string }>;
      }>(`/v1/organizations/${businessId}`, {
        method: 'GET',
      }),

    getMembers: async (businessId: string) =>
      apiRequest<{
        members: Array<{
          id: string;
          userId: string;
          name: string;
          email: string;
          role: string;
          status: string;
          branchId: string | null;
          branchName: string | null;
          departmentId: string | null;
          departmentName: string | null;
          createdAt: string;
        }>;
      }>(`/v1/organizations/${businessId}/members`, {
        method: 'GET',
      }),

    inviteMember: async (
      businessId: string,
      data: {
        email: string;
        name?: string;
        role: string;
        departmentId?: string;
        branchId?: string;
      }
    ) =>
      apiRequest<{
        invitation: {
          id: string;
          businessId: string;
          email: string;
          role: string;
          branchId: string | null;
          departmentId: string | null;
          status: string;
          expiresAt: string;
          createdAt: string;
          token?: string;
          deliveryStatus?: 'queued' | 'unconfigured';
        };
        member?: unknown;
      }>(`/v1/organizations/${businessId}/members/invite`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updateMemberRole: async (businessId: string, memberId: string, role: string) =>
      apiRequest<{ id: string; role: string }>(
        `/v1/organizations/${businessId}/members/${memberId}/role`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        }
      ),

    removeMember: async (businessId: string, memberId: string) =>
      apiRequest<{ success: boolean; message: string }>(
        `/v1/organizations/${businessId}/members/${memberId}`,
        {
          method: 'DELETE',
        }
      ),

    transferOwnership: async (businessId: string, targetMemberId: string) =>
      apiRequest<{ success: boolean; message: string }>(
        `/v1/organizations/${businessId}/transfer-ownership`,
        {
          method: 'POST',
          body: JSON.stringify({ targetMemberId }),
        }
      ),

    deleteOrganization: async (businessId: string) =>
      apiRequest<{ success: boolean; message: string }>(`/v1/organizations/${businessId}`, {
        method: 'DELETE',
      }),

    getInvitation: async (token: string) =>
      apiRequest<{
        invitation: {
          id: string;
          businessId: string;
          businessName: string;
          email: string;
          role: string;
          departmentName: string | null;
          status: string;
          expiresAt: string;
        };
      }>(`/v1/organizations/invitations/${encodeURIComponent(token.trim())}`, {
        method: 'GET',
      }),

    acceptInvitation: async (token: string) =>
      apiRequest<{
        success: boolean;
        message: string;
        membership: {
          id: string;
          userId: string;
          businessId: string;
          businessName: string;
          role: string;
          branchId: string | null;
          departmentId: string | null;
          status: string;
        };
      }>('/v1/organizations/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token: token.trim() }),
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
          assignments?: Array<{
            assignmentId: string;
            membershipId: string;
            overrideReason?: string | null;
            overrideBy?: string | null;
            overrideAt?: string | null;
          }>;
        }>;
        count: number;
      }>(`/v1/scheduling/shifts${qs}`, {
        method: 'GET',
      });
    },

    createShift: async (data: {
      branchId?: string;
      departmentId?: string;
      startsAt: string;
      endsAt: string;
      timeZone?: string;
      status?: 'draft' | 'review' | 'published';
    }) =>
      apiRequest<{ shift: any }>('/v1/scheduling/shifts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    assignWorker: async (shiftId: string, membershipId: string, overrideReason?: string) =>
      apiRequest<{ assignment: any }>(`/v1/scheduling/shifts/${shiftId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ membershipId, overrideReason }),
      }),

    unassignWorker: async (shiftId: string, membershipId: string) =>
      apiRequest<{ success: boolean }>(`/v1/scheduling/shifts/${shiftId}/assign/${membershipId}`, {
        method: 'DELETE',
      }),

    publishSchedule: async (shiftIds: string[]) =>
      apiRequest<{ publishedShifts: any[]; notificationsDispatched: number }>(
        '/v1/scheduling/publish',
        {
          method: 'POST',
          body: JSON.stringify({ shiftIds }),
        }
      ),
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

  billing: {
    getSubscription: async () =>
      apiRequest<{ data: any }>('/v1/billing/subscription', { method: 'GET' }),

    createQuote: async (data: { targetPlan?: string; targetSeats?: number; currency?: string }) =>
      apiRequest<{ data: any }>('/v1/billing/quotes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    confirmQuote: async (quoteId: string, idempotencyKey: string, options?: { cancelPending?: boolean }) =>
      apiRequest<{ data: any }>(`/v1/billing/quotes/${quoteId}/confirm`, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ idempotencyKey, ...(options || {}) }),
      }),

    cancelPayment: async () =>
      apiRequest<{ data: { cancelled: boolean; message: string } }>('/v1/billing/cancel-payment', {
        method: 'POST',
      }),

    simulateCheckout: async (data: { providerReference: string; outcome?: 'success' | 'failure' }) =>
      apiRequest<{ data: any }>('/v1/billing/simulate-checkout', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    scheduleDowngrade: async (data: { targetPlan?: string; targetSeats?: number }) =>
      apiRequest<{ data: any }>('/v1/billing/schedule-downgrade', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    cancelScheduledDowngrade: async () =>
      apiRequest<{ data: any }>('/v1/billing/schedule-downgrade', {
        method: 'DELETE',
      }),

    verifyPayment: async (reference: string) =>
      apiRequest<{ data: any; status: string; message?: string }>('/v1/billing/verify', {
        method: 'POST',
        body: JSON.stringify({ reference }),
      }),

    getLedger: async () =>
      apiRequest<{ data: any[] }>('/v1/billing/ledger', { method: 'GET' }),

    getHistory: async () =>
      apiRequest<{ data: any[] }>('/v1/billing/history', { method: 'GET' }),
  },

  settings: {
    getSettings: async () =>
      apiRequest<{ data: UserSettingsResponse }>('/v1/settings', { method: 'GET' }),

    updateSettings: async (data: UpdateSettingsPayload) =>
      apiRequest<{ data: UserSettingsResponse }>('/v1/settings', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },
};

export interface QuietHoursSettings {
  enabled: boolean;
  start: string;
  end: string;
}

export interface NotificationCategoriesSettings {
  shifts: boolean;
  swaps: boolean;
  approvals: boolean;
  attendance: boolean;
  billing: boolean;
  security: boolean;
}

export interface UserSettingsData {
  timeZone: string;
  quietHours: QuietHoursSettings;
  language: string;
  theme: 'system' | 'light' | 'dark';
  notificationCategories: NotificationCategoriesSettings;
}

export interface UserSettingsResponse {
  settings: UserSettingsData;
  fieldTimestamps: Record<string, string>;
  updatedAt: string;
}

export interface UpdateSettingsPayload {
  timeZone?: string;
  quietHours?: QuietHoursSettings;
  language?: string;
  theme?: 'system' | 'light' | 'dark';
  notificationCategories?: Partial<NotificationCategoriesSettings>;
  clientTimestamps?: Record<string, string>;
  clientTimestamp?: string;
}

