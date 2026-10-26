import { controlPool, shard1Pool, shard2Pool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { sendPushNotification } from '../services/push-service.ts';
import { sendEmail } from '../services/email-service.ts';
import { fulfillPaymentIntent } from '../services/payment-provider.ts';
import { enqueueJob, type JobData } from './job-queue.ts';

import { getUserSettings } from '../services/settings-service.ts';
import { evaluateQuietHours, normalizeCategory } from '../utils/quiet-hours.ts';
import { env } from '../config/env.ts';

/**
 * Whitelist of jobs that are allowed to run in the control plane without a tenant context (SEC-018, AC-TEN-08).
 */
export const CONTROL_PLANE_JOB_WHITELIST = new Set([
  'payment.webhook',
  'email.password_reset',
  'email.invitation',
  'sweeper.payment_inbox',
  'test.control_job',
]);

/**
 * Push Notification Dispatch Handler.
 * Runs inside tenant context (SEC-018), respects dedupeKey idempotency, re-evaluates
 * user preferences and quiet hours at delivery time (FR-NOT-013), and updates delivery status.
 */
export async function handlePushNotification(job: JobData<{
  businessId: string;
  userId: string;
  deviceId?: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  category?: string;
  urgent?: boolean;
  dedupeKey: string;
  shiftId?: string;
  scheduledFor?: string;
}>): Promise<any> {
  const { businessId, userId, deviceId, title, body, data, category, urgent, dedupeKey, shiftId } = job.data;

  return await withTenantContext(businessId, async (client) => {
    // 1. Check idempotency: if already delivered or superseded, do not re-send
    const deliveryCheck = await client.query<{ status: string }>(
      'SELECT status FROM notification_deliveries WHERE business_id = $1 AND dedupe_key = $2',
      [businessId, dedupeKey]
    );

    if (deliveryCheck.rows.length > 0) {
      const currentStatus = deliveryCheck.rows[0].status;
      if (currentStatus === 'delivered_expo') {
        return { skipped: true, reason: 'already_delivered' };
      }
      if (currentStatus === 'skipped_category_disabled' || currentStatus === 'skipped_superseded') {
        return { skipped: true, reason: currentStatus };
      }
    }

    // 2. Re-evaluate recipient preferences at delivery time (FR-NOT-013, AC-NOT-08)
    const userSettings = await getUserSettings(userId);
    const cat = normalizeCategory(category || data?.category || 'shifts');
    const categoriesPref = userSettings.settings.notificationCategories;

    if ((categoriesPref as any)?.[cat] === false) {
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'skipped_category_disabled', attempts = attempts + 1, updated_at = NOW()
         WHERE business_id = $1 AND dedupe_key = $2`,
        [businessId, dedupeKey]
      );
      return { skipped: true, reason: 'category_disabled' };
    }

    // 3. Re-evaluate quiet hours if non-urgent (e.g. if user altered quiet hours or time zone)
    if (!urgent) {
      const qh = evaluateQuietHours(new Date(), userSettings.settings.timeZone, userSettings.settings.quietHours);
      if (qh.inQuietHours && qh.delayMs > 0) {
        const reScheduledIso = qh.endsAt?.toISOString();
        const updatedData = {
          ...job.data,
          scheduledFor: reScheduledIso,
          data: {
            ...(job.data?.data || {}),
            scheduledFor: reScheduledIso,
          },
        };
        await enqueueJob(
          'push.notification',
          updatedData,
          {
            delayMs: qh.delayMs,
            businessId,
            maxAttempts: job.maxAttempts,
            backoffMs: job.backoffMs,
          }
        );
        await client.query(
          `UPDATE notification_deliveries
           SET status = 'deferred_quiet_hours', updated_at = NOW()
           WHERE business_id = $1 AND dedupe_key = $2`,
          [businessId, dedupeKey]
        );
        return { status: 're_deferred_quiet_hours', delayMs: qh.delayMs };
      }
    }

    // 4. Re-evaluate shift state (FR-NOT-013, AC-NOT-07): skip if shift was deleted
    if (shiftId) {
      const shiftRes = await client.query<{ status: string }>(
        'SELECT status FROM shifts WHERE business_id = $1 AND id = $2',
        [businessId, shiftId]
      );
      if (shiftRes.rows.length === 0) {
        await client.query(
          `UPDATE notification_deliveries
           SET status = 'skipped_superseded', attempts = attempts + 1, updated_at = NOW()
           WHERE business_id = $1 AND dedupe_key = $2`,
          [businessId, dedupeKey]
        );
        return { skipped: true, reason: 'superseded_shift_deleted' };
      }
    }

    // 5. Fetch push tokens from control plane
    let tokenQuery = 'SELECT token, device_id FROM push_tokens WHERE user_id = $1 AND invalidated_at IS NULL';
    const params: any[] = [userId];
    if (deviceId) {
      tokenQuery += ' AND device_id = $2';
      params.push(deviceId);
    }

    const tokensRes = await controlPool.query<{ token: string; device_id: string }>(tokenQuery, params);

    if (tokensRes.rows.length === 0) {
      // Fallback: No registered push tokens, record fallback
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'delivered_fallback_inbox', attempts = attempts + 1, updated_at = NOW()
         WHERE business_id = $1 AND dedupe_key = $2`,
        [businessId, dedupeKey]
      );
      return { status: 'fallback_inbox', reason: 'no_push_tokens' };
    }

    // 6. Dispatch to Expo
    let lastTicketId: string = '';
    let hasDelivered = false;
    let hasUnregistered = false;

    for (const t of tokensRes.rows) {
      const res = await sendPushNotification({
        pushToken: t.token,
        title,
        body,
        data,
        urgent,
      });
      if (res.status === 'ok') {
        lastTicketId = res.ticketId;
        hasDelivered = true;
      } else if (res.errorDetail === 'DeviceNotRegistered') {
        hasUnregistered = true;
      }
    }

    // 7. Update delivery record
    if (hasDelivered) {
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'delivered_expo', ticket_id = $1, attempts = attempts + 1, updated_at = NOW()
         WHERE business_id = $2 AND dedupe_key = $3`,
        [lastTicketId, businessId, dedupeKey]
      );
      return { status: 'delivered_expo', ticketId: lastTicketId };
    }

    if (hasUnregistered) {
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'skipped_unregistered_token', attempts = attempts + 1, updated_at = NOW()
         WHERE business_id = $1 AND dedupe_key = $2`,
        [businessId, dedupeKey]
      );
      return { status: 'skipped_unregistered_token', reason: 'DeviceNotRegistered' };
    }

    await client.query(
      `UPDATE notification_deliveries
       SET status = 'delivered_expo', ticket_id = $1, attempts = attempts + 1, updated_at = NOW()
       WHERE business_id = $2 AND dedupe_key = $3`,
      [lastTicketId, businessId, dedupeKey]
    );

    return { status: 'delivered_expo', ticketId: lastTicketId };
  });
}

/**
 * Payment Webhook Job Handler.
 * Fulfills pending payment events idempotently in tenant context (BILL-007).
 */
export async function handlePaymentWebhook(job: JobData<{
  provider: string;
  providerEventId: string;
  payload: any;
}>): Promise<any> {
  const { provider, providerEventId, payload } = job.data;

  // 1. Check control plane payment_events status
  const evtRes = await controlPool.query<{ status: string; payload: any }>(
    'SELECT status, payload FROM payment_events WHERE provider = $1 AND provider_event_id = $2',
    [provider, providerEventId]
  );

  if (evtRes.rows.length === 0) {
    throw new Error(`Payment event not found: ${provider}:${providerEventId}`);
  }

  const evt = evtRes.rows[0];
  if (evt.status === 'processed' || evt.status === 'ignored_duplicate') {
    return { status: evt.status, skipped: true };
  }

  const eventPayload = payload || evt.payload;
  const providerReference = eventPayload?.data?.reference;
  const amountMinor = eventPayload?.data?.amount_minor ?? eventPayload?.data?.amount ?? 0;
  const currency = eventPayload?.data?.currency;
  const outcomeStatus: 'success' | 'failed' =
    eventPayload?.data?.status === 'success' || eventPayload?.event === 'charge.success' ? 'success' : 'failed';

  // 2. Locate businessId
  let businessId = eventPayload?.data?.metadata?.business_id;
  if (!businessId && providerReference) {
    const f1 = await shard1Pool.query<{ business_id: string }>(
      'SELECT business_id FROM payment_intents WHERE provider_reference = $1',
      [providerReference]
    );
    if (f1.rows.length > 0) {
      businessId = f1.rows[0].business_id;
    } else {
      const f2 = await shard2Pool.query<{ business_id: string }>(
        'SELECT business_id FROM payment_intents WHERE provider_reference = $1',
        [providerReference]
      );
      if (f2.rows.length > 0) {
        businessId = f2.rows[0].business_id;
      }
    }
  }

  if (!businessId) {
    await controlPool.query(
      "UPDATE payment_events SET status = 'rejected_mismatch' WHERE provider = $1 AND provider_event_id = $2",
      [provider, providerEventId]
    );
    return { status: 'rejected_mismatch', reason: 'intent_not_found' };
  }

  // 3. Fulfill payment intent in tenant context
  return await fulfillPaymentIntent({
    businessId,
    providerReference,
    amountMinor,
    currency,
    outcomeStatus,
    provider,
    providerEventId,
  });
}

function getPublicAppBaseUrl(): string {
  const configured = env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const host = env.HOST === '0.0.0.0' ? 'localhost' : env.HOST;
  return `http://${host}:${env.PORT}`;
}

/**
 * Password Reset Email Handler.
 */
export async function handlePasswordResetEmail(job: JobData<{
  userId: string;
  email: string;
  rawToken: string;
  expiresAt?: string;
}>): Promise<any> {
  const { email, rawToken, expiresAt } = job.data;
  const idempotencyKey = `email:reset:${rawToken}`;
  const baseUrl = getPublicAppBaseUrl();
  const resetUrl = `${baseUrl}/v1/auth/reset-password?token=${rawToken}`;

  return await sendEmail({
    to: email,
    subject: 'Reset Your Rota Password',
    text: `You requested a password reset for your Rota account.\n\nReset your password by visiting the link below:\n${resetUrl}\n\nThis link expires in ${expiresAt || '1 hour'}. If you did not request a password reset, you can safely ignore this email.`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-top: 0; margin-bottom: 16px;">Password Reset</h2>
        <p style="font-size: 16px; line-height: 24px; margin-bottom: 24px;">
          You requested a password reset for your Rota account. Click the button below to choose a new password:
        </p>
        <div style="margin-bottom: 24px;">
          <a href="${resetUrl}" style="background-color: #0ea5e9; color: #ffffff; padding: 12px 24px; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 6px; display: inline-block;">
            Reset Password
          </a>
        </div>
        <p style="font-size: 14px; color: #64748b; line-height: 20px;">
          If the button does not work, copy and paste this link into your browser:<br/>
          <a href="${resetUrl}" style="color: #0ea5e9; word-break: break-all;">${resetUrl}</a>
        </p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
          This link expires in ${expiresAt || '1 hour'}. If you did not request a password reset, you can safely ignore this email.
        </p>
      </div>
    `.trim(),
    idempotencyKey,
  });
}

/**
 * Team Member Invitation Email Handler.
 */
export async function handleInvitationEmail(job: JobData<{
  businessId: string;
  invitationId: string;
  email: string;
  role: string;
  inviterName: string;
  rawToken?: string;
}>): Promise<any> {
  const { invitationId, email, role, inviterName, rawToken } = job.data;
  const token = rawToken || invitationId;
  const idempotencyKey = `email:invite:${invitationId}`;
  const baseUrl = getPublicAppBaseUrl();
  const inviteUrl = `${baseUrl}/v1/organizations/invitations/${token}`;

  return await sendEmail({
    to: email,
    subject: "You've been invited to join a team on Rota",
    text: `${inviterName} has invited you to join their Rota team as ${role}.\n\nAccept your invitation by visiting the link below:\n${inviteUrl}\n\nThis invitation link expires in 72 hours and can only be accepted once.`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-top: 0; margin-bottom: 16px;">Team Invitation</h2>
        <p style="font-size: 16px; line-height: 24px; margin-bottom: 24px;">
          <strong>${inviterName}</strong> has invited you to join their Rota team as <strong>${role}</strong>.
        </p>
        <div style="margin-bottom: 24px;">
          <a href="${inviteUrl}" style="background-color: #0ea5e9; color: #ffffff; padding: 12px 24px; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 6px; display: inline-block;">
            Accept Invitation
          </a>
        </div>
        <p style="font-size: 14px; color: #64748b; line-height: 20px;">
          If the button does not work, copy and paste this link into your browser:<br/>
          <a href="${inviteUrl}" style="color: #0ea5e9; word-break: break-all;">${inviteUrl}</a>
        </p>
        <p style="font-size: 12px; color: #94a3b8; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
          This invitation link expires in 72 hours and can only be accepted once.
        </p>
      </div>
    `.trim(),
    idempotencyKey,
  });
}

/**
 * Sweeper Handler for unfulfilled inbox events (BILL-007 step 3).
 * Re-enqueues payment events still marked 'received' after the specified delay threshold.
 */
export async function handlePaymentInboxSweeper(job: JobData<{
  thresholdSeconds?: number;
}>): Promise<{ reenqueued: number }> {
  const thresholdSeconds = job.data?.thresholdSeconds ?? 60;

  const res = await controlPool.query<{
    provider: string;
    provider_event_id: string;
    payload: any;
  }>(
    `SELECT provider, provider_event_id, payload
     FROM payment_events
     WHERE status = 'received'
       AND created_at < NOW() - ($1 || ' seconds')::interval
     LIMIT 50`,
    [thresholdSeconds]
  );

  let count = 0;
  for (const row of res.rows) {
    await enqueueJob('payment.webhook', {
      provider: row.provider,
      providerEventId: row.provider_event_id,
      payload: row.payload,
    });
    count++;
  }

  return { reenqueued: count };
}
