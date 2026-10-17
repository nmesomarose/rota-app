/**
 * Billing Router
 * PRD Reference: 8.1..8.10, 19.5, DR-01, BILL-001..030, PR-01..16
 *
 * Implements endpoints for subscription status, quote generation, owner confirmation,
 * provider checkout simulation, webhook ingestion, scheduled changes, and append-only ledger audit.
 */

import { Router, type Request, type Response } from 'express';
import { authenticateToken, requireBusinessMembership, requireRole } from '../middleware/auth-middleware.ts';
import { sendError } from '../utils/errors.ts';
import {
  getSubscriptionDetails,
  createBillingQuote,
  confirmBillingQuote,
  scheduleDowngrade,
  cancelScheduledDowngrade,
  processSubscriptionRenewal,
} from '../services/billing-service.ts';
import {
  processPaymentWebhook,
  generateSimulatedWebhook,
} from '../services/payment-provider.ts';
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
      });

      res.status(200).json({
        data: {
          ...intent,
          checkoutUrl: `/checkout/simulated?reference=${intent.providerReference}`,
          environment: 'simulated_provider_environment',
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
 */
billingRouter.post(
  '/v1/billing/webhook',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const signature = (req.headers['x-webhook-signature'] || req.headers['x-provider-signature']) as string;
      if (!signature) {
        sendError(req, res, 401, 'MISSING_SIGNATURE', 'Missing webhook signature header');
        return;
      }

      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      const result = await processPaymentWebhook({
        rawBody,
        signature,
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
