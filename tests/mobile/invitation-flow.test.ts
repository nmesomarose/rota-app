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

  const readSource = (relPath: string) => fs.readFileSync(getFilePath(relPath), 'utf8').replace(/\r\n/g, '\n');

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

  describe('6. Workspace Guidance & Empty State Redemption (BusinessSelectScreen.tsx & AcceptInvitationScreen.tsx)', () => {
    it('displays authenticated user identity banner in empty state (Task 3)', () => {
      const screenCode = readSource('mobile/src/screens/BusinessSelectScreen.tsx');

      assert.ok(
        screenCode.includes('styles.signedInCard'),
        'BusinessSelectScreen must render signedInCard in empty state'
      );
      assert.ok(
        screenCode.includes('styles.userInitialsCircle'),
        'BusinessSelectScreen must render user initials avatar'
      );
      assert.ok(
        screenCode.includes('currentUser?.email || \'Authenticated User\''),
        'BusinessSelectScreen must display signed-in user email or fallback'
      );
      assert.ok(
        screenCode.includes('Your account is active, but you are not currently a member of any workspace.'),
        'BusinessSelectScreen must explain user is authenticated with 0 memberships'
      );
    });

    it('provides clear invitation code redemption card on empty state (Task 4)', () => {
      const screenCode = readSource('mobile/src/screens/BusinessSelectScreen.tsx');

      assert.ok(
        screenCode.includes('Received an Invitation?'),
        'BusinessSelectScreen must display Received an Invitation card title'
      );
      assert.ok(
        screenCode.includes("navigation.navigate('AcceptInvitation', {})"),
        'BusinessSelectScreen must provide navigation action to AcceptInvitation'
      );
      assert.ok(
        screenCode.includes('Enter Invitation Code →'),
        'BusinessSelectScreen must render Enter Invitation Code button'
      );
    });

    it('provides invitation redemption action in multi-business list footer (Task 8)', () => {
      const screenCode = readSource('mobile/src/screens/BusinessSelectScreen.tsx');

      assert.ok(
        screenCode.includes('Have an invite code? Join another team'),
        'BusinessSelectScreen list footer must offer Join another team with invite code'
      );
      assert.ok(
        screenCode.includes('styles.joinInviteButton'),
        'BusinessSelectScreen must style joinInviteButton'
      );
    });

    it('provides clear recovery actions on expired or already used invitations (Task 10)', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes("errorCode === 'INVITATION_ALREADY_USED'"),
        'AcceptInvitationScreen must handle INVITATION_ALREADY_USED'
      );
      assert.ok(
        screenCode.includes("Go to Your Workspaces →"),
        'AcceptInvitationScreen must offer Go to Your Workspaces action on already-used invite'
      );
      assert.ok(
        screenCode.includes("errorCode === 'INVITATION_EXPIRED'"),
        'AcceptInvitationScreen must handle INVITATION_EXPIRED'
      );
      assert.ok(
        screenCode.includes("Try another link or token"),
        'AcceptInvitationScreen must offer reset action on expired invite'
      );
    });

    it('provides Google sign-in guidance for unauthenticated invitees', () => {
      const screenCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        screenCode.includes('If this email is registered with Google, tap "Sign In to Accept" and choose "Continue with Google".'),
        'AcceptInvitationScreen must advise Google-registered invitees to use Continue with Google'
      );
    });
  });

  describe('7. Polished Team Invitation Confirmation Experience (InvitationConfirmationModal.tsx & TeamScreen.tsx)', () => {
    it('defines InvitationConfirmationModal with all required elements', () => {
      const modalCode = readSource('mobile/src/components/InvitationConfirmationModal.tsx');

      // Success icon / illustration
      assert.ok(
        modalCode.includes('name="mail-open"') && modalCode.includes('iconCircle'),
        'InvitationConfirmationModal must render success illustration and mail-open icon'
      );
      assert.ok(
        modalCode.includes('miniCheckBadge'),
        'InvitationConfirmationModal must render mini check badge on illustration'
      );

      // Confirmation heading
      assert.ok(
        modalCode.includes('Invitation Created</Text>'),
        'InvitationConfirmationModal must render clear "Invitation Created" heading'
      );

      // Invited member email
      assert.ok(
        modalCode.includes('Invited Member</Text>') && modalCode.includes('{email}'),
        'InvitationConfirmationModal must render invited member email in metadata card'
      );

      // Assigned role
      assert.ok(
        modalCode.includes('Assigned Role</Text>') && modalCode.includes('roleBadge'),
        'InvitationConfirmationModal must render assigned role badge and label'
      );

      // Pending invitation status
      assert.ok(
        modalCode.includes('Pending Acceptance</Text>') && modalCode.includes('pendingBadge'),
        'InvitationConfirmationModal must prominently render Pending Acceptance status'
      );

      // Primary and secondary actions
      assert.ok(
        modalCode.includes('Back to Team</Text>'),
        'InvitationConfirmationModal must provide "Back to Team" primary action'
      );
      assert.ok(
        modalCode.includes('Invite Another Member</Text>'),
        'InvitationConfirmationModal must provide "Invite Another Member" secondary action'
      );
    });

    it('distinguishes invitation creation from email delivery and acceptance (Task 7)', () => {
      const modalCode = readSource('mobile/src/components/InvitationConfirmationModal.tsx');

      assert.ok(
        modalCode.includes('Next Steps for Invitee</Text>'),
        'InvitationConfirmationModal must render informational section for next steps'
      );
      assert.ok(
        modalCode.includes('The recipient must open the link and sign in using Google or their Rota password to join this workspace.'),
        'InvitationConfirmationModal must explain recipient must sign in to activate membership'
      );
      assert.ok(
        !modalCode.includes('Member has joined') && !modalCode.includes('Email delivered and accepted'),
        'InvitationConfirmationModal must never claim member has already joined or accepted'
      );
    });

    it('implements subtle, accessible animation on mount (Task 4)', () => {
      const modalCode = readSource('mobile/src/components/InvitationConfirmationModal.tsx');

      assert.ok(
        modalCode.includes('Animated.spring(scaleAnim'),
        'InvitationConfirmationModal must animate scale with Animated.spring'
      );
      assert.ok(
        modalCode.includes('Animated.timing(fadeAnim'),
        'InvitationConfirmationModal must animate opacity with Animated.timing'
      );
      assert.ok(
        modalCode.includes('useNativeDriver: true'),
        'Animations must use hardware acceleration via useNativeDriver'
      );
    });

    it('ensures small Android screen responsiveness and accessibility (Tasks 5 & 6)', () => {
      const modalCode = readSource('mobile/src/components/InvitationConfirmationModal.tsx');

      assert.ok(
        modalCode.includes('<ScrollView'),
        'InvitationConfirmationModal must use ScrollView for small screen safety'
      );
      assert.ok(
        modalCode.includes('minHeight: 48'),
        'Buttons must enforce minimum 48dp touch targets for accessibility'
      );
      assert.ok(
        modalCode.includes('accessibilityRole="button"') && modalCode.includes('accessibilityLabel="Back to Team"'),
        'Primary button must declare accessible button role and Back to Team label'
      );
      assert.ok(
        modalCode.includes('accessibilityLabel="Invite Another Member"'),
        'Secondary button must declare accessible Invite Another Member label'
      );
    });

    it('integrates InvitationConfirmationModal into TeamScreen.tsx replacing bare Alert.alert', () => {
      const teamCode = readSource('mobile/src/screens/TeamScreen.tsx');

      assert.ok(
        teamCode.includes("import { InvitationConfirmationModal } from '../components/InvitationConfirmationModal.tsx'"),
        'TeamScreen must import InvitationConfirmationModal'
      );
      assert.ok(
        teamCode.includes('const [confirmedInvite, setConfirmedInvite] = useState'),
        'TeamScreen must maintain confirmedInvite state'
      );
      assert.ok(
        teamCode.includes('const [showConfirmationModal, setShowConfirmationModal] = useState(false)'),
        'TeamScreen must maintain showConfirmationModal state'
      );
      assert.ok(
        teamCode.includes('setShowConfirmationModal(true)'),
        'handleInviteSubmit must trigger confirmation modal upon successful invitation creation'
      );
      assert.ok(
        !teamCode.includes("Alert.alert('Success', `Invited ${trimmedEmail}"),
        'TeamScreen must not show bare Alert.alert for invitation confirmation'
      );
      assert.ok(
        teamCode.includes('<InvitationConfirmationModal'),
        'TeamScreen must render InvitationConfirmationModal in JSX'
      );
    });

    it('handles Back to Team and Invite Another Member workflows cleanly', () => {
      const teamCode = readSource('mobile/src/screens/TeamScreen.tsx');

      assert.ok(
        teamCode.includes('const handleBackToTeamFromConfirmation = () => {'),
        'TeamScreen must implement handleBackToTeamFromConfirmation'
      );
      assert.ok(
        teamCode.includes('const handleInviteAnotherFromConfirmation = () => {'),
        'TeamScreen must implement handleInviteAnotherFromConfirmation'
      );
      assert.ok(
        teamCode.includes('setShowInviteModal(true)'),
        'Invite Another Member action must reopen the invite modal for rapid member entry'
      );
    });
  });

  describe('8. Authentication & Invitation Security Regression Suite (Tasks 1-5, 8, 9)', () => {
    it('verifies inviteOrganizationMember creates placeholder user without unusable password hash (Task 1)', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      assert.ok(
        orgServiceCode.includes("INSERT INTO users (email, password_hash, name, status)\n         VALUES ($1, NULL, $2, 'invited')"),
        'inviteOrganizationMember must set password_hash = NULL for invited placeholders'
      );
      assert.ok(
        !orgServiceCode.includes("placeholderHash = await hashPassword(randomUUID())"),
        'inviteOrganizationMember must never generate unusable random UUID password hashes'
      );
    });

    it('verifies authenticateWithGoogle allows genuinely invited accounts to authenticate via Google (Task 2)', () => {
      const googleServiceCode = readSource('src/services/google-auth-service.ts');

      assert.ok(
        googleServiceCode.includes("if (existingUser.status === 'invited')"),
        'authenticateWithGoogle must explicitly check for invited user status'
      );
      assert.ok(
        googleServiceCode.includes("SET google_id = $1,\n               auth_provider = 'google',\n               password_hash = NULL,\n               status = 'active'"),
        'authenticateWithGoogle must activate invited user, bind google_id, and ensure password_hash is NULL'
      );
    });

    it('preserves password re-authentication for existing active password accounts (Task 3)', () => {
      const googleServiceCode = readSource('src/services/google-auth-service.ts');

      assert.ok(
        googleServiceCode.includes("else if (existingUser.password_hash) {\n        // Account exists with password and is not linked to Google: require password re-auth\n        throw new AppError(\n          409,\n          'ACCOUNT_LINKING_REQUIRED'"),
        'authenticateWithGoogle must preserve ACCOUNT_LINKING_REQUIRED (409) for active password accounts'
      );
    });

    it('never automatically reactivates suspended or deactivated accounts (Task 4)', () => {
      const googleServiceCode = readSource('src/services/google-auth-service.ts');

      assert.ok(
        googleServiceCode.includes("if (existingUser.status === 'suspended' || existingUser.status === 'deactivated') {\n        throw new AppError(401, 'ACCOUNT_INACTIVE'"),
        'authenticateWithGoogle must immediately reject suspended or deactivated accounts with 401 ACCOUNT_INACTIVE'
      );
    });

    it('enforces single-use, email-bound, and unexpired token rules on invitation acceptance (Task 5)', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      assert.ok(
        orgServiceCode.includes("if (invitation.status === 'accepted' || invitation.status === 'revoked') {\n      throw new AppError(400, 'INVITATION_ALREADY_USED'"),
        'acceptOrganizationInvitation must reject used or revoked tokens'
      );
      assert.ok(
        orgServiceCode.includes("if (new Date(invitation.expires_at) < new Date() || invitation.status === 'expired') {\n      await client.query(\n        `UPDATE invitations SET status = 'expired'"),
        'acceptOrganizationInvitation must enforce expiration check and update status'
      );
      assert.ok(
        orgServiceCode.includes("if (userEmail !== inviteEmail) {\n      throw new AppError(\n        403,\n        'FORBIDDEN'"),
        'acceptOrganizationInvitation must strictly enforce email binding'
      );
    });

    it('guards against duplicate active memberships on acceptance (Task 9)', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      assert.ok(
        orgServiceCode.includes("if (existingMember.rowCount && existingMember.rows[0].status === 'active') {\n      throw new AppError(409, 'MEMBER_ALREADY_EXISTS'"),
        'acceptOrganizationInvitation must reject existing active members with 409 MEMBER_ALREADY_EXISTS'
      );
    });

    it('protects invitation tokens from UI exposure in confirmation and acceptance screens (Tasks 8 & Constraints)', () => {
      const confirmationCode = readSource('mobile/src/components/InvitationConfirmationModal.tsx');
      const acceptCode = readSource('mobile/src/screens/AcceptInvitationScreen.tsx');

      assert.ok(
        !confirmationCode.includes('tokenBox') && !confirmationCode.includes('tokenInput'),
        'InvitationConfirmationModal must not render tokenBox or tokenInput'
      );
      assert.ok(
        confirmationCode.includes('deliveryBadgeCard') && confirmationCode.includes('Protected Invitation Delivery'),
        'InvitationConfirmationModal must display protected delivery status badge'
      );
      assert.ok(
        acceptCode.includes('successGlowRing') && acceptCode.includes('successDetailsBox'),
        'AcceptInvitationScreen must render polished success confirmation card upon acceptance'
      );
    });
  });
});


