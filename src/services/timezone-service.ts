import { AppError } from '../utils/errors.ts';

/**
 * Validates that a string is a valid IANA time zone identifier.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes the offset in milliseconds between UTC and the specified time zone for a given instant.
 * Positive for zones ahead of UTC (e.g. UTC+1 -> +3600000), negative for zones behind UTC.
 */
export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => {
    const p = parts.find((part) => part.type === type);
    return p ? p.value : '0';
  };

  const year = parseInt(getPart('year'), 10);
  const month = parseInt(getPart('month'), 10) - 1;
  const day = parseInt(getPart('day'), 10);
  let hour = parseInt(getPart('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(getPart('minute'), 10);
  const second = parseInt(getPart('second'), 10);

  const localEquivalentUtc = Date.UTC(year, month, day, hour, minute, second);
  return localEquivalentUtc - date.getTime();
}

/**
 * Converts a local wall-clock date and time in an IANA time zone into an exact UTC Date instant.
 *
 * @param dateStr Date in 'YYYY-MM-DD' format
 * @param timeStr Time in 'HH:MM' 24h format
 * @param timeZone IANA time zone identifier (e.g. 'Africa/Lagos', 'America/New_York')
 */
export function localToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  if (!isValidTimeZone(timeZone)) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid IANA time zone '${timeZone}'`);
  }

  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const [hourStr, minuteStr] = timeStr.split(':');

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1;
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Malformed date or time format. Expected YYYY-MM-DD and HH:MM');
  }

  // Initial estimate treating local components as UTC
  const initialUtc = new Date(Date.UTC(year, month, day, hour, minute, 0));
  const offset = getTimeZoneOffsetMs(initialUtc, timeZone);
  const exactUtcTime = initialUtc.getTime() - offset;

  // Refine once in case of DST transition boundary
  const refinedDate = new Date(exactUtcTime);
  const refinedOffset = getTimeZoneOffsetMs(refinedDate, timeZone);
  if (refinedOffset !== offset) {
    return new Date(initialUtc.getTime() - refinedOffset);
  }

  return refinedDate;
}

/**
 * Converts a UTC Date instant into local wall-clock components in the specified time zone.
 */
export function utcToLocal(
  utcDate: Date,
  timeZone: string
): { dateStr: string; timeStr: string; dayOfWeek: number } {
  if (!isValidTimeZone(timeZone)) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid IANA time zone '${timeZone}'`);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcDate);
  const getPart = (type: string) => {
    const p = parts.find((part) => part.type === type);
    return p ? p.value : '00';
  };

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  let hour = getPart('hour');
  if (hour === '24') hour = '00';
  const minute = getPart('minute');

  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${hour}:${minute}`;

  // Get day of week in target timezone (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const dayOfWeekFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'narrow',
  });
  // Calculate day of week using local equivalent date
  const localDate = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
  const dayOfWeek = localDate.getDay();

  return { dateStr, timeStr, dayOfWeek };
}
