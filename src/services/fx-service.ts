/**
 * Foreign Exchange (FX) Service
 * PRD Reference: 8.1, 8.12, 19.5, DR-01, AC-FX-01..06
 *
 * Implements deterministic FX rate fixtures, freshness validation (30-minute threshold),
 * base USD pricing schedules, and server-authoritative NGN conversion.
 */

export interface PlanDefinition {
  id: 'starter' | 'team' | 'business';
  name: string;
  basePriceMinor: number; // in USD cents (e.g. 2000 = $20.00)
  includedSeats: number;
  maxSeats: number | null; // Starter capped at 5; Team/Business have no hard cap
  extraSeatPriceMinor: number; // in USD cents (e.g. 300 = $3.00)
}

export const PLANS: Record<string, PlanDefinition> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    basePriceMinor: 2000,
    includedSeats: 5,
    maxSeats: 5,
    extraSeatPriceMinor: 0,
  },
  team: {
    id: 'team',
    name: 'Team',
    basePriceMinor: 5000,
    includedSeats: 15,
    maxSeats: null,
    extraSeatPriceMinor: 300,
  },
  business: {
    id: 'business',
    name: 'Business',
    basePriceMinor: 12000,
    includedSeats: 40,
    maxSeats: null,
    extraSeatPriceMinor: 200,
  },
};

/**
 * Calculates authoritative monthly cost in USD minor units (cents) for a plan and seat quantity.
 * PRD 8.1: cost(plan, q) = base(plan) + extra_rate(plan) * max(0, q - included(plan))
 * Starter is always 5 seats. Cost uses purchased seat quantity, never current usage.
 */
export function calculateMonthlyCostUsd(planKey: string, seatQuantity: number): number {
  const plan = PLANS[planKey.toLowerCase()];
  if (!plan) {
    throw new Error(`Unknown plan: ${planKey}`);
  }
  const q = plan.id === 'starter' ? 5 : seatQuantity;
  const extraSeats = Math.max(0, q - plan.includedSeats);
  return plan.basePriceMinor + extraSeats * plan.extraSeatPriceMinor;
}

export interface FxRateResult {
  rate: number;
  source: string;
  retrievedAt: Date;
  isStale: boolean;
  currency: string;
}

// Global test fixture state for deterministic simulation (AC-FX-06)
let isManualOverride = false;

let testFxFixtureState: {
  rate: number;
  source: string;
  retrievedAt: Date;
  unavailable: boolean;
} = {
  rate: 1550.0,
  source: 'cbn_indicative_fixture',
  retrievedAt: new Date(),
  unavailable: false,
};

/**
 * Configure FX fixture state for automated testing (AC-FX-03, AC-FX-06).
 */
export function setFxFixtureState(state: Partial<typeof testFxFixtureState>): void {
  isManualOverride = true;
  testFxFixtureState = {
    ...testFxFixtureState,
    ...state,
  };
}

/**
 * Reset FX fixture state to default deterministic fixture.
 */
export function resetFxFixtureState(): void {
  isManualOverride = false;
  testFxFixtureState = {
    rate: 1550.0,
    source: 'cbn_indicative_fixture',
    retrievedAt: new Date(),
    unavailable: false,
  };
}

/**
 * Manually refresh the indicative FX fixture timestamp.
 */
export function refreshFxFixture(): void {
  isManualOverride = false;
  testFxFixtureState.retrievedAt = new Date();
  testFxFixtureState.unavailable = false;
}

const FX_STALENESS_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes (AC-FX-03)

/**
 * Retrieves the current FX rate for the requested currency.
 * Throws an error if the rate is unavailable or exceeds freshness threshold (AC-FX-03).
 */
export async function getFxRate(targetCurrency: string = 'NGN'): Promise<FxRateResult> {
  if (targetCurrency.toUpperCase() === 'USD') {
    return {
      rate: 1.0,
      source: 'base_usd',
      retrievedAt: new Date(),
      isStale: false,
      currency: 'USD',
    };
  }

  if (targetCurrency.toUpperCase() !== 'NGN') {
    throw new Error(`Unsupported currency: ${targetCurrency}`);
  }

  if (testFxFixtureState.unavailable) {
    throw new Error('FX_SOURCE_UNAVAILABLE');
  }

  const now = Date.now();
  // Auto-refresh the indicative fixture timestamp during runtime if not manually overridden by a test (AC-FX-03, AC-FX-06)
  if (!isManualOverride && (now - testFxFixtureState.retrievedAt.getTime()) > 15 * 60 * 1000) {
    testFxFixtureState.retrievedAt = new Date(now);
  }

  const rateAge = now - testFxFixtureState.retrievedAt.getTime();
  const isStale = rateAge > FX_STALENESS_THRESHOLD_MS;

  if (isStale) {
    throw new Error('FX_RATE_STALE');
  }

  return {
    rate: testFxFixtureState.rate,
    source: testFxFixtureState.source,
    retrievedAt: testFxFixtureState.retrievedAt,
    isStale: false,
    currency: 'NGN',
  };
}

/**
 * Converts a USD minor amount (cents) to NGN minor amount (kobo) using the provided rate.
 * Server-authoritative integer arithmetic (AC-FX-01, AC-FX-02).
 */
export function convertUsdToNgn(usdAmountMinor: number, fxRate: number): number {
  return Math.floor(usdAmountMinor * fxRate);
}
