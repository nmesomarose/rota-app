import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { hashPassword } from '../../src/services/password-service.ts';
import { assignWorker, createShift } from '../../src/services/scheduling-service.ts';

describe('Milestone M4: Notifications & In-App Inbox', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let staffToken: string;
  let staffUserId: string;
  let staffMembershipId: string;
  let businessId: string;
  let branchId: string;
  let departmentId: string;

  let advBusinessId: string;
  let advUserId: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register Owner
    const ownerEmail = `m4_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'SecurePass123!', name: 'M4 Owner' }),
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
        name: 'M4 Notification Enterprise',
        timezone: 'Europe/London',
        branchName: 'Main Branch',
        departments: ['Operations'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    departmentId = onboardData.departments[0].id;
    ownerToken = onboardData.tokens.accessToken;

    // 3. Register Staff user
    const staffEmail = `m4_staff_${Date.now()}@example.com`;
    const regStaffRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'SecurePass123!', name: 'Staff Worker' }),
    });
    const regStaffData = (await regStaffRes.json()) as any;
    staffUserId = regStaffData.user.id;

    // 4. Create Staff membership in tenant
    await withTenantContext(businessId, async (client) => {
      const memRes = await client.query<{ id: string }>(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
         VALUES ($1, $2, 'Staff', 'active', $3, $4)
         RETURNING id`,
        [businessId, staffUserId, branchId, departmentId]
      );
      staffMembershipId = memRes.rows[0].id;
    });

    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'M4 Notification Enterprise', 'Staff', 'active')`,
      [staffUserId, businessId]
    );

    // Switch/login staff into business context
    const staffLoginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'SecurePass123!' }),
    });
    const staffLoginData = (await staffLoginRes.json()) as any;
    staffToken = staffLoginData.tokens.accessToken;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Cleanup
    if (businessId) {
      await withTenantContext(businessId, async (client) => {
        await client.query('DELETE FROM inbox_items WHERE business_id = $1', [businessId]);
        await client.query('DELETE FROM notification_deliveries WHERE business_id = $1', [businessId]);
        await client.query('DELETE FROM activity_events WHERE business_id = $1', [businessId]);
        await client.query('DELETE FROM shifts WHERE business_id = $1', [businessId]);
        await client.query('DELETE FROM memberships WHERE business_id = $1', [businessId]);
        await client.query('DELETE FROM businesses WHERE id = $1', [businessId]);
      });
      await controlPool.query('DELETE FROM membership_directory WHERE business_id = $1', [businessId]);
    }
    if (staffUserId) {
      await controlPool.query('DELETE FROM push_tokens WHERE user_id = $1', [staffUserId]);
      await controlPool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
    }
    if (advBusinessId) {
      await withTenantContext(advBusinessId, async (client) => {
        await client.query('DELETE FROM businesses WHERE id = $1', [advBusinessId]);
      });
      await controlPool.query('DELETE FROM membership_directory WHERE business_id = $1', [advBusinessId]);
    }
    if (advUserId) {
      await controlPool.query('DELETE FROM users WHERE id = $1', [advUserId]);
    }
    await closeAllPools();
  });

  it('registers a device push token in control plane and prevents duplicate token collision (FR-NOT-002, AC-NOT-09, C-10)', async () => {
    const testToken = `ExponentPushToken[m4_test_device_${Date.now()}]`;
    const deviceId = 'test_device_android_123';

    // 1. First registration
    const res1 = await fetch(`${baseUrl}/v1/notifications/push-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        token: testToken,
        deviceId,
        platform: 'expo',
      }),
    });
    const data1 = (await res1.json()) as any;

    assert.equal(res1.status, 200);
    assert.equal(data1.pushToken.token, testToken);

    // 2. Re-registering the same token updates it without duplicate key error
    const res2 = await fetch(`${baseUrl}/v1/notifications/push-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        token: testToken,
        deviceId,
        platform: 'expo',
      }),
    });
    const data2 = (await res2.json()) as any;

    assert.equal(res2.status, 200);
    assert.equal(data2.pushToken.token, testToken);

    // Verify exactly 1 row exists in push_tokens for this token
    const checkDb = await controlPool.query(
      'SELECT COUNT(*)::int AS count FROM push_tokens WHERE token = $1',
      [testToken]
    );
    assert.equal(checkDb.rows[0].count, 1);
  });

  it('publishing a schedule notifies affected staff with in-app fallback (AC-006, FR-SCH-006, BR-002)', async () => {
    // 1. Create a draft shift in 24 hours (non-urgent)
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 32 * 60 * 60 * 1000).toISOString();

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt,
      endsAt,
      timeZone: 'Europe/London',
    });

    // 2. Assign staff member to the shift
    await assignWorker(
      businessId,
      shift.id,
      staffMembershipId,
      staffMembershipId,
      'owner',
      'req-m4-assign'
    );

    // 3. Publish the schedule
    const pubRes = await fetch(`${baseUrl}/v1/scheduling/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ shiftIds: [shift.id] }),
    });
    const pubData = (await pubRes.json()) as any;

    assert.equal(pubRes.status, 200);
    assert.equal(pubData.count, 1);

    // 4. Check that staff member received an in-app inbox item
    const inboxRes = await fetch(`${baseUrl}/v1/notifications/inbox`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${staffToken}`,
      },
    });
    const inboxData = (await inboxRes.json()) as any;

    assert.equal(inboxRes.status, 200);
    assert.ok(inboxData.count >= 1);
    const pubItem = inboxData.inbox.find((i: { category: string; title: string }) =>
      i.title.includes('Schedule Published')
    );
    assert.ok(pubItem, 'In-app inbox notification was generated');
    assert.equal(pubItem.urgent, false, 'Shift >12h away is non-urgent');
  });

  it('marks notifications urgent if shift starts within 12 hours (D-14, AC-NOT-01)', async () => {
    // 1. Create a draft shift starting in 4 hours
    const startsAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt,
      endsAt,
      timeZone: 'Europe/London',
    });

    await assignWorker(
      businessId,
      shift.id,
      staffMembershipId,
      staffMembershipId,
      'owner',
      'req-m4-urgent-assign'
    );

    // 2. Publish the shift
    const pubRes = await fetch(`${baseUrl}/v1/scheduling/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ shiftIds: [shift.id] }),
    });
    assert.equal(pubRes.status, 200);

    // 3. Verify in-app inbox item is marked urgent
    const inboxRes = await fetch(`${baseUrl}/v1/notifications/inbox`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${staffToken}`,
      },
    });
    const inboxData = (await inboxRes.json()) as any;

    assert.equal(inboxRes.status, 200);
    const urgentItem = inboxData.inbox.find((i: { urgent: boolean; title: string }) =>
      i.urgent === true && i.title.includes('URGENT: Schedule Published')
    );
    assert.ok(urgentItem, 'Urgent notification was correctly generated for shift within 12h');
    assert.equal(urgentItem.urgent, true);
  });

  it('allows staff to mark in-app notifications as read (FR-NOT-014)', async () => {
    const inboxRes = await fetch(`${baseUrl}/v1/notifications/inbox`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${staffToken}`,
      },
    });
    const inboxData = (await inboxRes.json()) as any;

    const itemToRead = inboxData.inbox[0];
    assert.ok(itemToRead, 'An inbox item exists');

    const markRes = await fetch(`${baseUrl}/v1/notifications/inbox/${itemToRead.id}/read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staffToken}`,
      },
    });
    const markData = (await markRes.json()) as any;

    assert.equal(markRes.status, 200);
    assert.ok(markData.item.read_at !== null);
  });

  it('enforces tenant isolation on in-app notifications (AC-TEN-01)', async () => {
    // 1. Register Adversary Owner
    const advEmail = `m4_adv_${Date.now()}@example.com`;
    const regAdvRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: advEmail, password: 'SecurePass123!', name: 'Adversary Owner' }),
    });
    const regAdvData = (await regAdvRes.json()) as any;
    advUserId = regAdvData.user.id;
    let advToken = regAdvData.tokens.accessToken;

    // 2. Onboard Adversary Org
    const advOrgRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${advToken}`,
      },
      body: JSON.stringify({
        name: 'M4 Adversary Corp',
        timezone: 'UTC',
        branchName: 'Adv Branch',
        departments: ['Security'],
      }),
    });
    const advOrgData = (await advOrgRes.json()) as any;
    advBusinessId = advOrgData.business.id;
    advToken = advOrgData.tokens.accessToken;

    // 3. Adversary requests inbox: must see 0 items from M4 Notification Enterprise
    const advInboxRes = await fetch(`${baseUrl}/v1/notifications/inbox`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${advToken}`,
      },
    });
    const advInboxData = (await advInboxRes.json()) as any;

    assert.equal(advInboxRes.status, 200);
    assert.equal(advInboxData.count, 0, 'Adversary cannot view other business notifications');
  });
});
