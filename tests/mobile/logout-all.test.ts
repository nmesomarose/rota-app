import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Mobile Logout from All Devices Verification (AUTH-11, AUTH-12)', () => {
  const getFilePath = (relPath: string) => {
    const candidate1 = path.resolve(process.cwd(), relPath);
    const candidate2 = path.resolve(process.cwd(), relPath.replace('mobile/', ''));
    return fs.existsSync(candidate1) ? candidate1 : candidate2;
  };

  const readSource = (relPath: string) => fs.readFileSync(getFilePath(relPath), 'utf8');

  describe('1. API Service Wrapper (mobile/src/services/api.ts)', () => {
    it('implements api.auth.logoutAll calling POST /v1/auth/logout-all', () => {
      const apiCode = readSource('mobile/src/services/api.ts');

      assert.ok(
        apiCode.includes('logoutAll: async () =>'),
        'api.auth must define logoutAll method'
      );
      assert.ok(
        apiCode.includes("apiRequest<{ success: boolean; message: string }>('/v1/auth/logout-all'"),
        'logoutAll must send POST request to /v1/auth/logout-all'
      );
    });

    it('clears credentials and offline cache on confirmed server success', () => {
      const apiCode = readSource('mobile/src/services/api.ts');
      const logoutAllBlock = apiCode.slice(apiCode.indexOf('logoutAll: async () =>'), apiCode.indexOf('deleteAccount:'));

      assert.ok(
        logoutAllBlock.includes('await clearSession()'),
        'logoutAll must call clearSession on successful execution'
      );
      assert.ok(
        logoutAllBlock.includes('await clearAllOfflineCache()'),
        'logoutAll must call clearAllOfflineCache on successful execution'
      );
      assert.ok(
        logoutAllBlock.includes('return result'),
        'logoutAll must return server response on confirmed success'
      );
    });

    it('preserves the existing single-device api.auth.logout implementation', () => {
      const apiCode = readSource('mobile/src/services/api.ts');

      assert.ok(
        apiCode.includes('logout: async () =>'),
        'api.auth.logout must be preserved'
      );
      assert.ok(
        apiCode.includes("apiRequest('/v1/auth/logout'"),
        'logout must continue calling /v1/auth/logout'
      );
    });
  });

  describe('2. Settings Screen Action & Security Section (SettingsScreen.tsx)', () => {
    it('renders Sign Out of All Devices action within Account & Security card', () => {
      const settingsCode = readSource('mobile/src/screens/SettingsScreen.tsx');

      assert.ok(
        settingsCode.includes('<Text style={styles.cardHeader}>Account & Security</Text>'),
        'Settings screen must feature an Account & Security section header'
      );
      assert.ok(
        settingsCode.includes('Active Sessions') || settingsCode.includes('Session Security'),
        'Settings screen must feature an active sessions section'
      );
      assert.ok(
        settingsCode.includes('Session Security (AUTH-11, AUTH-12)'),
        'Settings screen must document Session Security AUTH-11 and AUTH-12 requirements'
      );
      assert.ok(
        settingsCode.includes('accessibilityLabel="Sign Out of All Devices"'),
        'Sign Out of All Devices button must define accessible label'
      );
      assert.ok(
        settingsCode.includes('accessibilityRole="button"'),
        'Sign Out of All Devices action must declare button accessibility role'
      );
      assert.ok(
        settingsCode.includes('Sign Out of All Devices</Text>'),
        'Button must display Sign Out of All Devices text'
      );
    });

    it('requires explicit confirmation before issuing global revocation request', () => {
      const settingsCode = readSource('mobile/src/screens/SettingsScreen.tsx');

      assert.ok(
        settingsCode.includes('const handleLogoutAllPress = () =>'),
        'Must define handleLogoutAllPress trigger'
      );
      assert.ok(
        settingsCode.includes("Alert.alert("),
        'Must display Alert dialog before sending request'
      );
      assert.ok(
        settingsCode.includes("'Sign Out of All Devices'"),
        'Alert dialog title must match Sign Out of All Devices'
      );
      assert.ok(
        settingsCode.includes("style: 'destructive'"),
        'Confirmation button must use destructive styling'
      );
      assert.ok(
        settingsCode.includes("onPress: performLogoutAll"),
        'Confirmation button must invoke performLogoutAll on user confirmation'
      );
    });

    it('handles server failure safely without falsely claiming all devices were logged out', () => {
      const settingsCode = readSource('mobile/src/screens/SettingsScreen.tsx');
      const performBlock = settingsCode.slice(
        settingsCode.indexOf('const performLogoutAll = async () =>'),
        settingsCode.indexOf('const handleDeleteBusiness = () =>')
      );

      assert.ok(
        performBlock.includes('await api.auth.logoutAll()'),
        'performLogoutAll must invoke api.auth.logoutAll()'
      );
      assert.ok(
        performBlock.includes("Alert.alert('Sign Out All Devices Failed'"),
        'Must display failure alert on error and not claim success'
      );
      assert.ok(
        performBlock.includes('setLoggingOutAll(false)'),
        'Must reset loading spinner on failure'
      );
    });

    it('safely handles an already-expired session without infinite loop or unhandled crash', () => {
      const settingsCode = readSource('mobile/src/screens/SettingsScreen.tsx');
      const performBlock = settingsCode.slice(
        settingsCode.indexOf('const performLogoutAll = async () =>'),
        settingsCode.indexOf('const handleDeleteBusiness = () =>')
      );

      assert.ok(
        performBlock.includes("err.statusCode === 401 || err.code === 'SESSION_EXPIRED'"),
        'Must explicitly catch 401 or SESSION_EXPIRED responses'
      );
      assert.ok(
        performBlock.includes('await clearSession({ isExpired: true })'),
        'Must clear local session when session is already expired'
      );
      assert.ok(
        performBlock.includes("navigation.reset({"),
        'Must reset navigation container to Auth screen'
      );
    });

    it('preserves the existing single-device Sign Out action', () => {
      const settingsCode = readSource('mobile/src/screens/SettingsScreen.tsx');

      assert.ok(
        settingsCode.includes('const handleLogout = async () =>'),
        'handleLogout must remain intact'
      );
      assert.ok(
        settingsCode.includes('<Text style={styles.logoutButtonText}>Sign Out</Text>'),
        'Single-device Sign Out button must be preserved'
      );
    });
  });
});
