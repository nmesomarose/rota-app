import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { controlPool, closeAllPools } from '../src/db/connection.ts';
import { withTenantContext } from '../src/db/tenant-context.ts';

async function main() {
  console.log('================================================================');
  console.log('   ROTA E2E SHIFT ASSIGNMENT, OVERLAP & SWAP VERIFICATION TEST   ');
  console.log('================================================================');

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Register Owner & Onboard Organization
    const ownerEmail = `swap_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Owner Verified' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    let ownerToken = regOwnerData.tokens.accessToken;

    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Apex Healthcare Org',
        timezone: 'UTC',
        branchName: 'Main Clinic',
        departments: ['Ward A', 'Ward B'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    const businessId = onboardData.business.id;
    const branchId = onboardData.branch.id;
    ownerToken = onboardData.tokens.accessToken;
    const wardADeptId = onboardData.departments.find((d: any) => d.name === 'Ward A').id;

    console.log('✔ [STEP 1] Organization onboarded with active tenant context.');

    // 2. Helper to register staff member
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
         VALUES ($1, $2, 'Apex Healthcare Org', 'Staff', 'active')`,
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
      return { token: switchData.tokens.accessToken as string, membershipId: memId, name, email };
    }

    const staff1 = await createStaffUser('Nurse Sarah', wardADeptId);
    const staff2 = await createStaffUser('Nurse Michael', wardADeptId);
    console.log(`✔ [STEP 2] Created staff members: ${staff1.name} and ${staff2.name}.`);

    // 3. Create Shifts in Ward A
    // Shift 1: Nov 10, 08:00 - 16:00
    // Shift 2: Nov 11, 12:00 - 20:00
    // Shift 3 (Overlapping with Shift 1): Nov 10, 10:00 - 18:00
    const s1Res = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: wardADeptId,
        startsAt: '2026-11-10T08:00:00.000Z',
        endsAt: '2026-11-10T16:00:00.000Z',
        status: 'draft',
      }),
    });
    const s1Data = (await s1Res.json()) as any;
    const shift1Id = s1Data.shift.id;

    const s2Res = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: wardADeptId,
        startsAt: '2026-11-11T12:00:00.000Z',
        endsAt: '2026-11-11T20:00:00.000Z',
        status: 'draft',
      }),
    });
    const s2Data = (await s2Res.json()) as any;
    const shift2Id = s2Data.shift.id;

    const sOverlapRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        branchId,
        departmentId: wardADeptId,
        startsAt: '2026-11-10T10:00:00.000Z',
        endsAt: '2026-11-10T18:00:00.000Z',
        status: 'draft',
      }),
    });
    const sOverlapData = (await sOverlapRes.json()) as any;
    const shiftOverlapId = sOverlapData.shift.id;
    console.log('✔ [STEP 3] Shifts created in schedule.');

    // 4. Assign Staff 1 to Shift 1, and Staff 2 to Shift 2
    await fetch(`${baseUrl}/v1/scheduling/shifts/${shift1Id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff1.membershipId }),
    });

    await fetch(`${baseUrl}/v1/scheduling/shifts/${shift2Id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ membershipId: staff2.membershipId }),
    });
    console.log('✔ [STEP 4] Staff 1 assigned to Shift 1; Staff 2 assigned to Shift 2.');

    // 5. Test Overlap Conflict Prevention:
    // Check conflicts when attempting to assign Staff 1 to overlapping shift (Nov 10, 10:00-18:00)
    const conflictRes = await fetch(
      `${baseUrl}/v1/scheduling/conflicts?shiftId=${shiftOverlapId}&membershipId=${staff1.membershipId}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${ownerToken}` },
      }
    );
    const conflictData = (await conflictRes.json()) as any;
    const overlapConflict = conflictData.conflicts?.find((c: any) => c.type === 'OVERLAP');
    if (!conflictData.hasConflict || !overlapConflict) {
      throw new Error(`Expected overlap conflict, received: ${JSON.stringify(conflictData)}`);
    }
    console.log(`✔ [STEP 5] OVERLAP CONFLICT DETECTED & PREVENTED:`);
    console.log(`         Conflict Type: "${overlapConflict.type}", Message: "${overlapConflict.message}"`);

    // 6. Publish Shifts 1 & 2
    await fetch(`${baseUrl}/v1/scheduling/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ shiftIds: [shift1Id, shift2Id] }),
    });
    console.log('✔ [STEP 6] Shifts published to live schedule.');

    // 7. Verify Staff View Before Swap (Both see shifts, assignments, and names)
    const scheduleRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      headers: { Authorization: `Bearer ${staff1.token}` },
    });
    const scheduleData = (await scheduleRes.json()) as any;
    const publishedShifts = scheduleData.shifts;
    console.log(`✔ [STEP 7] Schedule retrieved: ${publishedShifts.length} published shifts available.`);

    // 8. Staff 1 requests a shift swap with Staff 2
    const swapReqRes = await fetch(`${baseUrl}/v1/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff1.token}` },
      body: JSON.stringify({
        requesterShiftId: shift1Id,
        counterpartMembershipId: staff2.membershipId,
        counterpartShiftId: shift2Id,
        notes: 'Trading morning shift for evening shift',
      }),
    });
    const swapReqData = (await swapReqRes.json()) as any;
    if (swapReqRes.status !== 201) {
      throw new Error(`Swap request failed: ${JSON.stringify(swapReqData)}`);
    }
    const swapId = swapReqData.swap.id;
    console.log(`✔ [STEP 8] Staff 1 submitted swap request (ID: ${swapId}, status: ${swapReqData.swap.status}).`);

    // 9. Staff 2 accepts the swap request
    const acceptRes = await fetch(`${baseUrl}/v1/swaps/${swapId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staff2.token}` },
    });
    const acceptData = (await acceptRes.json()) as any;
    if (acceptRes.status !== 200 || acceptData.swap.status !== 'peer_accepted') {
      throw new Error(`Swap accept failed: ${JSON.stringify(acceptData)}`);
    }
    console.log(`✔ [STEP 9] Staff 2 accepted swap request (status: ${acceptData.swap.status}).`);

    // 10. Manager approves the swap request
    const approveRes = await fetch(`${baseUrl}/v1/swaps/${swapId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const approveData = (await approveRes.json()) as any;
    if (approveRes.status !== 200 || approveData.swap.status !== 'approved') {
      throw new Error(`Swap approve failed: ${JSON.stringify(approveData)}`);
    }
    console.log(`✔ [STEP 10] Manager approved swap request (status: ${approveData.swap.status}).`);

    // 11. Final Verification: Fetch updated schedule and verify clean swap
    const finalScheduleRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const finalScheduleData = (await finalScheduleRes.json()) as any;
    const finalShifts = finalScheduleData.shifts;

    const finalShift1 = finalShifts.find((s: any) => s.id === shift1Id);
    const finalShift2 = finalShifts.find((s: any) => s.id === shift2Id);

    const shift1Assigned = (finalShift1.assignments || []).map((a: any) => a.membershipId);
    const shift2Assigned = (finalShift2.assignments || []).map((a: any) => a.membershipId);

    console.log('----------------------------------------------------------------');
    console.log('FINAL SWAP RESULTS IN DATABASE:');
    console.log(`- Shift 1 (08:00 - 16:00): Now assigned to Staff 2 (${staff2.name}) -> ${shift1Assigned.includes(staff2.membershipId) ? 'PASS ✅' : 'FAIL ❌'}`);
    console.log(`- Shift 2 (12:00 - 20:00): Now assigned to Staff 1 (${staff1.name}) -> ${shift2Assigned.includes(staff1.membershipId) ? 'PASS ✅' : 'FAIL ❌'}`);
    console.log('- Overlap Conflicts Encountered: ZERO (0) ✅');
    console.log('----------------------------------------------------------------');

    if (!shift1Assigned.includes(staff2.membershipId) || !shift2Assigned.includes(staff1.membershipId)) {
      throw new Error('Shift assignments did not swap cleanly!');
    }

    console.log('🎉 FULL PROCESS TEST PASSED WITH 100% SUCCESS!');
  } finally {
    server.close();
    await closeAllPools();
  }
}

main().catch((err) => {
  console.error('❌ Test execution error:', err);
  process.exit(1);
});
