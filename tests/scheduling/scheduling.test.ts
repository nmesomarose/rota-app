import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { localToUtc, utcToLocal } from '../../src/services/timezone-service.ts';

describe('Milestone M3: Scheduling Core Integration & Security', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let ownerMembershipId: string;
  let staffToken: string;
  let staffMembershipId: string;

  let businessId: string;
  let branchId: string;
  let checkoutDeptId: string;
  let stockDeptId: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register Owner
    const ownerEmail = `sched_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Ada Schedule Owner' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    ownerToken = regOwnerData.tokens.accessToken;

    // 2. Onboard Organization with America/New_York timezone to test DST transitions
    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Metro Supermarket',
        timezone: 'America/New_York',
        branchName: 'Downtown Branch',
        departments: ['Checkout', 'Stock/Inventory'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    ownerToken = onboardData.tokens.accessToken;
    ownerMembershipId = onboardData.membership.id;

    checkoutDeptId = onboardData.departments.find((d: any) => d.name === 'Checkout').id;
    stockDeptId = onboardData.departments.find((d: any) => d.name === 'Stock/Inventory').id;

    // 3. Register Staff user
    const staffEmail = `sched_staff_${Date.now()}@example.com`;
    const regStaffRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'Password123!', name: 'Tunde Cashier' }),
    });
    const regStaffData = (await regStaffRes.json()) as any;
    const staffUserId = regStaffData.user.id;

    // 4. Attach Staff membership in tenant plane directly to Checkout department (single-department constraint C-05, D-05)
    await withTenantContext(businessId, async (client) => {
      const memRes = await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
         VALUES ($1, $2, 'Staff', 'active', $3, $4)
         RETURNING id`,
        [businessId, staffUserId, branchId, checkoutDeptId]
      );
      staffMembershipId = memRes.rows[0].id;
    });

    // 5. Sync to control-plane directory so Staff can switch business
    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Metro Supermarket', 'Staff', 'active')`,
      [staffUserId, businessId]
    );

    // 6. Switch Staff session to this business
    const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regStaffData.tokens.accessToken}`,
      },
      body: JSON.stringify({ businessId }),
    });
    const switchData = (await switchRes.json()) as any;
    staffToken = switchData.tokens.accessToken;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeAllPools();
  });

  let createdShiftId: string;

  it('1. Timezone Engine: Verifies UTC instant conversion and DST clock change preservation (AC-SCH-03, FR-SCH-009)', async () => {
    // In America/New_York:
    // Summer (EDT, UTC-4): 2026-06-15 at 08:00 local should equal 12:00:00Z UTC
    const summerUtc = localToUtc('2026-06-15', '08:00', 'America/New_York');
    assert.strictEqual(summerUtc.toISOString(), '2026-06-15T12:00:00.000Z');

    // Winter (EST, UTC-5): 2026-01-15 at 08:00 local should equal 13:00:00Z UTC
    const winterUtc = localToUtc('2026-01-15', '08:00', 'America/New_York');
    assert.strictEqual(winterUtc.toISOString(), '2026-01-15T13:00:00.000Z');

    // Both convert back to local 08:00 wall-clock time
    const summerLocal = utcToLocal(summerUtc, 'America/New_York');
    const winterLocal = utcToLocal(winterUtc, 'America/New_York');
    assert.strictEqual(summerLocal.timeStr, '08:00');
    assert.strictEqual(winterLocal.timeStr, '08:00');
  });

  it('2. Overnight Shift: Validates shift crossing midnight in UTC and local time (AC-SCH-03, FR-SCH-007)', async () => {
    // Night shift from 22:00 to 06:00 next day
    const startsAt = '2026-10-20T22:00:00.000Z';
    const endsAt = '2026-10-21T06:00:00.000Z';

    const res = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt,
        endsAt,
      }),
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;
    assert.ok(body.shift.id);
    assert.strictEqual(body.shift.status, 'draft');
    assert.strictEqual(body.shift.version, 1);
    createdShiftId = body.shift.id;
  });

  it('3. Shift Versioning: Monotonic version bumps on every edit (FR-SWP-007)', async () => {
    assert.ok(createdShiftId);

    // Edit shift start/end times
    const updateRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${createdShiftId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        startsAt: '2026-10-20T21:00:00.000Z',
        endsAt: '2026-10-21T05:00:00.000Z',
      }),
    });

    assert.strictEqual(updateRes.status, 200);
    const body = (await updateRes.json()) as any;
    assert.strictEqual(body.shift.version, 2, 'Version must increment to 2 on first edit');

    // Second edit (status change to review)
    const update2Res = await fetch(`${baseUrl}/v1/scheduling/shifts/${createdShiftId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ status: 'review' }),
    });

    assert.strictEqual(update2Res.status, 200);
    const body2 = (await update2Res.json()) as any;
    assert.strictEqual(body2.shift.version, 3, 'Version must increment to 3 on second edit');
  });

  it('4. Schedule Visibility & Permissions: Staff see ONLY published shifts (AC-SCH-02)', async () => {
    // 1. Staff queries schedule while created shift is in 'review' status
    const staffGet1 = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.strictEqual(staffGet1.status, 200);
    const staffBody1 = (await staffGet1.json()) as any;
    const foundInReview = staffBody1.shifts.find((s: any) => s.id === createdShiftId);
    assert.strictEqual(foundInReview, undefined, 'Staff must NOT see shifts in draft or review');

    // 2. Manager queries schedule: sees review shift
    const managerGet = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(managerGet.status, 200);
    const managerBody = (await managerGet.json()) as any;
    const foundManager = managerBody.shifts.find((s: any) => s.id === createdShiftId);
    assert.ok(foundManager, 'Managers must see draft/review shifts');

    // 3. Manager publishes the shift
    const publishRes = await fetch(`${baseUrl}/v1/scheduling/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ shiftIds: [createdShiftId] }),
    });
    assert.strictEqual(publishRes.status, 200);

    // 4. Staff queries schedule again: now sees published shift!
    const staffGet2 = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.strictEqual(staffGet2.status, 200);
    const staffBody2 = (await staffGet2.json()) as any;
    const foundPublished = staffBody2.shifts.find((s: any) => s.id === createdShiftId);
    assert.ok(foundPublished, 'Staff must see published shifts');
    assert.strictEqual(foundPublished.status, 'published');
  });

  it('5. RBAC Shift Deletion: Staff cannot delete shifts (403 FORBIDDEN, AC-002, FR-RBAC-002)', async () => {
    const deleteRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${createdShiftId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${staffToken}` },
    });

    assert.strictEqual(deleteRes.status, 403);
    const body = (await deleteRes.json()) as any;
    assert.strictEqual(body.error.code, 'FORBIDDEN');

    // Verify shift was NOT deleted in database
    await withTenantContext(businessId, async (client) => {
      const check = await client.query('SELECT id FROM shifts WHERE business_id = $1 AND id = $2', [
        businessId,
        createdShiftId,
      ]);
      assert.strictEqual(check.rowCount, 1);
    });
  });

  it('6. Single-Department Constraint: Rejects assigning Staff to a different department (AC-DM-02, C-07)', async () => {
    // 1. Create a shift in Stock/Inventory department
    const stockShiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: stockDeptId,
        startsAt: '2026-10-22T09:00:00.000Z',
        endsAt: '2026-10-22T17:00:00.000Z',
      }),
    });
    const stockShift = (await stockShiftRes.json()) as any;

    // 2. Attempt to assign Staff (who belongs to Checkout) to this Stock/Inventory shift
    const assignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${stockShift.shift.id}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        membershipId: staffMembershipId,
      }),
    });

    assert.strictEqual(assignRes.status, 400);
    const body = (await assignRes.json()) as any;
    assert.strictEqual(body.error.code, 'DEPARTMENT_MISMATCH');
  });

  it('7. Conflict Detection & Reasoned Override: Availability & Overlap Conflicts (AC-SCH-01, AC-RBAC-03, BR-001, BR-005)', async () => {
    // 1. Staff submits availability preference: unavailable on Tuesday (day 2) between 12:00 and 18:00
    const availRes = await fetch(`${baseUrl}/v1/scheduling/availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        dayOfWeek: 2,
        startTime: '12:00',
        endTime: '18:00',
        preference: 'unavailable',
      }),
    });
    assert.strictEqual(availRes.status, 201);

    // 2. Create a shift that falls on Tuesday during that unavailable window
    // 2026-10-20 is Tuesday. 13:00 to 17:00 America/New_York (17:00 to 21:00 UTC)
    const tuesdayShiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-10-20T17:00:00.000Z',
        endsAt: '2026-10-20T21:00:00.000Z',
      }),
    });
    const tuesdayShift = (await tuesdayShiftRes.json()) as any;
    const shiftId = tuesdayShift.shift.id;

    // 3. Attempt to assign worker WITHOUT an override reason -> Must be rejected with 409 CONFLICT_DETECTED
    const assignAttempt1 = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        membershipId: staffMembershipId,
      }),
    });

    assert.strictEqual(assignAttempt1.status, 409);
    const conflictBody = (await assignAttempt1.json()) as any;
    assert.strictEqual(conflictBody.error.code, 'CONFLICT_DETECTED');
    assert.ok(conflictBody.error.details.conflicts.length > 0);

    // 4. Attempt to assign WITH an override reason by an authorised manager -> Must succeed!
    const overrideReasonText = 'Emergency floor rush coverage approved by Store Manager';
    const assignAttempt2 = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        membershipId: staffMembershipId,
        overrideReason: overrideReasonText,
      }),
    });

    assert.strictEqual(assignAttempt2.status, 200);
    const successBody = (await assignAttempt2.json()) as any;
    assert.strictEqual(successBody.overridden, true);
    assert.strictEqual(successBody.assignment.override_reason, overrideReasonText);
    assert.strictEqual(successBody.assignment.override_by, ownerMembershipId);
    assert.ok(successBody.assignment.override_at);

    // 5. Verify audit log was recorded for this privileged action (FR-RBAC-004, AC-RBAC-04)
    await withTenantContext(businessId, async (client) => {
      const auditRes = await client.query(
        `SELECT * FROM audit_log WHERE business_id = $1 AND action = 'availability_override'`,
        [businessId]
      );
      assert.strictEqual(auditRes.rowCount, 1);
      assert.strictEqual(auditRes.rows[0].actor_membership_id, ownerMembershipId);
      assert.strictEqual(auditRes.rows[0].outcome, 'allowed');
      assert.ok(auditRes.rows[0].request_id);
    });
  });

  it('8. Recurring Staffing Requirements: Generates shifts preserving wall-clock times (FR-SCH-009, AC-SCH-03)', async () => {
    // 1. Create a requirement: 2 cashiers from 08:00 to 16:00 on weekdays
    const reqRes = await fetch(`${baseUrl}/v1/scheduling/requirements`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        roleLabel: 'Cashier',
        headcount: 2,
        localStart: '08:00',
        localEnd: '16:00',
        weekdays: [1, 2, 3, 4, 5],
      }),
    });

    assert.strictEqual(reqRes.status, 201);
    const reqBody = (await reqRes.json()) as any;
    const requirementId = reqBody.requirement.id;

    // 2. Generate shifts from requirement for a summer date (EDT, UTC-4)
    const genRes = await fetch(`${baseUrl}/v1/scheduling/requirements/${requirementId}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ dateStr: '2026-06-15' }),
    });

    assert.strictEqual(genRes.status, 201);
    const genBody = (await genRes.json()) as any;
    assert.strictEqual(genBody.count, 2, 'Must generate exactly headcount (2) shifts');
    assert.strictEqual(genBody.shifts[0].starts_at, '2026-06-15T12:00:00.000Z');
    assert.strictEqual(genBody.shifts[0].ends_at, '2026-06-15T20:00:00.000Z');
  });

  it('9. Cross-Tenant Security: Business A token cannot access Business B shifts (AC-TEN-01, SEC-015)', async () => {
    // 1. Onboard a separate Business B
    const bizBRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ name: 'Foreign Business B' }),
    });
    const bizBData = (await bizBRes.json()) as any;
    const tokenB = bizBData.tokens.accessToken;

    // 2. Attempt to read Business A's shifts using Business B's token
    const crossRes = await fetch(`${baseUrl}/v1/scheduling/shifts?departmentId=${checkoutDeptId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    assert.strictEqual(crossRes.status, 200);
    const crossBody = (await crossRes.json()) as any;
    // Due to forced RLS and tenant scoping, Business B sees 0 of Business A's shifts!
    assert.strictEqual(crossBody.shifts.length, 0);

    // 3. Attempt to delete Business A's shift using Business B's token
    const deleteCrossRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${createdShiftId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(deleteCrossRes.status, 404, 'Must return 404 NOT_FOUND for cross-tenant resource');
  });
});
