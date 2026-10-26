/**
 * Payment Provider, Webhook Pipeline & Entitlement Fulfillment
 * PRD Reference: 8.6 (BILL-005..008, BILL-010, BILL-020, BILL-028), 19.5, DR-01, AC-010, AC-BILL-01
 *
 * Implements Paystack test-mode gateway integration, raw-body HMAC signature verification
 * (HMAC-SHA512 for Paystack, HMAC-SHA256 for simulated fallback), durable idempotent webhook
 * ingestion via control-plane payment_events, return-flow verification without trusting client redirects,
 * and tenant-plane transactional entitlement fulfillment with immutable ledger recording.
 */

import crypto from 'node:crypto';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { getSubscriptionDetails } from './billing-service.ts';
import {
  verifyPaystackSignature,
  verifyPaystackTransaction,
  getPaystackConfig,
} from './paystack-service.ts';
import { enqueueJob } from '../queue/job-queue.ts';

const SIMULATED_WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || 'simulated_secret_test_key_12345';

export interface WebhookEventPayload {
  event: 'charge.success' | 'charge.failed' | string;
  data: {
    id: string | number; // provider_event_id
    reference: string; // provider_reference
    amount_minor?: number;
    amount?: number; // Paystack uses 'amount'
    currency: string;
    status: 'success' | 'failed' | string;
    paid_at?: string;
    metadata?: {
      business_id?: string;
      quote_id?: string;
      [key: string]: unknown;
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
      amount: params.amountMinor,
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

export interface FulfillPaymentParams {
  businessId: string;
  providerReference: string;
  amountMinor: number;
  currency: string;
  outcomeStatus: 'success' | 'failed';
  provider: string; // 'paystack' | 'simulated'
  providerEventId: string;
  description?: string;
}

/**
 * Core transactional entitlement fulfillment.
 * Atomic within tenant database, locked FOR UPDATE to guarantee absolute idempotency.
 */
export async function fulfillPaymentIntent(params: FulfillPaymentParams): Promise<{
  status: 'processed' | 'rejected_mismatch' | 'failed';
  providerEventId: string;
  message?: string;
}> {
  const {
    businessId,
    providerReference,
    amountMinor,
    currency,
    outcomeStatus,
    provider,
    providerEventId,
    description,
  } = params;

  return await withTenantContext(businessId, async (client) => {
    // 1. Lock payment intent FOR UPDATE (BILL-007 Step 5)
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

    // 2. Out-of-order check: if intent is already in terminal state, ignore duplicate work
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

    // 3. Amount & currency verification against database intent record (BILL-007 Step 4)
    if (
      parseInt(intent.amount_minor, 10) !== amountMinor ||
      intent.currency.toUpperCase() !== currency.toUpperCase()
    ) {
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

    // 4. Handle provider-reported failure
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

    // 5. Success outcome: mark intent succeeded
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
           billing_currency = $3,
           scheduled_plan = $4,
           status = 'active', past_due_since = NULL,
           last_payment_at = NOW()
       WHERE business_id = $5`,
      [quote.target_plan, quote.target_seat_quantity, intent.currency, newScheduledPlan, businessId]
    );

    // Append strictly immutable ledger entry (BILL-010, C-08, BR-010, AC-013)
    const ledgerDesc =
      description ||
      `${provider === 'paystack' ? 'Paystack' : 'Simulated'} payment for plan ${quote.target_plan} (${quote.target_seat_quantity} seats)`;

    await client.query(
      `INSERT INTO ledger_entries (
         business_id, type, amount_minor, currency, quote_id, payment_intent_id,
         provider_event_id, description, plan, seat_quantity
       ) VALUES ($1, 'charge', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        businessId,
        amountMinor,
        intent.currency,
        intent.quote_id,
        intent.id,
        providerEventId,
        ledgerDesc,
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

/**
 * Ingests and processes a payment provider webhook with raw-body signature verification,
 * durable inboxing in control-plane `payment_events`, idempotency checks, and tenant fulfillment.
 * Supports both Paystack (HMAC-SHA512) and simulated fallback (HMAC-SHA256).
 */
export async function processPaymentWebhook(params: {
  rawBody: string | Buffer;
  signature: string;
  signatureType?: 'paystack' | 'simulated';
  secret?: string;
  asyncProcessing?: boolean;
}): Promise<{
  status: 'processed' | 'ignored_duplicate' | 'rejected_mismatch' | 'failed' | 'queued';
  providerEventId: string;
  message?: string;
}> {
  const { rawBody, signature, signatureType, secret } = params;

  // 1. Verify signature over raw request body before parsing (BILL-007, Step 1)
  let isValid = false;
  let isPaystack = signatureType === 'paystack';

  if (isPaystack || verifyPaystackSignature(rawBody, signature, secret)) {
    isPaystack = true;
    isValid = verifyPaystackSignature(rawBody, signature, secret);
  } else {
    isValid = verifyWebhookSignature(rawBody, signature, secret || SIMULATED_WEBHOOK_SECRET);
  }

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

  const providerEventId = String(payload.data.id);
  const providerReference = payload.data.reference;
  const amountMinor = payload.data.amount_minor ?? payload.data.amount ?? 0;
  const currency = payload.data.currency;
  const outcomeStatus: 'success' | 'failed' =
    payload.data.status === 'success' || payload.event === 'charge.success' ? 'success' : 'failed';
  const provider = isPaystack ? 'paystack' : 'simulated';

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
    return {
      status: 'ignored_duplicate',
      providerEventId,
      message: 'Duplicate event acknowledged and ignored',
    };
  }

  // 3b. Enqueue background job (BILL-007 Step 3)
  try {
    await enqueueJob('payment.webhook', {
      provider,
      providerEventId,
      payload,
    });
  } catch (qErr: any) {
    console.warn('[Webhook] Could not enqueue background payment.webhook job:', qErr.message);
  }

  // If asyncProcessing is enabled or requested, acknowledge receipt immediately (BILL-007 Step 2-3)
  if (params.asyncProcessing || process.env.ASYNC_WEBHOOK_PROCESSING === 'true') {
    return {
      status: 'queued',
      providerEventId,
      message: 'Webhook event received and enqueued for background processing',
    };
  }

  // 4. Locate payment intent across shards or using metadata business_id (BILL-007 Step 4)
  let businessId = payload.data.metadata?.business_id;

  if (!businessId) {
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

  // 5. Fulfill payment intent in tenant context
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

/**
 * Return-flow authoritative transaction verification (Safe return flow).
 * Queries provider API directly; never trusts client redirect parameters.
 */
export async function verifyAndFulfillPayment(params: {
  businessId: string;
  reference: string;
}): Promise<{
  status: 'succeeded' | 'failed' | 'pending';
  providerReference: string;
  message: string;
  subscription?: any;
}> {
  const { businessId, reference } = params;

  // 1. Locate intent in tenant plane
  const intent = await withTenantContext(businessId, async (client) => {
    const res = await client.query<{
      id: string;
      quote_id: string;
      provider: string;
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      'SELECT id, quote_id, provider, amount_minor, currency, status FROM payment_intents WHERE business_id = $1 AND provider_reference = $2',
      [businessId, reference]
    );
    return res.rows[0];
  });

  if (!intent) {
    const error: any = new Error('Payment intent not found for this business');
    error.code = 'INTENT_NOT_FOUND';
    error.status = 404;
    throw error;
  }

  // 2. If already marked succeeded (e.g. by webhook arriving before redirect), return current state
  if (intent.status === 'succeeded') {
    const sub = await getSubscriptionDetails(businessId);
    return {
      status: 'succeeded',
      providerReference: reference,
      message: 'Payment has already been verified and fulfilled',
      subscription: sub,
    };
  }

  if (intent.status === 'failed') {
    return {
      status: 'failed',
      providerReference: reference,
      message: 'Payment intent marked as failed',
    };
  }

  // 3. For Paystack: Query Paystack verify API directly
  if (intent.provider === 'paystack') {
    const paystackResult = await verifyPaystackTransaction(reference);

    if (paystackResult.status === 'success') {
      const providerEventId = `paystack_verify_${paystackResult.id || reference}`;

      // Ingest into control plane payment_events
      const inboxClient = await controlPool.connect();
      try {
        await inboxClient.query(
          `INSERT INTO payment_events (provider, provider_event_id, payload, status)
           VALUES ('paystack', $1, $2, 'received')
           ON CONFLICT (provider, provider_event_id) DO NOTHING`,
          [providerEventId, paystackResult]
        );
      } finally {
        inboxClient.release();
      }

      // Fulfill intent
      const fulfillment = await fulfillPaymentIntent({
        businessId,
        providerReference: reference,
        amountMinor: paystackResult.amountMinor,
        currency: paystackResult.currency,
        outcomeStatus: 'success',
        provider: 'paystack',
        providerEventId,
        description: `Verified Paystack payment for plan (${paystackResult.currency} ${paystackResult.amountMinor})`,
      });

      if (fulfillment.status === 'rejected_mismatch') {
        return {
          status: 'failed',
          providerReference: reference,
          message: fulfillment.message || 'Verification rejected: Amount or currency mismatch',
        };
      }

      const sub = await getSubscriptionDetails(businessId);
      return {
        status: 'succeeded',
        providerReference: reference,
        message: 'Payment verified by Paystack and subscription activated',
        subscription: sub,
      };
    } else if (paystackResult.status === 'abandoned' || paystackResult.status === 'failed') {
      await withTenantContext(businessId, async (client) => {
        await client.query(
          "UPDATE payment_intents SET status = 'failed', updated_at = NOW() WHERE business_id = $1 AND id = $2",
          [businessId, intent.id]
        );
      });

      return {
        status: 'failed',
        providerReference: reference,
        message: `Payment ${paystackResult.status} on Paystack: ${paystackResult.gatewayResponse || 'Incomplete'}`,
      };
    } else {
      return {
        status: 'pending',
        providerReference: reference,
        message: 'Payment is awaiting completion in Paystack checkout',
      };
    }
  }

  // Fallback for simulated provider
  return {
    status: intent.status === 'succeeded' ? 'succeeded' : 'pending',
    providerReference: reference,
    message: `Payment status is ${intent.status}`,
  };
}
