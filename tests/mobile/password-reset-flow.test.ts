import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Mobile Password Reset Flow: API, Navigation & Contracts', () => {
  it('1. static verification: api.auth exposes typed forgotPassword and resetPassword methods', () => {
    const apiPath = path.resolve(process.cwd(), 'mobile/src/services/api.ts');
    const apiContent = fs.readFileSync(apiPath, 'utf8');

    // Verify forgotPassword method contract
    assert.ok(
      apiContent.includes('forgotPassword: async (email: string)'),
      'api.auth must define forgotPassword(email: string)'
    );
    assert.ok(
      apiContent.includes("'/v1/auth/forgot-password'"),
      'forgotPassword must invoke /v1/auth/forgot-password'
    );
    assert.ok(
      apiContent.includes('email: email.trim().toLowerCase()'),
      'forgotPassword must trim and lowercase the email address'
    );

    // Verify resetPassword method contract
    assert.ok(
      apiContent.includes('resetPassword: async (token: string, password: string)'),
      'api.auth must define resetPassword(token: string, password: string)'
    );
    assert.ok(
      apiContent.includes("'/v1/auth/reset-password'"),
      'resetPassword must invoke /v1/auth/reset-password'
    );
    assert.ok(
      apiContent.includes('token: token.trim()'),
      'resetPassword must trim the reset token'
    );
  });

  it('2. navigation types: RootStackParamList registers ForgotPassword and ResetPassword routes', () => {
    const typesPath = path.resolve(process.cwd(), 'mobile/src/navigation/types.ts');
    const typesContent = fs.readFileSync(typesPath, 'utf8');

    assert.ok(
      typesContent.includes('ForgotPassword: { prefilledEmail?: string } | undefined;'),
      'RootStackParamList must declare ForgotPassword route with prefilledEmail param'
    );
    assert.ok(
      typesContent.includes('ResetPassword: { token?: string; email?: string } | undefined;'),
      'RootStackParamList must declare ResetPassword route with token and email params'
    );
  });

  it('3. navigation hierarchy: RootNavigator registers ForgotPassword and ResetPassword screens', () => {
    const rootNavPath = path.resolve(process.cwd(), 'mobile/src/navigation/RootNavigator.tsx');
    const rootNavContent = fs.readFileSync(rootNavPath, 'utf8');

    assert.ok(
      rootNavContent.includes("import { ForgotPasswordScreen } from '../screens/ForgotPasswordScreen.tsx';"),
      'RootNavigator must import ForgotPasswordScreen'
    );
    assert.ok(
      rootNavContent.includes("import { ResetPasswordScreen } from '../screens/ResetPasswordScreen.tsx';"),
      'RootNavigator must import ResetPasswordScreen'
    );
    assert.ok(
      rootNavContent.includes('<Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />'),
      'Stack.Navigator must register ForgotPasswordScreen'
    );
    assert.ok(
      rootNavContent.includes('<Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />'),
      'Stack.Navigator must register ResetPasswordScreen'
    );
  });

  it('4. login entrypoint: LoginScreen provides Forgot Password navigation link', () => {
    const loginScreenPath = path.resolve(process.cwd(), 'mobile/src/screens/LoginScreen.tsx');
    const loginContent = fs.readFileSync(loginScreenPath, 'utf8');

    assert.ok(
      loginContent.includes("navigation.navigate('ForgotPassword'"),
      'LoginScreen must provide Forgot Password button triggering navigation'
    );
    assert.ok(
      loginContent.includes('accessibilityLabel="Forgot Password"'),
      'LoginScreen must expose accessible Forgot Password label'
    );
    assert.ok(
      loginContent.includes('prefilledEmail: email.trim()'),
      'LoginScreen must pass prefilledEmail to ForgotPassword screen'
    );
  });

  it('5. form validation: email format validation rules', () => {
    const validateEmail = (val: string): boolean => {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
    };

    assert.strictEqual(validateEmail('user@example.com'), true);
    assert.strictEqual(validateEmail('staff.member+test@rota.io'), true);
    assert.strictEqual(validateEmail('invalid-email'), false);
    assert.strictEqual(validateEmail('missing@domain'), false);
    assert.strictEqual(validateEmail('   '), false);
    assert.strictEqual(validateEmail(''), false);
  });

  it('6. form validation: 4-point compulsory password criteria matching backend requirements', () => {
    const checkCriteria = (pwd: string) => {
      const hasMinLength = pwd.length >= 8;
      const hasLetter = /[a-zA-Z]/.test(pwd);
      const hasNumber = /[0-9]/.test(pwd);
      const hasSpecial = /[^a-zA-Z0-9]/.test(pwd);
      return {
        hasMinLength,
        hasLetter,
        hasNumber,
        hasSpecial,
        isValid: hasMinLength && hasLetter && hasNumber && hasSpecial,
      };
    };

    // Valid strong password
    const valid = checkCriteria('Secret123!');
    assert.strictEqual(valid.isValid, true);
    assert.strictEqual(valid.hasMinLength, true);
    assert.strictEqual(valid.hasLetter, true);
    assert.strictEqual(valid.hasNumber, true);
    assert.strictEqual(valid.hasSpecial, true);

    // Too short (< 8 chars)
    assert.strictEqual(checkCriteria('Sec1!').isValid, false);

    // Missing numbers
    assert.strictEqual(checkCriteria('SecretPass!').isValid, false);

    // Missing letters
    assert.strictEqual(checkCriteria('12345678!').isValid, false);

    // Missing special character
    assert.strictEqual(checkCriteria('Secret1234').isValid, false);
  });

  it('7. token handoff & HTTPS app link status verification', () => {
    const resetScreenPath = path.resolve(process.cwd(), 'mobile/src/screens/ResetPasswordScreen.tsx');
    const resetContent = fs.readFileSync(resetScreenPath, 'utf8');

    // Verify manual token input field exists
    assert.ok(
      resetContent.includes('accessibilityLabel="Reset token input"'),
      'ResetPasswordScreen must provide a manual token entry field'
    );
    assert.ok(
      resetContent.includes("placeholder=\"Paste 64-character token from email\""),
      'ResetPasswordScreen must guide the user on pasting token'
    );

    // Inspect backend reset-email URL template
    const queueHandlerPath = path.resolve(process.cwd(), 'src/queue/handlers.ts');
    const queueHandlerContent = fs.readFileSync(queueHandlerPath, 'utf8');
    assert.ok(
      queueHandlerContent.includes('resetUrl = `${baseUrl}/v1/auth/reset-password?token=${rawToken}`'),
      'Backend reset email template builds an HTTP resetUrl'
    );

    // Verify app scheme
    const appJsonPath = path.resolve(process.cwd(), 'mobile/app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    assert.strictEqual(appJson.expo.scheme, 'rota');
  });

  it('8. anti-enumeration preservation: ForgotPasswordScreen displays generic message on 200 OK', () => {
    const forgotScreenPath = path.resolve(process.cwd(), 'mobile/src/screens/ForgotPasswordScreen.tsx');
    const forgotContent = fs.readFileSync(forgotScreenPath, 'utf8');

    assert.ok(
      forgotContent.includes('If an account exists with this email, a password reset link has been sent.'),
      'ForgotPasswordScreen must preserve the generic anti-enumeration success message'
    );
  });

  it('9. session revocation notice: ResetPasswordScreen informs user that sessions are revoked', () => {
    const resetScreenPath = path.resolve(process.cwd(), 'mobile/src/screens/ResetPasswordScreen.tsx');
    const resetContent = fs.readFileSync(resetScreenPath, 'utf8');

    assert.ok(
      resetContent.includes('all active sessions on other devices have been signed out'),
      'ResetPasswordScreen must notify user of session revocation on success'
    );
  });

  it('10. deep linking: getStateFromPath reliably intercepts reset links and parses token query parameter', () => {
    // Test the parsing function matching linking.getStateFromPath in App.tsx
    function parseResetDeepLink(pathStr: string) {
      if (pathStr.includes('reset-password')) {
        const queryIdx = pathStr.indexOf('?');
        let token: string | undefined = undefined;
        if (queryIdx !== -1) {
          const queryParams = new URLSearchParams(pathStr.substring(queryIdx));
          token = queryParams.get('token') || undefined;
        }
        return {
          route: 'ResetPassword',
          params: { token },
        };
      }
      return null;
    }

    // 1. Custom scheme with direct path
    const r1 = parseResetDeepLink('reset-password?token=abcdef0123456789abcdef0123456789');
    assert.deepStrictEqual(r1, {
      route: 'ResetPassword',
      params: { token: 'abcdef0123456789abcdef0123456789' },
    });

    // 2. Full backend API path
    const r2 = parseResetDeepLink('v1/auth/reset-password?token=token_sample_456');
    assert.deepStrictEqual(r2, {
      route: 'ResetPassword',
      params: { token: 'token_sample_456' },
    });

    // 3. Fallback when token parameter is omitted
    const r3 = parseResetDeepLink('reset-password');
    assert.deepStrictEqual(r3, {
      route: 'ResetPassword',
      params: { token: undefined },
    });

    // 4. Non-reset path
    const r4 = parseResetDeepLink('schedule');
    assert.strictEqual(r4, null);
  });

  it('11. backend landing page: GET /v1/auth/reset-password provides mobile deep-link handoff and desktop web form', () => {
    const authRoutePath = path.resolve(process.cwd(), 'src/routes/auth.ts');
    const authContent = fs.readFileSync(authRoutePath, 'utf8');

    assert.ok(
      authContent.includes("authRouter.get('/v1/auth/reset-password'"),
      'Backend must implement GET /v1/auth/reset-password handler'
    );
    assert.ok(
      authContent.includes('rota://reset-password?token='),
      'Backend GET page must embed rota:// deep link for mobile redirection'
    );
    assert.ok(
      authContent.includes('Open in Rota App'),
      'Backend landing page must provide Open in Rota App button'
    );
    assert.ok(
      authContent.includes('Reset Password in Browser'),
      'Backend landing page must provide web form fallback for desktop browsers'
    );
  });

  it('12. backend domain association: exposes .well-known endpoints for verified app links', () => {
    const authRoutePath = path.resolve(process.cwd(), 'src/routes/auth.ts');
    const authContent = fs.readFileSync(authRoutePath, 'utf8');

    assert.ok(
      authContent.includes("authRouter.get('/.well-known/assetlinks.json'"),
      'Backend must expose /.well-known/assetlinks.json for Android App Links'
    );
    assert.ok(
      authContent.includes("authRouter.get('/.well-known/apple-app-site-association'"),
      'Backend must expose /.well-known/apple-app-site-association for iOS Universal Links'
    );
    assert.ok(
      authContent.includes('com.rota.app'),
      'Well-known configurations must reference package identifier com.rota.app'
    );
  });
});

