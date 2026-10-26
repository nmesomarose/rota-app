import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateBillingQuote,
  type BillingQuoteData,
  type SubscriptionData,
} from '../../mobile/src/services/billing-helpers.ts';

describe('Mobile Billing Zero-Amount Quotes & Plan State Evaluation', () => {
  const activeTeamSubscription: SubscriptionData = {
    plan: 'team',
    seatQuantity: 15,
    status: 'active',
    billingCurrency: 'NGN',
    activeSeatUsage: 9,
    admissionLimit: 15,
  };

  const activeBusinessSubscription: SubscriptionData = {
    plan: 'business',
    seatQuantity: 40,
    status: 'active',
    billingCurrency: 'USD',
    activeSeatUsage: 25,
    admissionLimit: 40,
  };

  it('1. Requirement 1: Displays exact message for unchanged, already-paid subscription with amountMinor = 0', () => {
    const quote: BillingQuoteData = {
      amountMinor: 0,
      currency: 'NGN',
      targetPlan: 'team',
      targetSeats: 15,
      deltaMonthlyUsd: 0,
    };

    const result = evaluateBillingQuote(quote, activeTeamSubscription);

    assert.strictEqual(result.isZeroAmount, true);
    assert.strictEqual(result.isUnchangedPaid, true);
    assert.strictEqual(result.isDowngrade, false);
    assert.strictEqual(result.isSeatReduction, false);
    assert.strictEqual(result.badgeType, 'success');
    assert.strictEqual(
      result.message,
      'Your current plan already covers these seats. No additional payment is required.'
    );
  });

  it('2. Requirement 2: Disables/hides Paystack checkout action for zero-amount quote', () => {
    const zeroQuote: BillingQuoteData = {
      amountMinor: 0,
      currency: 'NGN',
      targetPlan: 'team',
      targetSeats: 15,
    };

    const result = evaluateBillingQuote(zeroQuote, activeTeamSubscription);
    assert.strictEqual(result.canCheckout, false, 'Paystack checkout must not be allowed for 0 amount');
  });

  it('3. Requirement 3: Preserves normal Paystack checkout for positive amounts', () => {
    const positiveQuote: BillingQuoteData = {
      amountMinor: 9799100, // ₦97,991.00
      currency: 'NGN',
      targetPlan: 'business',
      targetSeats: 40,
      deltaMonthlyUsd: 7000,
    };

    const result = evaluateBillingQuote(positiveQuote, activeTeamSubscription);

    assert.strictEqual(result.isZeroAmount, false);
    assert.strictEqual(result.isUnchangedPaid, false);
    assert.strictEqual(result.canCheckout, true, 'Positive quotes must allow checkout');
    assert.strictEqual(result.message, '');
  });

  it('4. Requirement 4: Distinguishes unchanged subscriptions from scheduled plan downgrades', () => {
    // Current is Business (40 seats); quote target is Team (15 seats) with amountMinor = 0
    const downgradeQuote: BillingQuoteData = {
      amountMinor: 0,
      currency: 'USD',
      targetPlan: 'team',
      targetSeats: 15,
      deltaMonthlyUsd: -7000,
    };

    const result = evaluateBillingQuote(downgradeQuote, activeBusinessSubscription);

    assert.strictEqual(result.isZeroAmount, true);
    assert.strictEqual(result.isUnchangedPaid, false, 'Downgrades must NOT be labeled as unchanged already-paid');
    assert.strictEqual(result.isDowngrade, true);
    assert.strictEqual(result.isSeatReduction, false);
    assert.strictEqual(result.canCheckout, false);
    assert.strictEqual(result.badgeType, 'info');
    assert.ok(
      result.message.includes('Plan downgrades take effect at the end of the billing period'),
      'Must explain scheduled downgrade policy'
    );
  });

  it('5. Requirement 4: Distinguishes unchanged subscriptions from seat reductions on the same tier', () => {
    // Current is Team with 20 seats; quote target is Team with 15 seats with amountMinor = 0
    const teamWithExtraSeats: SubscriptionData = {
      plan: 'team',
      seatQuantity: 20,
      status: 'active',
      activeSeatUsage: 12,
    };

    const seatReductionQuote: BillingQuoteData = {
      amountMinor: 0,
      currency: 'NGN',
      targetPlan: 'team',
      targetSeats: 15,
      deltaMonthlyUsd: -1500,
    };

    const result = evaluateBillingQuote(seatReductionQuote, teamWithExtraSeats);

    assert.strictEqual(result.isZeroAmount, true);
    assert.strictEqual(result.isUnchangedPaid, false, 'Seat reduction must NOT be labeled as already covers these seats');
    assert.strictEqual(result.isSeatReduction, true);
    assert.strictEqual(result.isDowngrade, false);
    assert.strictEqual(result.canCheckout, false);
    assert.strictEqual(result.badgeType, 'info');
    assert.ok(
      result.message.includes('Seat reductions take effect at the next renewal period'),
      'Must explain seat reduction renewal policy'
    );
  });

  it('6. Does not label inactive/unpaid subscription as already-paid', () => {
    const inactiveSubscription: SubscriptionData = {
      plan: 'team',
      seatQuantity: 15,
      status: 'past_due',
    };

    const quote: BillingQuoteData = {
      amountMinor: 0,
      currency: 'NGN',
      targetPlan: 'team',
      targetSeats: 15,
    };

    const result = evaluateBillingQuote(quote, inactiveSubscription);

    assert.strictEqual(result.isUnchangedPaid, false, 'Past-due or unpaid subscription must not be labeled already-paid');
    assert.strictEqual(result.canCheckout, false);
  });

  it('7. Handles null or undefined quote gracefully', () => {
    const result = evaluateBillingQuote(null, activeTeamSubscription);
    assert.strictEqual(result.isZeroAmount, false);
    assert.strictEqual(result.canCheckout, false);
    assert.strictEqual(result.message, '');
  });

  it('8. BillingScreen.tsx static check: confirms evaluateBillingQuote integration and button guard', () => {
    const billingScreenPath = path.resolve(process.cwd(), 'mobile/src/screens/BillingScreen.tsx');
    const content = fs.readFileSync(billingScreenPath, 'utf8');

    assert.ok(
      content.includes('evaluateBillingQuote'),
      'BillingScreen.tsx must import and use evaluateBillingQuote'
    );
    assert.ok(
      content.includes('quoteAnalysis.isZeroAmount'),
      'BillingScreen.tsx must check quoteAnalysis.isZeroAmount to conditionally display notice'
    );
    assert.ok(
      content.includes('Proceed to Hosted Checkout'),
      'BillingScreen.tsx must preserve normal checkout button'
    );
  });
});
