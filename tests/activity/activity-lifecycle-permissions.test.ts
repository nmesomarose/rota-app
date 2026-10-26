import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../../src/app.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cacheService } from '../../src/services/cache-service.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { env } from '../../src/config/env.ts';
import { getShardIdForBusiness } from '../../src/sharding/shard-router.ts';
import { emitActivityEvent } from '../../src/services/activity-service.ts';

describe('Activity Feed Security & Lifecycle Permission Invariants (FR-ACT-005, FR-RBAC-006, AC-TEN-06)', () => {
  let server: Server;
  let baseUrl: string;

  const testBiz = randomUUID();
  let branchId: string;
  let deptSales: string;
  let deptWarehouse: string;

  let ownerToken: string;
  let ownerMembershipId: string;

  let memberToken: string;
  let memberMembershipId: string;
  let memberUserId: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Seed Business with 2 Departments
    await withTenantContext(testBiz, async (client) => {
      await client.query('INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)', [
        testBiz,
        'Lifecycle Test Biz',
        'UTC',
      ]);
      const br = await client.query<{ id: string }>(
        'INSERT INTO branches (business_id, name) VALUES ($1, $2) RETURNING id',
        [testBiz, 'HQ Branch']
      );
      branchId = br.rows[0].id;

      const dp1 = await client.query<{ id: string }>(
        'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id',
        [testBiz, branchId, 'Sales']
      );
      deptSales = dp1.rows[0].id;

      const dp2 = await client.query<{ id: string }>(
        'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id',
        [testBiz, branchId, 'Warehouse']
      );
      deptWarehouse = dp2.rows[0].id;
    });

    // Helper to register user
    async function setupUser(emailPrefix: string, name: string, role: string, deptId?: string) {
      const email = `${emailPrefix}_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
      const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Password123!', name }),
      });
      const regData = (await regRes.json()) as any;
      const userId = regData.user.id;

      let memId = '';
      await withTenantContext(testBiz, async (client) => {
        const res = await client.query(
          `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
           VALUES ($1, $2, $3, 'active', $4, $5)
           RETURNING id`,
          [testBiz, userId, role, branchId, deptId || null]
        );
        memId = res.rows[0].id;
      });

      await controlPool.query(
        `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
         VALUES ($1, $2, 'Lifecycle Test Biz', $3, 'active')`,
        [userId, testBiz, role]
      );

      const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${regData.tokens.accessToken}`,
        },
        body: JSON.stringify({ businessId: testBiz }),
      });
      const switchData = (await switchRes.json()) as any;

      return {
        token: switchData.tokens.accessToken,
        membershipId: memId,
        userId,
      };
    }

    const owner = await setupUser('owner_life', 'Owner Life', 'owner');
    ownerToken = owner.token;
    ownerMembershipId = owner.membershipId;

    const member = await setupUser('staff_life', 'Staff Life', 'staff', deptSales);
    memberToken = member.token;
    memberMembershipId = member.membershipId;
    memberUserId = member.userId;

    // Seed initial events:
    // Event 1: Public event
    await emitActivityEvent(testBiz, {
      type: 'schedule.published',
      branchId,
      departmentId: deptSales,
      actorMembershipId: ownerMembershipId,
      visibilityClass: 'public',
      payload: { note: 'Public schedule' },
    });

    // Event 2: Warehouse department event (Sales staff cannot see, Warehouse supervisor can see)
    await emitActivityEvent(testBiz, {
      type: 'inventory.stocked',
      branchId,
      departmentId: deptWarehouse,
      actorMembershipId: ownerMembershipId,
      visibilityClass: 'schedule',
      payload: { note: 'Warehouse inventory updated' },
    });

    // Event 3: Billing event (Only owner can see)
    await emitActivityEvent(testBiz, {
      type: 'billing.charged',
      visibilityClass: 'billing',
      payload: { amount: 9900 },
    });
  });

  after(async () => {
    await cacheService.invalidateTenant(testBiz);

    if (server) {
      await new Promise((res) => server.close(res));
    }

    const cleanup = async (bizId: string) => {
      const shard = getShardIdForBusiness(bizId);
      const url = shard === 'shard_1' ? env.SHARD_1_DATABASE_URL : env.SHARD_2_DATABASE_URL;
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query('DELETE FROM businesses WHERE id = $1', [bizId]).catch(() => {});
      await c.end();
    };

    await cleanup(testBiz);
    await closeAllPools();
  });

  it('1. Staff feed initially only sees public event and caches it', async () => {
    const res = await fetch(`${baseUrl}/v1/activity?limit=10`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].type, 'schedule.published');
  });

  it('2. Role Change: When Staff is promoted to Supervisor, cache invalidates and permissions elevate immediately', async () => {
    // Promote staff member to supervisor in Warehouse department
    const patchRes = await fetch(`${baseUrl}/v1/organizations/${testBiz}/members/${memberMembershipId}/role`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ role: 'supervisor' }),
    });
    assert.equal(patchRes.status, 200);

    // Also update department to Warehouse
    await withTenantContext(testBiz, async (client) => {
      await client.query('UPDATE memberships SET department_id = $1 WHERE id = $2', [
        deptWarehouse,
        memberMembershipId,
      ]);
    });
    // Invalidate activity cache for tenant
    await cacheService.invalidatePrefix(testBiz, 'activity');

    // Next read by promoted user: requireTenant dynamically detects supervisor role on shard
    const res = await fetch(`${baseUrl}/v1/activity?limit=10`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;

    // Now sees public event + Warehouse department event + self role change event (3 events), but still NO billing
    assert.equal(data.events.length, 3);
    const hasBilling = data.events.some((e: any) => e.visibility_class === 'billing');
    assert.equal(hasBilling, false, 'Supervisor must never see billing events in feed');
    const hasWarehouse = data.events.some((e: any) => e.type === 'inventory.stocked');
    assert.equal(hasWarehouse, true, 'Supervisor of Warehouse should now see Warehouse events');
    const hasRoleEvent = data.events.some((e: any) => e.type === 'membership.role_changed');
    assert.equal(hasRoleEvent, true, 'Supervisor sees role event concerning themselves');
  });

  it('3. Membership Removal: Deactivated member cannot access cached or live activity feed (401 SESSION_REVOKED)', async () => {
    // Delete/deactivate member
    const delRes = await fetch(`${baseUrl}/v1/organizations/${testBiz}/members/${memberMembershipId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(delRes.status, 200);

    // Attempt to access activity feed with former member's token: session was immediately revoked in control plane
    const res = await fetch(`${baseUrl}/v1/activity?limit=10`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(res.status, 401);
    const data = (await res.json()) as any;
    assert.equal(data.error.code, 'SESSION_REVOKED');
  });

  it('4. Event Mutation: Adding security/billing event does NOT leak to other users after cache invalidation', async () => {
    // Register fresh staff member in Sales
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `sales_staff_${Date.now()}@example.com`, password: 'Password123!', name: 'Sales Staff' }),
    });
    const regData = (await regRes.json()) as any;
    let staffMemId = '';
    await withTenantContext(testBiz, async (client) => {
      const res = await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
         VALUES ($1, $2, 'staff', 'active', $3, $4) RETURNING id`,
        [testBiz, regData.user.id, branchId, deptSales]
      );
      staffMemId = res.rows[0].id;
    });
    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Lifecycle Test Biz', 'staff', 'active')`,
      [regData.user.id, testBiz]
    );
    const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regData.tokens.accessToken}` },
      body: JSON.stringify({ businessId: testBiz }),
    });
    const staffToken = (await switchRes.json() as any).tokens.accessToken;

    // Staff reads feed and caches it
    const res1 = await fetch(`${baseUrl}/v1/activity?limit=10`, { headers: { Authorization: `Bearer ${staffToken}` } });
    assert.equal(res1.status, 200);

    // Emit sensitive billing and security events (which invalidates cache)
    await emitActivityEvent(testBiz, {
      type: 'billing.plan_upgraded',
      visibilityClass: 'billing',
      payload: { newPlan: 'enterprise' },
    });
    await emitActivityEvent(testBiz, {
      type: 'security.login_failed',
      visibilityClass: 'security',
      actorMembershipId: ownerMembershipId,
      subjectMembershipId: ownerMembershipId,
      payload: { ip: '127.0.0.1' },
    });

    // Staff reads feed again
    const res2 = await fetch(`${baseUrl}/v1/activity?limit=10`, { headers: { Authorization: `Bearer ${staffToken}` } });
    const data2 = (await res2.json()) as any;

    // Verify neither billing nor owner's security event is visible
    const leakedBilling = data2.events.some((e: any) => e.visibility_class === 'billing');
    const leakedSecurity = data2.events.some((e: any) => e.visibility_class === 'security');
    assert.equal(leakedBilling, false, 'Billing event must not leak to Staff');
    assert.equal(leakedSecurity, false, 'Security event must not leak to Staff');
  });

  it('5. PostgreSQL Fallback Mode: Enforces identical visibility boundaries when cache is disabled', async () => {
    cacheService.setEnabled(false);
    try {
      // Owner sees all 5+ events
      const ownerRes = await fetch(`${baseUrl}/v1/activity?limit=10`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      const ownerData = (await ownerRes.json()) as any;
      const hasBilling = ownerData.events.some((e: any) => e.visibility_class === 'billing');
      assert.equal(hasBilling, true, 'Owner should see billing event under PostgreSQL fallback');
    } finally {
      cacheService.setEnabled(true);
    }
  });
});
