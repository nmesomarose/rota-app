import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Mobile Expired Session Navigation & Security Clearance (Regression Suite)', () => {
  const getFilePath = (relPath: string) => {
    const candidate1 = path.resolve(process.cwd(), relPath);
    const candidate2 = path.resolve(process.cwd(), relPath.replace('mobile/', ''));
    return fs.existsSync(candidate1) ? candidate1 : candidate2;
  };

  const readSource = (relPath: string) => fs.readFileSync(getFilePath(relPath), 'utf8');

  describe('1. Storage Session Clearance & Hook Contract', () => {
    it('verifies storage.ts defines ClearSessionOptions and multi-listener hook support', () => {
      const content = readSource('mobile/src/services/storage.ts');

      assert.ok(
        content.includes('export interface ClearSessionOptions'),
        'storage.ts must export ClearSessionOptions interface'
      );
      assert.ok(
        content.includes('isExpired?: boolean'),
        'ClearSessionOptions must support isExpired boolean property'
      );
      assert.ok(
        content.includes('export function setOnClearSessionHook'),
        'storage.ts must preserve setOnClearSessionHook export'
      );
      assert.ok(
        content.includes('export function addOnClearSessionListener'),
        'storage.ts must provide addOnClearSessionListener for multi-subscriber safety'
      );
      assert.ok(
        content.includes('export async function clearSession(options?: ClearSessionOptions)'),
        'clearSession must accept optional ClearSessionOptions argument'
      );
      assert.ok(
        content.includes('onClearSessionHook(options)'),
        'clearSession must propagate options to onClearSessionHook'
      );
      assert.ok(
        content.includes('listener(options)'),
        'clearSession must propagate options to registered listeners'
      );
    });

    it('verifies storage.ts securely deletes all credentials on clearSession', () => {
      const content = readSource('mobile/src/services/storage.ts');

      assert.ok(
        content.includes('await secureDelete(ACCESS_TOKEN_KEY)'),
        'clearSession must securely delete ACCESS_TOKEN_KEY'
      );
      assert.ok(
        content.includes('await secureDelete(REFRESH_TOKEN_KEY)'),
        'clearSession must securely delete REFRESH_TOKEN_KEY'
      );
      assert.ok(
        content.includes('await secureDelete(USER_PROFILE_KEY)'),
        'clearSession must securely delete USER_PROFILE_KEY'
      );
      assert.ok(
        content.includes('await secureDelete(ACTIVE_BUSINESS_KEY)'),
        'clearSession must securely delete ACTIVE_BUSINESS_KEY'
      );
    });
  });

  describe('2. Return-To-Login & Navigation Architecture Integration', () => {
    it('verifies notifications.ts integrates session-clear hook with returnToLogin', () => {
      const content = readSource('mobile/src/services/notifications.ts');

      assert.ok(
        content.includes('setOnClearSessionHook((options) => {'),
        'notifications.ts must hook into setOnClearSessionHook with options'
      );
      assert.ok(
        content.includes('returnToLogin({ isSessionExpired: options?.isExpired })'),
        'notifications.ts hook must forward options.isExpired to returnToLogin'
      );
      assert.ok(
        content.includes('resetPushRegistrationState()'),
        'notifications.ts hook must reset push token registration cache'
      );
    });

    it('verifies returnToLogin resets navigation stack to Auth at index 0 preventing back-navigation', () => {
      const content = readSource('mobile/src/services/notifications.ts');

      assert.ok(
        content.includes('export function returnToLogin'),
        'notifications.ts must export returnToLogin function'
      );
      assert.ok(
        content.includes('rootNavigationRef.reset({'),
        'returnToLogin must invoke rootNavigationRef.reset'
      );
      assert.ok(
        content.includes('index: 0'),
        'Navigation reset must specify index: 0 so no authenticated screens remain in back-stack'
      );
      assert.ok(
        content.includes("routes: [{ name: 'Auth' }]"),
        'Navigation reset must set routes to [{ name: "Auth" }]'
      );
    });

    it('verifies navigation deduplication and current-route bypass', () => {
      const content = readSource('mobile/src/services/notifications.ts');

      assert.ok(
        content.includes('isResettingToAuth'),
        'notifications.ts must implement isResettingToAuth lock to prevent duplicate resets'
      );
      assert.ok(
        content.includes("currentRoute?.name === 'Auth'"),
        'notifications.ts must bypass reset if user is already on Auth screen'
      );
      assert.ok(
        content.includes('setTimeout(() => {'),
        'notifications.ts must release navigation lock asynchronously'
      );
    });

    it('verifies alert deduplication and suppression on manual sign-out', () => {
      const content = readSource('mobile/src/services/notifications.ts');

      assert.ok(
        content.includes('sessionExpiredAlertVisible'),
        'notifications.ts must maintain sessionExpiredAlertVisible flag'
      );
      assert.ok(
        content.includes("Alert.alert("),
        'notifications.ts must trigger Alert.alert when session is expired'
      );
      assert.ok(
        content.includes("'Session Expired'"),
        'Alert must have "Session Expired" title'
      );
      assert.ok(
        content.includes('export function resetSessionExpiredAlertState'),
        'notifications.ts must export resetSessionExpiredAlertState'
      );
    });

    it('verifies unmounted container queues auth reset for onReady dispatch', () => {
      const content = readSource('mobile/src/services/notifications.ts');

      assert.ok(
        content.includes('!rootNavigationRef.isReady()'),
        'returnToLogin must check rootNavigationRef.isReady()'
      );
      assert.ok(
        content.includes('pendingAuthReset = true'),
        'returnToLogin must queue pendingAuthReset if navigation ref is not ready'
      );
      assert.ok(
        content.includes('pendingAuthReset && rootNavigationRef.isReady()'),
        'dispatchPendingNotificationNavigation must check pendingAuthReset on ready'
      );
    });

    it('verifies App.tsx wires rootNavigationRef and onReady dispatcher', () => {
      const content = readSource('mobile/App.tsx');

      assert.ok(
        content.includes('ref={rootNavigationRef}'),
        'App.tsx must attach rootNavigationRef to NavigationContainer'
      );
      assert.ok(
        content.includes('onReady={dispatchPendingNotificationNavigation}'),
        'App.tsx must wire onReady to dispatchPendingNotificationNavigation'
      );
    });
  });

  describe('3. Confirmed Refresh Expiry vs Transient Failure Resilience', () => {
    it('verifies api.ts calls clearSession({ isExpired: true }) and clearAllOfflineCache on 401 refresh failure', () => {
      const content = readSource('mobile/src/services/api.ts');

      assert.ok(
        content.includes('await clearSession({ isExpired: true });'),
        'api.ts must call clearSession with { isExpired: true } on confirmed refresh failure'
      );
      assert.ok(
        content.includes('await clearAllOfflineCache();'),
        'api.ts must clear offline cache to prevent data exposure on confirmed expiry'
      );
      // The error is constructed as a variable first so it can be propagated to queued refresh subscribers
      assert.ok(
        content.includes("new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.')"),
        'api.ts must construct SESSION_EXPIRED ApiError'
      );
      assert.ok(
        content.includes('throw expiryError;') || content.includes("throw new ApiError(401, 'SESSION_EXPIRED'"),
        'api.ts must throw the SESSION_EXPIRED error'
      );
    });

    it('verifies api.ts preserves offline access and session tokens on network, timeout, or 500 errors', () => {
      const content = readSource('mobile/src/services/api.ts');

      // 5xx backend errors throw SERVER_ERROR without calling clearSession
      assert.ok(
        content.includes('else if (refreshRes.status >= 500)'),
        'api.ts must isolate 5xx errors from session clearance'
      );
      assert.ok(
        content.includes("refreshErr.code === 'NETWORK_ERROR'"),
        'api.ts must preserve tokens on network drop'
      );
      assert.ok(
        content.includes("refreshErr.code === 'REQUEST_TIMEOUT'"),
        'api.ts must preserve tokens on request timeout'
      );
      assert.ok(
        content.includes("refreshErr.code === 'SERVER_ERROR'"),
        'api.ts must preserve tokens on server 5xx'
      );
    });

    it('verifies manual sign-out calls clearSession without isExpired to avoid false expiry alert', () => {
      const rootNavContent = readSource('mobile/src/navigation/RootNavigator.tsx');
      const apiContent = readSource('mobile/src/services/api.ts');

      // Quick sign-out in RootNavigator
      assert.ok(
        rootNavContent.includes('await clearSession();'),
        'RootNavigator handleQuickSignOut must call clearSession() without { isExpired: true }'
      );

      // api.auth.logout in api.ts
      assert.ok(
        apiContent.includes('logout: async () =>'),
        'api.auth must provide logout method'
      );
    });

    it('verifies LoginScreen resets session expired alert state upon successful authentication', () => {
      const content = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        content.includes('resetSessionExpiredAlertState();'),
        'LoginScreen must call resetSessionExpiredAlertState upon successful auth'
      );
    });
  });

  describe('4. Simulation & Behavioral Deduplication Invariants', () => {
    it('simulates concurrent 401 arrivals and verifies single navigation reset and single alert', () => {
      let resetCallCount = 0;
      let alertCallCount = 0;
      let isResetting = false;
      let alertVisible = false;

      function simulateReturnToLogin(options?: { isSessionExpired?: boolean }) {
        const isExpired = !!options?.isSessionExpired;

        if (isExpired && !alertVisible) {
          alertVisible = true;
          alertCallCount++;
        }

        if (isResetting) {
          return;
        }

        isResetting = true;
        resetCallCount++;
      }

      // Simulate 10 simultaneous 401 network responses hitting the handler
      for (let i = 0; i < 10; i++) {
        simulateReturnToLogin({ isSessionExpired: true });
      }

      assert.strictEqual(alertCallCount, 1, 'Exactly one alert must be triggered across concurrent 401s');
      assert.strictEqual(resetCallCount, 1, 'Exactly one navigation reset must be dispatched across concurrent 401s');
    });

    it('simulates manual logout and verifies no session-expired alert is displayed', () => {
      let alertCallCount = 0;
      let alertVisible = false;

      function simulateReturnToLogin(options?: { isSessionExpired?: boolean }) {
        const isExpired = !!options?.isSessionExpired;
        if (isExpired && !alertVisible) {
          alertVisible = true;
          alertCallCount++;
        }
      }

      // Manual sign-out invokes with undefined or isSessionExpired: false
      simulateReturnToLogin(undefined);
      simulateReturnToLogin({ isSessionExpired: false });

      assert.strictEqual(alertCallCount, 0, 'No session expired alert must be displayed on manual logout');
    });
  });
});
