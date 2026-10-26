import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveNotificationTarget,
} from '../../mobile/src/services/notification-routing.ts';

describe('Mobile Push Notifications & Navigation Tap Routing', () => {
  describe('1. Notification Target Resolution (Tap Routing)', () => {
    it('routes billing alerts and failed subscription renewals to Billing screen', () => {
      const target1 = resolveNotificationTarget({ category: 'billing' });
      assert.deepStrictEqual(target1, { route: 'Billing' });

      const target2 = resolveNotificationTarget({
        category: 'billing',
        type: 'renewal_failed',
        plan: 'growth',
      });
      assert.deepStrictEqual(target2, { route: 'Billing' });

      const target3 = resolveNotificationTarget({
        type: 'renewal_failed',
      });
      assert.deepStrictEqual(target3, { route: 'Billing' });
    });

    it('routes published shift notifications to Schedule screen with shiftId', () => {
      const target = resolveNotificationTarget({
        category: 'shifts',
        shiftId: 'shift_abc_123',
        startsAt: '2026-10-23T09:00:00.000Z',
      });
      assert.deepStrictEqual(target, {
        route: 'Main',
        screen: 'Schedule',
        params: { shiftId: 'shift_abc_123' },
      });
    });

    it('routes shift changes (cancellations/updates) to Schedule screen', () => {
      const target = resolveNotificationTarget({
        category: 'shifts',
        shiftId: 'shift_xyz_789',
        changeType: 'cancelled',
      });
      assert.deepStrictEqual(target, {
        route: 'Main',
        screen: 'Schedule',
        params: { shiftId: 'shift_xyz_789' },
      });
    });

    it('routes swap requests and swap responses to Feed screen inbox tab', () => {
      const target = resolveNotificationTarget({
        category: 'swaps',
        swapId: 'swap_999',
        requesterShiftId: 'shift_1',
        counterpartShiftId: 'shift_2',
      });
      assert.deepStrictEqual(target, {
        route: 'Main',
        screen: 'Feed',
        params: { tab: 'inbox', swapId: 'swap_999' },
      });
    });

    it('routes mandatory security notices to Settings screen', () => {
      const target = resolveNotificationTarget({
        category: 'security',
      });
      assert.deepStrictEqual(target, {
        route: 'Main',
        screen: 'Settings',
      });
    });

    it('routes unrecognized or null payloads to Feed inbox fallback', () => {
      assert.deepStrictEqual(resolveNotificationTarget(null), {
        route: 'Main',
        screen: 'Feed',
        params: { tab: 'inbox' },
      });

      assert.deepStrictEqual(resolveNotificationTarget(undefined), {
        route: 'Main',
        screen: 'Feed',
        params: { tab: 'inbox' },
      });

      assert.deepStrictEqual(resolveNotificationTarget({ category: 'unknown_category' }), {
        route: 'Main',
        screen: 'Feed',
        params: { tab: 'inbox' },
      });
    });
  });

  describe('2. Device Identification & Storage Integration', () => {
    it('verifies storage.ts provides persistent getDeviceId and onClearSessionHook', () => {
      const candidate1 = path.resolve(process.cwd(), 'mobile/src/services/storage.ts');
      const candidate2 = path.resolve(process.cwd(), 'src/services/storage.ts');
      const storagePath = fs.existsSync(candidate1) ? candidate1 : candidate2;
      const content = fs.readFileSync(storagePath, 'utf8');

      assert.ok(
        content.includes('export async function getDeviceId'),
        'storage.ts must export getDeviceId for persistent device tracking'
      );
      assert.ok(
        content.includes('rota_device_id'),
        'storage.ts must define rota_device_id key in SecureStore'
      );
      assert.ok(
        content.includes('setOnClearSessionHook'),
        'storage.ts must provide setOnClearSessionHook to reset push tokens upon logout'
      );
    });
  });

  describe('3. Push Token Registration & Guardrails Static Verification', () => {
    it('verifies notifications.ts handles simulator, permissions, Android channel, and registration safety', () => {
      const candidate1 = path.resolve(process.cwd(), 'mobile/src/services/notifications.ts');
      const candidate2 = path.resolve(process.cwd(), 'src/services/notifications.ts');
      const notifPath = fs.existsSync(candidate1) ? candidate1 : candidate2;
      const content = fs.readFileSync(notifPath, 'utf8');

      // Check physical device check
      assert.ok(
        content.includes('Device.isDevice'),
        'notifications.ts must check Device.isDevice to avoid simulator push crashes'
      );

      // Check permission requests
      assert.ok(
        content.includes('requestPermissionsAsync'),
        'notifications.ts must request permissions using expo-notifications'
      );

      // Check Android notification channel
      assert.ok(
        content.includes('setNotificationChannelAsync'),
        'notifications.ts must configure Android default notification channel'
      );

      // Check backend API token registration
      assert.ok(
        content.includes('api.notifications.registerPushToken'),
        'notifications.ts must call api.notifications.registerPushToken'
      );

      // Check cold-start / terminated app check
      assert.ok(
        content.includes('getLastNotificationResponseAsync'),
        'notifications.ts must inspect getLastNotificationResponseAsync for cold starts'
      );

      // Check notification listeners
      assert.ok(
        content.includes('addNotificationReceivedListener') &&
        content.includes('addNotificationResponseReceivedListener'),
        'notifications.ts must attach received and response listeners'
      );

      // Check in-flight promise deduplication
      assert.ok(
        content.includes('activeRegistrationPromise'),
        'notifications.ts must deduplicate in-flight registration promises to prevent race conditions'
      );

      // Check expired session handling
      assert.ok(
        content.includes('SESSION_EXPIRED') && content.includes('status: \'unauthenticated\''),
        'notifications.ts must gracefully handle expired sessions without repeated unauthorized network attempts'
      );
    });

    it('verifies RootNavigator does not execute duplicate push registration calls on session restoration', () => {
      const candidate1 = path.resolve(process.cwd(), 'mobile/src/navigation/RootNavigator.tsx');
      const candidate2 = path.resolve(process.cwd(), 'src/navigation/RootNavigator.tsx');
      const rootNavPath = fs.existsSync(candidate1) ? candidate1 : candidate2;
      const content = fs.readFileSync(rootNavPath, 'utf8');

      // Verify restoreSession does not trigger registerForPushNotificationsAsync redundantly before MainTabs mounts
      const restoreSessionBlock = content.match(/const restoreSession = async \(\) => \{([\s\S]*?)\};/);
      assert.ok(restoreSessionBlock, 'RootNavigator must define restoreSession');
      assert.ok(
        !restoreSessionBlock[1].includes('registerForPushNotificationsAsync'),
        'restoreSession must not call registerForPushNotificationsAsync directly; MainTabs handles registration on mount'
      );
    });
  });

  describe('4. EAS Configuration & Plugin Verification', () => {
    it('verifies app.json contains expo-notifications plugin and valid EAS projectId', () => {
      const candidate1 = path.resolve(process.cwd(), 'mobile/app.json');
      const candidate2 = path.resolve(process.cwd(), 'app.json');
      const appJsonPath = fs.existsSync(candidate1) ? candidate1 : candidate2;
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

      // Check plugin registration
      const plugins = appJson.expo?.plugins || [];
      const hasNotificationPlugin = plugins.some((p: any) =>
        p === 'expo-notifications' || (Array.isArray(p) && p[0] === 'expo-notifications')
      );
      assert.ok(hasNotificationPlugin, 'app.json must include expo-notifications in plugins');

      // Check EAS projectId
      const projectId = appJson.expo?.extra?.eas?.projectId;
      assert.ok(typeof projectId === 'string' && projectId.length > 0, 'app.json must have EAS projectId configured');

      // Check Android package and googleServicesFile
      assert.strictEqual(appJson.expo?.android?.package, 'com.rota.app');
      assert.strictEqual(appJson.expo?.android?.googleServicesFile, './google-services.json');

      // Check eas.json development profile specifies APK buildType
      const easJsonCandidate1 = path.resolve(process.cwd(), 'mobile/eas.json');
      const easJsonCandidate2 = path.resolve(process.cwd(), 'eas.json');
      const easJsonPath = fs.existsSync(easJsonCandidate1) ? easJsonCandidate1 : easJsonCandidate2;
      const easJson = JSON.parse(fs.readFileSync(easJsonPath, 'utf8'));
      assert.strictEqual(
        easJson.build?.development?.android?.buildType,
        'apk',
        'eas.json development profile must specify android.buildType: apk for installable APKs'
      );
    });

    it('verifies package.json includes expo-dev-client, expo-notifications, expo-device, and expo-constants', () => {
      const candidate1 = path.resolve(process.cwd(), 'mobile/package.json');
      const candidate2 = path.resolve(process.cwd(), 'package.json');
      const pkgJsonPath = fs.existsSync(candidate1) ? candidate1 : candidate2;
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

      assert.ok(pkgJson.dependencies['expo-dev-client'], 'expo-dev-client must be in dependencies for development builds');
      assert.ok(pkgJson.dependencies['expo-notifications'], 'expo-notifications must be in dependencies');
      assert.ok(pkgJson.dependencies['expo-device'], 'expo-device must be in dependencies');
      assert.ok(pkgJson.dependencies['expo-constants'], 'expo-constants must be in dependencies');
    });
  });
});
