import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Native Mobile Google Sign-In Verification (FR-AUTH-002, FR-AUTH-011, AC-AUTH-04, AC-AUTH-05)', () => {
  const getFilePath = (relPath: string) => {
    const candidate1 = path.resolve(process.cwd(), relPath);
    const candidate2 = path.resolve(process.cwd(), relPath.replace('mobile/', ''));
    return fs.existsSync(candidate1) ? candidate1 : candidate2;
  };

  const readSource = (relPath: string) => fs.readFileSync(getFilePath(relPath), 'utf8');

  describe('1. Native Google Authentication Architecture (mobile/src/services/google-auth.ts)', () => {
    it('uses @react-native-google-signin/google-signin for native account selection', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes("@react-native-google-signin/google-signin"),
        'Must reference @react-native-google-signin/google-signin'
      );
      assert.ok(
        authCode.includes('GoogleSignin.configure'),
        'Must configure GoogleSignin with webClientId'
      );
      assert.ok(
        authCode.includes('GoogleSignin.hasPlayServices'),
        'Must check Google Play Services availability'
      );
      assert.ok(
        authCode.includes('GoogleSignin.signIn'),
        'Must invoke native GoogleSignin.signIn account picker'
      );
    });

    it('removes insecure browser-based OAuth implicit flow implementations', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        !authCode.includes('openAuthSessionAsync'),
        'Must not use openAuthSessionAsync browser sessions'
      );
      assert.ok(
        !authCode.includes('buildGoogleAuthUrl'),
        'Must not construct manual browser OAuth URLs'
      );
      assert.ok(
        !authCode.includes('extractIdTokenFromUrl'),
        'Must not extract tokens from URL hash fragments'
      );
      assert.ok(
        !authCode.includes('generateNonce'),
        'Obsolete browser nonce generator must be removed'
      );
      assert.ok(
        !authCode.includes('expo-web-browser'),
        'google-auth.ts must not import expo-web-browser'
      );
    });

    it('handles Google Play Services unavailability gracefully', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes('PLAY_SERVICES_NOT_AVAILABLE'),
        'Must detect PLAY_SERVICES_NOT_AVAILABLE status'
      );
      assert.ok(
        authCode.includes("code: 'PLAY_SERVICES_UNAVAILABLE'"),
        'Must return user-friendly PLAY_SERVICES_UNAVAILABLE error'
      );
    });

    it('handles user cancellation without throwing errors', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes('SIGN_IN_CANCELLED'),
        'Must catch SIGN_IN_CANCELLED code'
      );
      assert.ok(
        authCode.includes("response.type === 'cancelled'"),
        'Must detect cancelled response type'
      );
      assert.ok(
        authCode.includes("return { type: 'cancel' }"),
        'Must return { type: cancel } on user dismissal'
      );
    });

    it('prevents concurrent in-flight authentication requests with an in-progress guard', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes('isAuthInProgress'),
        'Must maintain an isAuthInProgress mutex'
      );
      assert.ok(
        authCode.includes('IN_PROGRESS'),
        'Must handle native IN_PROGRESS error status'
      );
    });

    it('safely handles missing environment configuration without crashing', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes("code: 'CONFIG_REQUIRED'"),
        'Must return CONFIG_REQUIRED error code when Web Client ID is unset'
      );
    });

    it('persists session tokens and user profile to SecureStore upon backend confirmation', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes('await setAccessToken(authData.tokens.accessToken)'),
        'Must persist accessToken via SecureStore'
      );
      assert.ok(
        authCode.includes('await setRefreshToken(authData.tokens.refreshToken)'),
        'Must persist refreshToken via SecureStore'
      );
      assert.ok(
        authCode.includes('await setUserProfile(authData.user)'),
        'Must persist user profile via SecureStore'
      );
    });

    it('handles ACCOUNT_LINKING_REQUIRED (HTTP 409) for safe password re-auth', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes("err.code === 'ACCOUNT_LINKING_REQUIRED' || err.statusCode === 409"),
        'Must catch ACCOUNT_LINKING_REQUIRED error code and 409 status'
      );
      assert.ok(
        authCode.includes("type: 'linking_required'"),
        'Must return linking_required result type'
      );
    });

    it('robustly resolves account linking email from error details, native prompt, or JWT token', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');

      assert.ok(
        authCode.includes('extractEmailFromJwt'),
        'Must define extractEmailFromJwt helper for JWT payload email decoding'
      );
      assert.ok(
        authCode.includes('errorDetails?.email || promptEmail || extractEmailFromJwt(idToken)'),
        'Must prioritize errorDetails.email, promptEmail, and fallback to extractEmailFromJwt'
      );
    });
  });

  describe('2. Expo App Configuration (mobile/app.json)', () => {
    it('declares @react-native-google-signin/google-signin in config plugins', () => {
      const appJson = readSource('mobile/app.json');

      assert.ok(
        appJson.includes('"@react-native-google-signin/google-signin"'),
        'app.json must declare @react-native-google-signin/google-signin in plugins'
      );
    });

    it('maintains Android package name com.rota.app matching Google Cloud credentials', () => {
      const appJson = readSource('mobile/app.json');

      assert.ok(
        appJson.includes('"package": "com.rota.app"'),
        'app.json must define Android package com.rota.app'
      );
      assert.ok(
        appJson.includes('"googleServicesFile": "./google-services.json"'),
        'app.json must reference googleServicesFile'
      );
    });
  });

  describe('3. Login Screen UI & Handlers (LoginScreen.tsx)', () => {
    it('renders Continue with Google button with accessible label and role', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('accessibilityLabel="Continue with Google"'),
        'Must declare accessible label "Continue with Google"'
      );
      assert.ok(
        loginCode.includes('accessibilityRole="button"'),
        'Must declare accessibility role "button"'
      );
      assert.ok(
        loginCode.includes('<Text style={styles.googleButtonText}>Continue with Google</Text>'),
        'Must display "Continue with Google" text'
      );
      assert.ok(
        loginCode.includes('<GoogleLogo size={20} />'),
        'Must render vector Google logo mark'
      );
    });

    it('renders visual separator between Google Sign-In and email forms', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('or continue with email</Text>'),
        'Must display "or continue with email" divider'
      );
      assert.ok(
        loginCode.includes('styles.orDividerContainer'),
        'Must use divider container style'
      );
    });

    it('prevents duplicate concurrent authentication submissions', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('if (googleLoading || loading) return;'),
        'handleGoogleSignIn must guard against concurrent submissions'
      );
      assert.ok(
        loginCode.includes('disabled={loading || googleLoading}'),
        'Google button must be disabled when loading or googleLoading'
      );
      assert.ok(
        loginCode.includes('setGoogleLoading(true)'),
        'Must set googleLoading active before async execution'
      );
    });

    it('preserves pending invitation token upon successful Google authentication', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');
      const googleHandlerBlock = loginCode.slice(
        loginCode.indexOf('const handleGoogleSignIn = async () =>'),
        loginCode.indexOf('const handleConfirmAccountLink = async () =>')
      );

      assert.ok(
        googleHandlerBlock.includes("if (pendingInviteToken) {\n          navigation.replace('AcceptInvitation', { token: pendingInviteToken });"),
        'Must route to AcceptInvitation with pendingInviteToken on Google sign in success'
      );
    });

    it('navigates to Main Schedule when single business is assigned', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');
      const googleHandlerBlock = loginCode.slice(
        loginCode.indexOf('const handleGoogleSignIn = async () =>'),
        loginCode.indexOf('const handleConfirmAccountLink = async () =>')
      );

      assert.ok(
        googleHandlerBlock.includes("else if (result.activeBusinessId && result.businesses.length === 1)"),
        'Must check single active business context'
      );
      assert.ok(
        googleHandlerBlock.includes("navigation.replace('Main', { screen: 'Schedule' })"),
        'Must navigate to Main Schedule'
      );
      assert.ok(
        googleHandlerBlock.includes("navigation.replace('BusinessSelect')"),
        'Must navigate to BusinessSelect if multi-business or no active business'
      );
    });

    it('renders Account Linking modal and requires password re-authentication', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('Link Google Account</Text>'),
        'Must render Link Google Account modal title'
      );
      assert.ok(
        loginCode.includes('api.auth.linkGoogleAccount(linkingEmail, linkingPassword, linkingIdToken)'),
        'Must call api.auth.linkGoogleAccount on password confirmation'
      );
    });

    it('adds a working show/hide password toggle to the account-linking password field', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('showLinkingPassword'),
        'Must declare showLinkingPassword state'
      );
      assert.ok(
        loginCode.includes('setShowLinkingPassword'),
        'Must provide setShowLinkingPassword updater'
      );
      assert.ok(
        loginCode.includes('secureTextEntry={!showLinkingPassword}'),
        'Must toggle secureTextEntry based on showLinkingPassword state'
      );
      assert.ok(
        loginCode.includes('<EyeIcon visible={showLinkingPassword}'),
        'Must render EyeIcon reflecting showLinkingPassword state'
      );
    });

    it('provides an accessible Forgot Password recovery path from the account-linking modal', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes("navigation.navigate('ForgotPassword'"),
        'Must navigate to ForgotPassword screen'
      );
      assert.ok(
        loginCode.includes('prefilledEmail: linkingEmail'),
        'Must pass prefilledEmail: linkingEmail to ForgotPassword screen'
      );
    });

    it('uses official Google branding asset in GoogleLogo and modal header', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes("require('../../assets/google-logo.png')"),
        'Must reference official Google logo asset from assets/google-logo.png'
      );
      assert.ok(
        loginCode.includes('accessibilityLabel="Google logo"'),
        'Must provide accessible label for Google logo'
      );
    });

    it('provides accessible modal dismiss and cancel actions that reset linking state', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('handleCloseLinkingModal'),
        'Must define handleCloseLinkingModal'
      );
      assert.ok(
        loginCode.includes('accessibilityLabel="Cancel linking"'),
        'Must declare accessible Cancel button'
      );
    });

    it('preserves existing email/password login and registration functionality', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('const handleAuth = async () =>'),
        'Must retain handleAuth for email/password authentication'
      );
      assert.ok(
        loginCode.includes('api.auth.login(trimmedEmail, password)'),
        'Must retain api.auth.login invocation'
      );
      assert.ok(
        loginCode.includes('api.auth.register(trimmedEmail, password'),
        'Must retain api.auth.register invocation'
      );
    });
  });

  describe('4. Security Requirements & Secrets Isolation', () => {
    it('never embeds Google client secrets in the mobile source or config', () => {
      const apiCode = readSource('mobile/src/services/api.ts');
      const authCode = readSource('mobile/src/services/google-auth.ts');
      const appJson = readSource('mobile/app.json');
      const configCode = readSource('mobile/src/services/api-config.ts');

      assert.ok(
        !apiCode.includes('GOOGLE_CLIENT_SECRET'),
        'api.ts must never contain Google client secrets'
      );
      assert.ok(
        !authCode.includes('GOOGLE_CLIENT_SECRET'),
        'google-auth.ts must never contain Google client secrets'
      );
      assert.ok(
        !appJson.includes('client_secret'),
        'app.json must never contain Google client secrets'
      );
      assert.ok(
        !configCode.includes('GOOGLE_CLIENT_SECRET'),
        'api-config.ts must never reference Google client secrets'
      );
    });

    it('never logs raw Google ID tokens or session tokens', () => {
      const authCode = readSource('mobile/src/services/google-auth.ts');
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        !authCode.includes('console.log(idToken'),
        'google-auth.ts must not log idToken'
      );
      assert.ok(
        !authCode.includes('console.log(authData.tokens'),
        'google-auth.ts must not log session tokens'
      );
      assert.ok(
        !loginCode.includes('console.log(linkingIdToken'),
        'LoginScreen.tsx must not log linkingIdToken'
      );
    });
  });

  describe('5. Mobile API Configuration (api-config.ts)', () => {
    it('exports getGoogleWebClientId aligned with backend audience requirements', () => {
      const configCode = readSource('mobile/src/services/api-config.ts');

      assert.ok(
        configCode.includes('getGoogleClientId') || configCode.includes('getGoogleWebClientId'),
        'api-config.ts must export Web Client ID resolver'
      );
      assert.ok(
        configCode.includes('EXPO_PUBLIC_GOOGLE_CLIENT_ID') || configCode.includes('EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'),
        'Must read EXPO_PUBLIC_GOOGLE_CLIENT_ID or EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'
      );
    });
  });

  describe('6. Authentication Guidance & Error Clarity (LoginScreen.tsx - Tasks 1 & 2)', () => {
    it('renders guidance hint explaining Continue with Google for registered Google accounts', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('styles.authGuidanceHint'),
        'LoginScreen must render authGuidanceHint container'
      );
      assert.ok(
        loginCode.includes('Registered with Google? Tap "Continue with Google" above.'),
        'LoginScreen must explain Google sign-in on login tab'
      );
      assert.ok(
        loginCode.includes('Tip: You can also tap "Continue with Google" to create your account instantly.'),
        'LoginScreen must explain Google sign-up on registration tab'
      );
    });

    it('guides Google users on 401 while preserving generic backend authentication error (Task 1 & 2)', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes("err.statusCode === 401"),
        'LoginScreen must intercept 401 error status'
      );
      assert.ok(
        loginCode.includes('Invalid email or password. If you registered with Google, please use "Continue with Google" above.'),
        'LoginScreen must guide Google users on 401 without weakening backend anti-enumeration'
      );
    });

    it('guides existing account owners on 409 registration conflict', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes("err.code === 'EMAIL_ALREADY_EXISTS'"),
        'LoginScreen must intercept EMAIL_ALREADY_EXISTS'
      );
      assert.ok(
        loginCode.includes('An account with this email already exists. Switch to Sign In above to log in with your password or Continue with Google.'),
        'LoginScreen must provide actionable direction on email conflict'
      );
    });
  });
});

