import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { closeAllPools } from '../../src/db/connection.ts';

describe('Team Management, Roles (Supervisor & Co-Owner), and Lifecycle Verification', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
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

  let ownerToken: string;
  let ownerId: string;
  let businessId: string;
  let staffMemberId: string;
  let staffUserId: string;

  it('1. Owner onboards a new business and retrieves initial members list', async () => {
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `team_owner_${Date.now()}@example.com`,
        password: 'Password123!',
        name: 'Team Owner',
      }),
    });
    const regBody = (await regRes.json()) as any;
    assert.strictEqual(regRes.status, 201);
    ownerId = regBody.user.id;

    // Onboard business
    const bizRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regBody.tokens.accessToken}`,
      },
      body: JSON.stringify({ name: 'Team Enterprise Test' }),
    });
    const bizBody = (await bizRes.json()) as any;
    assert.strictEqual(bizRes.status, 201);
    businessId = bizBody.business.id;
    ownerToken = bizBody.tokens.accessToken;

    // List members
    const membersRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(membersRes.status, 200);
    const membersBody = (await membersRes.json()) as any;
    assert.ok(Array.isArray(membersBody.members));
    assert.strictEqual(membersBody.members.length, 1);
    assert.strictEqual(membersBody.members[0].role, 'owner');
  });

  it('2. Owner invites a new staff member within subscription seat limits', async () => {
    const inviteEmail = `invited_staff_${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/v1/organizations/${businessId}/members/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        email: inviteEmail,
        name: 'Invited Staff',
        role: 'staff',
      }),
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;
    assert.ok(body.invitation);
    assert.strictEqual(body.invitation.email, inviteEmail);
    assert.strictEqual(body.invitation.role, 'staff');
    assert.strictEqual(body.invitation.status, 'pending');
    assert.ok(body.invitation.token);

    // Register the invited staff user to obtain credentials and session
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: inviteEmail,
        password: 'Password123!',
        name: 'Invited Staff',
      }),
    });
    assert.strictEqual(regRes.status, 201);
    const regBody = (await regRes.json()) as any;
    const staffToken = regBody.tokens.accessToken;
    staffUserId = regBody.user.id;

    // Staff accepts the invitation using the single-use token
    const acceptRes = await fetch(`${baseUrl}/v1/organizations/invitations/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        token: body.invitation.token,
      }),
    });

    assert.strictEqual(acceptRes.status, 200);
    const acceptBody = (await acceptRes.json()) as any;
    assert.strictEqual(acceptBody.membership.role, 'staff');
    assert.strictEqual(acceptBody.membership.status, 'active');
    staffMemberId = acceptBody.membership.id;
  });

  it('3. Owner appoints the staff member as Shift Supervisor', async () => {
    const res = await fetch(
      `${baseUrl}/v1/organizations/${businessId}/members/${staffMemberId}/role`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ role: 'supervisor' }),
      }
    );

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.role, 'supervisor');
  });

  it('4. Owner promotes the supervisor to Co-Owner', async () => {
    const res = await fetch(
      `${baseUrl}/v1/organizations/${businessId}/members/${staffMemberId}/role`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ role: 'co_owner' }),
      }
    );

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.role, 'co_owner');
  });

  it('5. Sole-owner demotion protection rejects demoting the only remaining owner', async () => {
    // List members to find owner's member id
    const listRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const listBody = (await listRes.json()) as any;
    const ownerMember = listBody.members.find((m: any) => m.role === 'owner');
    assert.ok(ownerMember);

    // Attempt to demote sole owner to staff
    const res = await fetch(
      `${baseUrl}/v1/organizations/${businessId}/members/${ownerMember.id}/role`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ role: 'staff' }),
      }
    );

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error.code, 'CANNOT_REMOVE_LAST_OWNER');
  });

  it('6. Sole-owner account deletion is blocked until business is transferred or deleted', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/account`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ password: 'Password123!' }),
    });

    assert.strictEqual(res.status, 409);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error.code, 'SOLE_OWNER_CANNOT_DELETE');
  });

  it('7. Owner can remove/deactivate a co-owner safely', async () => {
    const res = await fetch(
      `${baseUrl}/v1/organizations/${businessId}/members/${staffMemberId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
      }
    );

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.success, true);

    // Verify status updated to inactive
    const listRes = await fetch(`${baseUrl}/v1/organizations/${businessId}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const listBody = (await listRes.json()) as any;
    const deactivated = listBody.members.find((m: any) => m.id === staffMemberId);
    assert.strictEqual(deactivated.status, 'inactive');
  });
});
