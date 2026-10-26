import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Mobile Invitation Acceptance Flow Verification (FR-AUTH-007, AC-INV-01..06, BILL-009)', () => {
  const getFilePath = (relPath: string) => {
    const candidate1 = path.resolve(process.cwd(), relPath);
    const candidate2 = path.resolve(process.cwd(), relPath.replace('mobile/', ''));
    return fs.existsSync(candidate1) ? candidate1 : candidate2;
  };

  const readSource = (relPath: string) => fs.readFileSync(getFilePath(relPath), 'utf8');

  describe('1. API Service Contracts (mobile/src/services/api.ts)', () => {
    it('defines api.organizations.getInvitation calling public GET endpoint', () => {
      const apiCode = readSource('mobile/src/services/api.ts');

      assert.ok(
        apiCode.includes('getInvitation: async (token: string) =>'),
        'api.organizations must export getInvitation method'
      );
      assert.ok(
        apiCode.includes('/v1/organizations/invitations/${encodeURIComponent(token.trim())}'),
        'getInvitation must target /v1/organizations/invitations/:token with encoded token'
      );
      assert.ok(
        apiCode.includes("method: 'GET'"),
        'getInvitation must use GET method'
      );
    });

    it('defines api.organizations.acceptInvitation calling protected POST endpoint with token body', () => {
      const apiCode = readSource('mobile/src/services/api.ts');

      assert.ok(
        apiCode.includes('acceptInvitation: async (token: string) =>'),
        'api.organizations must export acceptInvitation method'
      );
      assert.ok(
        apiCode.includes("'/v1/organizations/invitations/accept'"),
        'acceptInvitation must target /v1/organizations/invitations/accept'
      );
      assert.ok(
        apiCode.includes("body: JSON.stringify({ token: token.trim() })"),
        'acceptInvitation must submit token in JSON body'
      );
    });

    it('never sends client-supplied unverified businessId or role in acceptInvitation body', () => {
      const apiCode = readSource('mobile/src/services/api.ts');
      const acceptBlock = apiCode.slice(
        apiCode.indexOf('acceptInvitation: async (token: string) =>'),
        apiCode.indexOf('scheduling: {')
      );
      const bodyLine = acceptBlock.slice(acceptBlock.indexOf('body:'), acceptBlock.indexOf('})'));

      assert.ok(
        !bodyLine.includes('businessId'),
        'acceptInvitation request body must not submit client-provided businessId'
      );
      assert.ok(
        !bodyLine.includes('role'),
        'acceptInvitation request body must not submit client-provided role'
      );
      assert.ok(
        bodyLine.includes('token: token.trim()'),
        'acceptInvitation request body must only submit sanitized token'
      );
    });
  });

  describe('2. Navigation Types & Deep Linking (types.ts & App.tsx)', () => {
    it('registers typed AcceptInvitation route in RootStackParamList', () => {
      const typesCode = readSource('mobile/src/navigation/types.ts');

      assert.ok(
        typesCode.includes('AcceptInvitation: { token?: string }'),
        'RootStackParamList must declare AcceptInvitation with optional token'
      );
      assert.ok(
        typesCode.includes('Auth: { initialMode?: \'login\' | \'signup\'; pendingInviteToken?: string; prefilledEmail?: string } | undefined'),
        'RootStackParamList must support pendingInviteToken and prefilledEmail on Auth route'
      );
    });

    it('configures deep link parsing for rota://invite/:token and backend web links', () => {
      const appCode = readSource('mobile/App.tsx');

      assert.ok(
        appCode.includes("path.includes('invite') || path.includes('invitations')"),
        'App.tsx getStateFromPath must detect invite and invitations paths'
      );
      assert.ok(
        appCode.includes("name: 'AcceptInvitation'"),
        'getStateFromPath must route invite paths to AcceptInvitation screen'
      );
      assert.ok(
        appCode.includes("AcceptInvitation: 'invite/:token'"),
        'linking.config.screens must map AcceptInvitation to invite/:token'
      );
    });

    it('extracts token from both query parameters (?token=...) and path segments (/invite/...)', () => {
      const appCode = readSource('mobile/App.tsx');
      const linkingBlock = appCode.slice(
        appCode.indexOf("path.includes('invite') || path.includes('invitations')"),
        appCode.indexOf('return getStateFromPath(path, options);')
      );

      assert.ok(
        linkingBlock.includes("queryParams.get('token')"),
        'Linking must check query parameter token'
      );
      assert.ok(
        linkingBlock.includes("segments.findIndex"),
        'Linking must check path segments for token'
      );
    });
  });

  describe('3. Login & Registration Invitation Preservation (LoginScreen.tsx)', () => {
    it('receives pendingInviteToken and prefilledEmail from navigation route', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('export function LoginScreen({ navigation, route }: Props)'),
        'LoginScreen must receive route props'
      );
      assert.ok(
        loginCode.includes('const pendingInviteToken = route?.params?.pendingInviteToken;'),
        'LoginScreen must extract pendingInviteToken'
      );
      assert.ok(
        loginCode.includes('const prefilledEmail = route?.params?.prefilledEmail;'),
        'LoginScreen must extract prefilledEmail'
      );
    });

    it('displays pending invitation notice banner when token is present', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes('{pendingInviteToken && ('),
        'LoginScreen must conditionally render banner for pending invite'
      );
      assert.ok(
        loginCode.includes('Pending Team Invitation</Text>'),
        'LoginScreen must display Pending Team Invitation title'
      );
    });

    it('redirects to AcceptInvitation after successful registration without losing token', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes("if (pendingInviteToken) {\n            navigation.replace('AcceptInvitation', { token: pendingInviteToken });"),
        'Registration success timeout must redirect to AcceptInvitation when pendingInviteToken is present'
      );
    });

    it('redirects to AcceptInvitation after successful login without losing token', () => {
      const loginCode = readSource('mobile/src/screens/LoginScreen.tsx');

      assert.ok(
        loginCode.includes("if (pendingInviteToken) {\n          navigation.replace('AcceptInvitation', { token: pendingInviteToken });"),
        'Login success handler must redirect to AcceptInvitation when pendingInviteToken is present'
      );
    });
  });

  describe('4. Mobile Acceptance Screen (AcceptInvitationScreen.tsx)', () => {
    it('loads invitation preview via public endpoint on mount', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes('api.organizations.getInvitation(tokenToFetch)'),
        'Screen must call getInvitation to fetch preview'
      );
      assert.ok(
        screenCode.includes('setInvitation(data.invitation)'),
        'Screen must store invitation preview in state'
      );
    });

    it('provides clear unauthenticated view directing invitee to sign in or create account', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes("navigation.replace('Auth', {\n                    initialMode: 'login',\n                    pendingInviteToken: token,\n                    prefilledEmail: invitation.email,\n                  })"),
        'Sign in button must pass pendingInviteToken and prefilledEmail'
      );
      assert.ok(
        screenCode.includes("navigation.replace('Auth', {\n                    initialMode: 'signup',\n                    pendingInviteToken: token,\n                    prefilledEmail: invitation.email,\n                  })"),
        'Create account button must pass initialMode: signup with pendingInviteToken and prefilledEmail'
      );
    });

    it('strictly checks email matching before permitting acceptance', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes('invitation.email.trim().toLowerCase() === currentUser.email.trim().toLowerCase()'),
        'Must compare currentUser email against invitation email case-insensitively'
      );
      assert.ok(
        screenCode.includes('Account Mismatch</Text>'),
        'Must display Account Mismatch notice on email divergence'
      );
      assert.ok(
        screenCode.includes('Switch Account</Text>'),
        'Must offer Switch Account action when email does not match'
      );
    });

    it('clears previous tenant caches and updates active business context on acceptance', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes('await api.organizations.acceptInvitation(token)'),
        'Must call api.organizations.acceptInvitation'
      );
      assert.ok(
        screenCode.includes('await clearAllOfflineCache()'),
        'Must clear offline cache on invitation acceptance'
      );
      assert.ok(
        screenCode.includes('await clearAllTenantQueries()'),
        'Must clear TanStack Query cache on invitation acceptance'
      );
      assert.ok(
        screenCode.includes('await api.organizations.switchBusiness(result.membership.businessId)'),
        'Must switch business context to accepted organization'
      );
      assert.ok(
        screenCode.includes('await setActiveBusiness({'),
        'Must persist active business context in SecureStore'
      );
      assert.ok(
        screenCode.includes("navigation.replace('Main', { screen: 'Schedule' })"),
        'Must navigate to Main Schedule after successful acceptance'
      );
    });

    it('handles expired, already-used, seat-limit, and revoked error states clearly', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes("errorCode === 'INVITATION_EXPIRED'"),
        'Must detect and display INVITATION_EXPIRED'
      );
      assert.ok(
        screenCode.includes("errorCode === 'INVITATION_ALREADY_USED'"),
        'Must detect and display INVITATION_ALREADY_USED'
      );
      assert.ok(
        screenCode.includes("errorCode === 'SEAT_LIMIT_REACHED'"),
        'Must detect and display SEAT_LIMIT_REACHED'
      );
      assert.ok(
        screenCode.includes("errorCode === 'MEMBER_ALREADY_EXISTS'"),
        'Must detect and display MEMBER_ALREADY_EXISTS'
      );
    });

    it('guards against duplicate submissions while acceptance is pending', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes('if (!token || accepting) return;'),
        'Must return immediately if submission is already in progress'
      );
      assert.ok(
        screenCode.includes('disabled={accepting}'),
        'Accept button must be disabled when accepting is true'
      );
      assert.ok(
        screenCode.includes('setAccepting(true)'),
        'Must set accepting state before async acceptance call'
      );
    });
  });

  describe('5. Root Navigator Registration (RootNavigator.tsx)', () => {
    it('registers AcceptInvitationScreen in Stack.Navigator', () => {
      const navCode = readSource('mobile/src/navigation/RootNavigator.tsx');

      assert.ok(
        navCode.includes("import { AcceptInvitationScreen } from '../screens/AcceptInvitationScreen.tsx'"),
        'RootNavigator must import AcceptInvitationScreen'
      );
      assert.ok(
        navCode.includes('<Stack.Screen name="AcceptInvitation" component={AcceptInvitationScreen} />'),
        'RootNavigator must register AcceptInvitation screen component'
      );
    });
  });
});
