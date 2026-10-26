import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { createShift, assignWorker } from '../../src/services/scheduling-service.ts';
import {
  notifyPublishedShifts,
  notifyShiftChange,
  notifyFailedRenewal,
  notifySecurityNotice,
  registerPushToken,
} from '../../src/services/notification-service.ts';
import { updateUserSettings } from '../../src/services/settings-service.ts';
import { handlePushNotification } from '../../src/queue/handlers.ts';
import {
  clearPushDispatchHistory,
  getPushDispatchHistory,
} from '../../src/services/push-service.ts';
import { createDefaultWorker } from '../../src/queue/job-worker.ts';
import { getRedisClient } from '../../src/services/redis-client.ts';
import {
  promoteDelayedJobs,
  getJob,
  clearAllQueues,
  QUEUE_KEYS,
} from '../../src/queue/job-queue.ts';

describe('Notification Preferences & Quiet Hours Enforcement (FR-NOT-006..014, BR-011, AC-NOT-01, AC-NOT-02, AC-NOT-08)', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let ownerUserId: string;
  let staffToken: string;
  let staffUserId: string;
  let staffMembershipId: string;
  let ownerMembershipId: string;
  let businessId: string;
  let branchId: string;
  let departmentId: string;

  const pushTokenStaff = `ExponentPushToken[pref_test_staff_${Date.now()}]`;
  const pushTokenOwner = `ExponentPushToken[pref_test_owner_${Date.now()}]`;

  const originalEnv = { ...process.env };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PUSH_PROVIDER = 'simulated';
    process.env.EMAIL_PROVIDER = 'simulated';
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Register Owner
    const ownerEmail = `pref_owner_${Date.now()}@example.com`;
    const regOwnerRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'SecurePass123!', name: 'Pref Owner' }),
    });
    const regOwnerData = (await regOwnerRes.json()) as any;
    ownerToken = regOwnerData.tokens.accessToken;
    ownerUserId = regOwnerData.user.id;

    // 2. Onboard Business
    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        name: 'Preference Enforcement Corp',
        timezone: 'Europe/London',
        branchName: 'HQ Branch',
        departments: ['Operations'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    businessId = onboardData.business.id;
    branchId = onboardData.branch.id;
    departmentId = onboardData.departments[0].id;
    ownerToken = onboardData.tokens.accessToken;

    await withTenantContext(businessId, async (client) => {
      const oMem = await client.query<{ id: string }>(
        'SELECT id FROM memberships WHERE business_id = $1 AND user_id = $2',
        [businessId, ownerUserId]
      );
      ownerMembershipId = oMem.rows[0].id;
    });

    // 3. Register Staff
    const staffEmail = `pref_staff_${Date.now()}@example.com`;
    const regStaffRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'SecurePass123!', name: 'Pref Staff' }),
    });
    const regStaffData = (await regStaffRes.json()) as any;
    staffUserId = regStaffData.user.id;

    await withTenantContext(businessId, async (client) => {
      const sMem = await client.query<{ id: string }>(
        `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
         VALUES ($1, $2, 'Staff', 'active', $3, $4)
         RETURNING id`,
        [businessId, staffUserId, branchId, departmentId]
      );
      staffMembershipId = sMem.rows[0].id;
    });

    await controlPool.query(
      `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
       VALUES ($1, $2, 'Preference Enforcement Corp', 'Staff', 'active')`,
      [staffUserId, businessId]
    );

    const staffLoginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffEmail, password: 'SecurePass123!' }),
    });
    const staffLoginData = (await staffLoginRes.json()) as any;
    staffToken = staffLoginData.tokens.accessToken;

    // 4. Register Push Tokens
    await registerPushToken({
      userId: staffUserId,
      deviceId: 'staff_device_1',
      token: pushTokenStaff,
    });
    await registerPushToken({
      userId: ownerUserId,
      deviceId: 'owner_device_1',
      token: pushTokenOwner,
    });
  });

  after(async () => {
    process.env = { ...originalEnv };
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
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
      await controlPool.query('DELETE FROM user_settings WHERE user_id = $1', [staffUserId]);
      await controlPool.query('DELETE FROM push_tokens WHERE user_id = $1', [staffUserId]);
      await controlPool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
    }
    if (ownerUserId) {
      await controlPool.query('DELETE FROM user_settings WHERE user_id = $1', [ownerUserId]);
      await controlPool.query('DELETE FROM push_tokens WHERE user_id = $1', [ownerUserId]);
      await controlPool.query('DELETE FROM users WHERE id = $1', [ownerUserId]);
    }
    await closeAllPools();
  });

  beforeEach(async () => {
    await clearAllQueues();
    clearPushDispatchHistory();
  });

  it('1. Suppresses push notifications when recipient disables the category (AC-NOT-08)', async () => {
    // 1. Staff disables 'shifts' category
    await updateUserSettings(staffUserId, {
      notificationCategories: { shifts: false },
    });

    // 2. Create non-urgent shift 48 hours away
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 56 * 3600 * 1000).toISOString();
    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt,
      endsAt,
      timeZone: 'Europe/London',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-1');

    // 3. Publish shift
    const results = await notifyPublishedShifts(businessId, [shift.id]);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'skipped_category_disabled');

    // 4. In-App Inbox item MUST still be created (BR-011)
    const inboxItems = await withTenantContext(businessId, async (client) => {
      const res = await client.query<{ id: string; category: string }>(
        'SELECT id, category FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND payload->>\'shiftId\' = $3',
        [businessId, staffUserId, shift.id]
      );
      return res.rows;
    });
    assert.equal(inboxItems.length, 1, 'In-app item exists despite category opt-out');

    // 5. Check delivery table record
    const deliveries = await withTenantContext(businessId, async (client) => {
      const res = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND recipient_user_id = $2 AND event_id = $3',
        [businessId, staffUserId, `pub_shift_${shift.id}`]
      );
      return res.rows;
    });
    assert.equal(deliveries[0].status, 'skipped_category_disabled');

    // 6. Push history remains empty
    assert.equal(getPushDispatchHistory().length, 0);
  });

  it('2. Mandatory billing notices always create in-app inbox items even if push is disabled (AC-NOT-02, FR-NOT-009)', async () => {
    // 1. Owner disables billing push notifications
    await updateUserSettings(ownerUserId, {
      notificationCategories: { billing: false },
    });

    // 2. Trigger failed renewal notification
    const results = await notifyFailedRenewal(businessId, { plan: 'team', seatQuantity: 10 });
    assert.ok(results.length >= 1);
    assert.equal(results[0].status, 'skipped_category_disabled');

    // 3. Verify in-app inbox item was created with mandatory: true and urgent: true
    const inboxItems = await withTenantContext(businessId, async (client) => {
      const res = await client.query<{ id: string; category: string; mandatory: boolean; urgent: boolean }>(
        'SELECT id, category, mandatory, urgent FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND category = \'billing\'',
        [businessId, ownerUserId]
      );
      return res.rows;
    });
    assert.ok(inboxItems.length >= 1);
    const item = inboxItems[0];
    assert.equal(item.category, 'billing');
    assert.equal(item.mandatory, true, 'Billing notice must be mandatory');
    assert.equal(item.urgent, true, 'Failed renewal notice to owner must be urgent');

    // 4. Verify no push was sent because owner switched off push for billing
    assert.equal(getPushDispatchHistory().length, 0);
  });

  it('3. Mandatory security notices always create in-app inbox items with mandatory: true (FR-NOT-009, AC-NOT-02)', async () => {
    // 1. Staff disables security push notifications
    await updateUserSettings(staffUserId, {
      notificationCategories: { security: false },
    });

    // 2. Trigger security notice
    const res = await notifySecurityNotice(
      businessId,
      staffUserId,
      staffMembershipId,
      'Security Alert: New Login',
      'A new device logged into your account.'
    );

    assert.equal(res.status, 'skipped_category_disabled');

    // 3. Verify in-app inbox item has mandatory: true
    const inboxItems = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ mandatory: boolean; category: string }>(
        'SELECT mandatory, category FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND category = \'security\'',
        [businessId, staffUserId]
      );
      return r.rows;
    });
    assert.ok(inboxItems.length >= 1);
    assert.equal(inboxItems[0].mandatory, true, 'Security notice must be mandatory in-app');
  });

  it('4. Defers non-urgent push notifications during quiet hours using recipient stored timezone (FR-NOT-007, AC-016)', async () => {
    // 1. Configure Staff settings: quiet hours 22:00 to 07:00 in Europe/London
    await updateUserSettings(staffUserId, {
      timeZone: 'Europe/London',
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      notificationCategories: { shifts: true },
    });

    // 2. Create non-urgent shift 48 hours away
    const startsAt = new Date('2026-06-20T10:00:00Z');
    const endsAt = new Date('2026-06-20T18:00:00Z');
    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timeZone: 'Europe/London',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-4');

    // 3. Simulate publication at 23:30 London time (summer BST = UTC+1 -> 22:30 UTC)
    // 2026-06-18 22:30 UTC = 2026-06-18 23:30 BST (inside 22:00-07:00 quiet hours)
    const simulatedNow = new Date('2026-06-18T22:30:00Z');

    const results = await notifyPublishedShifts(businessId, [shift.id], simulatedNow);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'deferred_quiet_hours');
    assert.ok((results[0].delayMs ?? 0) > 0);

    // 4. Verify in-app inbox item was created immediately (BR-011)
    const inboxItems = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ id: string }>(
        'SELECT id FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND payload->>\'shiftId\' = $3',
        [businessId, staffUserId, shift.id]
      );
      return r.rows;
    });
    assert.equal(inboxItems.length, 1, 'In-app item must be created immediately');

    // 5. Verify notification delivery record status is 'deferred_quiet_hours'
    const deliveries = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND recipient_user_id = $2 AND event_id = $3',
        [businessId, staffUserId, `pub_shift_${shift.id}`]
      );
      return r.rows;
    });
    assert.equal(deliveries[0].status, 'deferred_quiet_hours');
  });

  it('5. Urgent shift publication (<12h) bypasses quiet hours and delivers immediately (FR-NOT-008, AC-NOT-01)', async () => {
    // 1. Staff in quiet hours 22:00 to 07:00
    await updateUserSettings(staffUserId, {
      timeZone: 'Europe/London',
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      notificationCategories: { shifts: true },
    });

    // 2. Simulated now is 23:30 London time (22:30 UTC), shift starts in 4 hours at 03:30 London time (02:30 UTC)
    const simulatedNow = new Date('2026-06-18T22:30:00Z');
    const startsAt = new Date('2026-06-19T02:30:00Z');
    const endsAt = new Date('2026-06-19T10:30:00Z');

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timeZone: 'Europe/London',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-5');

    const results = await notifyPublishedShifts(businessId, [shift.id], simulatedNow);
    assert.equal(results.length, 1);
    assert.equal(results[0].urgent, true, 'Shift <12h away must be marked urgent');
    assert.equal(results[0].status, 'dispatched_expo', 'Urgent push must bypass quiet hours');
    assert.equal(results[0].delayMs, 0);

    // Verify delivery table status
    const deliveries = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND recipient_user_id = $2 AND event_id = $3',
        [businessId, staffUserId, `pub_shift_${shift.id}`]
      );
      return r.rows;
    });
    assert.equal(deliveries[0].status, 'dispatched_expo');
  });

  it('6. Urgent shift change (cancelled or rescheduled <12h) bypasses quiet hours (AC-NOT-01, AC-SCH-04)', async () => {
    // 1. Shift scheduled 4 hours away on a distinct day
    const simulatedNow = new Date('2026-07-18T22:30:00Z');
    const startsAt = new Date('2026-07-19T02:30:00Z');

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date('2026-07-19T10:30:00Z').toISOString(),
      timeZone: 'Europe/London',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-6', 'testing urgent shift change');

    // 2. Notify shift cancellation
    const results = await notifyShiftChange(
      businessId,
      shift.id,
      'cancelled',
      startsAt,
      undefined,
      simulatedNow
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].urgent, true);
    assert.equal(results[0].status, 'dispatched_expo', 'Cancellation <12h must bypass quiet hours');
    assert.equal(results[0].delayMs, 0);
  });

  it('7. Urgent push does NOT override user opt-out of non-mandatory category (PRD 12.2 line 670)', async () => {
    // 1. Staff explicitly disabled 'shifts'
    await updateUserSettings(staffUserId, {
      notificationCategories: { shifts: false },
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
    });

    // 2. Shift starts in 2 hours on a distinct day (urgent!)
    const simulatedNow = new Date('2026-08-18T22:30:00Z');
    const startsAt = new Date('2026-08-19T00:30:00Z');

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date('2026-08-19T08:30:00Z').toISOString(),
      timeZone: 'Europe/London',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-7', 'testing urgent opt-out');

    const results = await notifyPublishedShifts(businessId, [shift.id], simulatedNow);
    assert.equal(results.length, 1);
    assert.equal(results[0].urgent, true, 'Marked urgent');
    assert.equal(results[0].status, 'skipped_category_disabled', 'Push skipped because category is disabled');

    // In-app item still exists with urgent: true
    const inboxItems = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ urgent: boolean }>(
        'SELECT urgent FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND payload->>\'shiftId\' = $3',
        [businessId, staffUserId, shift.id]
      );
      return r.rows;
    });
    assert.equal(inboxItems[0].urgent, true);
  });

  it('8. Timezone boundaries: different recipients evaluate quiet hours according to their own timezone', async () => {
    // Staff user is in Europe/London (BST = UTC+1)
    await updateUserSettings(staffUserId, {
      timeZone: 'Europe/London',
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      notificationCategories: { shifts: true },
    });

    // Owner user is in America/New_York (EDT = UTC-4)
    await updateUserSettings(ownerUserId, {
      timeZone: 'America/New_York',
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      notificationCategories: { shifts: true },
    });

    // At 22:30 UTC:
    // In London, it is 23:30 (IN quiet hours 22:00 to 07:00) -> deferred
    // In New York, it is 18:30 (NOT in quiet hours) -> dispatched immediately
    const simulatedNow = new Date('2026-06-18T22:30:00Z');

    // Create 2 shifts: one for staff, one for owner
    const shiftStaff = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date('2026-06-21T10:00:00Z').toISOString(),
      endsAt: new Date('2026-06-21T18:00:00Z').toISOString(),
      timeZone: 'UTC',
    });
    await assignWorker(businessId, shiftStaff.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-8a');

    const shiftOwner = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date('2026-06-21T10:00:00Z').toISOString(),
      endsAt: new Date('2026-06-21T18:00:00Z').toISOString(),
      timeZone: 'UTC',
    });
    await assignWorker(businessId, shiftOwner.id, ownerMembershipId, ownerMembershipId, 'owner', 'req-pref-8b');

    const resStaff = await notifyPublishedShifts(businessId, [shiftStaff.id], simulatedNow);
    assert.equal(resStaff[0].status, 'deferred_quiet_hours', 'London recipient is deferred');

    const resOwner = await notifyPublishedShifts(businessId, [shiftOwner.id], simulatedNow);
    assert.equal(resOwner[0].status, 'dispatched_expo', 'New York recipient is dispatched immediately');
  });

  it('9. Delayed job delivery execution and worker idempotency (FR-NOT-010, FR-NOT-013)', async () => {
    // Enable categories
    await updateUserSettings(staffUserId, {
      notificationCategories: { shifts: true },
      quietHours: { enabled: false, start: '22:00', end: '07:00' },
    });

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date('2026-06-22T10:00:00Z').toISOString(),
      endsAt: new Date('2026-06-22T18:00:00Z').toISOString(),
      timeZone: 'UTC',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, staffMembershipId, 'owner', 'req-pref-9');

    const dedupeKey = `delayed_test_${shift.id}_${staffUserId}_staff_device_1`;

    // Initialize delivery record
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
         VALUES ($1, $2, $3, 'staff_device_1', 'push', $4, 'deferred_quiet_hours')
         ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
        [businessId, `pub_shift_${shift.id}`, staffUserId, dedupeKey]
      );
    });

    // 1. Worker processes the claimed delayed job
    const jobData: any = {
      id: 'job_test_delayed_1',
      type: 'push.notification',
      data: {
        businessId,
        userId: staffUserId,
        deviceId: 'staff_device_1',
        title: 'Schedule Published',
        body: 'Your shift has been published.',
        category: 'shifts',
        urgent: false,
        dedupeKey,
        shiftId: shift.id,
      },
    };

    const workerResult1 = await handlePushNotification(jobData);
    assert.equal(workerResult1.status, 'delivered_expo');

    // Verify delivery table updated to 'delivered_expo'
    const deliveries = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string; ticket_id: string }>(
        'SELECT status, ticket_id FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      return r.rows;
    });
    assert.equal(deliveries[0].status, 'delivered_expo');
    assert.ok(deliveries[0].ticket_id);

    // Verify push was sent to Expo
    assert.equal(getPushDispatchHistory().length, 1);

    // 2. Retry/re-process the same job: idempotent skipping
    const workerResult2 = await handlePushNotification(jobData);
    assert.equal(workerResult2.skipped, true);
    assert.equal(workerResult2.reason, 'already_delivered');

    // Push history should still be 1 (not duplicated)
    assert.equal(getPushDispatchHistory().length, 1);
  });

  it('10. Delivery re-evaluation: skips delivery if user disabled category while deferred (FR-NOT-013, AC-NOT-08)', async () => {
    // 1. User had shifts enabled when job was queued, but now turns it off
    await updateUserSettings(staffUserId, {
      notificationCategories: { shifts: false },
    });

    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date('2026-06-23T10:00:00Z').toISOString(),
      endsAt: new Date('2026-06-23T18:00:00Z').toISOString(),
      timeZone: 'UTC',
    });
    const dedupeKey = `re_eval_test_${shift.id}_${staffUserId}_staff_device_1`;

    await withTenantContext(businessId, async (client) => {
      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
         VALUES ($1, $2, $3, 'staff_device_1', 'push', $4, 'deferred_quiet_hours')
         ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
        [businessId, `pub_shift_${shift.id}`, staffUserId, dedupeKey]
      );
    });

    const jobData: any = {
      id: 'job_test_delayed_re_eval',
      type: 'push.notification',
      data: {
        businessId,
        userId: staffUserId,
        deviceId: 'staff_device_1',
        title: 'Schedule Published',
        body: 'Your shift has been published.',
        category: 'shifts',
        urgent: false,
        dedupeKey,
        shiftId: shift.id,
      },
    };

    const workerResult = await handlePushNotification(jobData);
    assert.equal(workerResult.skipped, true);
    assert.equal(workerResult.reason, 'category_disabled');

    // Delivery table status updated to 'skipped_category_disabled'
    const deliveries = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      return r.rows;
    });
    assert.equal(deliveries[0].status, 'skipped_category_disabled');
    assert.equal(getPushDispatchHistory().length, 0, 'No push was dispatched');
  });

  it('11. Quiet-hours re-deferral: re-evaluates quiet hours when matured job runs and re-defers if quiet hours still apply (FR-NOT-007, FR-NOT-013)', async () => {
    // 1. Calculate quiet hours surrounding the current moment
    const now = new Date();
    const curH = now.getUTCHours();
    const startH = String((curH - 1 + 24) % 24).padStart(2, '0');
    const endH1 = String((curH + 1) % 24).padStart(2, '0');
    const endH2 = String((curH + 2) % 24).padStart(2, '0');

    // Configure recipient with quiet hours enabled in UTC
    await updateUserSettings(staffUserId, {
      timeZone: 'UTC',
      notificationCategories: { shifts: true },
      quietHours: {
        enabled: true,
        start: `${startH}:00`,
        end: `${endH1}:00`,
      },
    });

    // 2. Create non-urgent shift 48 hours away and publish
    const shift = await createShift(businessId, {
      branchId,
      departmentId,
      startsAt: new Date(Date.now() + 100 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 108 * 3600 * 1000).toISOString(),
      timeZone: 'Europe/London',
    });
    await assignWorker(businessId, shift.id, staffMembershipId, ownerMembershipId, 'owner', 'req-pref-11', 'Shift assignment for quiet hours test');

    clearPushDispatchHistory();
    const notifyRes = await notifyPublishedShifts(businessId, [shift.id]);
    assert.equal(notifyRes.length, 1);
    assert.equal(notifyRes[0].status, 'deferred_quiet_hours');
    assert.ok((notifyRes[0].delayMs ?? 0) > 0);

    // Initial assertions:
    // No premature push sent
    assert.equal(getPushDispatchHistory().length, 0);

    // Exactly 1 in-app inbox item created
    const initialInbox = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ id: string }>(
        'SELECT id FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND payload->>\'shiftId\' = $3',
        [businessId, staffUserId, shift.id]
      );
      return r.rows;
    });
    assert.equal(initialInbox.length, 1, 'Initial inbox item created immediately');

    // Exactly 1 delivery record in deferred_quiet_hours status
    const dedupeKey = `pub_shift_${shift.id}_${staffUserId}_staff_device_1`;
    const initialDeliveries = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      return r.rows;
    });
    assert.equal(initialDeliveries.length, 1);
    assert.equal(initialDeliveries[0].status, 'deferred_quiet_hours');

    // Find the original delayed job in Redis
    const redis = getRedisClient();
    const delayedJobsBefore = (await (redis as any).zrange(QUEUE_KEYS.DELAYED, 0, -1)) as string[];
    assert.ok(delayedJobsBefore.length > 0);
    const originalJobId = delayedJobsBefore[delayedJobsBefore.length - 1];

    // 3. Change quiet hours settings before delivery so quiet hours STILL apply (extended by 1 hour)
    await updateUserSettings(staffUserId, {
      quietHours: {
        enabled: true,
        start: `${startH}:00`,
        end: `${endH2}:00`,
      },
    });

    // 4. Mature the delayed job by fast-forwarding its score to 0 and promoting it
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, originalJobId);
    const promoted = await promoteDelayedJobs();
    assert.ok(promoted >= 1, 'Promoted original delayed job to ready queue');

    // 5. Execute the matured job through the real JobWorker queue path
    const worker = createDefaultWorker({ workerId: 'worker_re_defer_test' });
    const processed = await worker.processNext();
    assert.equal(processed, true, 'Worker processed the matured job');

    // 6. Verify original job completed and a NEW delayed job was enqueued for the extended window
    const originalJobStatus = await getJob(originalJobId);
    assert.equal(originalJobStatus?.status, 'completed', 'Original matured job completed');

    const delayedAfter = (await (redis as any).zrange(QUEUE_KEYS.DELAYED, 0, -1, 'WITHSCORES')) as string[];
    assert.ok(delayedAfter.length >= 2, 'New delayed job exists in delayed set');
    const newJobId = delayedAfter[0];
    assert.notEqual(newJobId, originalJobId, 'New job has distinct ID');
    const newRunAtScore = Number(delayedAfter[1]);
    assert.ok(newRunAtScore > Date.now(), 'New job is scheduled in the future per extended quiet hours');

    // 7. Verify no premature push, no duplicate inbox item, and no duplicate delivery record
    assert.equal(getPushDispatchHistory().length, 0, 'No premature push dispatched during re-deferral');

    const inboxAfter = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ id: string }>(
        'SELECT id FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND payload->>\'shiftId\' = $3',
        [businessId, staffUserId, shift.id]
      );
      return r.rows;
    });
    assert.equal(inboxAfter.length, 1, 'No duplicate in-app inbox item created');

    const deliveriesAfter = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string }>(
        'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      return r.rows;
    });
    assert.equal(deliveriesAfter.length, 1, 'No duplicate delivery record created');
    assert.equal(deliveriesAfter[0].status, 'deferred_quiet_hours');

    // 8. Finally, when quiet hours window ends, job delivers cleanly
    await updateUserSettings(staffUserId, {
      quietHours: { enabled: false, start: `${startH}:00`, end: `${endH2}:00` },
    });
    await redis.zadd(QUEUE_KEYS.DELAYED, 0, newJobId);
    await promoteDelayedJobs();
    await worker.processNext();

    assert.equal(getPushDispatchHistory().length, 1, 'Push notification dispatched once quiet hours end');
    assert.equal(getPushDispatchHistory()[0].pushToken, pushTokenStaff);

    const finalDeliveries = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ status: string; ticket_id: string }>(
        'SELECT status, ticket_id FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
        [businessId, dedupeKey]
      );
      return r.rows;
    });
    assert.equal(finalDeliveries[0].status, 'delivered_expo');
    assert.ok(finalDeliveries[0].ticket_id);

    const finalInbox = await withTenantContext(businessId, async (client) => {
      const r = await client.query<{ id: string }>(
        'SELECT id FROM inbox_items WHERE business_id = $1 AND recipient_user_id = $2 AND payload->>\'shiftId\' = $3',
        [businessId, staffUserId, shift.id]
      );
      return r.rows;
    });
    assert.equal(finalInbox.length, 1, 'Inbox items remain exactly 1 after final delivery');
  });
});
