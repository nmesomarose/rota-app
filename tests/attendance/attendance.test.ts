import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';

describe('Milestone M5: Attendance Tracking, Duplicate Prevention & Manager Notifications', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let staff1Token: string;
  let staff1MembershipId: string;
  let staff2Token: string;
  let staff2MembershipId: string;

  let businessId: string;
  let branchId: string;
  let deptId: string;

  let publishedShiftId: string;
  let draftShiftId: string;
  let assignment1Id: string;
  let assignment2Id: string;
  let draftAssignmentId: string;

  let biz2Token: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Owner & Org setup
    const ownerEmail = `att_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Owner Attendance' }),
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
        name: 'Apex Health Center',
        timezone: 'UTC',
        branchName: 'Main Clinic',
        departments: ['Nursing'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    deptId = onboardData.departments[0].id;
    ownerToken = onboardData.tokens.accessToken;

    // Helper to register staff member
    async function createStaff(name: string) {
      const email = `att_staff_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
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
           VALUES ($1, $2, 'Staff', 'active', $3, $4)
           RETURNING id`,
          [businessId, userId, branchId, deptId]
        );
        memId = res.rows[0].id;
      });

      await controlPool.query(
        `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
         VALUES ($1, $2, 'Apex Health Center', 'Staff', 'active')`,
        [userId, businessId]
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

    const s1 = await createStaff('Nurse Joy');
    staff1Token = s1.token;
    staff1MembershipId = s1.membershipId;

    const s2 = await createStaff('Nurse Kelly');
    staff2Token = s2.token;
    staff2MembershipId = s2.membershipId;

    // 2. Setup second business for cross-tenant testing
    const b2Email = `b2_att_${Date.now()}@example.com`;
    const regB2 = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: b2Email, password: 'Password123!', name: 'B2 Admin' }),
    });
    const regB2Data = (await regB2.json()) as any;
    const onboardB2 = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regB2Data.tokens.accessToken}`,
      },
      body: JSON.stringify({
        name: 'Clinic Two',
        timezone: 'UTC',
        branchName: 'Branch 2',
        departments: ['Ward'],
      }),
    });
    biz2Token = ((await onboardB2.json()) as any).tokens.accessToken;

    // 3. Create published shift and draft shift
    const start1 = new Date(Date.now() + 24 * 3600 * 1000);
    start1.setUTCHours(9, 0, 0, 0);
    const end1 = new Date(start1.getTime() + 8 * 3600 * 1000);

    const sPubRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: deptId,
        startsAt: start1.toISOString(),
        endsAt: end1.toISOString(),
        status: 'published',
      }),
    });
    publishedShiftId = ((await sPubRes.json()) as any).shift.id;

    const start2 = new Date(start1.getTime() + 24 * 3600 * 1000);
    const end2 = new Date(start2.getTime() + 8 * 3600 * 1000);

    const sDraftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: deptId,
        startsAt: start2.toISOString(),
        endsAt: end2.toISOString(),
        status: 'draft',
      }),
    });
    draftShiftId = ((await sDraftRes.json()) as any).shift.id;

    // Assign Staff 1 and Staff 2 to published shift
    const a1Res = await fetch(`${baseUrl}/v1/scheduling/shifts/${publishedShiftId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff1MembershipId }),
    });
    assignment1Id = ((await a1Res.json()) as any).assignment.id;

    const a2Res = await fetch(`${baseUrl}/v1/scheduling/shifts/${publishedShiftId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff2MembershipId }),
    });
    assignment2Id = ((await a2Res.json()) as any).assignment.id;

    // Assign Staff 1 to draft shift
    const aDraftRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${draftShiftId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff1MembershipId }),
    });
    draftAssignmentId = ((await aDraftRes.json()) as any).assignment.id;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await closeAllPools();
  });

  it('1. Rejects staff member recording attendance (403 FORBIDDEN, FR-ATT-001)', async () => {
    const res = await fetch(`${baseUrl}/v1/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1Token}` },
      body: JSON.stringify({
        shiftAssignmentId: assignment1Id,
        state: 'present',
      }),
    });
    assert.equal(res.status, 403);
  });

  it('2. Rejects attendance on unpublished draft shifts (400 SHIFT_NOT_PUBLISHED, FR-ATT-001)', async () => {
    const res = await fetch(`${baseUrl}/v1/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        shiftAssignmentId: draftAssignmentId,
        state: 'present',
      }),
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as any;
    assert.equal(data.error.code, 'SHIFT_NOT_PUBLISHED');
  });

  it('3. Manager records present attendance on published shift (FR-ATT-001, AC-SCH-07)', async () => {
    const res = await fetch(`${baseUrl}/v1/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        shiftAssignmentId: assignment1Id,
        state: 'present',
        notes: 'On time for morning round',
      }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as any;
    assert.equal(data.attendance.state, 'present');
    assert.equal(data.attendance.membership_id, staff1MembershipId);
  });

  it('4. Rejects duplicate attendance record for the same shift assignment (409 DUPLICATE_ATTENDANCE)', async () => {
    const dupRes = await fetch(`${baseUrl}/v1/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        shiftAssignmentId: assignment1Id,
        state: 'late',
      }),
    });
    assert.equal(dupRes.status, 409);
    const dupData = (await dupRes.json()) as any;
    assert.equal(dupData.error.code, 'DUPLICATE_ATTENDANCE');
  });

  it('5. Manager records absence and triggers manager notification (FR-ATT-002, AC-SCH-07)', async () => {
    const res = await fetch(`${baseUrl}/v1/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        shiftAssignmentId: assignment2Id,
        state: 'absent',
        notes: 'Unexcused absence',
      }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as any;
    assert.equal(data.attendance.state, 'absent');

    // Check manager's inbox for urgent absence notification
    const inboxRes = await fetch(`${baseUrl}/v1/notifications/inbox`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(inboxRes.status, 200);
    const inboxData = (await inboxRes.json()) as any;
    const absenceItem = inboxData.inbox.find((i: any) => i.category === 'attendance');
    assert.ok(absenceItem, 'Expected urgent attendance notification in manager inbox');
    assert.equal(absenceItem.urgent, true);
    assert.equal(absenceItem.title, 'Staff Absence Reported');
  });

  it('6. Staff can only view their own attendance records (AC-ACT-01)', async () => {
    // Staff 1 lists attendance
    const s1Res = await fetch(`${baseUrl}/v1/attendance`, {
      headers: { Authorization: `Bearer ${staff1Token}` },
    });
    assert.equal(s1Res.status, 200);
    const s1Data = (await s1Res.json()) as any;

    // Must see Staff 1 record
    const hasS1 = s1Data.attendance.some((r: any) => r.membership_id === staff1MembershipId);
    assert.ok(hasS1);

    // Must NOT see Staff 2's absence record
    const hasS2 = s1Data.attendance.some((r: any) => r.membership_id === staff2MembershipId);
    assert.equal(hasS2, false);
  });

  it('7. Enforces tenant isolation: Business B cannot read or record Business A attendance (AC-TEN-01)', async () => {
    const crossRes = await fetch(`${baseUrl}/v1/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${biz2Token}` },
      body: JSON.stringify({
        shiftAssignmentId: assignment1Id,
        state: 'present',
      }),
    });
    assert.equal(crossRes.status, 404);
  });
});
