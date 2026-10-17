import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';

describe('Milestone M2: Business Switching, Scoping, and Tenant Boundary Verification', () => {
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

  let userToken: string;
  let userId: string;
  let businessAId: string;
  let businessBId: string;
  let businessCToken: string;
  let businessCId: string;

  it('1. Prepares user with two businesses (Business A and Business B)', async () => {
    // 1. Register User 1
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `multi_biz_${Date.now()}@example.com`,
        password: 'Password123!',
        name: 'Multi Biz User',
      }),
    });
    const regBody = (await regRes.json()) as any;
    userToken = regBody.tokens.accessToken;
    userId = regBody.user.id;

    // 2. Onboard Business A
    const bizARes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ name: 'Organization Alpha' }),
    });
    const bizABody = (await bizARes.json()) as any;
    businessAId = bizABody.business.id;
    userToken = bizABody.tokens.accessToken; // Scoped to Business A

    // 3. Onboard Business B for same user
    const bizBRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ name: 'Organization Beta' }),
    });
    const bizBBody = (await bizBRes.json()) as any;
    businessBId = bizBBody.business.id;
    userToken = bizBBody.tokens.accessToken; // Scoped to Business B

    // 4. Register User 2 with an unrelated Business C
    const regCRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `stranger_${Date.now()}@example.com`,
        password: 'Password123!',
        name: 'Stranger User',
      }),
    });
    const regCBody = (await regCRes.json()) as any;
    const bizCRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regCBody.tokens.accessToken}`,
      },
      body: JSON.stringify({ name: 'Organization Gamma (Foreign)' }),
    });
    const bizCBody = (await bizCRes.json()) as any;
    businessCId = bizCBody.business.id;
    businessCToken = bizCBody.tokens.accessToken;
  });

  it('2. Switches business context from B to A and receives newly scoped access token', async () => {
    const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ businessId: businessAId }),
    });

    assert.strictEqual(switchRes.status, 200);
    const switchBody = (await switchRes.json()) as any;
    assert.strictEqual(switchBody.activeBusinessId, businessAId);
    assert.strictEqual(switchBody.role, 'owner');
    assert.ok(switchBody.tokens.accessToken);

    const tokenScopedToA = switchBody.tokens.accessToken;

    // Verify token can read Business A
    const getARes = await fetch(`${baseUrl}/v1/organizations/${businessAId}`, {
      headers: { Authorization: `Bearer ${tokenScopedToA}` },
    });
    assert.strictEqual(getARes.status, 200);

    // Verify token CANNOT read Business B (returns 404 NOT_FOUND per SEC-015 and AC-TEN-01)
    const getBRes = await fetch(`${baseUrl}/v1/organizations/${businessBId}`, {
      headers: { Authorization: `Bearer ${tokenScopedToA}` },
    });
    assert.strictEqual(getBRes.status, 404);
    const getBBody = (await getBRes.json()) as any;
    assert.strictEqual(getBBody.error.code, 'NOT_FOUND');
  });

  it('3. Rejects switching to an unauthorized business (404 NOT_FOUND)', async () => {
    // User attempts to switch to Business C (belongs to Stranger User)
    const unauthSwitchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ businessId: businessCId }),
    });

    assert.strictEqual(unauthSwitchRes.status, 404);
    const body = (await unauthSwitchRes.json()) as any;
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  });

  it('4. Rejects client-supplied spoofed business headers (Context comes strictly from server token)', async () => {
    // Present token for Business C, but client passes X-Business-Id: Business A
    const spoofRes = await fetch(`${baseUrl}/v1/organizations/${businessAId}`, {
      headers: {
        Authorization: `Bearer ${businessCToken}`,
        'X-Business-Id': businessAId,
      },
    });

    // Must be rejected as 404 NOT_FOUND because token is scoped to C, not A
    assert.strictEqual(spoofRes.status, 404);
  });

  it('5. FR-RBAC-006 & AC-TEN-06: Membership deactivation applies immediately on next request', async () => {
    // 1. Switch back to Business B
    const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ businessId: businessBId }),
    });
    assert.strictEqual(switchRes.status, 200);
    const tokenScopedToB = (await switchRes.json() as any).tokens.accessToken;

    // Verify access works prior to deactivation
    const okRes = await fetch(`${baseUrl}/v1/organizations/${businessBId}`, {
      headers: { Authorization: `Bearer ${tokenScopedToB}` },
    });
    assert.strictEqual(okRes.status, 200);

    // 2. Deactivate membership directly in tenant database
    await withTenantContext(businessBId, async (client) => {
      await client.query(
        `UPDATE memberships
         SET status = 'deactivated', updated_at = NOW()
         WHERE business_id = $1 AND user_id = $2`,
        [businessBId, userId]
      );
    });

    // 3. Immediately send request with existing valid token:
    // Middleware MUST check the database authoritatively and reject with 403 MEMBERSHIP_INACTIVE
    const blockedRes = await fetch(`${baseUrl}/v1/organizations/${businessBId}`, {
      headers: { Authorization: `Bearer ${tokenScopedToB}` },
    });
    assert.strictEqual(blockedRes.status, 403);
    const blockedBody = (await blockedRes.json()) as any;
    assert.strictEqual(blockedBody.error.code, 'MEMBERSHIP_INACTIVE');
  });
});
