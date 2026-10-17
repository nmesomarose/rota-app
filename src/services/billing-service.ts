/**
 * Billing and Subscription Lifecycle Service
 * PRD Reference: 8.1..8.10, 19.5, DR-01, BILL-001..030, PR-01..16
 *
 * Implements server-authoritative quotes, proration calculation, anchor day handling,
 * seat admission limit enforcement, scheduled downgrades/seat reductions,
 * and subscription lifecycle state transitions.
 */

import crypto from 'node:crypto';
import { withTenantContext } from '../db/tenant-context.ts';
import {
  PLANS,
  calculateMonthlyCostUsd,
  getFxRate,
  convertUsdToNgn,
  type PlanDefinition,
} from './fx-service.ts';

export interface ProrationResult {
  amountMinor: number;
  baseUsdAmountMinor: number;
  deltaMonthlyUsd: number;
  periodDays: number;
  remainingDays: number;
  effectiveLocalDate: string;
}

/**
 * Returns the calendar date string (YYYY-MM-DD) for a given timestamp in a specified IANA time zone.
 */
export function getLocalDateString(date: Date, timezone: string = 'UTC'): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(date); // 'YYYY-MM-DD'
  } catch {
    // Fallback to UTC if timezone is invalid
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Calculates the difference in integer calendar days between two 'YYYY-MM-DD' dates.
 * d2 - d1
 */
export function diffInCalendarDays(d2Str: string, d1Str: string): number {
  const d1 = new Date(`${d1Str}T00:00:00Z`);
  const d2 = new Date(`${d2Str}T00:00:00Z`);
  const msDiff = d2.getTime() - d1.getTime();
  return Math.round(msDiff / (24 * 60 * 60 * 1000));
}

/**
 * Calculates next period end date given the period start date and anchor day (PR-15, BILL-016).
 * Periods run month-to-month anchored to the initial anchor day (1-31).
 * If the anchor day does not exist in the next month, the last day of that month is used.
 */
export function calculateNextPeriodEndDate(startDateStr: string, anchorDay: number): string {
  const [yearStr, monthStr] = startDateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10); // 1-indexed (1..12)

  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }

  // Find number of days in nextMonth
  // Passing 0 as day to Date returns the last day of the previous month
  const daysInNextMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const effectiveDay = Math.min(anchorDay, daysInNextMonth);

  const mm = String(nextMonth).padStart(2, '0');
  const dd = String(effectiveDay).padStart(2, '0');
  return `${nextYear}-${mm}-${dd}`;
}

/**
 * Calculates next local midnight timestamp for a given time zone.
 */
export function getNextLocalMidnight(date: Date, timezone: string = 'UTC'): Date {
  const localDateStr = getLocalDateString(date, timezone);
  const nextDate = new Date(`${localDateStr}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate;
}

/**
 * Authoritative Server Proration Calculator (BILL-001, BILL-004, BILL-016, PR-01..16).
 *
 * Formula:
 * period_days = period_end_date - period_start_date
 * day = effective_local_date - period_start_date + 1
 * remaining_days = period_days - day + 1
 * Δmonthly = cost(new_plan, new_q) - cost(old_plan, old_q)
 * If Δmonthly <= 0: amount = 0
 * If Δmonthly > 0: amount = floor(Δmonthly * remaining_days / period_days)
 */
export function calculateProration(params: {
  currentPlan: string;
  currentSeats: number;
  targetPlan: string;
  targetSeats: number;
  periodStartDate: string; // YYYY-MM-DD
  periodEndDate: string; // YYYY-MM-DD
  effectiveLocalDate: string; // YYYY-MM-DD
  currency: 'USD' | 'NGN';
  fxRate?: number;
}): ProrationResult {
  const {
    currentPlan,
    currentSeats,
    targetPlan,
    targetSeats,
    periodStartDate,
    periodEndDate,
    effectiveLocalDate,
    currency,
    fxRate = 1.0,
  } = params;

  const periodDays = diffInCalendarDays(periodEndDate, periodStartDate);
  if (periodDays <= 0) {
    throw new Error('Invalid period: periodEndDate must be after periodStartDate');
  }

  const dayNumber = diffInCalendarDays(effectiveLocalDate, periodStartDate) + 1;
  if (dayNumber < 1 || dayNumber > periodDays) {
    // Effective date outside current period
    throw new Error(`Effective local date ${effectiveLocalDate} is outside billing period [${periodStartDate}, ${periodEndDate}]`);
  }

  const remainingDays = periodDays - dayNumber + 1;

  const oldMonthlyCost = calculateMonthlyCostUsd(currentPlan, currentSeats);
  const newMonthlyCost = calculateMonthlyCostUsd(targetPlan, targetSeats);
  const deltaMonthlyUsd = newMonthlyCost - oldMonthlyCost;

  let baseUsdAmountMinor = 0;
  if (deltaMonthlyUsd > 0) {
    baseUsdAmountMinor = Math.floor((deltaMonthlyUsd * remainingDays) / periodDays);
  }

  let amountMinor = baseUsdAmountMinor;
  if (currency === 'NGN') {
    amountMinor = convertUsdToNgn(baseUsdAmountMinor, fxRate);
  }

  return {
    amountMinor,
    baseUsdAmountMinor,
    deltaMonthlyUsd,
    periodDays,
    remainingDays,
    effectiveLocalDate,
  };
}

export interface SubscriptionDetails {
  plan: string;
  billingCurrency: string;
  seatQuantity: number;
  status: string;
  periodStartDate: string;
  periodEndDate: string;
  anchorDay: number;
  scheduledPlan: string | null;
  scheduledSeatQuantity: number | null;
  activeSeatUsage: number;
  admissionLimit: number;
  lastPaymentAt: Date | null;
  pastDueSince: Date | null;
  version: number;
}

/**
 * Retrieves the full subscription state for a business, including active seat usage and admission limit.
 */
export async function getSubscriptionDetails(businessId: string): Promise<SubscriptionDetails> {
  return await withTenantContext(businessId, async (client) => {
    // 1. Fetch subscription row
    const subRes = await client.query<{
      plan: string;
      billing_currency: string;
      seat_quantity: number;
      status: string;
      period_start_date: string;
      period_end_date: string;
      anchor_day: number;
      scheduled_plan: string | null;
      scheduled_seat_quantity: number | null;
      last_payment_at: Date | null;
      past_due_since: Date | null;
      version: number;
    }>(
      `SELECT plan, billing_currency, seat_quantity, status,
              to_char(period_start_date, 'YYYY-MM-DD') as period_start_date,
              to_char(period_end_date, 'YYYY-MM-DD') as period_end_date,
              anchor_day, scheduled_plan, scheduled_seat_quantity,
              last_payment_at, past_due_since, 1 as version
       FROM subscriptions
       WHERE business_id = $1`,
      [businessId]
    );

    if (subRes.rows.length === 0) {
      throw new Error('Subscription not found');
    }
    const sub = subRes.rows[0];

    // 2. Count active memberships (BILL-017)
    const usageRes = await client.query<{ count: string }>(
      `SELECT count(*)::text as count
       FROM memberships
       WHERE business_id = $1 AND status = 'active'`,
      [businessId]
    );
    const activeSeatUsage = parseInt(usageRes.rows[0]?.count || '0', 10);

    // 3. Admission limit = min(current entitled seats, scheduled lower limit) (BILL-021)
    const scheduledSeats = sub.scheduled_seat_quantity ?? (
      sub.scheduled_plan ? (PLANS[sub.scheduled_plan]?.includedSeats ?? sub.seat_quantity) : sub.seat_quantity
    );
    const admissionLimit = Math.min(sub.seat_quantity, scheduledSeats);

    return {
      plan: sub.plan,
      billingCurrency: sub.billing_currency,
      seatQuantity: sub.seat_quantity,
      status: sub.status,
      periodStartDate: sub.period_start_date,
      periodEndDate: sub.period_end_date,
      anchorDay: sub.anchor_day,
      scheduledPlan: sub.scheduled_plan,
      scheduledSeatQuantity: sub.scheduled_seat_quantity,
      activeSeatUsage,
      admissionLimit,
      lastPaymentAt: sub.last_payment_at,
      pastDueSince: sub.past_due_since,
      version: sub.version,
    };
  });
}

/**
 * Creates a server-authoritative quote for an upgrade or seat addition (BILL-013, BR-006).
 */
export async function createBillingQuote(params: {
  businessId: string;
  userId: string;
  targetPlan?: string;
  targetSeats?: number;
  currency?: string;
  mockTimestamp?: Date; // For deterministic testing of time zones/dates
}): Promise<{
  id: string;
  currency: string;
  amountMinor: number;
  baseUsdAmountMinor: number;
  fxRate: number | null;
  fxSource: string | null;
  fxRetrievedAt: Date | null;
  effectiveLocalDate: string;
  periodDays: number;
  remainingDays: number;
  deltaMonthlyUsd: number;
  targetPlan: string;
  targetSeats: number;
  expiresAt: Date;
  status: string;
}> {
  const { businessId, userId, mockTimestamp } = params;

  return await withTenantContext(businessId, async (client) => {
    // 1. Fetch business details (timezone) and subscription
    const bizRes = await client.query<{ timezone: string }>(
      'SELECT timezone FROM businesses WHERE id = $1',
      [businessId]
    );
    const timezone = bizRes.rows[0]?.timezone || 'UTC';

    const subDetails = await getSubscriptionDetails(businessId);

    // Restricted mode blocks quote creation for upgrades and extra seats (BILL-030)
    if (subDetails.status === 'restricted') {
      const error: any = new Error('Upgrades and additional seats are blocked while subscription is in restricted mode');
      error.code = 'SUBSCRIPTION_RESTRICTED';
      error.status = 403;
      throw error;
    }

    const currentPlan = subDetails.plan;
    const currentSeats = subDetails.seatQuantity;

    const targetPlan = (params.targetPlan || currentPlan).toLowerCase();
    const targetPlanDef = PLANS[targetPlan];
    if (!targetPlanDef) {
      const error: any = new Error(`Invalid target plan: ${targetPlan}`);
      error.code = 'INVALID_PLAN';
      error.status = 400;
      throw error;
    }

    let targetSeats = params.targetSeats ?? currentSeats;
    if (targetPlan === 'starter') {
      targetSeats = 5;
    } else {
      targetSeats = Math.max(targetSeats, targetPlanDef.includedSeats);
    }

    // Check usage limits if downsizing
    if (targetSeats < subDetails.activeSeatUsage) {
      const error: any = new Error(`Target seats (${targetSeats}) is below current active usage (${subDetails.activeSeatUsage})`);
      error.code = 'SEAT_REDUCTION_EXCEEDS_USAGE';
      error.status = 400;
      throw error;
    }
    if (targetPlanDef.maxSeats && subDetails.activeSeatUsage > targetPlanDef.maxSeats) {
      const error: any = new Error(`Current usage (${subDetails.activeSeatUsage}) exceeds target plan limit (${targetPlanDef.maxSeats})`);
      error.code = 'DOWNGRADE_EXCEEDS_LIMIT';
      error.status = 400;
      throw error;
    }

    // Determine currency
    const quoteCurrency = (params.currency || subDetails.billingCurrency).toUpperCase() as 'USD' | 'NGN';

    let fxRate: number | null = null;
    let fxSource: string | null = null;
    let fxRetrievedAt: Date | null = null;

    if (quoteCurrency === 'NGN') {
      const fx = await getFxRate('NGN');
      fxRate = fx.rate;
      fxSource = fx.source;
      fxRetrievedAt = fx.retrievedAt;
    }

    // Calculate local effective date
    const now = mockTimestamp || new Date();
    const effectiveLocalDate = getLocalDateString(now, timezone);

    // Proration calculation
    const proration = calculateProration({
      currentPlan,
      currentSeats,
      targetPlan,
      targetSeats,
      periodStartDate: subDetails.periodStartDate,
      periodEndDate: subDetails.periodEndDate,
      effectiveLocalDate,
      currency: quoteCurrency,
      fxRate: fxRate || 1.0,
    });

    // Resolve membership id for created_by constraint (references memberships(business_id, id))
    const memberRes = await client.query<{ id: string }>(
      'SELECT id FROM memberships WHERE business_id = $1 AND (user_id = $2 OR id = $2)',
      [businessId, userId]
    );
    const createdByMembershipId = memberRes.rows[0]?.id;
    if (!createdByMembershipId) {
      throw new Error(`Membership not found for user ${userId} in business ${businessId}`);
    }

    // Expiry: earlier of 15 minutes and next local midnight (BILL-013)
    const fifteenMins = new Date(now.getTime() + 15 * 60 * 1000);
    const localMidnight = getNextLocalMidnight(now, timezone);
    const expiresAt = fifteenMins < localMidnight ? fifteenMins : localMidnight;

    // Insert quote
    const insertRes = await client.query<{
      id: string;
      currency: string;
      amount_minor: string;
      base_usd_amount_minor: string;
      fx_rate: string | null;
      fx_source: string | null;
      fx_retrieved_at: Date | null;
      effective_local_date: string;
      period_days: number;
      remaining_days: number;
      expires_at: Date;
      status: string;
    }>(
      `INSERT INTO billing_quotes (
         business_id, currency, amount_minor, base_usd_amount_minor,
         fx_rate, fx_source, fx_retrieved_at, subscription_version,
         target_plan, target_seat_quantity, effective_local_date,
         period_days, remaining_days, status, expires_at, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open', $14, $15)
       RETURNING id, currency, amount_minor, base_usd_amount_minor, fx_rate, fx_source,
                 fx_retrieved_at, to_char(effective_local_date, 'YYYY-MM-DD') as effective_local_date,
                 period_days, remaining_days, expires_at, status`,
      [
        businessId,
        quoteCurrency,
        proration.amountMinor,
        proration.baseUsdAmountMinor,
        fxRate,
        fxSource,
        fxRetrievedAt,
        subDetails.version,
        targetPlan,
        targetSeats,
        effectiveLocalDate,
        proration.periodDays,
        proration.remainingDays,
        expiresAt,
        createdByMembershipId,
      ]
    );

    const row = insertRes.rows[0];
    return {
      id: row.id,
      currency: row.currency,
      amountMinor: parseInt(row.amount_minor, 10),
      baseUsdAmountMinor: parseInt(row.base_usd_amount_minor, 10),
      fxRate: row.fx_rate ? parseFloat(row.fx_rate) : null,
      fxSource: row.fx_source,
      fxRetrievedAt: row.fx_retrieved_at,
      effectiveLocalDate: row.effective_local_date,
      periodDays: row.period_days,
      remainingDays: row.remaining_days,
      deltaMonthlyUsd: proration.deltaMonthlyUsd,
      targetPlan,
      targetSeats,
      expiresAt: row.expires_at,
      status: row.status,
    };
  });
}

/**
 * Confirms a billing quote and creates an open payment intent (BILL-014, BILL-022, PR-16).
 */
export async function confirmBillingQuote(params: {
  businessId: string;
  quoteId: string;
  idempotencyKey: string;
  requestBody: any;
}): Promise<{
  paymentIntentId: string;
  providerReference: string;
  amountMinor: number;
  currency: string;
  status: string;
  expiresAt: Date;
}> {
  const { businessId, quoteId, idempotencyKey, requestBody } = params;

  return await withTenantContext(businessId, async (client) => {
    // 1. Check if an intent with this idempotency key already exists for this business (BILL-008)
    const existingIntentRes = await client.query<{
      id: string;
      provider_reference: string;
      amount_minor: string;
      currency: string;
      status: string;
      expires_at: Date;
      request_hash: string;
    }>(
      `SELECT id, provider_reference, amount_minor, currency, status, expires_at, request_hash
       FROM payment_intents
       WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, idempotencyKey]
    );

    const requestHash = crypto.createHash('sha256').update(JSON.stringify(requestBody)).digest('hex');

    if (existingIntentRes.rows.length > 0) {
      const existing = existingIntentRes.rows[0];
      if (existing.request_hash !== requestHash) {
        const error: any = new Error('Idempotency key reused with different request payload');
        error.code = 'IDEMPOTENCY_MISMATCH';
        error.status = 422;
        throw error;
      }
      return {
        paymentIntentId: existing.id,
        providerReference: existing.provider_reference,
        amountMinor: parseInt(existing.amount_minor, 10),
        currency: existing.currency,
        status: existing.status,
        expiresAt: existing.expires_at,
      };
    }

    // 2. Check for an existing open payment intent (BILL-022)
    const openIntentRes = await client.query<{ id: string }>(
      `SELECT id FROM payment_intents
       WHERE business_id = $1 AND status = 'awaiting_payment' AND expires_at > NOW()`,
      [businessId]
    );
    if (openIntentRes.rows.length > 0) {
      const error: any = new Error('Another payment intent is currently pending for this business');
      error.code = 'PAYMENT_PENDING';
      error.status = 409;
      throw error;
    }

    // 3. Lock quote row
    const quoteRes = await client.query<{
      id: string;
      currency: string;
      amount_minor: string;
      base_usd_amount_minor: string;
      target_plan: string;
      target_seat_quantity: number;
      subscription_version: number;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, currency, amount_minor, base_usd_amount_minor, target_plan,
              target_seat_quantity, subscription_version, status, expires_at
       FROM billing_quotes
       WHERE business_id = $1 AND id = $2
       FOR UPDATE`,
      [businessId, quoteId]
    );

    if (quoteRes.rows.length === 0) {
      const error: any = new Error('Quote not found');
      error.code = 'QUOTE_NOT_FOUND';
      error.status = 404;
      throw error;
    }

    const quote = quoteRes.rows[0];

    if (quote.status !== 'open') {
      const error: any = new Error(`Quote is already ${quote.status}`);
      error.code = 'QUOTE_ALREADY_USED';
      error.status = 409;
      throw error;
    }

    if (new Date() > quote.expires_at) {
      await client.query(
        "UPDATE billing_quotes SET status = 'expired' WHERE business_id = $1 AND id = $2",
        [businessId, quoteId]
      );
      const error: any = new Error('Quote has expired');
      error.code = 'QUOTE_EXPIRED';
      error.status = 400;
      throw error;
    }

    // 4. Validate currency matches current subscription (PR-16: CURRENCY_MISMATCH)
    const subRes = await client.query<{ billing_currency: string; status: string }>(
      'SELECT billing_currency, status FROM subscriptions WHERE business_id = $1',
      [businessId]
    );
    const sub = subRes.rows[0];

    if (quote.currency !== sub.billing_currency) {
      const error: any = new Error(`Quote currency (${quote.currency}) does not match subscription currency (${sub.billing_currency})`);
      error.code = 'CURRENCY_MISMATCH';
      error.status = 400;
      throw error;
    }

    // 5. Mark quote confirmed
    await client.query(
      "UPDATE billing_quotes SET status = 'confirmed', confirmed_at = NOW() WHERE business_id = $1 AND id = $2",
      [businessId, quoteId]
    );

    // 6. Generate provider reference and create payment intent
    const providerReference = `sim_ref_${crypto.randomUUID()}`;
    const amountMinor = parseInt(quote.amount_minor, 10);

    const intentRes = await client.query<{
      id: string;
      provider_reference: string;
      amount_minor: string;
      currency: string;
      status: string;
      expires_at: Date;
    }>(
      `INSERT INTO payment_intents (
         business_id, quote_id, provider, provider_reference,
         amount_minor, currency, status, idempotency_key, request_hash, expires_at
       ) VALUES ($1, $2, 'simulated', $3, $4, $5, 'awaiting_payment', $6, $7, $8)
       RETURNING id, provider_reference, amount_minor, currency, status, expires_at`,
      [
        businessId,
        quoteId,
        providerReference,
        amountMinor,
        quote.currency,
        idempotencyKey,
        requestHash,
        quote.expires_at,
      ]
    );

    const intent = intentRes.rows[0];
    return {
      paymentIntentId: intent.id,
      providerReference: intent.provider_reference,
      amountMinor: parseInt(intent.amount_minor, 10),
      currency: intent.currency,
      status: intent.status,
      expiresAt: intent.expires_at,
    };
  });
}

/**
 * Schedules a downgrade or seat reduction at the end of the billing period (BILL-003, BILL-018, PR-08, PR-10a, PR-12, PR-13).
 */
export async function scheduleDowngrade(params: {
  businessId: string;
  userId: string;
  targetPlan?: string;
  targetSeats?: number;
}): Promise<{
  scheduledPlan: string;
  scheduledSeats: number;
  periodEndDate: string;
}> {
  const { businessId, userId } = params;

  return await withTenantContext(businessId, async (client) => {
    const subDetails = await getSubscriptionDetails(businessId);

    const targetPlan = (params.targetPlan || subDetails.plan).toLowerCase();
    const planDef = PLANS[targetPlan];
    if (!planDef) {
      const error: any = new Error(`Invalid target plan: ${targetPlan}`);
      error.code = 'INVALID_PLAN';
      error.status = 400;
      throw error;
    }

    let targetSeats = params.targetSeats ?? subDetails.seatQuantity;
    if (targetPlan === 'starter') {
      targetSeats = 5;
    } else {
      targetSeats = Math.max(targetSeats, planDef.includedSeats);
    }

    // Check usage limits: usage cannot exceed target limit
    if (planDef.maxSeats && subDetails.activeSeatUsage > planDef.maxSeats) {
      const error: any = new Error(`Current usage (${subDetails.activeSeatUsage}) exceeds target plan limit (${planDef.maxSeats})`);
      error.code = 'DOWNGRADE_EXCEEDS_LIMIT';
      error.status = 400;
      throw error;
    }

    if (targetSeats < subDetails.activeSeatUsage) {
      const error: any = new Error(`Target seats (${targetSeats}) is below current active usage (${subDetails.activeSeatUsage})`);
      error.code = 'SEAT_REDUCTION_EXCEEDS_USAGE';
      error.status = 400;
      throw error;
    }

    await client.query(
      `UPDATE subscriptions
       SET scheduled_plan = $1, scheduled_seat_quantity = $2
       WHERE business_id = $3`,
      [targetPlan, targetSeats, businessId]
    );

    // Append audit/ledger notice entry for scheduled change (PR-10a)
    await client.query(
      `INSERT INTO ledger_entries (
         business_id, type, amount_minor, currency, description, plan, seat_quantity
       ) VALUES ($1, 'scheduled_change', 0, $2, $3, $4, $5)`,
      [
        businessId,
        subDetails.billingCurrency,
        `Scheduled change: Plan -> ${targetPlan}, Seats -> ${targetSeats} effective at period end (${subDetails.periodEndDate})`,
        targetPlan,
        targetSeats,
      ]
    );

    return {
      scheduledPlan: targetPlan,
      scheduledSeats: targetSeats,
      periodEndDate: subDetails.periodEndDate,
    };
  });
}

/**
 * Cancels a scheduled downgrade or seat reduction (PR-10a).
 */
export async function cancelScheduledDowngrade(businessId: string): Promise<void> {
  await withTenantContext(businessId, async (client) => {
    const subDetails = await getSubscriptionDetails(businessId);
    if (!subDetails.scheduledPlan && !subDetails.scheduledSeatQuantity) {
      return; // Nothing to cancel
    }

    await client.query(
      `UPDATE subscriptions
       SET scheduled_plan = NULL, scheduled_seat_quantity = NULL
       WHERE business_id = $1`,
      [businessId]
    );

    // Record cancellation ledger entry (PR-10a)
    await client.query(
      `INSERT INTO ledger_entries (
         business_id, type, amount_minor, currency, description, plan, seat_quantity
       ) VALUES ($1, 'scheduled_change_cancelled', 0, $2, $3, $4, $5)`,
      [
        businessId,
        subDetails.billingCurrency,
        `Scheduled downgrade to ${subDetails.scheduledPlan || subDetails.plan} cancelled by owner`,
        subDetails.plan,
        subDetails.seatQuantity,
      ]
    );
  });
}

/**
 * Reconstructs subscription state by replaying all append-only ledger entries in sequence (BILL-010, BILL-025, AC-LED-01).
 */
export async function reconstructSubscriptionFromLedger(businessId: string): Promise<{
  plan: string;
  seatQuantity: number;
  totalPaidMinor: number;
  currency: string;
  entryCount: number;
}> {
  return await withTenantContext(businessId, async (client) => {
    const res = await client.query<{
      seq: string;
      type: string;
      amount_minor: string;
      currency: string;
      plan: string;
      seat_quantity: number;
    }>(
      `SELECT seq, type, amount_minor, currency, plan, seat_quantity
       FROM ledger_entries
       WHERE business_id = $1
       ORDER BY seq ASC`,
      [businessId]
    );

    let currentPlan = 'starter';
    let currentSeats = 5;
    let totalPaidMinor = 0;
    let currency = 'USD';

    for (const entry of res.rows) {
      currency = entry.currency;
      const amt = parseInt(entry.amount_minor, 10);

      if (entry.type === 'charge' || entry.type === 'renewal') {
        currentPlan = entry.plan;
        currentSeats = entry.seat_quantity;
        totalPaidMinor += amt;
      } else if (entry.type === 'reversal') {
        totalPaidMinor -= amt;
      }
    }

    return {
      plan: currentPlan,
      seatQuantity: currentSeats,
      totalPaidMinor,
      currency,
      entryCount: res.rows.length,
    };
  });
}

/**
 * Executes or simulates subscription renewal at period end (BILL-011, BILL-026, BILL-030).
 */
export async function processSubscriptionRenewal(params: {
  businessId: string;
  outcome?: 'success' | 'failure';
}): Promise<{
  status: string;
  plan: string;
  seatQuantity: number;
  periodStartDate: string;
  periodEndDate: string;
}> {
  const { businessId, outcome = 'success' } = params;

  return await withTenantContext(businessId, async (client) => {
    const subRes = await client.query<{
      plan: string;
      billing_currency: string;
      seat_quantity: number;
      status: string;
      period_start_date: string;
      period_end_date: string;
      anchor_day: number;
      scheduled_plan: string | null;
      scheduled_seat_quantity: number | null;
      past_due_since: Date | null;
    }>(
      `SELECT plan, billing_currency, seat_quantity, status,
              to_char(period_start_date, 'YYYY-MM-DD') as period_start_date,
              to_char(period_end_date, 'YYYY-MM-DD') as period_end_date,
              anchor_day, scheduled_plan, scheduled_seat_quantity, past_due_since
       FROM subscriptions
       WHERE business_id = $1
       FOR UPDATE`,
      [businessId]
    );

    const sub = subRes.rows[0];

    if (outcome === 'failure') {
      // Failed renewal: enters past_due at t0 (BILL-011)
      const pastDueSince = sub.past_due_since || new Date();
      await client.query(
        `UPDATE subscriptions
         SET status = 'past_due', past_due_since = $1
         WHERE business_id = $2`,
        [pastDueSince, businessId]
      );

      // Append ledger audit notice
      await client.query(
        `INSERT INTO ledger_entries (
           business_id, type, amount_minor, currency, description, plan, seat_quantity
         ) VALUES ($1, 'renewal_failed', 0, $2, 'Renewal payment failed at period end; subscription entered past_due grace period', $3, $4)`,
        [businessId, sub.billing_currency, sub.plan, sub.seat_quantity]
      );

      return {
        status: 'past_due',
        plan: sub.plan,
        seatQuantity: sub.seat_quantity,
        periodStartDate: sub.period_start_date,
        periodEndDate: sub.period_end_date,
      };
    }

    // Renewal Succeeded
    const effectivePlan = sub.scheduled_plan || sub.plan;
    const effectiveSeats = sub.scheduled_seat_quantity || sub.seat_quantity;
    const newPeriodStart = sub.period_end_date;
    const newPeriodEnd = calculateNextPeriodEndDate(newPeriodStart, sub.anchor_day);

    const renewalAmountUsd = calculateMonthlyCostUsd(effectivePlan, effectiveSeats);

    await client.query(
      `UPDATE subscriptions
       SET plan = $1, seat_quantity = $2,
           period_start_date = $3, period_end_date = $4,
           status = 'active', past_due_since = NULL,
           scheduled_plan = NULL, scheduled_seat_quantity = NULL,
           last_payment_at = NOW()
       WHERE business_id = $5`,
      [effectivePlan, effectiveSeats, newPeriodStart, newPeriodEnd, businessId]
    );

    // Append immutable renewal ledger entry
    await client.query(
      `INSERT INTO ledger_entries (
         business_id, type, amount_minor, currency, description, plan, seat_quantity
       ) VALUES ($1, 'renewal', $2, $3, $4, $5, $6)`,
      [
        businessId,
        renewalAmountUsd,
        sub.billing_currency,
        `Subscription renewed for period ${newPeriodStart} to ${newPeriodEnd}`,
        effectivePlan,
        effectiveSeats,
      ]
    );

    return {
      status: 'active',
      plan: effectivePlan,
      seatQuantity: effectiveSeats,
      periodStartDate: newPeriodStart,
      periodEndDate: newPeriodEnd,
    };
  });
}
