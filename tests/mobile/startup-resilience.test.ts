import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Mobile Startup & Android Runtime Resilience Verification', () => {
  const getFilePath = (relPath: string) => {
    const candidate1 = path.resolve(process.cwd(), relPath);
    const candidate2 = path.resolve(process.cwd(), relPath.replace('mobile/', ''));
    return fs.existsSync(candidate1) ? candidate1 : candidate2;
  };

  const readSource = (relPath: string) => fs.readFileSync(getFilePath(relPath), 'utf8');

  describe('1. Native Binary Dependency Parity & Lottie Isolation', () => {
    it('mobile/package.json must not include lottie-react-native to prevent unlinked native TurboModule crashes', () => {
      const packageJson = JSON.parse(readSource('mobile/package.json'));
      assert.strictEqual(
        packageJson.dependencies['lottie-react-native'],
        undefined,
        'mobile/package.json must not contain lottie-react-native'
      );
    });

    it('LoginScreen.tsx must not statically import lottie-react-native', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');
      assert.ok(
        !loginCode.includes("from 'lottie-react-native'"),
        'LoginScreen.tsx must not import from lottie-react-native'
      );
      assert.ok(
        !loginCode.includes('<LottieView'),
        'LoginScreen.tsx must not render LottieView'
      );
    });

    it('LoginScreen.tsx uses CelebrationBadge built with pure React Native Animated and Ionicons', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');
      assert.ok(
        loginCode.includes('function CelebrationBadge'),
        'LoginScreen.tsx must define CelebrationBadge component'
      );
      assert.ok(
        loginCode.includes('<CelebrationBadge isDark={isDark} />'),
        'LoginScreen.tsx must render CelebrationBadge on registration success'
      );
      assert.ok(
        loginCode.includes('Animated.spring') && loginCode.includes('Animated.timing'),
        'CelebrationBadge must use core Animated primitives'
      );
      assert.ok(
        loginCode.includes('name="checkmark-circle"'),
        'CelebrationBadge must use standard Ionicons checkmark'
      );
    });
  });

  describe('2. Startup Session Restoration & Timeout Guard', () => {
    it('RootNavigator.tsx implements bounded timeout on restoreSession()', () => {
      const rootNavCode = readSource('mobile/src/navigation/RootNavigator.tsx');
      assert.ok(
        rootNavCode.includes('Promise.race'),
        'restoreSession must use Promise.race to prevent indefinite splash hangs'
      );
      assert.ok(
        rootNavCode.includes('setTimeout') && (rootNavCode.includes('2500') || rootNavCode.includes('3000')),
        'restoreSession must configure a 2500-3000ms bounded timeout'
      );
    });

    it('restoreSession() timeout fallback preserves stored credentials without calling clearSession()', () => {
      const rootNavCode = readSource('mobile/src/navigation/RootNavigator.tsx');
      const restoreBlock = rootNavCode.slice(
        rootNavCode.indexOf('const restoreSession = async () =>'),
        rootNavCode.indexOf('if (!initialRoute)')
      );
      assert.ok(
        !restoreBlock.includes('clearSession'),
        'restoreSession fallback must not call clearSession when session restoration is slow'
      );
      assert.ok(
        restoreBlock.includes("setInitialRoute(targetRoute)") || restoreBlock.includes("setInitialRoute('Auth')"),
        'restoreSession must set initial route to enable user interaction'
      );
    });
  });

  describe('3. Root Navigation Error Boundary', () => {
    it('RootNavigator.tsx defines and exports RootErrorBoundary component', () => {
      const rootNavCode = readSource('mobile/src/navigation/RootNavigator.tsx');
      assert.ok(
        rootNavCode.includes('export class RootErrorBoundary extends React.Component'),
        'RootNavigator.tsx must declare RootErrorBoundary class'
      );
      assert.ok(
        rootNavCode.includes('getDerivedStateFromError'),
        'RootErrorBoundary must implement getDerivedStateFromError lifecycle'
      );
      assert.ok(
        rootNavCode.includes('componentDidCatch'),
        'RootErrorBoundary must implement componentDidCatch lifecycle'
      );
    });

    it('RootNavigator wraps Stack.Navigator within RootErrorBoundary', () => {
      const rootNavCode = readSource('mobile/src/navigation/RootNavigator.tsx');
      assert.ok(
        rootNavCode.includes('<RootErrorBoundary>\n      <Stack.Navigator') ||
          rootNavCode.includes('<RootErrorBoundary>') && rootNavCode.includes('</RootErrorBoundary>'),
        'Stack.Navigator must be wrapped with RootErrorBoundary'
      );
    });

    it('RootErrorBoundary displays user-friendly recovery UI and Try Again / Reload button', () => {
      const rootNavCode = readSource('mobile/src/navigation/RootNavigator.tsx');
      assert.ok(
        rootNavCode.includes('Unable to Load Screen'),
        'RootErrorBoundary must display clear headline'
      );
      assert.ok(
        rootNavCode.includes('accessibilityLabel="Reload application"'),
        'RootErrorBoundary must provide accessible Reload button'
      );
    });
  });

  describe('4. Hermes-Safe JWT Decoding & Token Handling', () => {
    it('google-auth.ts defines Hermes-safe fallback base64 decoder in extractEmailFromJwt', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');
      assert.ok(
        authCode.includes('decodeBase64Safe'),
        'Must define decodeBase64Safe helper'
      );
      assert.ok(
        authCode.includes('extractEmailFromJwt'),
        'Must export extractEmailFromJwt'
      );
      assert.ok(
        authCode.includes('decodeBase64Safe(padded)'),
        'extractEmailFromJwt must utilize decodeBase64Safe'
      );
    });

    it('evaluates standalone decodeBase64Safe logic on standard JWT payload', () => {
      const mockPayload = Buffer.from(
        JSON.stringify({
          email: 'nurse.sarah@rota.local',
          email_verified: true,
          name: 'Sarah Jenkins',
        })
      )
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const padded = mockPayload.padEnd(mockPayload.length + ((4 - (mockPayload.length % 4)) % 4), '=');
      const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');

      // Test standalone decoder logic matching implementation
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      const str = base64.replace(/=+$/, '');
      let output = '';
      for (
        let bc = 0, bs = 0, buffer: number, idx = 0;
        (buffer = chars.indexOf(str.charAt(idx++)));
        ~buffer &&
        ((bs = bc % 4 ? bs * 64 + buffer : buffer),
        bc++ % 4)
          ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
          : 0
      ) {}

      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.email, 'nurse.sarah@rota.local');
    });
  });

  describe('5. Account Linking Payload Conformance', () => {
    it('LoginScreen.tsx validates password presence before calling linkGoogleAccount', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');
      const linkingHandler = loginCode.slice(
        loginCode.indexOf('const handleConfirmAccountLink = async () =>'),
        loginCode.indexOf('if (registrationSuccess)')
      );
      assert.ok(
        linkingHandler.includes('if (!linkingPassword)'),
        'Must validate linkingPassword is non-empty'
      );
      assert.ok(
        linkingHandler.includes('api.auth.linkGoogleAccount(linkingEmail, linkingPassword, linkingIdToken)'),
        'Must invoke linkGoogleAccount with exact parameter signature'
      );
    });
  });
});
