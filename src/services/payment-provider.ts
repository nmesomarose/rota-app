/**
 * Simulated Payment Provider & Webhook Pipeline
 * PRD Reference: 8.6 (BILL-005, BILL-006, BILL-007, BILL-008, BILL-010, BILL-020, BILL-028),
 *                19.5, DR-01, AC-010, AC-BILL-01
 *
 * Implements a visibly labelled simulated payment gateway, raw-body HMAC-SHA256
 * signature verification, durable idempotent webhook ingestion via control-plane payment_events,
 * and tenant-plane transactional entitlement fulfillment with immutable ledger recording.
 */

import crypto from 'node:crypto';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { getSubscriptionDetails } from './billing-service.ts';

const SIMULATED_WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || 'simulated_secret_test_key_12345';

export interface WebhookEventPayload {
  event: 'charge.success' | 'charge.failed';
  data: {
    id: string; // provider_event_id
    reference: string; // provider_reference
    amount_minor: number;
    currency: string;
    status: 'success' | 'failed';
    paid_at?: string;
    metadata?: {
      business_id?: string;
    };
  };
}

/**
 * Computes an HMAC-SHA256 signature over raw payload string (AC-010).
 */
export function computeWebhookSignature(rawBody: string | Buffer, secret: string = SIMULATED_WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies HMAC-SHA256 signature using timingSafeEqual to prevent timing attacks.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string = SIMULATED_WEBHOOK_SECRET
): boolean {
  try {
    const expected = computeWebhookSignature(rawBody, secret);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const signatureBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch {
    return false;
  }
}

/**
 * Generates a signed simulated webhook event for automated testing and client checkout simulation.
 */
export function generateSimulatedWebhook(params: {
  eventId?: string;
  reference: string;
  amountMinor: number;
  currency: string;
  outcome: 'success' | 'failure';
  businessId?: string;
  secret?: string;
}): {
  payload: WebhookEventPayload;
  rawBody: string;
  signature: string;
} {
  const eventId = params.eventId || `sim_evt_${crypto.randomUUID()}`;
  const payload: WebhookEventPayload = {
    event: params.outcome === 'success' ? 'charge.success' : 'charge.failed',
    data: {
      id: eventId,
      reference: params.reference,
      amount_minor: params.amountMinor,
      currency: params.currency,
      status: params.outcome === 'success' ? 'success' : 'failed',
      paid_at: new Date().toISOString(),
      metadata: {
        business_id: params.businessId,
      },
    },
  };

  const rawBody = JSON.stringify(payload);
  const signature = computeWebhookSignature(rawBody, params.secret || SIMULATED_WEBHOOK_SECRET);

  return {
    payload,
    rawBody,
    signature,
  };
}

/**
 * Ingests and processes a payment provider webhook with raw-body signature verification,
 * durable inboxing in control-plane `payment_events`, idempotency checks, and tenant fulfillment.
 */
export async function processPaymentWebhook(params: {
  rawBody: string | Buffer;
  signature: string;
  secret?: string;
}): Promise<{
  status: 'processed' | 'ignored_duplicate' | 'rejected_mismatch' | 'failed';
  providerEventId: string;
  message?: string;
}> {
  const { rawBody, signature, secret = SIMULATED_WEBHOOK_SECRET } = params;

  // 1. Verify signature over raw request body before parsing (BILL-007, Step 1)
  const isValid = verifyWebhookSignature(rawBody, signature, secret);
  if (!isValid) {
    const error: any = new Error('Invalid webhook signature');
    error.code = 'INVALID_SIGNATURE';
    error.status = 401;
    throw error;
  }

  // 2. Parse payload
  const rawBodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let payload: WebhookEventPayload;
  try {
    payload = JSON.parse(rawBodyStr);
  } catch {
    const error: any = new Error('Malformed JSON payload');
    error.code = 'MALFORMED_JSON';
    error.status = 400;
    throw error;
  }

  const { id: providerEventId, reference: providerReference, amount_minor, currency, status: outcomeStatus } = payload.data;
  const provider = 'simulated';

  // 3. Persist event in control-plane inbox (payment_events) under unique constraint (BILL-007, Step 2)
  const inboxClient = await controlPool.connect();
  let isDuplicate = false;
  try {
    await inboxClient.query(
      `INSERT INTO payment_events (provider, provider_event_id, payload, status)
       VALUES ($1, $2, $3, 'received')`,
      [provider, providerEventId, payload]
    );
  } catch (err: any) {
    // Unique violation (23505) -> Duplicate event ID
    if (err.code === '23505') {
      isDuplicate = true;
    } else {
      throw err;
    }
  } finally {
    inboxClient.release();
  }

  if (isDuplicate) {
    // Duplicate is acknowledged and ignored (BILL-007 Step 2)
    return {
      status: 'ignored_duplicate',
      providerEventId,
      message: 'Duplicate event acknowledged and ignored',
    };
  }

  // 4. Locate payment intent across shards or using metadata business_id (BILL-007 Step 4)
  let businessId = payload.data.metadata?.business_id;

  if (!businessId) {
    // Locate intent across shards
    const pool1 = (await import('../db/connection.ts')).shard1Pool;
    const pool2 = (await import('../db/connection.ts')).shard2Pool;

    const find1 = await pool1.query<{ business_id: string }>(
      'SELECT business_id FROM payment_intents WHERE provider_reference = $1',
      [providerReference]
    );
    if (find1.rows.length > 0) {
      businessId = find1.rows[0].business_id;
    } else {
      const find2 = await pool2.query<{ business_id: string }>(
        'SELECT business_id FROM payment_intents WHERE provider_reference = $1',
        [providerReference]
      );
      if (find2.rows.length > 0) {
        businessId = find2.rows[0].business_id;
      }
    }
  }

  if (!businessId) {
    // Unknown reference
    await controlPool.query(
      "UPDATE payment_events SET status = 'rejected_mismatch' WHERE provider = $1 AND provider_event_id = $2",
      [provider, providerEventId]
    );
    return {
      status: 'rejected_mismatch',
      providerEventId,
      message: 'Payment intent not found for reference',
    };
  }

  // 5. In one tenant-plane transaction: lock subscription, apply entitlement, write ledger (BILL-007 Step 5)
  return await withTenantContext(businessId, async (client) => {
    // Lock intent
    const intentRes = await client.query<{
      id: string;
      quote_id: string;
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      `SELECT id, quote_id, amount_minor, currency, status
       FROM payment_intents
       WHERE business_id = $1 AND provider_reference = $2
       FOR UPDATE`,
      [businessId, providerReference]
    );

    if (intentRes.rows.length === 0) {
      await controlPool.query(
        "UPDATE payment_events SET status = 'rejected_mismatch' WHERE provider = $1 AND provider_event_id = $2",
        [provider, providerEventId]
      );
      return {
        status: 'rejected_mismatch',
        providerEventId,
        message: 'Payment intent not found in tenant plane',
      };
    }

    const intent = intentRes.rows[0];

    // Out-of-order check: if intent is already in terminal state, ignore
    if (intent.status === 'succeeded' || intent.status === 'failed') {
      await controlPool.query(
        "UPDATE payment_events SET status = 'processed', processed_at = NOW() WHERE provider = $1 AND provider_event_id = $2",
        [provider, providerEventId]
      );
      return {
        status: 'processed',
        providerEventId,
        message: 'Intent already in terminal state',
      };
    }

    // Amount & currency verification (BILL-007 Step 4)
    if (parseInt(intent.amount_minor, 10) !== amount_minor || intent.currency !== currency) {
      await client.query(
        "UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE business_id = $1 AND id = $2",
        [businessId, intent.id]
      );
      await controlPool.query(
        "UPDATE payment_events SET status = 'rejected_mismatch' WHERE provider = $1 AND provider_event_id = $2",
        [provider, providerEventId]
      );
      return {
        status: 'rejected_mismatch',
        providerEventId,
        message: 'Amount or currency mismatch',
      };
    }

    if (outcomeStatus === 'failed') {
      await client.query(
        "UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE business_id = $1 AND id = $2",
        [businessId, intent.id]
      );
      await controlPool.query(
        "UPDATE payment_events SET status = 'processed', processed_at = NOW() WHERE provider = $1 AND provider_event_id = $2",
        [provider, providerEventId]
      );
      return {
        status: 'failed',
        providerEventId,
        message: 'Payment failed reported by provider',
      };
    }

    // Success outcome: mark intent succeeded
    await client.query(
      "UPDATE payment_intents SET status = 'succeeded', updated_at = NOW() WHERE business_id = $1 AND id = $2",
      [businessId, intent.id]
    );

    // Fetch quote to apply entitlement
    const quoteRes = await client.query<{
      target_plan: string;
      target_seat_quantity: number;
    }>(
      'SELECT target_plan, target_seat_quantity FROM billing_quotes WHERE business_id = $1 AND id = $2',
      [businessId, intent.quote_id]
    );
    const quote = quoteRes.rows[0];

    // Lock subscription row FOR UPDATE
    const subRes = await client.query<{
      plan: string;
      seat_quantity: number;
      scheduled_plan: string | null;
      status: string;
    }>(
      'SELECT plan, seat_quantity, scheduled_plan, status FROM subscriptions WHERE business_id = $1 FOR UPDATE',
      [businessId]
    );
    const sub = subRes.rows[0];

    // Upgrade cancels scheduled downgrade (BILL-020, PR-10b)
    const isPlanUpgrade = quote.target_plan !== sub.plan;
    const newScheduledPlan = isPlanUpgrade ? null : sub.scheduled_plan;

    // Apply entitlement to subscription
    await client.query(
      `UPDATE subscriptions
       SET plan = $1, seat_quantity = $2,
           scheduled_plan = $3,
           status = 'active', past_due_since = NULL,
           last_payment_at = NOW()
       WHERE business_id = $4`,
      [quote.target_plan, quote.target_seat_quantity, newScheduledPlan, businessId]
    );

    // Append strictly immutable ledger entry (BILL-010, C-08, BR-010, AC-013)
    await client.query(
      `INSERT INTO ledger_entries (
         business_id, type, amount_minor, currency, quote_id, payment_intent_id,
         provider_event_id, description, plan, seat_quantity
       ) VALUES ($1, 'charge', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        businessId,
        amount_minor,
        currency,
        intent.quote_id,
        intent.id,
        providerEventId,
        `Simulated payment for plan ${quote.target_plan} (${quote.target_seat_quantity} seats)`,
        quote.target_plan,
        quote.target_seat_quantity,
      ]
    );

    // Mark event processed in control plane
    await controlPool.query(
      "UPDATE payment_events SET status = 'processed', processed_at = NOW() WHERE provider = $1 AND provider_event_id = $2",
      [provider, providerEventId]
    );

    return {
      status: 'processed',
      providerEventId,
      message: 'Payment processed and entitlement granted',
    };
  });
}
