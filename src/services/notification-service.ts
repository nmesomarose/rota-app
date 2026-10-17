import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { AppError } from '../utils/errors.ts';

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
 * Creates schedule publication notifications for all assigned staff (AC-006, FR-SCH-006, BR-002).
 * Deduplicated per event/device (C-10, FR-NOT-010).
 * Urgent if within 12 hours of shift start (D-14, AC-NOT-01).
 * In-app inbox fallback is always generated (FR-NOT-009, FR-NOT-014).
 */
export async function notifyPublishedShifts(
  businessId: string,
  shiftIds: string[]
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

    const now = Date.now();
    const deliveries: NotificationDeliveryResult[] = [];

    for (const row of assignmentsRes.rows) {
      const startsAtTime = new Date(row.starts_at).getTime();
      const diffHours = (startsAtTime - now) / (1000 * 60 * 60);
      // Urgent if shift starts within 12 hours (D-14, AC-NOT-01)
      const isUrgent = diffHours <= 12 && diffHours > -2;

      // 1. Mandatory In-App Inbox item (FR-NOT-009, FR-NOT-014)
      const inboxRes = await client.query<{ id: string }>(
        `INSERT INTO inbox_items (business_id, recipient_membership_id, recipient_user_id, category, title, body, payload, mandatory, urgent)
         VALUES ($1, $2, $3, 'shift', $4, $5, $6, false, $7)
         RETURNING id`,
        [
          businessId,
          row.membership_id,
          row.user_id,
          isUrgent ? 'URGENT: Schedule Published' : 'Schedule Published',
          `Your shift starting at ${new Date(row.starts_at).toISOString()} has been published.`,
          JSON.stringify({
            shiftId: row.shift_id,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            branchId: row.branch_id,
            departmentId: row.department_id,
          }),
          isUrgent,
        ]
      );

      const inboxItemId = inboxRes.rows[0].id;

      // 2. Fetch user's registered push tokens from control plane
      const pushTokensRes = await controlPool.query<{ id: string; token: string; device_id: string }>(
        `SELECT id, token, device_id FROM push_tokens WHERE user_id = $1 AND invalidated_at IS NULL`,
        [row.user_id]
      );

      // 3. Dispatch records with dedupe key (C-10, FR-NOT-010, AC-NOT-03)
      if (pushTokensRes.rows.length === 0) {
        const dedupeKey = `pub_${row.shift_id}_${row.user_id}_inbox`;
        await client.query(
          `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, channel, dedupe_key, status)
           VALUES ($1, $2, $3, 'inbox', $4, 'delivered_fallback_inbox')
           ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
          [businessId, `pub_shift_${row.shift_id}`, row.user_id, dedupeKey]
        );
      } else {
        for (const tokenRow of pushTokensRes.rows) {
          const dedupeKey = `pub_${row.shift_id}_${row.user_id}_${tokenRow.device_id}`;
          const isExpo = tokenRow.token.startsWith('ExponentPushToken[') || tokenRow.token.startsWith('ExpoPushToken[');
          const status = isExpo ? 'dispatched_expo' : 'queued_unverified_token';

          await client.query(
            `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, device_id, channel, dedupe_key, status)
             VALUES ($1, $2, $3, $4, 'push', $5, $6)
             ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
            [businessId, `pub_shift_${row.shift_id}`, row.user_id, tokenRow.device_id, dedupeKey, status]
          );
        }
      }

      deliveries.push({
        shiftId: row.shift_id,
        userId: row.user_id,
        urgent: isUrgent,
        inboxItemId,
      });
    }

    return deliveries;
  });
}

/**
 * Notifies affected staff when a published shift is cancelled or rescheduled (AC-SCH-04, AC-NOT-01).
 * Urgent if either old or new starts_at is within 12 hours (AC-NOT-01).
 */
export async function notifyShiftChange(
  businessId: string,
  shiftId: string,
  changeType: 'cancelled' | 'updated',
  oldStartsAt?: Date,
  newStartsAt?: Date
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

    const now = Date.now();
    const deliveries: NotificationDeliveryResult[] = [];

    for (const row of assignmentsRes.rows) {
      const checkStarts = newStartsAt || row.starts_at;
      const startsAtTime = new Date(checkStarts).getTime();
      const oldStartsAtTime = oldStartsAt ? new Date(oldStartsAt).getTime() : startsAtTime;

      const diffOld = (oldStartsAtTime - now) / (1000 * 60 * 60);
      const diffNew = (startsAtTime - now) / (1000 * 60 * 60);

      // Urgent if change is within 12 hours of old or new start (D-14, AC-NOT-01)
      const isUrgent = (diffOld <= 12 && diffOld > -2) || (diffNew <= 12 && diffNew > -2);

      const title = changeType === 'cancelled'
        ? (isUrgent ? 'URGENT: Shift Cancelled' : 'Shift Cancelled')
        : (isUrgent ? 'URGENT: Shift Updated' : 'Shift Updated');

      const body = changeType === 'cancelled'
        ? `Your shift on ${new Date(checkStarts).toISOString()} has been cancelled.`
        : `Your shift has been rescheduled to start at ${new Date(checkStarts).toISOString()}.`;

      const inboxRes = await client.query<{ id: string }>(
        `INSERT INTO inbox_items (business_id, recipient_membership_id, recipient_user_id, category, title, body, payload, mandatory, urgent)
         VALUES ($1, $2, $3, 'shift', $4, $5, $6, false, $7)
         RETURNING id`,
        [
          businessId,
          row.membership_id,
          row.user_id,
          title,
          body,
          JSON.stringify({ shiftId, changeType, startsAt: checkStarts }),
          isUrgent,
        ]
      );

      const inboxItemId = inboxRes.rows[0].id;
      const dedupeKey = `change_${changeType}_${shiftId}_${row.user_id}_${now}`;

      await client.query(
        `INSERT INTO notification_deliveries (business_id, event_id, recipient_user_id, channel, dedupe_key, status)
         VALUES ($1, $2, $3, 'inbox', $4, 'delivered_fallback_inbox')
         ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
        [businessId, `change_${shiftId}`, row.user_id, dedupeKey]
      );

      deliveries.push({
        shiftId,
        userId: row.user_id,
        urgent: isUrgent,
        inboxItemId,
      });
    }

    return deliveries;
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
