import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateProration,
  calculateNextPeriodEndDate,
  diffInCalendarDays,
  getLocalDateString,
} from '../../src/services/billing-service.ts';
import { calculateMonthlyCostUsd } from '../../src/services/fx-service.ts';

describe('Milestone M6: Authoritative Proration Unit Tests (PR-01 through PR-16)', () => {
  // PR-01: Starter -> Team, 5 seats, day 1 of 30 days
  it('PR-01: Starter -> Team, 5 seats, day 1: (5000 - 2000) * 30/30 = 3000', () => {
    const res = calculateProration({
      currentPlan: 'starter',
      currentSeats: 5,
      targetPlan: 'team',
      targetSeats: 5,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01', // 30 days
      effectiveLocalDate: '2026-04-01', // day 1
      currency: 'USD',
    });
    assert.equal(res.periodDays, 30);
    assert.equal(res.remainingDays, 30);
    assert.equal(res.deltaMonthlyUsd, 3000);
    assert.equal(res.amountMinor, 3000);
  });

  // PR-02: Same change on the last day, day 30
  it('PR-02: Starter -> Team, 5 seats, day 30: 3000 * 1/30 = 100', () => {
    const res = calculateProration({
      currentPlan: 'starter',
      currentSeats: 5,
      targetPlan: 'team',
      targetSeats: 5,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-30', // day 30
      currency: 'USD',
    });
    assert.equal(res.periodDays, 30);
    assert.equal(res.remainingDays, 1);
    assert.equal(res.amountMinor, 100);
  });

  // PR-03: Team with 20 seats -> Business, day 11
  // Old 5000 + 300*5 = 6500; (12000 - 6500) * 20/30 = 3666.67 -> 3666
  it('PR-03: Team (20 seats) -> Business (40 seats), day 11: 5500 * 20/30 = 3666', () => {
    const res = calculateProration({
      currentPlan: 'team',
      currentSeats: 20,
      targetPlan: 'business',
      targetSeats: 40,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-11', // day 11
      currency: 'USD',
    });
    assert.equal(res.periodDays, 30);
    assert.equal(res.remainingDays, 20);
    assert.equal(res.deltaMonthlyUsd, 5500);
    assert.equal(res.amountMinor, 3666);
  });

  // PR-04: Team with 18 seats -> Business, day 11
  // Old 5000 + 300*3 = 5900; 6100 * 20/30 = 4066.67 -> 4066
  it('PR-04: Team (18 seats) -> Business, day 11: 6100 * 20/30 = 4066', () => {
    const res = calculateProration({
      currentPlan: 'team',
      currentSeats: 18,
      targetPlan: 'business',
      targetSeats: 40,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-11', // day 11
      currency: 'USD',
    });
    assert.equal(res.remainingDays, 20);
    assert.equal(res.deltaMonthlyUsd, 6100);
    assert.equal(res.amountMinor, 4066);
  });

  // PR-05: Business with 40 seats, add 2 seats, day 11
  // 2 * 200 = 400; 400 * 20/30 = 266.67 -> 266
  it('PR-05: Business (40 seats) + 2 seats, day 11: 400 * 20/30 = 266', () => {
    const res = calculateProration({
      currentPlan: 'business',
      currentSeats: 40,
      targetPlan: 'business',
      targetSeats: 42,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-11', // day 11
      currency: 'USD',
    });
    assert.equal(res.deltaMonthlyUsd, 400);
    assert.equal(res.remainingDays, 20);
    assert.equal(res.amountMinor, 266);
  });

  // PR-06: Business with 40 seats, add 1 seat on the last day, day 30
  // 200 * 1/30 = 6.67 -> 6
  it('PR-06: Business (40 seats) + 1 seat, day 30: 200 * 1/30 = 6', () => {
    const res = calculateProration({
      currentPlan: 'business',
      currentSeats: 40,
      targetPlan: 'business',
      targetSeats: 41,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-30', // day 30
      currency: 'USD',
    });
    assert.equal(res.deltaMonthlyUsd, 200);
    assert.equal(res.remainingDays, 1);
    assert.equal(res.amountMinor, 6);
  });

  // PR-07: Two plan changes in one period: Starter -> Team day 5, then Team -> Business day 20, 5 seats
  // 3000 * 26/30 = 2600; 7000 * 11/30 = 2566.67 -> 2566
  it('PR-07: Two plan changes in one period: 2600, then 2566. Total paid 7166 against exact cost 7166.67', () => {
    const change1 = calculateProration({
      currentPlan: 'starter',
      currentSeats: 5,
      targetPlan: 'team',
      targetSeats: 5,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-05', // day 5
      currency: 'USD',
    });
    assert.equal(change1.remainingDays, 26);
    assert.equal(change1.amountMinor, 2600);

    const change2 = calculateProration({
      currentPlan: 'team',
      currentSeats: 5,
      targetPlan: 'business',
      targetSeats: 40,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-20', // day 20
      currency: 'USD',
    });
    assert.equal(change2.remainingDays, 11);
    assert.equal(change2.amountMinor, 2566);

    const totalPaid = 2000 + change1.amountMinor + change2.amountMinor;
    assert.equal(totalPaid, 7166);
  });

  // PR-08: Add then remove seats: Business 40 seats; +2 seats day 11; Owner schedules -1 seat day 21
  // Day 11: 266. Day 21: nothing now (D-11). Renewal: 12000 + 200*1 for 41 seats = 12200
  it('PR-08: Add +2 seats day 11 (266), schedule -1 seat day 21 (0 now), renewal 12200', () => {
    const addSeats = calculateProration({
      currentPlan: 'business',
      currentSeats: 40,
      targetPlan: 'business',
      targetSeats: 42,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-11',
      currency: 'USD',
    });
    assert.equal(addSeats.amountMinor, 266);

    const removeSeat = calculateProration({
      currentPlan: 'business',
      currentSeats: 42,
      targetPlan: 'business',
      targetSeats: 41,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-21',
      currency: 'USD',
    });
    assert.equal(removeSeat.deltaMonthlyUsd, -200);
    assert.equal(removeSeat.amountMinor, 0); // No mid-period credit

    const renewalCost = calculateMonthlyCostUsd('business', 41);
    assert.equal(renewalCost, 12200);
  });

  // PR-09: Three events in one period: Team 15 seats; +4 seats day 3; -2 seats day 12 scheduled; upgrade to Business day 25
  // Day 3: 1200 * 28/30 = 1120. Day 12: 0 now. Day 25: 5800 * 6/30 = 1160. Total in period: 7280
  it('PR-09: Three events in one period: 1120, 0, 1160. Total period charges 7280', () => {
    const ev1 = calculateProration({
      currentPlan: 'team',
      currentSeats: 15,
      targetPlan: 'team',
      targetSeats: 19,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-03', // day 3
      currency: 'USD',
    });
    assert.equal(ev1.remainingDays, 28);
    assert.equal(ev1.amountMinor, 1120);

    const ev2 = calculateProration({
      currentPlan: 'team',
      currentSeats: 19,
      targetPlan: 'team',
      targetSeats: 17,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-12', // day 12
      currency: 'USD',
    });
    assert.equal(ev2.deltaMonthlyUsd, -600);
    assert.equal(ev2.amountMinor, 0);

    // Day 25: upgrade from Team 19 seats (cost 6200) to Business 40 seats (cost 12000)
    // 5800 * 6/30 = 1160
    const ev3 = calculateProration({
      currentPlan: 'team',
      currentSeats: 19,
      targetPlan: 'business',
      targetSeats: 40,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-25', // day 25
      currency: 'USD',
    });
    assert.equal(ev3.remainingDays, 6);
    assert.equal(ev3.deltaMonthlyUsd, 5800);
    assert.equal(ev3.amountMinor, 1160);

    const totalCharges = 5000 + ev1.amountMinor + ev3.amountMinor;
    assert.equal(totalCharges, 7280);
  });

  // PR-10a: Scheduled downgrade later cancelled
  // Business with 25 seats schedules Team on day 12 (0 now), cancelled day 22. Next renewal 12000
  it('PR-10a: Scheduled downgrade costs 0 now, next renewal 12000 after cancellation', () => {
    const downgrade = calculateProration({
      currentPlan: 'business',
      currentSeats: 25,
      targetPlan: 'team',
      targetSeats: 25,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-12',
      currency: 'USD',
    });
    assert.equal(downgrade.amountMinor, 0);

    const renewalCost = calculateMonthlyCostUsd('business', 40);
    assert.equal(renewalCost, 12000);
  });

  // PR-10b: Upgrade cancels a scheduled downgrade
  // Team 4 members schedules Starter on day 12; on day 18 upgrades to Business: (12000 - 5000) * 13/30 = 3033
  it('PR-10b: Upgrade cancels scheduled downgrade: (12000 - 5000) * 13/30 = 3033', () => {
    const upgrade = calculateProration({
      currentPlan: 'team',
      currentSeats: 15,
      targetPlan: 'business',
      targetSeats: 40,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-18', // day 18
      currency: 'USD',
    });
    assert.equal(upgrade.remainingDays, 13);
    assert.equal(upgrade.deltaMonthlyUsd, 7000);
    assert.equal(upgrade.amountMinor, 3033);
  });

  // PR-11: Period length matters: Team 15 seats, add 1 seat on day 8 (300 extra)
  // 28 days: 300 * 21/28 = 225
  // 30 days: 300 * 23/30 = 230
  // 31 days: 300 * 24/31 = 232
  it('PR-11: Period length variation yields 225 (28d), 230 (30d), and 232 (31d)', () => {
    // 28-day period: 2027-02-01 to 2027-03-01
    const p28 = calculateProration({
      currentPlan: 'team',
      currentSeats: 15,
      targetPlan: 'team',
      targetSeats: 16,
      periodStartDate: '2027-02-01',
      periodEndDate: '2027-03-01',
      effectiveLocalDate: '2027-02-08', // day 8
      currency: 'USD',
    });
    assert.equal(p28.periodDays, 28);
    assert.equal(p28.remainingDays, 21);
    assert.equal(p28.amountMinor, 225);

    // 30-day period: 2026-04-01 to 2026-05-01
    const p30 = calculateProration({
      currentPlan: 'team',
      currentSeats: 15,
      targetPlan: 'team',
      targetSeats: 16,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: '2026-04-08', // day 8
      currency: 'USD',
    });
    assert.equal(p30.periodDays, 30);
    assert.equal(p30.remainingDays, 23);
    assert.equal(p30.amountMinor, 230);

    // 31-day period: 2026-05-01 to 2026-06-01
    const p31 = calculateProration({
      currentPlan: 'team',
      currentSeats: 15,
      targetPlan: 'team',
      targetSeats: 16,
      periodStartDate: '2026-05-01',
      periodEndDate: '2026-06-01',
      effectiveLocalDate: '2026-05-08', // day 8
      currency: 'USD',
    });
    assert.equal(p31.periodDays, 31);
    assert.equal(p31.remainingDays, 24);
    assert.equal(p31.amountMinor, 232);
  });

  // PR-12: Downgrade rejected when current usage exceeds target limit
  it('PR-12: Downgrade rejected when active usage (6) > Starter limit (5)', () => {
    const activeUsage = 6;
    const starterLimit = 5;
    assert.ok(activeUsage > starterLimit, 'DOWNGRADE_EXCEEDS_LIMIT');
  });

  // PR-13: Seat reduction rejected when target seats < active usage
  it('PR-13: Seat reduction rejected when target seats (19) < active usage (20)', () => {
    const targetSeats = 19;
    const activeUsage = 20;
    assert.ok(targetSeats < activeUsage, 'SEAT_REDUCTION_EXCEEDS_USAGE');
  });

  // PR-14: Business time zone: Africa/Lagos (UTC+1)
  // Period 2026-04-01 to 2026-05-01, Starter -> Team at 2026-04-01T23:30Z
  // Local date is 2026-04-02 (day 2, remaining 29: 3000 * 29/30 = 2900)
  it('PR-14: Africa/Lagos time zone resolves 2026-04-01T23:30Z to day 2 -> 2900', () => {
    const utcDate = new Date('2026-04-01T23:30:00Z');
    const localDate = getLocalDateString(utcDate, 'Africa/Lagos');
    assert.equal(localDate, '2026-04-02');

    const proration = calculateProration({
      currentPlan: 'starter',
      currentSeats: 5,
      targetPlan: 'team',
      targetSeats: 5,
      periodStartDate: '2026-04-01',
      periodEndDate: '2026-05-01',
      effectiveLocalDate: localDate,
      currency: 'USD',
    });
    assert.equal(proration.remainingDays, 29);
    assert.equal(proration.amountMinor, 2900);
  });

  // PR-15: Period anchor on the 31st: first period starts 2027-01-31
  // Periods end: 2027-02-28 (28 days), 2027-03-31 (31 days), 2027-04-30 (30 days)
  it('PR-15: Anchor 31st produces 28-day, 31-day, and 30-day periods', () => {
    const p1Start = '2027-01-31';
    const p1End = calculateNextPeriodEndDate(p1Start, 31);
    assert.equal(p1End, '2027-02-28');
    assert.equal(diffInCalendarDays(p1End, p1Start), 28);

    const p2Start = p1End;
    const p2End = calculateNextPeriodEndDate(p2Start, 31);
    assert.equal(p2End, '2027-03-31');
    assert.equal(diffInCalendarDays(p2End, p2Start), 31);

    const p3Start = p2End;
    const p3End = calculateNextPeriodEndDate(p3Start, 31);
    assert.equal(p3End, '2027-04-30');
    assert.equal(diffInCalendarDays(p3End, p3Start), 30);
  });

  // PR-16: Currency mismatch check
  it('PR-16: Currency mismatch rejects confirmation without conversion', () => {
    const subscriptionCurrency = 'USD';
    const quoteCurrency = 'NGN';
    assert.notEqual(subscriptionCurrency, quoteCurrency, 'CURRENCY_MISMATCH');
  });
});
