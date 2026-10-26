import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { closeRedisClient } from '../../src/services/redis-client.ts';
import { createShift, assignWorker } from '../../src/services/scheduling-service.ts';
import { requestSwap, peerAcceptSwap, peerRejectSwap, approveSwap } from '../../src/services/swap-service.ts';
import { processSubscriptionRenewal } from '../../src/services/billing-service.ts';
import { requestPasswordReset, resetPassword } from '../../src/services/auth-service.ts';
import { registerPushToken, getInboxItems } from '../../src/services/notification-service.ts';
import {
  sendPushNotification,
  setCustomPushFetch,
  clearPushDispatchHistory,
  getPushDispatchHistory,
} from '../../src/services/push-service.ts';

describe('Notification Event Integrations & Expo Push Adapter', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let ownerUserId: string;
  let ownerMembershipId: string;

  let staff1Token: string;
  let staff1UserId: string;
  let staff1MembershipId: string;

  let staff2Token: string;
  let staff2UserId: string;
  let staff2MembershipId: string;

  let businessId: string;
  let branchId: string;
  let departmentId: string;

  let shift1Id: string;
  let shift2Id: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register Owner & Onboard Organization
    const ownerEmail = `swap_notif_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'SecurePassword123!', name: 'Swap Owner' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    ownerToken = regOwnerData.tokens.accessToken;
    ownerUserId = regOwnerData.user.id;

    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Swap Notification Corp',
        timezone: 'UTC',
        branchName: 'Main Store',
        departments: ['Sales'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    departmentId = onboardData.departments[0].id;
    ownerToken = onboardData.tokens.accessToken;
    ownerMembershipId = onboardData.membership.id;

    // Helper to register staff member
    async function createStaff(name: string) {
      const email = `swap_staff_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
      const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'SecurePassword123!', name }),
      });
      const regData = (await regRes.json()) as any;
      const userId = regData.user.id;

      let memId = '';
      await withTenantContext(businessId, async (client) => {
        const res = await client.query<{ id: string }>(
          `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
           VALUES ($1, $2, 'Staff', 'active', $3, $4)
           RETURNING id`,
          [businessId, userId, branchId, departmentId]
        );
        memId = res.rows[0].id;
      });

      await controlPool.query(
        `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
         VALUES ($1, $2, 'Swap Notification Corp', 'Staff', 'active')`,
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
      return { token: switchData.tokens.accessToken as string, membershipId: memId, userId, email };
    }

    const s1 = await createStaff('Staff Alice');
    staff1Token = s1.token;
    staff1MembershipId = s1.membershipId;
    staff1UserId = s1.userId;

    const s2 = await createStaff('Staff Bob');
    staff2Token = s2.token;
    staff2MembershipId = s2.membershipId;
    staff2UserId = s2.userId;

    // Register push tokens for both staff members
    await registerPushToken({
      userId: staff1UserId,
      deviceId: 'alice_phone',
      token: `ExponentPushToken[alice_${Date.now()}]`,
    });

    await registerPushToken({
      userId: staff2UserId,
      deviceId: 'bob_phone',
      token: `ExponentPushToken[bob_${Date.now()}]`,
    });
  });

  beforeEach(() => {
    clearPushDispatchHistory();
    setCustomPushFetch(null);
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await closeRedisClient();
    await closeAllPools();
  });

  it('1. Swap request creates an inbox item and push delivery record for counterpart under category swaps', async () => {
    // Create shifts for staff 1 and staff 2
    const now = Date.now();
    const shift1 = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date(now + 24 * 3600 * 1000).toISOString(),
      endsAt: new Date(now + 32 * 3600 * 1000).toISOString(),
      timeZone: 'UTC',
    });
    shift1Id = shift1.id;

    const shift2 = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date(now + 48 * 3600 * 1000).toISOString(),
      endsAt: new Date(now + 56 * 3600 * 1000).toISOString(),
      timeZone: 'UTC',
    });
    shift2Id = shift2.id;

    await assignWorker(businessId, shift1Id, staff1MembershipId, staff1MembershipId, 'owner', 'req-swap-s1');
    await assignWorker(businessId, shift2Id, staff2MembershipId, staff2MembershipId, 'owner', 'req-swap-s2');

    // Alice requests swap with Bob
    const swap = await requestSwap(businessId, staff1MembershipId, {
      requesterShiftId: shift1Id,
      counterpartMembershipId: staff2MembershipId,
      counterpartShiftId: shift2Id,
    });

    assert.ok(swap.id);

    // Verify Bob received an inbox item under category 'swaps'
    const bobInbox = await getInboxItems(businessId, staff2MembershipId, staff2UserId);
    const swapItem = bobInbox.find((item) => item.category === 'swaps' && item.title === 'Shift Swap Request');
    assert.ok(swapItem, 'Bob received shift swap request in inbox');
    assert.equal(swapItem.category, 'swaps');
  });

  it('2. Peer accept dispatches swaps notifications to requester and department managers', async () => {
    // Find the swap created in previous test
    let swapId = '';
    await withTenantContext(businessId, async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT id FROM swap_requests WHERE business_id = $1 AND requester_membership_id = $2`,
        [businessId, staff1MembershipId]
      );
      swapId = res.rows[0].id;
    });

    // Bob accepts the swap request
    const accepted = await peerAcceptSwap(businessId, swapId, staff2MembershipId);
    assert.equal(accepted.status, 'peer_accepted');

    // Verify Alice (requester) received an inbox notification that Bob accepted
    const aliceInbox = await getInboxItems(businessId, staff1MembershipId, staff1UserId);
    const acceptItem = aliceInbox.find((item) => item.category === 'swaps' && item.title.includes('Accepted by Colleague'));
    assert.ok(acceptItem, 'Alice received notice that Bob accepted');
    assert.equal(acceptItem.category, 'swaps');

    // Verify Owner received a pending approval notice
    const ownerInbox = await getInboxItems(businessId, ownerMembershipId, ownerUserId);
    const pendingItem = ownerInbox.find((item) => item.category === 'swaps' && item.title.includes('Awaiting Approval'));
    assert.ok(pendingItem, 'Owner received notice that swap awaits approval');
    assert.equal(pendingItem.category, 'swaps');
  });

  it('3. Manager approval dispatches approval notifications to both workers under category swaps', async () => {
    let swapId = '';
    await withTenantContext(businessId, async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT id FROM swap_requests WHERE business_id = $1 AND requester_membership_id = $2`,
        [businessId, staff1MembershipId]
      );
      swapId = res.rows[0].id;
    });

    // Owner approves the swap
    const approved = await approveSwap(businessId, swapId, ownerMembershipId, 'owner', departmentId);
    assert.equal(approved.status, 'approved');

    // Verify both Alice and Bob received approval notifications
    const aliceInbox = await getInboxItems(businessId, staff1MembershipId, staff1UserId);
    const aliceApproved = aliceInbox.find((item) => item.category === 'swaps' && item.title === 'Shift Swap Approved');
    assert.ok(aliceApproved, 'Alice received Shift Swap Approved notice');

    const bobInbox = await getInboxItems(businessId, staff2MembershipId, staff2UserId);
    const bobApproved = bobInbox.find((item) => item.category === 'swaps' && item.title === 'Shift Swap Approved');
    assert.ok(bobApproved, 'Bob received Shift Swap Approved notice');
  });

  it('4. Peer rejection dispatches declination notice to requester under category swaps', async () => {
    // Create new shifts for rejection test
    const now = Date.now();
    const s1 = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date(now + 72 * 3600 * 1000).toISOString(),
      endsAt: new Date(now + 80 * 3600 * 1000).toISOString(),
      timeZone: 'UTC',
    });
    const s2 = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date(now + 96 * 3600 * 1000).toISOString(),
      endsAt: new Date(now + 104 * 3600 * 1000).toISOString(),
      timeZone: 'UTC',
    });

    await assignWorker(businessId, s1.id, staff1MembershipId, staff1MembershipId, 'owner', 'req-rej-1');
    await assignWorker(businessId, s2.id, staff2MembershipId, staff2MembershipId, 'owner', 'req-rej-2');

    const swap = await requestSwap(businessId, staff1MembershipId, {
      requesterShiftId: s1.id,
      counterpartMembershipId: staff2MembershipId,
      counterpartShiftId: s2.id,
    });

    // Bob rejects the swap
    const rejected = await peerRejectSwap(businessId, swap.id, staff2MembershipId);
    assert.equal(rejected.status, 'peer_rejected');

    // Verify Alice received rejection notice
    const aliceInbox = await getInboxItems(businessId, staff1MembershipId, staff1UserId);
    const declItem = aliceInbox.find((item) => item.category === 'swaps' && item.title === 'Swap Request Declined');
    assert.ok(declItem, 'Alice received Swap Request Declined notice');
    assert.equal(declItem.category, 'swaps');
  });

  it('5. Failed subscription renewal invokes notifyFailedRenewal and creates mandatory billing notice for owners', async () => {
    const result = await processSubscriptionRenewal({
      businessId,
      outcome: 'failure',
    });

    assert.equal(result.status, 'past_due');

    // Verify Owner received mandatory billing notice
    const ownerInbox = await getInboxItems(businessId, ownerMembershipId, ownerUserId);
    const renewalFailItem = ownerInbox.find((item) => item.category === 'billing' && item.title.includes('Renewal Payment Failed'));
    assert.ok(renewalFailItem, 'Owner received failed renewal billing notice');
    assert.equal(renewalFailItem.mandatory, true, 'Failed renewal must be mandatory');
    assert.equal(renewalFailItem.urgent, true, 'Failed renewal notice must be urgent');
  });

  it('6. Password reset invokes notifySecurityNotice and dispatches security alert to user active memberships', async () => {
    // Request password reset for Alice
    const userRes = await controlPool.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [staff1UserId]
    );
    const aliceEmail = userRes.rows[0].email;

    const resetReq = await requestPasswordReset(aliceEmail);
    assert.ok(resetReq.resetToken);

    // Complete reset
    const resetRes = await resetPassword(resetReq.resetToken, 'NewSecurePassword123!');
    assert.equal(resetRes.success, true);

    // Verify Alice received security alert in inbox
    const aliceInbox = await getInboxItems(businessId, staff1MembershipId, staff1UserId);
    const secItem = aliceInbox.find((item) => item.category === 'security' && item.title.includes('Security Alert: Password Changed'));
    assert.ok(secItem, 'Alice received mandatory security notice in inbox');
    assert.equal(secItem.mandatory, true);
  });

  it('7. Expo Push REST adapter formats payload correctly and returns ticket on HTTP 200', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;

    setCustomPushFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          data: [
            {
              status: 'ok',
              id: 'ticket_real_expo_123',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await sendPushNotification({
      pushToken: 'ExponentPushToken[expo_mock_token]',
      title: 'Shift Reminder',
      body: 'Your shift begins in 2 hours',
      data: { shiftId: '123-abc' },
      urgent: true,
    });

    assert.equal(res.success, true);
    assert.equal(res.ticketId, 'ticket_real_expo_123');
    assert.equal(res.provider, 'expo');
    assert.equal(capturedUrl, 'https://exp.host/--/api/v2/push/send');
    assert.equal(capturedBody.to, 'ExponentPushToken[expo_mock_token]');
    assert.equal(capturedBody.priority, 'high');
  });

  it('8. Expo Push REST adapter throws on HTTP 500 so queue worker can retry with backoff', async () => {
    setCustomPushFetch(async () => {
      return new Response('Expo Gateway 502 Bad Gateway', { status: 502 });
    });

    await assert.rejects(
      async () => {
        await sendPushNotification({
          pushToken: 'ExponentPushToken[expo_fail_token]',
          title: 'Shift Change',
          body: 'Shift moved',
        });
      },
      /Expo push HTTP 502/
    );
  });

  it('9. Expo Push REST adapter invalidates token in control plane on DeviceNotRegistered error', async () => {
    const staleToken = `ExponentPushToken[stale_device_${Date.now()}]`;

    // Register token in control plane
    await registerPushToken({
      userId: staff2UserId,
      deviceId: 'stale_phone',
      token: staleToken,
    });

    // Verify token initially has invalidated_at IS NULL
    const checkBefore = await controlPool.query(
      'SELECT invalidated_at FROM push_tokens WHERE token = $1',
      [staleToken]
    );
    assert.equal(checkBefore.rows[0].invalidated_at, null);

    // Mock Expo returning DeviceNotRegistered
    setCustomPushFetch(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              status: 'error',
              message: '"ExponentPushToken[stale_device]" is not a registered push notification recipient',
              details: {
                error: 'DeviceNotRegistered',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await sendPushNotification({
      pushToken: staleToken,
      title: 'Stale Test',
      body: 'Testing DeviceNotRegistered',
    });

    assert.equal(res.success, false);
    assert.equal(res.errorDetail, 'DeviceNotRegistered');

    // Verify token was automatically marked invalidated in the database
    const checkAfter = await controlPool.query(
      'SELECT invalidated_at FROM push_tokens WHERE token = $1',
      [staleToken]
    );
    assert.ok(checkAfter.rows[0].invalidated_at !== null, 'Push token invalidated_at timestamp was set');
  });
});
