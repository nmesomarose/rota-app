import { Platform, Alert } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types.ts';
import { api, ApiError } from './api.ts';
import { getAccessToken, getUserProfile, getDeviceId, setOnClearSessionHook } from './storage.ts';

// Reset push token registration cache and return to Login whenever session is cleared or expired
setOnClearSessionHook((options) => {
  resetPushRegistrationState();
  returnToLogin({ isSessionExpired: options?.isExpired });
});

/**
 * Configure default foreground notification presentation behavior.
 * Shows an alert banner, notification list item, and plays sound without setting badge count.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    priority: Notifications.AndroidNotificationPriority.HIGH,
  }),
});

import {
  type NavigationTarget,
  type NotificationPayloadData,
  resolveNotificationTarget,
} from './notification-routing.ts';

export type { NavigationTarget, NotificationPayloadData };
export { resolveNotificationTarget };

/**
 * Global navigation container ref attached to Root NavigationContainer.
 */
export const rootNavigationRef = createNavigationContainerRef<RootStackParamList>();

let pendingTarget: NavigationTarget | null = null;
let isResettingToAuth = false;
let sessionExpiredAlertVisible = false;
let pendingAuthReset = false;
let pendingExpiredAlert = false;

export function resetSessionExpiredAlertState(): void {
  sessionExpiredAlertVisible = false;
  isResettingToAuth = false;
  pendingAuthReset = false;
  pendingExpiredAlert = false;
}

export function isSessionExpiredAlertShowing(): boolean {
  return sessionExpiredAlertVisible;
}

export function isAuthResetPending(): boolean {
  return pendingAuthReset;
}

/**
 * Automatically returns the user to the Login screen upon session clearance or confirmed expiry.
 * Thread-safe: deduplicates concurrent navigation resets and alerts from multiple 401 responses.
 */
export function returnToLogin(options?: { isSessionExpired?: boolean }): void {
  const isExpired = !!options?.isSessionExpired;

  // 1. Show deduplicated alert if session has confirmed expired
  if (isExpired && !sessionExpiredAlertVisible) {
    sessionExpiredAlertVisible = true;
    if (typeof Alert !== 'undefined' && typeof Alert.alert === 'function') {
      Alert.alert(
        'Session Expired',
        'Your session has expired. Please log in again.',
        [
          {
            text: 'Log In',
            onPress: () => {
              sessionExpiredAlertVisible = false;
            },
          },
        ],
        {
          cancelable: false,
          onDismiss: () => {
            sessionExpiredAlertVisible = false;
          },
        }
      );
    }
  }

  // 2. Perform navigation reset to Auth screen
  if (!rootNavigationRef.isReady()) {
    // NavigationContainer is not mounted yet; queue reset for onReady
    pendingAuthReset = true;
    if (isExpired) {
      pendingExpiredAlert = true;
    }
    return;
  }

  // Prevent duplicate concurrent navigation resets
  if (isResettingToAuth) {
    return;
  }

  try {
    const currentRoute = rootNavigationRef.getCurrentRoute();
    if (currentRoute?.name === 'Auth') {
      // Already on the login/auth screen; no navigation reset needed
      return;
    }

    isResettingToAuth = true;
    rootNavigationRef.reset({
      index: 0,
      routes: [{ name: 'Auth' }],
    });
  } catch {
    // Safe fallback if navigation state cannot be reset
  } finally {
    // Release the navigation reset lock asynchronously to avoid thrashing
    setTimeout(() => {
      isResettingToAuth = false;
    }, 500);
  }
}

/**
 * Navigates to the resolved screen for a given notification payload.
 * If the navigation container is not ready (e.g. app cold-start), queues target.
 */
export function navigateFromNotification(data?: NotificationPayloadData | null): void {
  const target = resolveNotificationTarget(data);

  if (rootNavigationRef.isReady()) {
    if (target.route === 'Billing') {
      rootNavigationRef.navigate('Billing');
    } else if (target.route === 'Main') {
      rootNavigationRef.navigate('Main', {
        screen: target.screen,
        params: target.params,
      } as any);
    }
  } else {
    pendingTarget = target;
  }
}

/**
 * Called by NavigationContainer onReady to dispatch any queued notification navigation.
 */
export function dispatchPendingNotificationNavigation(): void {
  if (pendingAuthReset && rootNavigationRef.isReady()) {
    pendingAuthReset = false;
    const shouldAlert = pendingExpiredAlert;
    pendingExpiredAlert = false;
    returnToLogin({ isSessionExpired: shouldAlert });
    return;
  }

  if (pendingTarget && rootNavigationRef.isReady()) {
    const target = pendingTarget;
    pendingTarget = null;
    if (target.route === 'Billing') {
      rootNavigationRef.navigate('Billing');
    } else if (target.route === 'Main') {
      rootNavigationRef.navigate('Main', {
        screen: target.screen,
        params: target.params,
      } as any);
    }
  }
}

export interface PushRegistrationResult {
  status:
    | 'registered'
    | 'permission_denied'
    | 'simulator_skipped'
    | 'unauthenticated'
    | 'failed';
  token?: string;
  deviceId?: string;
  error?: string;
}

let lastRegisteredToken: string | null = null;
let lastRegisteredUserId: string | null = null;
let activeRegistrationPromise: Promise<PushRegistrationResult> | null = null;

/**
 * Resets the in-memory push token registration cache (called on sign out or session clearance).
 */
export function resetPushRegistrationState(): void {
  lastRegisteredToken = null;
  lastRegisteredUserId = null;
  activeRegistrationPromise = null;
  pendingTarget = null;
  resetSessionExpiredAlertState();
}

/**
 * Requests push notification permissions and registers the Expo push token
 * with the Rota backend control plane for the authenticated user (FR-NOT-002, AC-NOT-09).
 * Deduplicates in-flight calls and suppresses repeated unauthorized attempts when session is expired.
 */
export function registerForPushNotificationsAsync(): Promise<PushRegistrationResult> {
  if (activeRegistrationPromise) {
    return activeRegistrationPromise;
  }

  activeRegistrationPromise = (async () => {
    try {
      // 1. Verify user authentication
      const accessToken = await getAccessToken();
      if (!accessToken) {
        return { status: 'unauthenticated' };
      }

      const userProfile = await getUserProfile();
      const currentUserId = userProfile?.id || null;

      // 2. Physical device check
      // Push notifications cannot be registered or received on iOS/Android emulators
      if (!Device.isDevice) {
        if (process.env.NODE_ENV !== 'test') {
          console.log('[Notifications] Physical device required for remote Expo push notifications.');
        }
        return { status: 'simulator_skipped' };
      }

      // 3. Android notification channel configuration
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#0F172A',
        });
      }

      // 4. Request notification permissions
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        if (process.env.NODE_ENV !== 'test') {
          console.log('[Notifications] Push notification permissions were denied by the user.');
        }
        return { status: 'permission_denied' };
      }

      // 5. Retrieve Expo Push Token with EAS Project ID
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        Constants.easConfig?.projectId ??
        'e518331f-054c-47cc-9946-7d4606b347bf';

      const tokenResponse = await Notifications.getExpoPushTokenAsync({
        projectId,
      });
      const token = tokenResponse.data;

      // Avoid duplicate registrations in the same session
      if (lastRegisteredToken === token && lastRegisteredUserId === currentUserId) {
        return { status: 'registered', token };
      }

      // 6. Register token with backend control plane (FR-NOT-002, AC-NOT-09)
      const deviceId = await getDeviceId();
      const platform =
        Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'expo';

      await api.notifications.registerPushToken(token, deviceId, platform);

      lastRegisteredToken = token;
      lastRegisteredUserId = currentUserId;

      if (process.env.NODE_ENV !== 'test') {
        console.log(`[Notifications] Registered push token successfully with backend (device: ${deviceId})`);
      }

      return {
        status: 'registered',
        token,
        deviceId,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isExpired =
        (err instanceof ApiError && (err.statusCode === 401 || err.code === 'SESSION_EXPIRED')) ||
        errorMsg.toLowerCase().includes('session has expired');

      if (isExpired) {
        if (process.env.NODE_ENV !== 'test') {
          console.log('[Notifications] Push token registration skipped: user session is expired or unauthenticated.');
        }
        return {
          status: 'unauthenticated',
          error: errorMsg,
        };
      }

      if (process.env.NODE_ENV !== 'test') {
        console.warn('[Notifications] Failed to register push token with backend:', errorMsg);
      }
      return {
        status: 'failed',
        error: errorMsg,
      };
    } finally {
      activeRegistrationPromise = null;
    }
  })();

  return activeRegistrationPromise;
}

/**
 * Initializes notification listeners for foreground reception, tap responses, and cold-start taps.
 * Returns a cleanup function that should be invoked on unmount.
 */
export function setupNotificationListeners(options?: {
  onNotificationReceived?: (notification: Notifications.Notification) => void;
  onNotificationResponse?: (response: Notifications.NotificationResponse) => void;
}): () => void {
  // 1. Foreground notification delivery listener
  const receivedSubscription = Notifications.addNotificationReceivedListener(
    (notification) => {
      if (process.env.NODE_ENV !== 'test') {
        console.log('[Notifications] Foreground notification received:', notification.request.content.title);
      }
      options?.onNotificationReceived?.(notification);
    }
  );

  // 2. Notification response (tap) listener
  const responseSubscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      if (process.env.NODE_ENV !== 'test') {
        console.log('[Notifications] Notification response tapped:', response.notification.request.content.title);
      }
      const data = response.notification.request.content.data as NotificationPayloadData | undefined;
      navigateFromNotification(data);
      options?.onNotificationResponse?.(response);
    }
  );

  // 3. Cold start / terminated app launch check
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) {
        if (process.env.NODE_ENV !== 'test') {
          console.log('[Notifications] App launched from cold-start via notification tap');
        }
        const data = response.notification.request.content.data as NotificationPayloadData | undefined;
        navigateFromNotification(data);
      }
    })
    .catch((err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[Notifications] Error inspecting initial notification response:', err);
      }
    });

  return () => {
    receivedSubscription.remove();
    responseSubscription.remove();
  };
}
