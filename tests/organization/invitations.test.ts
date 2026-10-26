import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { getRedisClient } from '../../src/services/redis-client.ts';

describe('Secure Team Invitations & Server-Side Acceptance (FR-AUTH-007, AC-INV-01..06, BILL-009)', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const redis = getRedisClient();
    const keys = await redis.keys('ratelimit:invitation:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeAllPools();
  });

  // State
  let ownerToken: string;
  let ownerEmail: string;
  let businessId: string;
  let defaultBranchId: string;
  let defaultDepartmentId: string;
  let altDepartmentId: string;

  let supervisorToken: string;
  let supervisorEmail: string;
  let supervisorMemberId: string;

  let staffToken: string;
  let staffEmail: string;

  const helperRegister = async (email: string, name: string) => {
    const res = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!', name }),
    });
    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;
    return { token: body.tokens.accessToken, user: body.user };
  };

  it('1. Owner onboards a business with two departments', async () => {
    ownerEmail = `inv_owner_${Date.now()}@example.com`;
    const reg = await helperRegister(ownerEmail, 'Organization Owner');

    const bizRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reg.token}`,
      },
      body: JSON.stringify({
        name: 'Invitation Test Enterprise',
        departments: ['Front Desk', 'Kitchen'],
      }),
    });
    assert.strictEqual(bizRes.status, 201);
    const bizBody = (await bizRes.json()) as any;
    businessId = bizBody.business.id;
    ownerToken = bizBody.tokens.accessToken;
    defaultBranchId = bizBody.branch.id;
    defaultDepartmentId = bizBody.departments[0].id;
    altDepartmentId = bizBody.departments[1].id;
  });

  let inviteeEmail: string;
  let validInvitationToken: string;

  it('2. Owner creates a valid single-use expiring invitation for a staff member', async () => {
    inviteeEmail = `invitee_staff_${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        email: inviteeEmail,
        name: 'Invited Staff One',
        role: 'staff',
        departmentId: defaultDepartmentId,
      }),
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;
    assert.ok(body.invitation);
    assert.strictEqual(body.invitation.email, inviteeEmail);
    assert.strictEqual(body.invitation.role, 'staff');
    assert.strictEqual(body.invitation.status, 'pending');
    assert.ok(body.invitation.token);
    assert.ok(body.invitation.token.startsWith(`inv_${businessId}_`));
    validInvitationToken = body.invitation.token;

    // Verify token is NOT stored as raw plaintext in database (hashed storage check)
    await withTenantContext(businessId, async (client) => {
      const dbRes = await client.query<{ token_hash: string }>(
        `SELECT token_hash FROM invitations WHERE business_id = $1 AND id = $2`,
        [businessId, body.invitation.id]
      );
      assert.strictEqual(dbRes.rowCount, 1);
      assert.notStrictEqual(dbRes.rows[0].token_hash, validInvitationToken);
      assert.strictEqual(dbRes.rows[0].token_hash.length, 64); // SHA-256 hex string
    });
  });

  it('3. Public preview endpoint returns invitation metadata without requiring authentication', async () => {
    const res = await fetch(`${baseUrl}/v1/organizations/invitations/${validInvitationToken}`, {
      method: 'GET',
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.invitation.email, inviteeEmail);
    assert.strictEqual(body.invitation.role, 'staff');
    assert.strictEqual(body.invitation.businessName, 'Invitation Test Enterprise');
    assert.strictEqual(body.invitation.departmentName, 'Front Desk');
    assert.strictEqual(body.invitation.status, 'pending');
  });

  it('4. Email binding protection: another user cannot accept someone else’s invitation', async () => {
    const intruder = await helperRegister(`intruder_${Date.now()}@example.com`, 'Intruder');
    const res = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${intruder.token}`,
      },
      body: JSON.stringify({ token: validInvitationToken }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'FORBIDDEN');
  });

  let inviteeToken: string;

  it('5. Successfully accepts valid invitation, activating membership and syncing directory', async () => {
    const inviteeReg = await helperRegister(inviteeEmail, 'Invited Staff One');
    inviteeToken = inviteeReg.token;
    const res = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${inviteeToken}`,
      },
      body: JSON.stringify({ token: validInvitationToken }),
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.membership.role, 'staff');
    assert.strictEqual(body.membership.status, 'active');
    assert.strictEqual(body.membership.businessId, businessId);

    // Verify invitation marked 'accepted' in tenant shard
    await withTenantContext(businessId, async (client) => {
      const invCheck = await client.query<{ status: string; accepted_at: string }>(
        `SELECT status, accepted_at FROM invitations WHERE business_id = $1 AND email = $2`,
        [businessId, inviteeEmail]
      );
      assert.strictEqual(invCheck.rows[0].status, 'accepted');
      assert.ok(invCheck.rows[0].accepted_at !== null);
    });
  });

  it('6. Token reuse rejection: cannot accept already-accepted invitation a second time', async () => {
    const res = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${inviteeToken}`,
      },
      body: JSON.stringify({ token: validInvitationToken }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVITATION_ALREADY_USED');
  });

  it('7. Invalid / malformed token rejection', async () => {
    const user = await helperRegister(`tester_${Date.now()}@example.com`, 'Tester');
    const res = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.token}`,
      },
      body: JSON.stringify({ token: `inv_${businessId}_nonexistentfake1234567890abcdef` }),
    });

    assert.strictEqual(res.status, 404);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'NOT_FOUND');
  });

  it('8. Expired invitation rejection', async () => {
    const expiredEmail = `expired_invite_${Date.now()}@example.com`;
    const expiredReg = await helperRegister(expiredEmail, 'Expired Invitee');

    // Create an expired invitation directly in tenant shard
    const crypto = await import('node:crypto');
    const rawExpToken = `inv_${businessId}_exp_${Date.now()}_${Math.random()}`;
    const expHash = crypto.createHash('sha256').update(rawExpToken).digest('hex');

    let ownerMemberId: string;
    await withTenantContext(businessId, async (client) => {
      const ownerRes = await client.query<{ id: string }>(
        `SELECT id FROM memberships WHERE business_id = $1 AND role = 'owner'`,
        [businessId]
      );
      ownerMemberId = ownerRes.rows[0].id;

      await client.query(
        `INSERT INTO invitations (
           business_id, email, role, branch_id, department_id,
           invited_by_membership_id, token_hash, status, expires_at
         ) VALUES ($1, $2, 'staff', $3, $4, $5, $6, 'pending', NOW() - INTERVAL '1 hour')`,
        [businessId, expiredEmail, defaultBranchId, defaultDepartmentId, ownerMemberId, expHash]
      );
    });

    const res = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${expiredReg.token}`,
      },
      body: JSON.stringify({ token: rawExpToken }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVITATION_EXPIRED');
  });

  it('9. Supervisor permissions: can invite staff into own department only', async () => {
    // 9a. Owner invites supervisor into Front Desk
    supervisorEmail = `supervisor_${Date.now()}@example.com`;
    const invRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        email: supervisorEmail,
        name: 'Front Desk Supervisor',
        role: 'supervisor',
        departmentId: defaultDepartmentId,
      }),
    });
    assert.strictEqual(invRes.status, 201);
    const invBody = (await invRes.json()) as any;

    const supReg = await helperRegister(supervisorEmail, 'Front Desk Supervisor');
    const acceptRes = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supReg.token}`,
      },
      body: JSON.stringify({ token: invBody.invitation.token }),
    });
    assert.strictEqual(acceptRes.status, 200);
    const acceptBody = (await acceptRes.json()) as any;
    supervisorMemberId = acceptBody.membership.id;

    // Login/switch into business to get scoped supervisor token
    const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supReg.token}`,
      },
      body: JSON.stringify({ businessId }),
    });
    assert.strictEqual(switchRes.status, 200);
    const switchBody = (await switchRes.json()) as any;
    supervisorToken = switchBody.tokens.accessToken;

    // 9b. Supervisor attempts to invite into a different department (Kitchen) -> fails 403
    const crossDeptEmail = `cross_dept_${Date.now()}@example.com`;
    const rejectDeptRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        email: crossDeptEmail,
        role: 'staff',
        departmentId: altDepartmentId, // Kitchen != Front Desk
      }),
    });
    assert.strictEqual(rejectDeptRes.status, 403);
    const rejectDeptBody = (await rejectDeptRes.json()) as any;
    assert.strictEqual(rejectDeptBody.error?.code, 'FORBIDDEN');

    // 9c. Supervisor attempts to invite a supervisor role -> fails 403
    const supInviteSup = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        email: `another_sup_${Date.now()}@example.com`,
        role: 'supervisor',
      }),
    });
    assert.strictEqual(supInviteSup.status, 403);

    // 9d. Supervisor invites staff into Front Desk -> succeeds!
    staffEmail = `staff_member_${Date.now()}@example.com`;
    const supSuccessRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        email: staffEmail,
        role: 'staff',
        departmentId: defaultDepartmentId,
      }),
    });
    assert.strictEqual(supSuccessRes.status, 201);
    const supSuccessBody = (await supSuccessRes.json()) as any;
    assert.strictEqual(supSuccessBody.invitation.role, 'staff');
    assert.strictEqual(supSuccessBody.invitation.departmentId, defaultDepartmentId);

    // Staff accepts
    const staffReg = await helperRegister(staffEmail, 'Staff Member');
    const staffAccept = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffReg.token}`,
      },
      body: JSON.stringify({ token: supSuccessBody.invitation.token }),
    });
    assert.strictEqual(staffAccept.status, 200);

    // Switch into business to obtain staff token
    const staffSwitch = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffReg.token}`,
      },
      body: JSON.stringify({ businessId }),
    });
    assert.strictEqual(staffSwitch.status, 200);
    const staffSwitchBody = (await staffSwitch.json()) as any;
    staffToken = staffSwitchBody.tokens.accessToken;
  });

  it('10. Staff member cannot invite any role (AC-INV-06)', async () => {
    const res = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        email: `staff_illegal_invite_${Date.now()}@example.com`,
        role: 'staff',
      }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'FORBIDDEN');
  });

  it('11. Inviter permission revocation: deactivating inviter revokes pending invitations at acceptance time', async () => {
    // Supervisor invites a new candidate
    const candidateEmail = `candidate_${Date.now()}@example.com`;
    const invRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        email: candidateEmail,
        role: 'staff',
      }),
    });
    assert.strictEqual(invRes.status, 201);
    const invBody = (await invRes.json()) as any;
    const candidateToken = invBody.invitation.token;

    // Owner deactivates the supervisor
    const removeRes = await fetch(
      `${baseUrl}/v1/organizations/${businessId}/members/${supervisorMemberId}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
      }
    );
    assert.strictEqual(removeRes.status, 200);

    // Candidate registers and attempts to accept -> fails with 403 INVITATION_REVOKED
    const candReg = await helperRegister(candidateEmail, 'Candidate');
    const acceptRes = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candReg.token}`,
      },
      body: JSON.stringify({ token: candidateToken }),
    });

    assert.strictEqual(acceptRes.status, 403);
    const acceptBody = (await acceptRes.json()) as any;
    assert.strictEqual(acceptBody.error?.code, 'INVITATION_REVOKED');
  });

  it('12. Transactional seat admission limit check at acceptance time (BILL-009, J-14)', async () => {
    // Set seat limit to current active count (which is 2: owner + 1 active staff)
    await withTenantContext(businessId, async (client) => {
      const activeRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM memberships WHERE business_id = $1 AND status = 'active'`,
        [businessId]
      );
      const currentActive = parseInt(activeRes.rows[0].count, 10);

      // Temporarily set subscription seat_quantity to currentActive + 1
      await client.query(
        `UPDATE subscriptions SET seat_quantity = $1 WHERE business_id = $2`,
        [currentActive + 1, businessId]
      );
    });

    // Owner invites candidate A
    const candAEmail = `cand_a_${Date.now()}@example.com`;
    const invA = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ email: candAEmail, role: 'staff' }),
    });
    assert.strictEqual(invA.status, 201);
    const bodyA = (await invA.json()) as any;

    // Now set seat_quantity exactly equal to currentActive so seats are full
    await withTenantContext(businessId, async (client) => {
      const activeRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM memberships WHERE business_id = $1 AND status = 'active'`,
        [businessId]
      );
      const currentActive = parseInt(activeRes.rows[0].count, 10);
      await client.query(`UPDATE subscriptions SET seat_quantity = $1 WHERE business_id = $2`, [
        currentActive,
        businessId,
      ]);
    });

    // Candidate A registers and attempts to accept -> fails with 409 SEAT_LIMIT_REACHED
    const candAReg = await helperRegister(candAEmail, 'Candidate A');
    const acceptFail = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candAReg.token}`,
      },
      body: JSON.stringify({ token: bodyA.invitation.token }),
    });

    assert.strictEqual(acceptFail.status, 409);
    const failBody = (await acceptFail.json()) as any;
    assert.strictEqual(failBody.error?.code, 'SEAT_LIMIT_REACHED');

    // Verify invitation is NOT consumed (remains pending per J-14)
    await withTenantContext(businessId, async (client) => {
      const invCheck = await client.query<{ status: string }>(
        `SELECT status FROM invitations WHERE business_id = $1 AND email = $2`,
        [businessId, candAEmail]
      );
      assert.strictEqual(invCheck.rows[0].status, 'pending');
    });

    // Owner increases seat quantity
    await withTenantContext(businessId, async (client) => {
      await client.query(`UPDATE subscriptions SET seat_quantity = 10 WHERE business_id = $1`, [
        businessId,
      ]);
    });

    // Candidate A attempts to accept again -> succeeds!
    const acceptSuccess = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candAReg.token}`,
      },
      body: JSON.stringify({ token: bodyA.invitation.token }),
    });

    assert.strictEqual(acceptSuccess.status, 200);
    const successBody = (await acceptSuccess.json()) as any;
    assert.strictEqual(successBody.membership.status, 'active');
  });

  it('13. Production security: raw invitation token is omitted from API responses in production mode', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';

      const prodEmail = `prod_invite_${Date.now()}@example.com`;
      const res = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          email: prodEmail,
          role: 'staff',
        }),
      });

      assert.strictEqual(res.status, 201);
      const body = (await res.json()) as any;
      assert.ok(body.invitation);
      assert.strictEqual(body.invitation.email, prodEmail);
      assert.strictEqual(body.invitation.role, 'staff');
      assert.strictEqual(body.invitation.status, 'pending');
      // Token MUST NOT be present in production response
      assert.strictEqual(body.invitation.token, undefined);
      assert.strictEqual('token' in body.invitation, false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

