import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateQuietHours,
  isUrgentNotification,
  normalizeCategory,
  getUtcDateFromLocal,
} from '../../src/utils/quiet-hours.ts';

describe('Quiet Hours & Urgency Evaluation Unit Tests', () => {
  it('normalizes notification categories correctly', () => {
    assert.equal(normalizeCategory('shift'), 'shifts');
    assert.equal(normalizeCategory('shifts'), 'shifts');
    assert.equal(normalizeCategory('swap'), 'swaps');
    assert.equal(normalizeCategory('attendance'), 'attendance');
    assert.equal(normalizeCategory('billing'), 'billing');
    assert.equal(normalizeCategory('security'), 'security');
    assert.equal(normalizeCategory('unknown'), 'unknown');
  });

  describe('evaluateQuietHours - Overnight Windows (e.g. 22:00 to 07:00)', () => {
    const quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };

    it('identifies in-quiet-hours in the late evening (before midnight)', () => {
      // 23:30 UTC
      const now = new Date('2026-05-15T23:30:00Z');
      const res = evaluateQuietHours(now, 'UTC', quietHours);

      assert.equal(res.inQuietHours, true);
      assert.ok(res.delayMs > 0);
      assert.ok(res.endsAt);
      // Ends at 07:00 next day UTC (7.5 hours from 23:30)
      assert.equal(res.endsAt.toISOString(), '2026-05-16T07:00:00.000Z');
      assert.equal(res.delayMs, 7.5 * 60 * 60 * 1000);
    });

    it('identifies in-quiet-hours in the early morning (after midnight)', () => {
      // 04:15 UTC
      const now = new Date('2026-05-16T04:15:00Z');
      const res = evaluateQuietHours(now, 'UTC', quietHours);

      assert.equal(res.inQuietHours, true);
      assert.ok(res.delayMs > 0);
      assert.ok(res.endsAt);
      // Ends at 07:00 today UTC (2 hours 45 mins from 04:15)
      assert.equal(res.endsAt.toISOString(), '2026-05-16T07:00:00.000Z');
      assert.equal(res.delayMs, 2.75 * 60 * 60 * 1000);
    });

    it('identifies outside quiet-hours during daytime', () => {
      // 14:00 UTC
      const now = new Date('2026-05-16T14:00:00Z');
      const res = evaluateQuietHours(now, 'UTC', quietHours);

      assert.equal(res.inQuietHours, false);
      assert.equal(res.delayMs, 0);
    });

    it('handles exact boundary conditions at start and end', () => {
      // Exactly 22:00:00 -> IN quiet hours
      const atStart = new Date('2026-05-16T22:00:00Z');
      const resStart = evaluateQuietHours(atStart, 'UTC', quietHours);
      assert.equal(resStart.inQuietHours, true);

      // Exactly 07:00:00 -> OUT of quiet hours (quiet hours ended)
      const atEnd = new Date('2026-05-16T07:00:00Z');
      const resEnd = evaluateQuietHours(atEnd, 'UTC', quietHours);
      assert.equal(resEnd.inQuietHours, false);
      assert.equal(resEnd.delayMs, 0);
    });
  });

  describe('evaluateQuietHours - Same-day Windows (e.g. 01:00 to 06:00)', () => {
    const quietHours = {
      enabled: true,
      start: '01:00',
      end: '06:00',
    };

    it('identifies in-quiet-hours within same day window', () => {
      const now = new Date('2026-05-16T03:30:00Z');
      const res = evaluateQuietHours(now, 'UTC', quietHours);

      assert.equal(res.inQuietHours, true);
      assert.equal(res.endsAt?.toISOString(), '2026-05-16T06:00:00.000Z');
      assert.equal(res.delayMs, 2.5 * 60 * 60 * 1000);
    });

    it('identifies outside same day window', () => {
      const now = new Date('2026-05-16T20:00:00Z');
      const res = evaluateQuietHours(now, 'UTC', quietHours);

      assert.equal(res.inQuietHours, false);
      assert.equal(res.delayMs, 0);
    });
  });

  describe('evaluateQuietHours - Timezone & Boundary Differences', () => {
    const quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };

    it('correctly shifts quiet hours based on recipient time zone', () => {
      // 03:00 UTC
      // In Europe/London (BST = UTC+1 in July): local time is 04:00 (IN quiet hours: 22:00-07:00)
      // In America/New_York (EDT = UTC-4 in July): local time is 23:00 previous day (IN quiet hours: 22:00-07:00)
      // In Asia/Tokyo (JST = UTC+9 all year): local time is 12:00 noon (NOT in quiet hours)
      const now = new Date('2026-07-15T03:00:00Z');

      const resLondon = evaluateQuietHours(now, 'Europe/London', quietHours);
      assert.equal(resLondon.inQuietHours, true, 'London should be in quiet hours at 04:00 BST');

      const resNY = evaluateQuietHours(now, 'America/New_York', quietHours);
      assert.equal(resNY.inQuietHours, true, 'New York should be in quiet hours at 23:00 EDT');

      const resTokyo = evaluateQuietHours(now, 'Asia/Tokyo', quietHours);
      assert.equal(resTokyo.inQuietHours, false, 'Tokyo should NOT be in quiet hours at 12:00 JST');
    });

    it('safely falls back to UTC if timezone is invalid or unrecognized', () => {
      const now = new Date('2026-05-16T23:00:00Z');
      const res = evaluateQuietHours(now, 'Invalid/NonExistent_Zone', quietHours);

      assert.equal(res.inQuietHours, true);
      assert.equal(res.endsAt?.toISOString(), '2026-05-17T07:00:00.000Z');
    });

    it('safely returns false when quiet hours is disabled or start === end', () => {
      const now = new Date('2026-05-16T23:00:00Z');
      const disabledRes = evaluateQuietHours(now, 'UTC', { ...quietHours, enabled: false });
      assert.equal(disabledRes.inQuietHours, false);

      const equalRes = evaluateQuietHours(now, 'UTC', { enabled: true, start: '08:00', end: '08:00' });
      assert.equal(equalRes.inQuietHours, false);
    });
  });

  describe('isUrgentNotification (FR-NOT-008, AC-NOT-01, AC-FR-02)', () => {
    const fixedNow = new Date('2026-05-16T10:00:00Z');

    it('flags shift starting within 12 hours as urgent (e.g. 4 hours away)', () => {
      const startsAt = new Date('2026-05-16T14:00:00Z');
      const isUrgent = isUrgentNotification({
        category: 'shifts',
        startsAt,
        now: fixedNow,
      });
      assert.equal(isUrgent, true);
    });

    it('flags shift starting 13 hours away as non-urgent (AC-NOT-01)', () => {
      const startsAt = new Date('2026-05-16T23:00:00Z'); // 13 hours away
      const isUrgent = isUrgentNotification({
        category: 'shifts',
        startsAt,
        now: fixedNow,
      });
      assert.equal(isUrgent, false, 'A shift 13 hours away must be deferred');
    });

    it('flags shift change as urgent if new start is within 12 hours even if old was 15 hours away', () => {
      const oldStartsAt = new Date('2026-05-17T01:00:00Z'); // 15h away
      const newStartsAt = new Date('2026-05-16T16:00:00Z'); // 6h away
      const isUrgent = isUrgentNotification({
        category: 'shifts',
        oldStartsAt,
        newStartsAt,
        now: fixedNow,
      });
      assert.equal(isUrgent, true);
    });

    it('flags shift change as urgent if old start was within 12 hours (e.g. cancelled/rescheduled near start)', () => {
      const oldStartsAt = new Date('2026-05-16T14:00:00Z'); // 4h away
      const newStartsAt = new Date('2026-05-18T10:00:00Z'); // 48h away
      const isUrgent = isUrgentNotification({
        category: 'shifts',
        oldStartsAt,
        newStartsAt,
        now: fixedNow,
      });
      assert.equal(isUrgent, true);
    });

    it('flags failed renewal notices to owners as urgent (AC-FR-02)', () => {
      const isUrgent = isUrgentNotification({
        category: 'billing',
        isFailedRenewal: true,
        now: fixedNow,
      });
      assert.equal(isUrgent, true);
    });
  });
});
