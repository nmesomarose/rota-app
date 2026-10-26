/**
 * Billing Router
 * PRD Reference: 8.1..8.10, 19.5, DR-01, BILL-001..030, PR-01..16
 *
 * Implements endpoints for subscription status, quote generation, owner confirmation,
 * provider checkout simulation, webhook ingestion, scheduled changes, and append-only ledger audit.
 */

import { Router, type Request, type Response } from 'express';
import { authenticateToken, requireBusinessMembership, requireRole } from '../middleware/auth-middleware.ts';
import { paymentEndpointLimiter } from '../middleware/rate-limiter.ts';
import { sendError } from '../utils/errors.ts';
import {
  getSubscriptionDetails,
  createBillingQuote,
  confirmBillingQuote,
  scheduleDowngrade,
  cancelScheduledDowngrade,
  processSubscriptionRenewal,
  cancelPendingPaymentIntent,
  getPaymentHistory,
} from '../services/billing-service.ts';
import {
  processPaymentWebhook,
  generateSimulatedWebhook,
  verifyAndFulfillPayment,
} from '../services/payment-provider.ts';
import { registerMockPaystackTransaction } from '../services/paystack-service.ts';
import { withTenantContext } from '../db/tenant-context.ts';

export const billingRouter = Router();

/**
 * GET /v1/billing/subscription
 * Retrieves authoritative subscription, seat limits, active usage, and scheduled changes.
 */
billingRouter.get(
  '/v1/billing/subscription',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const subscription = await getSubscriptionDetails(businessId);

      res.status(200).json({
        data: subscription,
      });
    } catch (err: any) {
      console.error('[Billing Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/quotes
 * Generates a server-authoritative quote for an upgrade or seat addition (Owner only).
 */
billingRouter.post(
  '/v1/billing/quotes',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  paymentEndpointLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const userId = req.user!.id;
      const { targetPlan, targetSeats, currency } = req.body;

      const quote = await createBillingQuote({
        businessId,
        userId,
        targetPlan,
        targetSeats,
        currency,
      });

      res.status(201).json({
        data: quote,
      });
    } catch (err: any) {
      console.error('[Create Quote Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/quotes/:id/confirm
 * Confirms a quote and creates a single open payment intent (Owner only).
 */
billingRouter.post(
  '/v1/billing/quotes/:id/confirm',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  paymentEndpointLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const quoteId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const rawHeader = req.headers['idempotency-key'];
      const idempotencyKey = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader) || req.body?.idempotencyKey;

      if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        sendError(req, res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header or body field is required');
        return;
      }

      const intent = await confirmBillingQuote({
        businessId,
        quoteId,
        idempotencyKey,
        requestBody: req.body,
        provider: req.body?.provider || (process.env.BILLING_PROVIDER as any) || 'paystack',
        userEmail: req.user?.email,
        callbackUrl: req.body?.callbackUrl,
      });

      res.status(200).json({
        data: {
          ...intent,
          checkoutUrl: intent.checkoutUrl,
          accessCode: intent.accessCode,
          provider: intent.provider,
          environment: intent.provider === 'paystack' ? 'paystack_test' : 'simulated_provider_environment',
        },
      });
    } catch (err: any) {
      console.error('[Confirm Quote Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/schedule-downgrade
 * Schedules a downgrade or seat reduction to take effect at renewal (Owner only).
 */
billingRouter.post(
  '/v1/billing/schedule-downgrade',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const userId = req.user!.id;
      const { targetPlan, targetSeats } = req.body;

      const result = await scheduleDowngrade({
        businessId,
        userId,
        targetPlan,
        targetSeats,
      });

      res.status(200).json({
        data: result,
      });
    } catch (err: any) {
      console.error('[Schedule Downgrade Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * DELETE /v1/billing/schedule-downgrade
 * Cancels a previously scheduled downgrade (Owner only).
 */
billingRouter.delete(
  '/v1/billing/schedule-downgrade',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      await cancelScheduledDowngrade(businessId);

      res.status(200).json({
        data: { message: 'Scheduled downgrade cancelled' },
      });
    } catch (err: any) {
      console.error('[Cancel Downgrade Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/simulate-checkout
 * Simulates checkout completion by generating a signed webhook and processing it (Owner only).
 */
billingRouter.post(
  '/v1/billing/simulate-checkout',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const { providerReference, outcome = 'success' } = req.body;

      if (!providerReference) {
        sendError(req, res, 400, 'REFERENCE_REQUIRED', 'providerReference is required');
        return;
      }

      // Lookup intent amount and currency
      const intent = await withTenantContext(businessId, async (client) => {
        const res = await client.query<{ amount_minor: string; currency: string }>(
          'SELECT amount_minor, currency FROM payment_intents WHERE business_id = $1 AND provider_reference = $2',
          [businessId, providerReference]
        );
        return res.rows[0];
      });

      if (!intent) {
        sendError(req, res, 404, 'INTENT_NOT_FOUND', 'Payment intent not found');
        return;
      }

      const { rawBody, signature } = generateSimulatedWebhook({
        reference: providerReference,
        amountMinor: parseInt(intent.amount_minor, 10),
        currency: intent.currency,
        outcome,
        businessId,
      });

      const result = await processPaymentWebhook({
        rawBody,
        signature,
      });

      res.status(200).json({
        data: {
          ...result,
          environment: 'simulated_provider',
        },
      });
    } catch (err: any) {
      console.error('[Simulate Checkout Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/webhook
 * Public webhook endpoint for payment provider callbacks.
 * Verifies raw-body HMAC signature and durably ingests the event.
 * Supports Paystack (x-paystack-signature) and simulated (x-webhook-signature).
 */
billingRouter.post(
  '/v1/billing/webhook',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const paystackSig = req.headers['x-paystack-signature'] as string;
      const genericSig = (req.headers['x-webhook-signature'] || req.headers['x-provider-signature']) as string;
      const signature = paystackSig || genericSig;

      if (!signature) {
        sendError(req, res, 401, 'MISSING_SIGNATURE', 'Missing webhook signature header');
        return;
      }

      const signatureType = paystackSig ? 'paystack' : 'simulated';
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      const asyncProcessing = req.headers['x-async-processing'] === 'true' || process.env.ASYNC_WEBHOOK_PROCESSING === 'true';
      const result = await processPaymentWebhook({
        rawBody,
        signature,
        signatureType,
        asyncProcessing,
      });

      res.status(200).json({
        status: result.status,
        providerEventId: result.providerEventId,
      });
    } catch (err: any) {
      console.error('[Webhook Processing Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/verify
 * Authoritative return-flow verification endpoint (Owner only).
 * Directly queries the payment provider API to verify transaction success
 * before activating subscriptions or granting entitlements. Never trusts client redirect data.
 */
billingRouter.post(
  '/v1/billing/verify',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const { reference } = req.body;

      if (!reference || typeof reference !== 'string') {
        sendError(req, res, 400, 'REFERENCE_REQUIRED', 'A valid payment reference is required');
        return;
      }

      const result = await verifyAndFulfillPayment({
        businessId,
        reference,
      });

      res.status(200).json({
        data: result,
      });
    } catch (err: any) {
      console.error('[Verify Payment Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/cancel-payment
 * Explicitly cancels any awaiting_payment intent for the active business (Owner only).
 */
billingRouter.post(
  '/v1/billing/cancel-payment',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const cancelled = await cancelPendingPaymentIntent(businessId);
      res.status(200).json({
        data: {
          cancelled,
          message: cancelled
            ? 'Pending payment session cancelled successfully'
            : 'No pending payment session found',
        },
      });
    } catch (err: any) {
      console.error('[Cancel Payment Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * GET /v1/billing/return
 * Authoritative redirect return callback (Redirected by Paystack or Mock Simulator).
 * Renders a mobile-friendly return page, attempts server-side fulfillment, and avoids
 * client-side auto-redirection that causes Safari's "address is invalid" error in Expo Go.
 */
billingRouter.get('/v1/billing/return', async (req: Request, res: Response): Promise<void> => {
  const reference = (req.query.reference || req.query.trxref || '') as string;
  const rawHost = (req.headers.host || req.hostname || 'localhost') as string;
  const hostIp = rawHost.split(':')[0];
  const expoProjectLink = `exp://${hostIp}:8081`;
  const expoSchemeLink = 'exp://';
  const deepLink = `rota://billing/return?reference=${encodeURIComponent(reference)}`;

  let fulfilledStatus: 'succeeded' | 'failed' | 'pending' | 'unverified' = 'unverified';
  let planName: string | null = null;
  let seatQuantity: number | null = null;

  if (reference) {
    try {
      const { shard1Pool, shard2Pool } = await import('../db/connection.ts');
      let businessId: string | null = null;

      const s1 = await shard1Pool.query<{ business_id: string }>(
        'SELECT business_id FROM payment_intents WHERE provider_reference = $1',
        [reference]
      );
      if (s1.rows.length > 0) {
        businessId = s1.rows[0].business_id;
      } else {
        const s2 = await shard2Pool.query<{ business_id: string }>(
          'SELECT business_id FROM payment_intents WHERE provider_reference = $1',
          [reference]
        );
        if (s2.rows.length > 0) {
          businessId = s2.rows[0].business_id;
        }
      }

      if (businessId) {
        const result = await verifyAndFulfillPayment({
          businessId,
          reference,
        });
        fulfilledStatus = result.status;
        if (result.subscription) {
          planName = result.subscription.plan;
          seatQuantity = result.subscription.seatQuantity;
        }
      }
    } catch (vErr) {
      console.warn('[Billing Return Auto-Verify Notice]', vErr);
    }
  }

  const isSuccess = fulfilledStatus === 'succeeded';
  const headline = isSuccess ? 'Payment Confirmed!' : 'Payment Completed';
  const iconEmoji = isSuccess ? '✅' : '💳';
  const subtitle = isSuccess
    ? `Your subscription has been activated (${planName?.toUpperCase() || 'NEW PLAN'}, ${seatQuantity || ''} seats).`
    : 'Your payment session was submitted to Paystack.';

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rota — ${headline}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0B1120;
      color: #F8FAFC;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #1E293B;
      border: 1px solid #334155;
      border-radius: 20px;
      padding: 32px 24px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 30px -10px rgba(0, 0, 0, 0.5);
    }
    .icon {
      font-size: 52px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 10px;
      color: #F8FAFC;
      font-weight: 700;
    }
    .subtitle {
      color: #94A3B8;
      font-size: 15px;
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .instruction-box {
      background: #0F172A;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 20px;
      text-align: left;
    }
    .instruction-title {
      font-size: 12px;
      font-weight: 700;
      color: #38BDF8;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .instruction-item {
      font-size: 13px;
      color: #CBD5E1;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .instruction-item:last-child {
      margin-bottom: 0;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .btn {
      display: block;
      color: white;
      text-decoration: none;
      padding: 14px 20px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 15px;
      transition: background 0.2s, transform 0.1s;
      box-sizing: border-box;
      text-align: center;
    }
    .btn-expo {
      background: #0284C7;
    }
    .btn-expo:hover {
      background: #0369A1;
    }
    .btn-secondary {
      background: #334155;
      color: #F8FAFC;
    }
    .btn-secondary:hover {
      background: #475569;
    }
    .ref {
      font-family: monospace;
      font-size: 11px;
      color: #64748B;
      margin-top: 16px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${iconEmoji}</div>
    <h1>${headline}</h1>
    <p class="subtitle">${subtitle}</p>

    <div class="instruction-box">
      <div class="instruction-title">Return to Rota</div>
      <div class="instruction-item">📱 <strong>In Expo Go:</strong> Switch back to the Expo Go app (or tap <strong>◀ Expo Go</strong> in the top-left corner of your screen). Your plan is already active on the server!</div>
      <div class="instruction-item">🔄 <strong>If Expo Go restarted:</strong> Tap <em>Go to Expo Home</em> on your phone and open <strong>Rota</strong> under <em>Recently in Development</em>, or tap the button below.</div>
      <div class="instruction-item">🚀 <strong>In Standalone App:</strong> Tap <em>Open Standalone Rota App</em>.</div>
    </div>

    <div class="actions">
      <a href="${expoProjectLink}" class="btn btn-expo" id="expo-return-btn">📱 Reconnect in Expo Go (${hostIp}:8081)</a>
      <a href="${deepLink}" class="btn btn-secondary" id="return-btn">🚀 Open Standalone Rota App</a>
    </div>

    <div class="ref">Ref: ${reference || 'N/A'}</div>
  </div>
</body>
</html>`);
});

/**
 * GET /v1/billing/mock-checkout
 * Local development checkout simulator (Used when no real Paystack key is set in dev).
 */
billingRouter.get('/v1/billing/mock-checkout', (req: Request, res: Response): void => {
  const reference = (req.query.reference || '') as string;
  const action = req.query.action as string;

  if (action === 'complete') {
    registerMockPaystackTransaction({
      status: 'success',
      reference,
      amountMinor: 5000,
      currency: 'USD',
      paidAt: new Date().toISOString(),
      gatewayResponse: 'Mock Checkout Successful',
      channel: 'card',
    });
    res.redirect(`/v1/billing/return?reference=${encodeURIComponent(reference)}`);
    return;
  }

  if (action === 'cancel') {
    registerMockPaystackTransaction({
      status: 'abandoned',
      reference,
      amountMinor: 0,
      currency: 'USD',
      gatewayResponse: 'Transaction cancelled by user in mock simulator',
    });
    res.redirect(`/v1/billing/return?reference=${encodeURIComponent(reference)}`);
    return;
  }

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paystack Checkout Simulator (Development Mode)</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0F172A;
      color: #F8FAFC;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      background: #1E293B;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 32px 24px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    .badge {
      display: inline-block;
      background: #0284C7;
      color: white;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 8px;
      color: #F8FAFC;
    }
    p {
      color: #94A3B8;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .ref-box {
      background: #0F172A;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 12px;
      color: #38BDF8;
      margin-bottom: 24px;
      word-break: break-all;
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .btn {
      display: block;
      padding: 12px 20px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
      transition: opacity 0.2s;
    }
    .btn-success {
      background: #10B981;
      color: #FFFFFF;
    }
    .btn-cancel {
      background: #334155;
      color: #CBD5E1;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Development Mock Mode</span>
    <h1>Paystack Checkout Simulator</h1>
    <p>Simulating hosted checkout session for local development without live/test Paystack API credentials.</p>
    <div class="ref-box">${reference}</div>
    <div class="btn-group">
      <a href="/v1/billing/mock-checkout?reference=${encodeURIComponent(reference)}&action=complete" class="btn btn-success">
        Simulate Successful Payment
      </a>
      <a href="/v1/billing/mock-checkout?reference=${encodeURIComponent(reference)}&action=cancel" class="btn btn-cancel">
        Cancel / Abandon Transaction
      </a>
    </div>
  </div>
</body>
</html>`);
});

/**
 * GET /v1/billing/ledger
 * Returns append-only financial ledger entries (Owner only).
 */
billingRouter.get(
  '/v1/billing/ledger',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const entries = await withTenantContext(businessId, async (client) => {
        const res = await client.query<{
          seq: string;
          type: string;
          amount_minor: string;
          currency: string;
          description: string;
          plan: string;
          seat_quantity: number;
          created_at: Date;
        }>(
          `SELECT seq, type, amount_minor, currency, description, plan, seat_quantity, created_at
           FROM ledger_entries
           WHERE business_id = $1
           ORDER BY seq ASC`,
          [businessId]
        );
        return res.rows.map((r) => ({
          seq: parseInt(r.seq, 10),
          type: r.type,
          amountMinor: parseInt(r.amount_minor, 10),
          currency: r.currency,
          description: r.description,
          plan: r.plan,
          seatQuantity: r.seat_quantity,
          createdAt: r.created_at,
        }));
      });

      res.status(200).json({
        data: entries,
      });
    } catch (err: any) {
      console.error('[Ledger Fetch Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * GET /v1/billing/history
 * Retrieves all payment intent attempts (succeeded, failed, awaiting_payment, expired) for the active business (Owner only).
 */
billingRouter.get(
  '/v1/billing/history',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const history = await getPaymentHistory(businessId);
      res.status(200).json({
        data: history,
      });
    } catch (err: any) {
      console.error('[Payment History Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);

/**
 * POST /v1/billing/renew
 * Triggers or simulates subscription period renewal (Owner only).
 */
billingRouter.post(
  '/v1/billing/renew',
  authenticateToken,
  requireBusinessMembership,
  requireRole(['owner']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = req.user!.businessId!;
      const { outcome = 'success' } = req.body;

      const result = await processSubscriptionRenewal({
        businessId,
        outcome,
      });

      res.status(200).json({
        data: result,
      });
    } catch (err: any) {
      console.error('[Renewal Error]', err);
      sendError(req, res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message);
    }
  }
);
