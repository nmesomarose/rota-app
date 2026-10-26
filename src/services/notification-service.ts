import type { PoolClient } from 'pg';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { AppError } from '../utils/errors.ts';
import { enqueueJob } from '../queue/job-queue.ts';
import { getUserSettings } from './settings-service.ts';
import {
  evaluateQuietHours,
  isUrgentNotification,
  normalizeCategory,
} from '../utils/quiet-hours.ts';

export interface RegisterPushTokenInput {
  userId: string;
  deviceId: string;
  token: string;
  platform?: string;
}

export interface NotificationDeliveryResult {
  shiftId: string;
  userId: string;
  urgent: boolean;
  inboxItemId: string;
  status?: string;
  delayMs?: number;
}

export interface DispatchNotificationParams {
  businessId: string;
  recipientMembershipId: string;
  recipientUserId: string;
  category: 'shifts' | 'swaps' | 'approvals' | 'attendance' | 'billing' | 'security' | string;
  title: string;
  body: string;
  payload?: Record<string, any>;
  mandatory?: boolean;
  isUrgent?: boolean;
  startsAt?: Date | string | null;
  oldStartsAt?: Date | string | null;
  newStartsAt?: Date | string | null;
  isFailedRenewal?: boolean;
  shiftId?: string;
  eventId: string;
  now?: Date;
}

/**
 * Registers or updates a device push token in the control plane (PRD 9.2, FR-NOT-002, AC-NOT-09, C-10).
 * Unique token constraint prevents duplicates across logins.
 */
export async function registerPushToken(input: RegisterPushTokenInput) {
  const { userId, deviceId, token, platform = 'expo' } = input;

  const res = await controlPool.query(
    `INSERT INTO push_tokens (user_id, device_id, token, platform, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       device_id = EXCLUDED.device_id,
       platform = EXCLUDED.platform,
       invalidated_at = NULL,
       updated_at = NOW()
     RETURNING id, user_id, device_id, token, platform, created_at`,
    [userId, deviceId, token, platform]
  );

  return res.rows[0];
}

/**
 * Invalidates a push token in the control plane when provider reports DeviceNotRegistered (PRD 9.2, FR-NOT-002).
 */
export async function invalidatePushToken(token: string): Promise<void> {
  await controlPool.query(
    `UPDATE push_tokens
     SET invalidated_at = NOW(),
         updated_at = NOW()
     WHERE token = $1 AND invalidated_at IS NULL`,
    [token]
  );
}

/**
 * Dispatches an in-app inbox item and evaluates push notifications according to recipient preferences:
 * - In-app inbox item is ALWAYS inserted immediately (FR-NOT-009, FR-NOT-014, BR-011).
 * - Mandatory notices (billing and security) have mandatory = true.
 * - Disabled notification_categories suppress push notifications (AC-NOT-08).
 * - Quiet hours defer non-urgent push notifications to Redis delayed queue (FR-NOT-007, AC-016).
 * - Urgent notifications bypass quiet hours (FR-NOT-008, AC-NOT-01).
 * - Re-evaluated when delivered (FR-NOT-013).
 */
export async function dispatchNotificationToRecipient(
  client: PoolClient,
  params: DispatchNotificationParams
): Promise<NotificationDeliveryResult> {
  const {
    businessId,
    recipientMembershipId,
    recipientUserId,
    category,
    title,
    body,
    payload = {},
    startsAt,
    oldStartsAt,
    newStartsAt,
    isFailedRenewal,
    shiftId,
    eventId,
  } = params;

  const now = params.now || new Date();
  const normalizedCat = normalizeCategory(category);
  const isMandatory = Boolean(params.mandatory || normalizedCat === 'billing' || normalizedCat === 'security');

  // 1. Calculate urgency per PRD FR-NOT-008 & AC-NOT-01
  const urgent = isUrgentNotification({
    category: normalizedCat,
    isUrgent: params.isUrgent,
    startsAt,
    oldStartsAt,
    newStartsAt,
    isFailedRenewal,
    now,
  });

  // 2. In-App Inbox item is ALWAYS persisted (FR-NOT-009, FR-NOT-014, BR-011)
  const inboxRes = await client.query<{ id: string }>(
    `INSERT INTO inbox_items (business_id, recipient_membership_id, recipient_user_id, category, title, body, payload, mandatory, urgent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      businessId,
      recipientMembershipId,
      recipientUserId,
      normalizedCat,
      title,
      body,
      JSON.stringify(payload),
      isMandatory,
      urgent,
    ]
  );
  const inboxItemId = inboxRes.rows[0].id;

  // 3. Fetch recipient's settings from control plane (FR-SET-001, FR-NOT-006, FR-NOT-007)
  const userSettings = await getUserSettings(recipientUserId);
  const categoriesPref = userSettings.settings.notificationCategories;
  const isPushCategoryEnabled = (categoriesPref as any)?.[normalizedCat] !== false;

  // If the category is disabled by the user, suppress push notifications (AC-NOT-08)
  // Per PRD 12.2 / line 670: Urgent push bypasses quiet hours, but does NOT override opt-out of non-mandatory category.
  if (!isPushCategoryEnabled) {
    const dedupeKey = `${eventId}_${recipientUserId}_category_disabled`;
    await client.query(
      `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, channel, dedupe_key, status)
       VALUES ($1, $2, $3, 'push', $4, 'skipped_category_disabled')
       ON CONFLICT (business_id, dedupe_key) DO UPDATE SET status = 'skipped_category_disabled', updated_at = NOW()`,
      [businessId, eventId, recipientUserId, dedupeKey]
    );

    return {
      shiftId: shiftId || '',
      userId: recipientUserId,
      urgent,
      inboxItemId,
      status: 'skipped_category_disabled',
      delayMs: 0,
    };
  }

  // 4. Fetch registered push tokens from control plane (FR-NOT-002, AC-NOT-09)
  const pushTokensRes = await controlPool.query<{ id: string; token: string; device_id: string }>(
    `SELECT id, token, device_id FROM push_tokens WHERE user_id = $1 AND invalidated_at IS NULL`,
    [recipientUserId]
  );

  if (pushTokensRes.rows.length === 0) {
    const dedupeKey = `${eventId}_${recipientUserId}_inbox`;
    await client.query(
      `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, channel, dedupe_key, status)
       VALUES ($1, $2, $3, 'inbox', $4, 'delivered_fallback_inbox')
       ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
      [businessId, eventId, recipientUserId, dedupeKey]
    );

    return {
      shiftId: shiftId || '',
      userId: recipientUserId,
      urgent,
      inboxItemId,
      status: 'delivered_fallback_inbox',
      delayMs: 0,
    };
  }

  // 5. Evaluate Quiet Hours (FR-NOT-007, BR-011, AC-016)
  let delayMs = 0;
  let deliveryStatus = 'dispatched_expo';
  let endsAt: Date | undefined;

  if (urgent) {
    // Urgent push bypasses quiet hours (FR-NOT-008, AC-NOT-01)
    delayMs = 0;
    deliveryStatus = 'dispatched_expo';
  } else {
    const qh = evaluateQuietHours(now, userSettings.settings.timeZone, userSettings.settings.quietHours);
    if (qh.inQuietHours) {
      delayMs = qh.delayMs;
      deliveryStatus = 'deferred_quiet_hours';
      endsAt = qh.endsAt;
    } else {
      delayMs = 0;
      deliveryStatus = 'dispatched_expo';
    }
  }

  // 6. Enqueue push job per registered device (FR-NOT-010: one delivery record per event, recipient, device and channel)
  for (const tokenRow of pushTokensRes.rows) {
    const dedupeKey = `${eventId}_${recipientUserId}_${tokenRow.device_id}`;
    const isExpo = tokenRow.token.startsWith('ExponentPushToken[') || tokenRow.token.startsWith('ExpoPushToken[');
    const initialStatus = isExpo ? deliveryStatus : 'queued_unverified_token';

    await client.query(
      `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
       VALUES ($1, $2, $3, $4, 'push', $5, $6)
       ON CONFLICT (business_id, dedupe_key) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
      [businessId, eventId, recipientUserId, tokenRow.device_id, dedupeKey, initialStatus]
    );

    try {
      await enqueueJob(
        'push.notification',
        {
          businessId,
          userId: recipientUserId,
          deviceId: tokenRow.device_id,
          title,
          body,
          data: {
            ...payload,
            category: normalizedCat,
            shiftId,
            scheduledFor: endsAt?.toISOString(),
          },
          category: normalizedCat,
          urgent,
          dedupeKey,
          shiftId,
          scheduledFor: endsAt?.toISOString(),
        },
        { delayMs, businessId }
      );
    } catch (_qErr: any) {
      // Redis queue transient error should not fail transaction
    }
  }

  return {
    shiftId: shiftId || '',
    userId: recipientUserId,
    urgent,
    inboxItemId,
    status: deliveryStatus,
    delayMs,
  };
}

/**
 * Creates schedule publication notifications for all assigned staff (AC-006, FR-SCH-006, BR-002).
 * Deduplicated per event/device (C-10, FR-NOT-010).
 * Urgent if within 12 hours of shift start (D-14, AC-NOT-01).
 * In-app inbox fallback is always generated (FR-NOT-009, FR-NOT-014).
 * Enforces recipient category preferences and quiet hours (FR-NOT-006, FR-NOT-007, AC-NOT-08).
 */
export async function notifyPublishedShifts(
  businessId: string,
  shiftIds: string[],
  nowDate?: Date
): Promise<NotificationDeliveryResult[]> {
  if (!shiftIds || shiftIds.length === 0) {
    return [];
  }

  return withTenantContext(businessId, async (client) => {
    const assignmentsRes = await client.query<{
      shift_id: string;
      membership_id: string;
      user_id: string;
      starts_at: Date;
      ends_at: Date;
      branch_id: string;
      department_id: string;
    }>(
      `SELECT sa.shift_id, sa.membership_id, m.user_id, s.starts_at, s.ends_at, s.branch_id, s.department_id
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       JOIN memberships m ON m.business_id = sa.business_id AND m.id = sa.membership_id
       WHERE sa.business_id = $1 AND sa.shift_id = ANY($2::uuid[])`,
      [businessId, shiftIds]
    );

    const now = nowDate || new Date();
    const deliveries: NotificationDeliveryResult[] = [];

    for (const row of assignmentsRes.rows) {
      const urgent = isUrgentNotification({
        category: 'shifts',
        startsAt: row.starts_at,
        now,
      });

      const res = await dispatchNotificationToRecipient(client, {
        businessId,
        recipientMembershipId: row.membership_id,
        recipientUserId: row.user_id,
        category: 'shifts',
        title: urgent ? 'URGENT: Schedule Published' : 'Schedule Published',
        body: `Your shift starting at ${new Date(row.starts_at).toISOString()} has been published.`,
        payload: {
          shiftId: row.shift_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          branchId: row.branch_id,
          departmentId: row.department_id,
        },
        mandatory: false,
        isUrgent: urgent,
        startsAt: row.starts_at,
        shiftId: row.shift_id,
        eventId: `pub_shift_${row.shift_id}`,
        now,
      });

      deliveries.push(res);
    }

    return deliveries;
  });
}

/**
 * Notifies affected staff when a published shift is cancelled or rescheduled (AC-SCH-04, AC-NOT-01).
 * Urgent if either old or new starts_at is within 12 hours (AC-NOT-01).
 * Enforces recipient category preferences and quiet hours (FR-NOT-006, FR-NOT-007, AC-NOT-08).
 */
export async function notifyShiftChange(
  businessId: string,
  shiftId: string,
  changeType: 'cancelled' | 'updated',
  oldStartsAt?: Date,
  newStartsAt?: Date,
  nowDate?: Date
): Promise<NotificationDeliveryResult[]> {
  return withTenantContext(businessId, async (client) => {
    const assignmentsRes = await client.query<{
      shift_id: string;
      membership_id: string;
      user_id: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT sa.shift_id, sa.membership_id, m.user_id, s.starts_at, s.ends_at
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       JOIN memberships m ON m.business_id = sa.business_id AND m.id = sa.membership_id
       WHERE sa.business_id = $1 AND sa.shift_id = $2`,
      [businessId, shiftId]
    );

    const now = nowDate || new Date();
    const deliveries: NotificationDeliveryResult[] = [];

    for (const row of assignmentsRes.rows) {
      const checkStarts = newStartsAt || row.starts_at;

      const urgent = isUrgentNotification({
        category: 'shifts',
        startsAt: checkStarts,
        oldStartsAt,
        newStartsAt,
        now,
      });

      const title = changeType === 'cancelled'
        ? (urgent ? 'URGENT: Shift Cancelled' : 'Shift Cancelled')
        : (urgent ? 'URGENT: Shift Updated' : 'Shift Updated');

      const body = changeType === 'cancelled'
        ? `Your shift on ${new Date(checkStarts).toISOString()} has been cancelled.`
        : `Your shift has been rescheduled to start at ${new Date(checkStarts).toISOString()}.`;

      const res = await dispatchNotificationToRecipient(client, {
        businessId,
        recipientMembershipId: row.membership_id,
        recipientUserId: row.user_id,
        category: 'shifts',
        title,
        body,
        payload: {
          shiftId,
          changeType,
          startsAt: checkStarts,
          oldStartsAt,
          newStartsAt,
        },
        mandatory: false,
        isUrgent: urgent,
        startsAt: checkStarts,
        oldStartsAt,
        newStartsAt,
        shiftId,
        eventId: `change_${changeType}_${shiftId}_${now.getTime()}`,
        now,
      });

      deliveries.push(res);
    }

    return deliveries;
  });
}

/**
 * Notifies business owners when subscription renewal payment fails (BILL-011, FR-NOT-008, FR-NOT-009, AC-FR-02).
 * Notices to Owners are urgent and bypass quiet hours.
 * In-app inbox item is mandatory (mandatory = true).
 */
export async function notifyFailedRenewal(
  businessId: string,
  details?: { plan?: string; seatQuantity?: number },
  nowDate?: Date
): Promise<NotificationDeliveryResult[]> {
  return withTenantContext(businessId, async (client) => {
    const ownersRes = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM memberships WHERE business_id = $1 AND role = 'owner' AND status = 'active'`,
      [businessId]
    );

    const now = nowDate || new Date();
    const deliveries: NotificationDeliveryResult[] = [];

    for (const owner of ownersRes.rows) {
      const res = await dispatchNotificationToRecipient(client, {
        businessId,
        recipientMembershipId: owner.id,
        recipientUserId: owner.user_id,
        category: 'billing',
        title: 'URGENT: Subscription Renewal Payment Failed',
        body: 'Your subscription renewal payment failed. Please update your payment method to prevent account restriction.',
        payload: {
          type: 'renewal_failed',
          plan: details?.plan,
          seatQuantity: details?.seatQuantity,
        },
        mandatory: true,
        isUrgent: true,
        isFailedRenewal: true,
        eventId: `renewal_failed_${businessId}_${now.getTime()}`,
        now,
      });

      deliveries.push(res);
    }

    return deliveries;
  });
}

/**
 * Dispatches a mandatory security notification to a specific user (FR-NOT-009, AC-NOT-02).
 * In-app inbox item is always created with mandatory = true.
 */
export async function notifySecurityNotice(
  businessId: string,
  recipientUserId: string,
  recipientMembershipId: string,
  title: string,
  body: string,
  payload?: Record<string, any>,
  nowDate?: Date
): Promise<NotificationDeliveryResult> {
  return withTenantContext(businessId, async (client) => {
    const now = nowDate || new Date();
    return await dispatchNotificationToRecipient(client, {
      businessId,
      recipientMembershipId,
      recipientUserId,
      category: 'security',
      title,
      body,
      payload,
      mandatory: true,
      isUrgent: false,
      eventId: `security_${recipientUserId}_${now.getTime()}`,
      now,
    });
  });
}

/**
 * Retrieves in-app inbox notifications for the user's membership (FR-NOT-014).
 */
export async function getInboxItems(
  businessId: string,
  membershipId: string,
  userId: string
) {
  return withTenantContext(businessId, async (client) => {
    const res = await client.query(
      `SELECT id, category, title, body, payload, mandatory, urgent, read_at, created_at
       FROM inbox_items
       WHERE business_id = $1 AND (recipient_membership_id = $2 OR recipient_user_id = $3)
       ORDER BY created_at DESC
       LIMIT 50`,
      [businessId, membershipId, userId]
    );

    return res.rows;
  });
}

/**
 * Marks an in-app inbox notification as read.
 */
export async function markInboxItemRead(
  businessId: string,
  itemId: string,
  membershipId: string
) {
  return withTenantContext(businessId, async (client) => {
    const res = await client.query(
      `UPDATE inbox_items
       SET read_at = NOW()
       WHERE business_id = $1 AND id = $2 AND recipient_membership_id = $3
       RETURNING id, read_at`,
      [businessId, itemId, membershipId]
    );

    if (res.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Inbox item not found');
    }

    return res.rows[0];
  });
}
