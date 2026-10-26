/**
 * Billing Quote Analysis and UI Helpers for Mobile
 *
 * Implements business logic for determining quote status, distinguishing unchanged
 * paid subscriptions from scheduled downgrades and seat reductions, and controlling
 * checkout button behavior.
 */

export interface BillingQuoteData {
  id?: string;
  currency?: string;
  amountMinor: number;
  baseUsdAmountMinor?: number;
  fxRate?: number | null;
  targetPlan: string;
  targetSeats: number;
  deltaMonthlyUsd?: number;
  expiresAt?: string | Date;
}

export interface SubscriptionData {
  plan: string;
  seatQuantity: number;
  status?: string;
  billingCurrency?: string;
  scheduledPlan?: string | null;
  scheduledSeatQuantity?: number | null;
  activeSeatUsage?: number;
  admissionLimit?: number;
}

export interface ZeroQuoteExplanation {
  isZeroAmount: boolean;
  isUnchangedPaid: boolean;
  isDowngrade: boolean;
  isSeatReduction: boolean;
  canCheckout: boolean;
  message: string;
  badgeType: 'success' | 'info' | 'warning' | 'none';
}

/**
 * Evaluates a billing quote against the current subscription state.
 *
 * PRD Requirements:
 * 1. amountMinor = 0 for unchanged, already-paid subscription displays:
 *    "Your current plan already covers these seats. No additional payment is required."
 * 2. Hides/disables Paystack checkout action for zero-amount quotes.
 * 3. Preserves normal checkout for positive amounts.
 * 4. Distinguishes unchanged subscriptions from scheduled downgrades or seat reductions.
 *    Does not incorrectly label every ₦0 quote as already paid.
 */
export function evaluateBillingQuote(
  quote: BillingQuoteData | null | undefined,
  subscription: SubscriptionData | null | undefined
): ZeroQuoteExplanation {
  if (!quote) {
    return {
      isZeroAmount: false,
      isUnchangedPaid: false,
      isDowngrade: false,
      isSeatReduction: false,
      canCheckout: false,
      message: '',
      badgeType: 'none',
    };
  }

  // Positive amounts: normal checkout path
  if (quote.amountMinor > 0) {
    return {
      isZeroAmount: false,
      isUnchangedPaid: false,
      isDowngrade: false,
      isSeatReduction: false,
      canCheckout: true,
      message: '',
      badgeType: 'none',
    };
  }

  const currentPlan = (subscription?.plan || '').toLowerCase();
  const targetPlan = (quote.targetPlan || '').toLowerCase();
  const currentSeats = subscription?.seatQuantity ?? 0;
  const targetSeats = quote.targetSeats;
  const isPaidActive = subscription?.status === 'active';

  const isSamePlan = Boolean(currentPlan && targetPlan && currentPlan === targetPlan);
  const isSameSeats = targetSeats === currentSeats;

  // 1. Unchanged, already-paid subscription
  if (isSamePlan && isSameSeats && isPaidActive) {
    return {
      isZeroAmount: true,
      isUnchangedPaid: true,
      isDowngrade: false,
      isSeatReduction: false,
      canCheckout: false,
      message: 'Your current plan already covers these seats. No additional payment is required.',
      badgeType: 'success',
    };
  }

  // 2. Plan downgrade (lower tier plan e.g. business -> team, team -> starter)
  const planHierarchy: Record<string, number> = {
    starter: 1,
    team: 2,
    business: 3,
  };
  const currentTier = planHierarchy[currentPlan] ?? 0;
  const targetTier = planHierarchy[targetPlan] ?? 0;

  if (targetTier < currentTier) {
    return {
      isZeroAmount: true,
      isUnchangedPaid: false,
      isDowngrade: true,
      isSeatReduction: false,
      canCheckout: false,
      message: 'Plan downgrades take effect at the end of the billing period with no immediate credit. Use Scheduled Downgrade below.',
      badgeType: 'info',
    };
  }

  // 3. Seat reduction on the same tier (e.g. 20 seats -> 15 seats on Team)
  if (isSamePlan && targetSeats < currentSeats) {
    return {
      isZeroAmount: true,
      isUnchangedPaid: false,
      isDowngrade: false,
      isSeatReduction: true,
      canCheckout: false,
      message: 'Seat reductions take effect at the next renewal period with no immediate credit.',
      badgeType: 'info',
    };
  }

  // 4. Other zero-charge changes (e.g. inactive subscription, trial, or deltaMonthly <= 0)
  return {
    isZeroAmount: true,
    isUnchangedPaid: false,
    isDowngrade: false,
    isSeatReduction: false,
    canCheckout: false,
    message: 'No additional payment is required for this configuration.',
    badgeType: 'info',
  };
}
