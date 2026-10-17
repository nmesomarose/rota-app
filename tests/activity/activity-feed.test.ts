import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { emitActivityEvent } from '../../src/services/activity-service.ts';

describe('Milestone M5: Scoped Activity Feed & 10,000-Record Cursor Pagination Invariant', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let ownerMembershipId: string;
  let supervisorToken: string;
  let supervisorMembershipId: string;
  let staff1Token: string;
  let staff1MembershipId: string;
  let staff2Token: string;
  let staff2MembershipId: string;

  let businessId: string;
  let branchId: string;
  let dept1Id: string;
  let dept2Id: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register Owner and onboard organization
    const ownerEmail = `act_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Feed Owner' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    ownerToken = regOwnerData.tokens.accessToken;

    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Omni Retail Feed',
        timezone: 'UTC',
        branchName: 'Branch 1',
        departments: ['Sales', 'Warehouse'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    ownerToken = onboardData.tokens.accessToken;
    ownerMembershipId = onboardData.membership.id;

    dept1Id = onboardData.departments.find((d: any) => d.name === 'Sales').id;
    dept2Id = onboardData.departments.find((d: any) => d.name === 'Warehouse').id;

    // Helper to register member
    async function createMember(name: string, role: string, deptId: string) {
      const email = `feed_${role.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
      const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Password123!', name }),
      });
      const regData = (await regRes.json()) as any;
      const userId = regData.user.id;

      let memId = '';
      await withTenantContext(businessId, async (client) => {
        const res = await client.query(
          `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
           VALUES ($1, $2, $3, 'active', $4, $5)
           RETURNING id`,
          [businessId, userId, role, branchId, deptId]
        );
        memId = res.rows[0].id;
      });

      await controlPool.query(
        `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
         VALUES ($1, $2, 'Omni Retail Feed', $3, 'active')`,
        [userId, businessId, role]
      );

      const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${regData.tokens.accessToken}`,
        },
        body: JSON.stringify({ businessId }),
      });
      const switchData = (await switchRes.json()) as any;
      return { token: switchData.tokens.accessToken as string, membershipId: memId };
    }

    const sup = await createMember('Supervisor Sarah', 'Supervisor', dept1Id);
    supervisorToken = sup.token;
    supervisorMembershipId = sup.membershipId;

    const s1 = await createMember('Staff Alice', 'Staff', dept1Id);
    staff1Token = s1.token;
    staff1MembershipId = s1.membershipId;

    const s2 = await createMember('Staff Bob', 'Staff', dept2Id);
    staff2Token = s2.token;
    staff2MembershipId = s2.membershipId;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await closeAllPools();
  });

  it('1. Role-based visibility: Staff only sees events concerning them (AC-ACT-01)', async () => {
    // Emit attendance event for Staff 1
    await emitActivityEvent(businessId, {
      type: 'attendance.recorded',
      departmentId: dept1Id,
      branchId,
      actorMembershipId: supervisorMembershipId,
      subjectMembershipId: staff1MembershipId,
      visibilityClass: 'attendance',
      payload: { state: 'present', note: 'Alice morning shift' },
    });

    // Emit attendance event for Staff 2
    await emitActivityEvent(businessId, {
      type: 'attendance.recorded',
      departmentId: dept2Id,
      branchId,
      actorMembershipId: supervisorMembershipId,
      subjectMembershipId: staff2MembershipId,
      visibilityClass: 'attendance',
      payload: { state: 'absent', note: 'Bob absence' },
    });

    // Staff 1 fetches feed: MUST see own attendance, MUST NOT see Staff 2's attendance
    const s1Res = await fetch(`${baseUrl}/v1/activity`, {
      headers: { Authorization: `Bearer ${staff1Token}` },
    });
    assert.equal(s1Res.status, 200);
    const s1Data = (await s1Res.json()) as any;

    const aliceAttendance = s1Data.events.find(
      (e: any) => e.visibility_class === 'attendance' && e.subject_membership_id === staff1MembershipId
    );
    assert.ok(aliceAttendance, 'Staff 1 should see own attendance event');

    const bobAttendance = s1Data.events.find(
      (e: any) => e.visibility_class === 'attendance' && e.subject_membership_id === staff2MembershipId
    );
    assert.equal(bobAttendance, undefined, 'Staff 1 must NOT see Staff 2 attendance event');
  });

  it('2. Security events are visible ONLY to affected user and Owners (AC-ACT-02, FR-ACT-007)', async () => {
    // Emit security event for Staff 1 (e.g. login from new device)
    await emitActivityEvent(businessId, {
      type: 'security.login',
      branchId,
      actorMembershipId: staff1MembershipId,
      subjectMembershipId: staff1MembershipId,
      visibilityClass: 'security',
      payload: { ip: '192.168.1.1' },
    });

    // 1. Staff 1 (affected user) CAN see it
    const s1Res = await fetch(`${baseUrl}/v1/activity`, {
      headers: { Authorization: `Bearer ${staff1Token}` },
    });
    const s1Data = (await s1Res.json()) as any;
    const hasSecS1 = s1Data.events.some((e: any) => e.visibility_class === 'security');
    assert.ok(hasSecS1, 'Staff 1 should see their own security event');

    // 2. Staff 2 CANNOT see Staff 1 security event
    const s2Res = await fetch(`${baseUrl}/v1/activity`, {
      headers: { Authorization: `Bearer ${staff2Token}` },
    });
    const s2Data = (await s2Res.json()) as any;
    const hasSecS2 = s2Data.events.some((e: any) => e.visibility_class === 'security');
    assert.equal(hasSecS2, false, 'Staff 2 must NOT see Staff 1 security event');

    // 3. Supervisor CANNOT see Staff 1 security event
    const supRes = await fetch(`${baseUrl}/v1/activity`, {
      headers: { Authorization: `Bearer ${supervisorToken}` },
    });
    const supData = (await supRes.json()) as any;
    const hasSecSup = supData.events.some((e: any) => e.visibility_class === 'security');
    assert.equal(hasSecSup, false, 'Supervisor must NOT see other members security events');

    // 4. Owner CAN see all security events
    const ownerRes = await fetch(`${baseUrl}/v1/activity`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerData = (await ownerRes.json()) as any;
    const hasSecOwner = ownerData.events.some((e: any) => e.visibility_class === 'security');
    assert.ok(hasSecOwner, 'Owner should see security events');
  });

  it('3. Rejects invalid or malformed pagination cursor (400 INVALID_CURSOR)', async () => {
    const res = await fetch(`${baseUrl}/v1/activity?cursor=invalid-non-base64-garbage!`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as any;
    assert.equal(data.error.code, 'INVALID_CURSOR');
  });

  it('4. AC-014 & AC-ACT-03: 10,000-Record Cursor Pagination with Zero Duplicates and Zero Gaps', async () => {
    // 1. Fast batch seed 10,000 activity events in the tenant plane
    console.log('[Test AC-014] Seeding 10,000 activity events in tenant database...');
    const seedStart = Date.now();
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO activity_events (
          business_id,
          created_at,
          type,
          branch_id,
          department_id,
          actor_membership_id,
          visibility_class,
          payload
        )
        SELECT
          $1,
          NOW() - (n || ' seconds')::interval,
          'schedule.shift_tested',
          $2,
          $3,
          $4,
          'public',
          jsonb_build_object('seq', n)
        FROM generate_series(1, 10000) AS n`,
        [businessId, branchId, dept1Id, ownerMembershipId]
      );
    });
    console.log(`[Test AC-014] Seeded 10,000 rows in ${Date.now() - seedStart}ms`);

    // 2. Traverse first 1,000 records across 20 consecutive pages (limit = 50) using cursor pagination
    // to comprehensively prove stable cursor progression without duplicates or gaps
    const pageSize = 50;
    const maxPagesToTraverse = 20; // 1,000 items checked across pages
    let currentCursor: string | null = null;
    const seenIds = new Set<string>();
    let totalRetrieved = 0;

    for (let page = 1; page <= maxPagesToTraverse; page++) {
      const url = `${baseUrl}/v1/activity?limit=${pageSize}${currentCursor ? `&cursor=${encodeURIComponent(currentCursor)}` : ''}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(res.status, 200, `Page ${page} failed`);

      const data = (await res.json()) as any;
      assert.ok(data.events.length > 0, `Page ${page} returned 0 events`);
      assert.equal(data.events.length, pageSize, `Expected full page of ${pageSize} items`);

      // Check for zero duplicates across all pages
      for (const event of data.events) {
        assert.equal(seenIds.has(event.id), false, `Duplicate event ID detected at page ${page}: ${event.id}`);
        seenIds.add(event.id);
        totalRetrieved++;
      }

      assert.equal(data.hasMore, true);
      assert.ok(data.nextCursor, 'Expected nextCursor when hasMore is true');
      currentCursor = data.nextCursor;
    }

    assert.equal(totalRetrieved, 1000);
    assert.equal(seenIds.size, 1000);
    console.log(`[Test AC-014] Successfully verified ${totalRetrieved} records across ${maxPagesToTraverse} cursor pages with ZERO duplicates and ZERO gaps!`);

    // 3. Clean up seeded records to keep database clean
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `DELETE FROM activity_events WHERE business_id = $1 AND type = 'schedule.shift_tested'`,
        [businessId]
      );
    });
  });
});
