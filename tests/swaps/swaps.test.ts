import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';

describe('Milestone M5: Shift Swaps Lifecycle, Stale Invalidation & Tenant Scoping', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let ownerMembershipId: string;
  let staff1Token: string;
  let staff1MembershipId: string;
  let staff2Token: string;
  let staff2MembershipId: string;
  let staff3Token: string; // Different department
  let staff3MembershipId: string;

  let businessId: string;
  let branchId: string;
  let checkoutDeptId: string;
  let stockDeptId: string;

  let shift1Id: string;
  let shift2Id: string;
  let shift3Id: string;

  let biz2Token: string;
  let biz2Id: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Owner registration & organization onboarding
    const ownerEmail = `swap_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Owner Swaps' }),
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
        name: 'Swap Retail Group',
        timezone: 'UTC',
        branchName: 'Main Store',
        departments: ['Checkout', 'Stock'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    ownerToken = onboardData.tokens.accessToken;
    ownerMembershipId = onboardData.membership.id;

    checkoutDeptId = onboardData.departments.find((d: any) => d.name === 'Checkout').id;
    stockDeptId = onboardData.departments.find((d: any) => d.name === 'Stock').id;

    // Helper to register staff member
    async function createStaffUser(name: string, deptId: string) {
      const email = `staff_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
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
         VALUES ($1, $2, 'Swap Retail Group', 'Staff', 'active')`,
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

    // Create Staff 1 & Staff 2 in Checkout
    const s1 = await createStaffUser('Staff One', checkoutDeptId);
    staff1Token = s1.token;
    staff1MembershipId = s1.membershipId;

    const s2 = await createStaffUser('Staff Two', checkoutDeptId);
    staff2Token = s2.token;
    staff2MembershipId = s2.membershipId;

    // Create Staff 3 in Stock (different department)
    const s3 = await createStaffUser('Staff Three', stockDeptId);
    staff3Token = s3.token;
    staff3MembershipId = s3.membershipId;

    // 2. Setup second business for isolation testing
    const b2OwnerEmail = `b2_swap_owner_${Date.now()}@example.com`;
    const regB2Res = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: b2OwnerEmail, password: 'Password123!', name: 'B2 Owner' }),
    });
    const regB2Data = (await regB2Res.json()) as any;
    const onboardB2Res = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regB2Data.tokens.accessToken}`,
      },
      body: JSON.stringify({
        name: 'Isolated Business B',
        timezone: 'UTC',
        branchName: 'Branch B',
        departments: ['Operations'],
      }),
    });
    const onboardB2Data = (await onboardB2Res.json()) as any;
    biz2Id = onboardB2Data.business.id;
    biz2Token = onboardB2Data.tokens.accessToken;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await closeAllPools();
  });

  it('1. Creates published shifts and assigns Staff 1 and Staff 2', async () => {
    // Shift 1: tomorrow 08:00 - 16:00
    const start1 = new Date(Date.now() + 24 * 3600 * 1000);
    start1.setUTCHours(8, 0, 0, 0);
    const end1 = new Date(start1.getTime() + 8 * 3600 * 1000);

    const s1Res = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: start1.toISOString(),
        endsAt: end1.toISOString(),
        status: 'published',
      }),
    });
    const s1Data = (await s1Res.json()) as any;
    assert.equal(s1Res.status, 201);
    shift1Id = s1Data.shift.id;

    // Shift 2: day after tomorrow 08:00 - 16:00
    const start2 = new Date(Date.now() + 48 * 3600 * 1000);
    start2.setUTCHours(8, 0, 0, 0);
    const end2 = new Date(start2.getTime() + 8 * 3600 * 1000);

    const s2Res = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: start2.toISOString(),
        endsAt: end2.toISOString(),
        status: 'published',
      }),
    });
    const s2Data = (await s2Res.json()) as any;
    assert.equal(s2Res.status, 201);
    shift2Id = s2Data.shift.id;

    // Shift 3 in Stock department
    const s3Res = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: stockDeptId,
        startsAt: start2.toISOString(),
        endsAt: end2.toISOString(),
        status: 'published',
      }),
    });
    const s3Data = (await s3Res.json()) as any;
    shift3Id = s3Data.shift.id;

    // Assign shift 1 to Staff 1
    const a1Res = await fetch(`${baseUrl}/v1/scheduling/shifts/${shift1Id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff1MembershipId }),
    });
    assert.equal(a1Res.status, 200);

    // Assign shift 2 to Staff 2
    const a2Res = await fetch(`${baseUrl}/v1/scheduling/shifts/${shift2Id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff2MembershipId }),
    });
    assert.equal(a2Res.status, 200);

    // Assign shift 3 to Staff 3
    const a3Res = await fetch(`${baseUrl}/v1/scheduling/shifts/${shift3Id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff3MembershipId }),
    });
    assert.equal(a3Res.status, 200);
  });

  it('2. Rejects self-swap and cross-department swap (FR-SWP-006, C-07, AC-SCH-05)', async () => {
    // Self-swap
    const selfRes = await fetch(`${baseUrl}/v1/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1Token}` },
      body: JSON.stringify({
        requesterShiftId: shift1Id,
        counterpartMembershipId: staff1MembershipId,
        counterpartShiftId: shift2Id,
      }),
    });
    assert.equal(selfRes.status, 400);
    const selfData = (await selfRes.json()) as any;
    assert.equal(selfData.error.code, 'SELF_SWAP_DISALLOWED');

    // Cross-department swap (Staff 1 in Checkout with Staff 3 in Stock)
    const crossRes = await fetch(`${baseUrl}/v1/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1Token}` },
      body: JSON.stringify({
        requesterShiftId: shift1Id,
        counterpartMembershipId: staff3MembershipId,
        counterpartShiftId: shift3Id,
      }),
    });
    assert.equal(crossRes.status, 400);
    const crossData = (await crossRes.json()) as any;
    assert.equal(crossData.error.code, 'CROSS_DEPARTMENT_SWAP_UNSUPPORTED');
  });

  let swapRequestId: string;

  it('3. Staff 1 requests swap with Staff 2 in same department (FR-SWP-001, AC-SCH-05)', async () => {
    const res = await fetch(`${baseUrl}/v1/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1Token}` },
      body: JSON.stringify({
        requesterShiftId: shift1Id,
        counterpartMembershipId: staff2MembershipId,
        counterpartShiftId: shift2Id,
        notes: 'Can you cover my Friday shift?',
      }),
    });

    assert.equal(res.status, 201);
    const data = (await res.json()) as any;
    assert.equal(data.swap.status, 'pending');
    assert.equal(data.swap.requester_shift_version, 1);
    assert.equal(data.swap.counterpart_shift_version, 1);
    swapRequestId = data.swap.id;
  });

  it('4. Rejects duplicate swap request for already-pending shift', async () => {
    const dupRes = await fetch(`${baseUrl}/v1/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1Token}` },
      body: JSON.stringify({
        requesterShiftId: shift1Id,
        counterpartMembershipId: staff2MembershipId,
        counterpartShiftId: shift2Id,
      }),
    });
    assert.equal(dupRes.status, 409);
    const dupData = (await dupRes.json()) as any;
    assert.equal(dupData.error.code, 'CONFLICTING_SWAP');
  });

  it('5. Rejects swap approval before peer acceptance (BR-004, AC-SCH-05)', async () => {
    const approveRes = await fetch(`${baseUrl}/v1/swaps/${swapRequestId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(approveRes.status, 400);
    const approveData = (await approveRes.json()) as any;
    assert.equal(approveData.error.code, 'SWAP_NOT_ACCEPTED');
  });

  it('6. Rejects peer acceptance from unauthorized user (403 FORBIDDEN)', async () => {
    // Staff 3 attempts to accept swap intended for Staff 2
    const unauthRes = await fetch(`${baseUrl}/v1/swaps/${swapRequestId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff3Token}` },
    });
    assert.equal(unauthRes.status, 403);
  });

  it('7. Stale shift rejection: modifying a shift invalidates pending swap (BR-003, FR-SWP-004, AC-007)', async () => {
    // 1. Owner updates Shift 1, bumping its version to 2
    const patchRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shift1Id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        status: 'published',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = (await patchRes.json()) as any;
    assert.equal(patchData.shift.version, 2);

    // 2. Staff 2 attempts to accept the swap -> Rejected as stale (409 STALE_SWAP)
    const acceptRes = await fetch(`${baseUrl}/v1/swaps/${swapRequestId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff2Token}` },
    });
    assert.equal(acceptRes.status, 409);
    const acceptData = (await acceptRes.json()) as any;
    assert.equal(acceptData.error.code, 'STALE_SWAP');

    // Verify swap status in DB is now 'stale'
    const listRes = await fetch(`${baseUrl}/v1/swaps`, {
      headers: { Authorization: `Bearer ${staff1Token}` },
    });
    const listData = (await listRes.json()) as any;
    const staleSwap = listData.swaps.find((s: any) => s.id === swapRequestId);
    assert.equal(staleSwap.status, 'stale');
  });

  it('8. Peer acceptance & Manager approval with atomic assignment swap (FR-SWP-002, FR-SWP-003, AC-SCH-05)', async () => {
    // 1. Create fresh swap request referencing current versions (shift 1 is v2, shift 2 is v1)
    const reqRes = await fetch(`${baseUrl}/v1/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1Token}` },
      body: JSON.stringify({
        requesterShiftId: shift1Id,
        counterpartMembershipId: staff2MembershipId,
        counterpartShiftId: shift2Id,
        notes: 'Resubmitting after schedule update',
      }),
    });
    assert.equal(reqRes.status, 201);
    const freshSwap = ((await reqRes.json()) as any).swap;
    assert.equal(freshSwap.requester_shift_version, 2);
    assert.equal(freshSwap.counterpart_shift_version, 1);

    // 2. Staff 2 accepts swap
    const acceptRes = await fetch(`${baseUrl}/v1/swaps/${freshSwap.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff2Token}` },
    });
    assert.equal(acceptRes.status, 200);
    const acceptedData = (await acceptRes.json()) as any;
    assert.equal(acceptedData.swap.status, 'peer_accepted');

    // 3. Manager approves swap
    const approveRes = await fetch(`${baseUrl}/v1/swaps/${freshSwap.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(approveRes.status, 200);
    const approvedData = (await approveRes.json()) as any;
    assert.equal(approvedData.swap.status, 'approved');
    assert.equal(approvedData.swap.approved_by, ownerMembershipId);

    // 4. Verify assignments were atomically swapped in database
    await withTenantContext(businessId, async (client) => {
      // Shift 1 was Staff 1, should now be assigned to Staff 2
      const a1 = await client.query(
        'SELECT membership_id FROM shift_assignments WHERE business_id = $1 AND shift_id = $2',
        [businessId, shift1Id]
      );
      assert.equal(a1.rows[0].membership_id, staff2MembershipId);

      // Shift 2 was Staff 2, should now be assigned to Staff 1
      const a2 = await client.query(
        'SELECT membership_id FROM shift_assignments WHERE business_id = $1 AND shift_id = $2',
        [businessId, shift2Id]
      );
      assert.equal(a2.rows[0].membership_id, staff1MembershipId);

      // Both shift versions must be bumped
      const s1Ver = await client.query('SELECT version FROM shifts WHERE business_id = $1 AND id = $2', [
        businessId,
        shift1Id,
      ]);
      const s2Ver = await client.query('SELECT version FROM shifts WHERE business_id = $1 AND id = $2', [
        businessId,
        shift2Id,
      ]);
      assert.equal(s1Ver.rows[0].version, 3);
      assert.equal(s2Ver.rows[0].version, 2);
    });
  });

  it('9. Enforces tenant isolation: Business B cannot access or modify Business A swaps (AC-TEN-01)', async () => {
    // Attempt to accept Business A swap using Business B token
    const res = await fetch(`${baseUrl}/v1/swaps/${swapRequestId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${biz2Token}` },
    });
    // Due to RLS and tenant scoping, swap does not exist in Business B
    assert.equal(res.status, 404);

    // Attempt to approve Business A swap using Business B token
    const approveRes = await fetch(`${baseUrl}/v1/swaps/${swapRequestId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${biz2Token}` },
    });
    assert.equal(approveRes.status, 404);
  });
});
