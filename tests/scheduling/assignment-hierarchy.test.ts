import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';

describe('Scheduling Shift Assignment Role Hierarchy Enforcement', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let ownerMembershipId: string;

  let gmToken: string;
  let gmMembershipId: string;

  let supervisorToken: string;
  let supervisorMembershipId: string;

  let peerSupervisorToken: string;
  let peerSupervisorMembershipId: string;

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

    const timestamp = Date.now();

    // 1. Register Owner
    const ownerEmail = `assign_owner_${timestamp}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Ada Hierarchy Owner' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    ownerToken = regOwnerData.tokens.accessToken;

    // 2. Onboard Organization
    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Hierarchy Market',
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

    // 3. Register and attach GM
    const gmEmail = `assign_gm_${timestamp}@example.com`;
    const regGmRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: gmEmail, password: 'Password123!', name: 'Garry GM' }),
    });
    const regGmData = (await regGmRes.json()) as any;
    const gmUserId = regGmData.user.id;

    await withTenantContext(businessId, async (client) => {
      const memRes = await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id)
         VALUES ($1, $2, 'gm', 'active', $3)
         RETURNING id`,
        [businessId, gmUserId, branchId]
      );
      gmMembershipId = memRes.rows[0].id;
    });
    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Hierarchy Market', 'gm', 'active')`,
      [gmUserId, businessId]
    );
    const switchGmRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regGmData.tokens.accessToken}`,
      },
      body: JSON.stringify({ businessId }),
    });
    const switchGmData = (await switchGmRes.json()) as any;
    gmToken = switchGmData.tokens.accessToken;

    // 4. Register and attach Supervisor
    const supEmail = `assign_sup_${timestamp}@example.com`;
    const regSupRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: supEmail, password: 'Password123!', name: 'Sam Supervisor' }),
    });
    const regSupData = (await regSupRes.json()) as any;
    const supUserId = regSupData.user.id;

    await withTenantContext(businessId, async (client) => {
      const memRes = await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id)
         VALUES ($1, $2, 'supervisor', 'active', $3)
         RETURNING id`,
        [businessId, supUserId, branchId]
      );
      supervisorMembershipId = memRes.rows[0].id;
    });
    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Hierarchy Market', 'supervisor', 'active')`,
      [supUserId, businessId]
    );
    const switchSupRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regSupData.tokens.accessToken}`,
      },
      body: JSON.stringify({ businessId }),
    });
    const switchSupData = (await switchSupRes.json()) as any;
    supervisorToken = switchSupData.tokens.accessToken;

    // 5. Register and attach Peer Supervisor
    const peerSupEmail = `assign_peersup_${timestamp}@example.com`;
    const regPeerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: peerSupEmail, password: 'Password123!', name: 'Stan PeerSupervisor' }),
    });
    const regPeerData = (await regPeerRes.json()) as any;
    const peerUserId = regPeerData.user.id;

    await withTenantContext(businessId, async (client) => {
      const memRes = await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id)
         VALUES ($1, $2, 'supervisor', 'active', $3)
         RETURNING id`,
        [businessId, peerUserId, branchId]
      );
      peerSupervisorMembershipId = memRes.rows[0].id;
    });
    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Hierarchy Market', 'supervisor', 'active')`,
      [peerUserId, businessId]
    );
    const switchPeerRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regPeerData.tokens.accessToken}`,
      },
      body: JSON.stringify({ businessId }),
    });
    const switchPeerData = (await switchPeerRes.json()) as any;
    peerSupervisorToken = switchPeerData.tokens.accessToken;

    // 6. Register and attach Staff member
    const staffEmail = `assign_staff_${timestamp}@example.com`;
    const regStaffRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'Password123!', name: 'Sally Staff' }),
    });
    const regStaffData = (await regStaffRes.json()) as any;
    const staffUserId = regStaffData.user.id;

    await withTenantContext(businessId, async (client) => {
      const memRes = await client.query(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
         VALUES ($1, $2, 'staff', 'active', $3, $4)
         RETURNING id`,
        [businessId, staffUserId, branchId, checkoutDeptId]
      );
      staffMembershipId = memRes.rows[0].id;
    });
    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Hierarchy Market', 'staff', 'active')`,
      [staffUserId, businessId]
    );
    const switchStaffRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regStaffData.tokens.accessToken}`,
      },
      body: JSON.stringify({ businessId }),
    });
    const switchStaffData = (await switchStaffRes.json()) as any;
    staffToken = switchStaffData.tokens.accessToken;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await closeAllPools();
  });

  it('1. Supervisor -> Staff assignment is ALLOWED (200 OK)', async () => {
    // Create shift in Checkout department
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-01T09:00:00.000Z',
        endsAt: '2026-11-01T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // Supervisor assigns Staff
    const assignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        membershipId: staffMembershipId,
      }),
    });

    assert.strictEqual(assignRes.status, 200, 'Supervisor assigning shift to Staff must be permitted');
    const assignData = (await assignRes.json()) as any;
    assert.strictEqual(assignData.assignment.membership_id, staffMembershipId);
    assert.strictEqual(assignData.assignment.shift_id, shiftId);
  });

  it('2. Supervisor -> Owner assignment is FORBIDDEN (403 FORBIDDEN, consistent authorization error)', async () => {
    // Create shift
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-02T09:00:00.000Z',
        endsAt: '2026-11-02T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // Supervisor attempts to assign Owner
    const assignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        membershipId: ownerMembershipId,
      }),
    });

    assert.strictEqual(assignRes.status, 403, 'Supervisor assigning shift to Owner must be forbidden with 403');
    const errBody = (await assignRes.json()) as any;
    assert.strictEqual(errBody.error.code, 'FORBIDDEN');
    assert.ok(
      errBody.error.message.includes('Supervisors cannot assign shifts to the Owner'),
      `Expected specific Owner hierarchy rejection message, got: ${errBody.error.message}`
    );
  });

  it('3. Supervisor -> higher role (GM) assignment is FORBIDDEN (403 FORBIDDEN)', async () => {
    // Create shift
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-03T09:00:00.000Z',
        endsAt: '2026-11-03T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // Supervisor attempts to assign GM
    const assignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        membershipId: gmMembershipId,
      }),
    });

    assert.strictEqual(assignRes.status, 403, 'Supervisor assigning shift to GM must be rejected with 403');
    const errBody = (await assignRes.json()) as any;
    assert.strictEqual(errBody.error.code, 'FORBIDDEN');
    assert.ok(
      errBody.error.message.includes('higher role') || errBody.error.message.includes('Supervisors'),
      `Expected higher role rejection message, got: ${errBody.error.message}`
    );
  });

  it('4. Supervisor -> peer Supervisor assignment is FORBIDDEN (403 FORBIDDEN)', async () => {
    // Create shift
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-04T09:00:00.000Z',
        endsAt: '2026-11-04T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // Supervisor attempts to assign peer Supervisor
    const assignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supervisorToken}`,
      },
      body: JSON.stringify({
        membershipId: peerSupervisorMembershipId,
      }),
    });

    assert.strictEqual(assignRes.status, 403, 'Supervisor assigning shift to peer Supervisor must be rejected with 403');
    const errBody = (await assignRes.json()) as any;
    assert.strictEqual(errBody.error.code, 'FORBIDDEN');
    assert.ok(
      errBody.error.message.includes('fellow Supervisors') || errBody.error.message.includes('Supervisors may only assign shifts to Staff'),
      `Expected peer supervisor rejection message, got: ${errBody.error.message}`
    );
  });

  it('5. Supervisor cannot unassign Owner from a shift (403 FORBIDDEN)', async () => {
    // 1. Create shift and let Owner assign Owner
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-05T09:00:00.000Z',
        endsAt: '2026-11-05T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // Owner assigns Owner
    const assignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ membershipId: ownerMembershipId }),
    });
    assert.strictEqual(assignRes.status, 200);

    // 2. Supervisor attempts to unassign Owner
    const unassignRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign/${ownerMembershipId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${supervisorToken}`,
      },
    });

    assert.strictEqual(unassignRes.status, 403, 'Supervisor unassigning Owner must be rejected with 403');
    const errBody = (await unassignRes.json()) as any;
    assert.strictEqual(errBody.error.code, 'FORBIDDEN');
    assert.ok(errBody.error.message.includes('Supervisors cannot unassign shifts for the Owner'));
  });

  it('6. Owner-authorized assignments: Owner can assign Staff, Supervisor, GM, and Owner', async () => {
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-06T09:00:00.000Z',
        endsAt: '2026-11-06T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // Owner assigns Supervisor -> ALLOWED
    const assignSupRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ membershipId: supervisorMembershipId }),
    });
    assert.strictEqual(assignSupRes.status, 200, 'Owner must be able to assign Supervisor');

    // Owner assigns GM -> ALLOWED
    const assignGmRes = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ membershipId: gmMembershipId }),
    });
    assert.strictEqual(assignGmRes.status, 200, 'Owner must be able to assign GM');
  });

  it('7. GM-authorized assignments: GM can assign Staff & Supervisor, but NOT Owner', async () => {
    const shiftRes = await fetch(`${baseUrl}/v1/scheduling/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        branchId,
        departmentId: checkoutDeptId,
        startsAt: '2026-11-07T09:00:00.000Z',
        endsAt: '2026-11-07T17:00:00.000Z',
      }),
    });
    assert.strictEqual(shiftRes.status, 201);
    const shiftData = (await shiftRes.json()) as any;
    const shiftId = shiftData.shift.id;

    // GM assigns Supervisor -> ALLOWED
    const gmAssignSup = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gmToken}`,
      },
      body: JSON.stringify({ membershipId: supervisorMembershipId }),
    });
    assert.strictEqual(gmAssignSup.status, 200, 'GM must be able to assign Supervisor');

    // GM attempts to assign Owner -> FORBIDDEN (403)
    const gmAssignOwner = await fetch(`${baseUrl}/v1/scheduling/shifts/${shiftId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gmToken}`,
      },
      body: JSON.stringify({ membershipId: ownerMembershipId }),
    });
    assert.strictEqual(gmAssignOwner.status, 403, 'GM assigning Owner must be rejected with 403 FORBIDDEN');
    const errBody = (await gmAssignOwner.json()) as any;
    assert.strictEqual(errBody.error.code, 'FORBIDDEN');
  });
});
