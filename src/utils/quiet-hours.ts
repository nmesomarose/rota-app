export interface QuietHoursSettings {
  enabled: boolean;
  start: string; // HH:mm (24-hour)
  end: string;   // HH:mm (24-hour)
}

export interface QuietHoursResult {
  inQuietHours: boolean;
  delayMs: number;
  endsAt?: Date;
}

export interface NotificationUrgencyParams {
  category: string;
  isUrgent?: boolean;
  startsAt?: Date | string | null;
  oldStartsAt?: Date | string | null;
  newStartsAt?: Date | string | null;
  isFailedRenewal?: boolean;
  now?: Date;
}

/**
 * Normalizes notification category string to standard category key.
 * PRD categories: shifts, swaps, approvals, attendance, billing, security.
 */
export function normalizeCategory(category: string): string {
  const c = (category || '').toLowerCase().trim();
  if (c === 'shift' || c === 'shifts') return 'shifts';
  if (c === 'swap' || c === 'swaps') return 'swaps';
  if (c === 'approval' || c === 'approvals') return 'approvals';
  if (c === 'attendance') return 'attendance';
  if (c === 'billing') return 'billing';
  if (c === 'security') return 'security';
  return c;
}

/**
 * Extracts zoned date and time components using Intl.DateTimeFormat.
 */
function getZonedParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const partMap: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      partMap[p.type] = parseInt(p.value, 10);
    }
  }

  return {
    year: partMap.year ?? date.getUTCFullYear(),
    month: partMap.month ?? date.getUTCMonth() + 1, // 1-12
    day: partMap.day ?? date.getUTCDate(),
    hour: (partMap.hour ?? 0) % 24,
    minute: partMap.minute ?? 0,
    second: partMap.second ?? 0,
  };
}

/**
 * Converts a target local date/time in a specific IANA time zone to the exact UTC Date.
 * Handles DST boundaries and time zone offsets.
 */
export function getUtcDateFromLocal(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const desiredLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let targetUtc = desiredLocalAsUtc;

  // First approximation
  const p1 = getZonedParts(new Date(targetUtc), timeZone);
  const p1LocalAsUtc = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second);
  const offset1 = p1LocalAsUtc - targetUtc;
  targetUtc = desiredLocalAsUtc - offset1;

  // Second refinement for DST boundaries
  const p2 = getZonedParts(new Date(targetUtc), timeZone);
  const p2LocalAsUtc = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
  const diff = p2LocalAsUtc - desiredLocalAsUtc;
  if (diff !== 0) {
    targetUtc -= diff;
  }

  return new Date(targetUtc);
}

/**
 * Evaluates whether `now` falls within the user's quiet hours in their time zone,
 * and calculates the exact millisecond delay until quiet hours end.
 *
 * Requirements:
 * - FR-NOT-007: Quiet hours use the user's server-stored time zone; non-urgent push is deferred.
 * - AC-016: Quiet hours defer non-urgent pushes using the stored time zone.
 * - Handles overnight windows crossing midnight (e.g. 22:00 to 07:00).
 * - Handles timezone and DST transitions.
 * - Missing or invalid settings fall back safely to immediate delivery (not in quiet hours).
 */
export function evaluateQuietHours(
  now: Date,
  timeZone: string | undefined | null,
  quietHours: QuietHoursSettings | undefined | null
): QuietHoursResult {
  if (!quietHours || !quietHours.enabled) {
    return { inQuietHours: false, delayMs: 0 };
  }

  const { start, end } = quietHours;
  if (!start || !end || start === end) {
    return { inQuietHours: false, delayMs: 0 };
  }

  // Fallback to UTC if timezone is missing or invalid
  let validTimeZone = 'UTC';
  if (timeZone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone });
      validTimeZone = timeZone;
    } catch {
      validTimeZone = 'UTC';
    }
  }

  const [startH, startM] = start.split(':').map((v) => parseInt(v, 10));
  const [endH, endM] = end.split(':').map((v) => parseInt(v, 10));

  if (
    isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM) ||
    startH < 0 || startH > 23 || startM < 0 || startM > 59 ||
    endH < 0 || endH > 23 || endM < 0 || endM > 59
  ) {
    return { inQuietHours: false, delayMs: 0 };
  }

  const startTotalMinutes = startH * 60 + startM;
  const endTotalMinutes = endH * 60 + endM;

  const local = getZonedParts(now, validTimeZone);
  const currentTotalMinutes = local.hour * 60 + local.minute;

  let inQuietHours = false;
  let daysUntilEnd = 0;

  if (startTotalMinutes > endTotalMinutes) {
    // Overnight window crossing midnight (e.g., 22:00 to 07:00)
    if (currentTotalMinutes >= startTotalMinutes) {
      // Late evening before midnight: quiet hours end tomorrow morning
      inQuietHours = true;
      daysUntilEnd = 1;
    } else if (currentTotalMinutes < endTotalMinutes) {
      // Early morning after midnight: quiet hours end today morning
      inQuietHours = true;
      daysUntilEnd = 0;
    }
  } else if (startTotalMinutes < endTotalMinutes) {
    // Window within the same day (e.g., 01:00 to 06:00)
    if (currentTotalMinutes >= startTotalMinutes && currentTotalMinutes < endTotalMinutes) {
      inQuietHours = true;
      daysUntilEnd = 0;
    }
  }

  if (!inQuietHours) {
    return { inQuietHours: false, delayMs: 0 };
  }

  const endsAt = getUtcDateFromLocal(
    local.year,
    local.month,
    local.day + daysUntilEnd,
    endH,
    endM,
    0,
    validTimeZone
  );

  const delayMs = Math.max(0, endsAt.getTime() - now.getTime());

  return {
    inQuietHours: true,
    delayMs,
    endsAt,
  };
}

/**
 * Determines whether a notification is urgent per PRD FR-NOT-008 and AC-NOT-01:
 * "Urgent means: a shift change where the affected shift's start (old or new, whichever is earlier
 * and still in the future) is within 12 hours of the change, and failed-renewal notices to Owners.
 * Urgent push bypasses quiet hours."
 */
export function isUrgentNotification(params: NotificationUrgencyParams): boolean {
  if (params.isUrgent) {
    return true;
  }

  if (params.isFailedRenewal) {
    return true;
  }

  const nowMs = (params.now ? params.now.getTime() : Date.now());

  // Check shift-related urgency
  const category = normalizeCategory(params.category);
  if (category === 'shifts') {
    const candidateStarts: number[] = [];

    if (params.startsAt) {
      candidateStarts.push(new Date(params.startsAt).getTime());
    }
    if (params.newStartsAt) {
      candidateStarts.push(new Date(params.newStartsAt).getTime());
    }
    if (params.oldStartsAt) {
      candidateStarts.push(new Date(params.oldStartsAt).getTime());
    }

    for (const startMs of candidateStarts) {
      const diffHours = (startMs - nowMs) / (1000 * 60 * 60);
      // Within 12 hours of shift start, and still upcoming or very recently started (-2h tolerance)
      if (diffHours <= 12 && diffHours > -2) {
        return true;
      }
    }
  }

  return false;
}
