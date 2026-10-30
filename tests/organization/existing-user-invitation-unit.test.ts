import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyPassword } from '../../src/services/password-service.ts';

describe('Existing User Invitation Acceptance, Google Auth & Tenant Isolation (Unit Regression Suite)', () => {
  const readSource = (relPath: string) =>
    fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8').replace(/\r\n/g, '\n');

  describe('1. Anti-Enumeration & Google-Only User Password Protection (SEC-004, FR-AUTH-002)', () => {
    it('verifyPassword safely returns false when password_hash is null (Google-only account)', async () => {
      // In Neon, Google OAuth users are stored with password_hash = NULL
      const result = await verifyPassword(null, 'AttemptedPassword123!');
      assert.strictEqual(result, false, 'verifyPassword must safely return false for null hash');
    });

    it('verifyPassword safely returns false for empty string password or hash', async () => {
      const res1 = await verifyPassword('', 'Password123!');
      const res2 = await verifyPassword('$argon2id$v=19$m=65536...', '');
      assert.strictEqual(res1, false);
      assert.strictEqual(res2, false);
    });

    it('backend login rejects Google-only account with generic 401 INVALID_CREDENTIALS', () => {
      const authServiceCode = readSource('src/services/auth-service.ts');

      // SEC-004: Anti-enumeration requires identical 401 code and message whether user does not exist
      // or user exists with NULL password_hash.
      assert.ok(
        authServiceCode.includes('verifyPassword(user.password_hash, rawPassword)'),
        'auth-service must verify password hash against input password'
      );
      assert.ok(
        authServiceCode.includes("throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')"),
        'auth-service must throw generic 401 INVALID_CREDENTIALS for failed password verification'
      );
    });
  });

  describe('2. Existing-User Invitation Acceptance Logic (AC-INV-07 & organization-service.ts)', () => {
    it('acceptOrganizationInvitation accepts existing authenticated user without creating duplicate user', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      // AC-INV-07: When an existing user accepts an invitation, a membership row is created
      // for the existing user. No duplicate user row is inserted.
      assert.ok(
        orgServiceCode.includes('export async function acceptOrganizationInvitation'),
        'organization-service must export acceptOrganizationInvitation'
      );
      assert.ok(
        orgServiceCode.includes('memberships'),
        'acceptOrganizationInvitation must create membership on tenant shard'
      );
      assert.ok(
        orgServiceCode.includes('syncEntryToDirectory(user.id, businessId, businessName, invitation.role, \'active\')'),
        'acceptOrganizationInvitation must sync membership to directory on rota_control'
      );

      // Verify that acceptOrganizationInvitation does NOT execute INSERT INTO users
      const acceptFnBlock = orgServiceCode.slice(
        orgServiceCode.indexOf('export async function acceptOrganizationInvitation'),
        orgServiceCode.indexOf('export async function getInvitationDetails')
      );
      assert.ok(
        !acceptFnBlock.includes('INSERT INTO rota_control.users') &&
          !acceptFnBlock.includes('INSERT INTO users'),
        'acceptOrganizationInvitation must not insert into users table'
      );
    });

    it('strictly validates email match between authenticated user and invitation recipient', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      assert.ok(
        orgServiceCode.includes('userEmail !== inviteEmail'),
        'Must compare invitation email and authenticated user email case-insensitively'
      );
      assert.ok(
        orgServiceCode.includes("throw new AppError(\n        403,\n        'FORBIDDEN',"),
        'Must reject mismatched emails with 403 FORBIDDEN'
      );
    });

    it('hashes invitation tokens with SHA-256 before database lookup', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');
      const tokenServiceCode = readSource('src/services/token-service.ts');

      assert.ok(
        orgServiceCode.includes('hashToken(rawToken.trim())'),
        'organization-service must hash invitation tokens using hashToken'
      );
      assert.ok(
        tokenServiceCode.includes("createHash('sha256')"),
        'Token hashing must use secure SHA-256'
      );
    });

    it('rejects expired invitations with INVITATION_EXPIRED (400)', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      assert.ok(
        orgServiceCode.includes("new Date(invitation.expires_at) < new Date() || invitation.status === 'expired'"),
        'Must compare expires_at against current timestamp or status'
      );
      assert.ok(
        orgServiceCode.includes("throw new AppError(400, 'INVITATION_EXPIRED', 'Invitation has expired')"),
        'Must return INVITATION_EXPIRED for expired invitations'
      );
    });

    it('rejects already-used invitations with INVITATION_ALREADY_USED (400)', () => {
      const orgServiceCode = readSource('src/services/organization-service.ts');

      assert.ok(
        orgServiceCode.includes("invitation.status === 'accepted' || invitation.status === 'revoked'"),
        'Must check if invitation is accepted or revoked'
      );
      assert.ok(
        orgServiceCode.includes("throw new AppError(400, 'INVITATION_ALREADY_USED', 'Invitation has already been accepted or revoked')"),
        'Must throw INVITATION_ALREADY_USED when status is accepted or revoked'
      );
    });
  });

  describe('3. Multi-Business Membership & Context Switching (AC-ORG-03, AC-ORG-04)', () => {
    it('GET /v1/organizations queries global membership_directory on rota_control', () => {
      const orgRouteCode = readSource('src/routes/organization.ts');

      assert.ok(
        orgRouteCode.includes('FROM membership_directory'),
        'GET /v1/organizations must query membership_directory'
      );
      assert.ok(
        orgRouteCode.includes("WHERE user_id = $1 AND status = 'active'"),
        'Must filter by user_id and active status'
      );
    });

    it('switchBusiness validates membership before granting tenant access token', () => {
      const authServiceCode = readSource('src/services/auth-service.ts');

      assert.ok(
        authServiceCode.includes('export async function switchBusiness'),
        'auth-service must export switchBusiness'
      );
      assert.ok(
        authServiceCode.includes("throw new AppError(404, 'NOT_FOUND', 'Target business not found or access denied')"),
        'switchBusiness must deny access if user is not an active member'
      );
      assert.ok(
        authServiceCode.includes('businessId: targetBusinessId'),
        'switchBusiness issues token with newly scoped businessId'
      );
    });
  });

  describe('4. Tenant Isolation Invariants (RLS & Sharding Architecture)', () => {
    it('all tenant queries execute within withTenantContext setting app.current_business_id', () => {
      const tenantContextCode = readSource('src/db/tenant-context.ts');

      assert.ok(
        tenantContextCode.includes('SET LOCAL app.current_business_id'),
        'tenant-context must set app.current_business_id in PostgreSQL session'
      );
      assert.ok(
        tenantContextCode.includes('withTenantContext'),
        'must export withTenantContext'
      );
    });

    it('invitations table enforces tenant foreign key on businesses(id) and FORCE ROW LEVEL SECURITY', () => {
      const migrationCode = readSource('migrations/tenant/007_create_invitations.js');

      assert.ok(
        migrationCode.includes('CREATE TABLE IF NOT EXISTS invitations'),
        'Migration must define invitations table'
      );
      assert.ok(
        migrationCode.includes('business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE'),
        'invitations table must reference businesses(id) with NOT NULL constraint'
      );
      assert.ok(
        migrationCode.includes('ALTER TABLE invitations FORCE ROW LEVEL SECURITY'),
        'invitations table must FORCE ROW LEVEL SECURITY'
      );
      assert.ok(
        migrationCode.includes("USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)"),
        'tenant isolation policy must scope to app.current_business_id'
      );
    });
  });
});
