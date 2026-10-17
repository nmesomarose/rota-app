/**
 * Subscription Lifecycle & Restricted Mode Middleware
 * PRD Reference: 8.8, 8.10 (BILL-030)
 *
 * Blocks mutating actions (shifts, swaps, attendance, invitations, org modifications, upgrade quotes)
 * when subscription is in 'restricted' mode.
 * Preserves staff read-only access and Owner renewal/payment access.
 */

import type { Request, Response, NextFunction } from 'express';
import { withTenantContext } from '../db/tenant-context.ts';
import { sendError } from '../utils/errors.ts';

export async function checkSubscriptionRestricted(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Read-only requests are always permitted (BILL-030)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }

  // 2. If no business context is set yet, proceed to standard auth handling
  if (!req.user?.businessId) {
    next();
    return;
  }

  // 3. Billing renewal, payment simulation, and webhooks are explicitly allowed in restricted mode
  // so an Owner can pay the outstanding balance (BILL-030)
  const allowedRestrictedPaths = [
    '/v1/billing/renew',
    '/v1/billing/simulate-checkout',
    '/v1/billing/webhook',
    '/v1/billing/quotes/', // confirming renewal quote
  ];

  const isAllowedPath = allowedRestrictedPaths.some((p) => req.originalUrl.includes(p));
  if (isAllowedPath) {
    next();
    return;
  }

  try {
    const sub = await withTenantContext(req.user.businessId, async (client) => {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM subscriptions WHERE business_id = $1',
        [req.user!.businessId]
      );
      return result.rows[0];
    });

    if (sub?.status === 'restricted') {
      sendError(
        req,
        res,
        403,
        'SUBSCRIPTION_RESTRICTED',
        'Action blocked: organization subscription is in restricted mode due to unpaid balance. An Owner must renew the subscription to restore full functionality.'
      );
      return;
    }

    next();
  } catch (err) {
    // If tenant lookup fails, allow downstream handler to handle or report error
    next();
  }
}
