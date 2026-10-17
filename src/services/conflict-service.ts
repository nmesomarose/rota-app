import type pg from 'pg';
import { utcToLocal } from './timezone-service.ts';

export interface ConflictDetails {
  type: 'OVERLAP' | 'AVAILABILITY' | 'DEPARTMENT_MISMATCH';
  message: string;
  details?: Record<string, unknown>;
}

export interface ShiftConflictResult {
  hasConflict: boolean;
  canOverride: boolean; // Overlaps and availability can be overridden by authorized managers
  conflicts: ConflictDetails[];
}

export interface ShortageConflictResult {
  departmentId: string;
  requirementId: string;
  requiredHeadcount: number;
  assignedCount: number;
  shortage: number;
  timeWindow: {
    start: string;
    end: string;
  };
}

/**
 * Checks for conflicts when assigning a member to a shift:
 * 1. Single-department check (Staff can only be assigned to their home department - C-07, AC-DM-02).
 * 2. Overlap check (No overlapping shifts for the same worker - BR-001).
 * 3. Availability check (Worker marked unavailable in this window - BR-005, AC-SCH-06).
 */
export async function detectAssignmentConflicts(
  client: pg.PoolClient,
  businessId: string,
  shiftId: string,
  membershipId: string
): Promise<ShiftConflictResult> {
  const conflicts: ConflictDetails[] = [];

  // 1. Fetch shift details
  const shiftRes = await client.query<{
    id: string;
    department_id: string;
    branch_id: string;
    starts_at: string;
    ends_at: string;
    time_zone: string;
    status: string;
  }>(
    `SELECT id, department_id, branch_id, starts_at, ends_at, time_zone, status
     FROM shifts
     WHERE business_id = $1 AND id = $2`,
    [businessId, shiftId]
  );

  if (shiftRes.rowCount === 0) {
    return { hasConflict: false, canOverride: false, conflicts: [] };
  }
  const shift = shiftRes.rows[0];

  // 2. Fetch member details
  const memberRes = await client.query<{
    id: string;
    role: string;
    department_id: string | null;
    branch_id: string | null;
    status: string;
  }>(
    `SELECT id, role, department_id, branch_id, status
     FROM memberships
     WHERE business_id = $1 AND id = $2`,
    [businessId, membershipId]
  );

  if (memberRes.rowCount === 0) {
    return { hasConflict: false, canOverride: false, conflicts: [] };
  }
  const member = memberRes.rows[0];

  // 3. Department matching constraint (C-07, AC-DM-02)
  // Staff must strictly belong to the shift's department.
  if (member.role === 'Staff' && member.department_id !== shift.department_id) {
    conflicts.push({
      type: 'DEPARTMENT_MISMATCH',
      message: `Staff member belongs to department '${member.department_id}', but shift is in department '${shift.department_id}'`,
      details: {
        memberDepartmentId: member.department_id,
        shiftDepartmentId: shift.department_id,
      },
    });
    // Department mismatch is a hard constraint (C-07) and cannot be overridden
    return {
      hasConflict: true,
      canOverride: false,
      conflicts,
    };
  }

  // 4. Overlapping shift check (BR-001)
  const overlapRes = await client.query<{
    shift_id: string;
    starts_at: string;
    ends_at: string;
  }>(
    `SELECT s.id AS shift_id, s.starts_at, s.ends_at
     FROM shift_assignments a
     JOIN shifts s ON s.business_id = a.business_id AND s.id = a.shift_id
     WHERE a.business_id = $1
       AND a.membership_id = $2
       AND s.id != $3
       AND s.status != 'cancelled'
       AND s.starts_at < $5
       AND s.ends_at > $4`,
    [businessId, membershipId, shiftId, shift.starts_at, shift.ends_at]
  );

  if (overlapRes.rowCount && overlapRes.rowCount > 0) {
    conflicts.push({
      type: 'OVERLAP',
      message: `Worker has an overlapping shift between ${overlapRes.rows[0].starts_at} and ${overlapRes.rows[0].ends_at}`,
      details: {
        conflictingShiftId: overlapRes.rows[0].shift_id,
        overlappingInterval: {
          startsAt: overlapRes.rows[0].starts_at,
          endsAt: overlapRes.rows[0].ends_at,
        },
      },
    });
  }

  // 5. Availability conflict check (BR-005, AC-SCH-06)
  const shiftStartsAt = new Date(shift.starts_at);
  const shiftEndsAt = new Date(shift.ends_at);
  const localStart = utcToLocal(shiftStartsAt, shift.time_zone);
  const localEnd = utcToLocal(shiftEndsAt, shift.time_zone);

  // Check availability entries for day of week
  const availRes = await client.query<{
    id: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
    preference: string;
  }>(
    `SELECT id, day_of_week, start_time, end_time, preference
     FROM availability_entries
     WHERE business_id = $1 AND membership_id = $2 AND day_of_week = $3`,
    [businessId, membershipId, localStart.dayOfWeek]
  );

  for (const entry of availRes.rows) {
    if (entry.preference === 'unavailable') {
      // If shift overlaps with the unavailable window
      if (localStart.timeStr < entry.end_time && localEnd.timeStr > entry.start_time) {
        conflicts.push({
          type: 'AVAILABILITY',
          message: `Worker marked unavailable on day ${entry.day_of_week} between ${entry.start_time} and ${entry.end_time}`,
          details: {
            dayOfWeek: entry.day_of_week,
            unavailableWindow: `${entry.start_time}-${entry.end_time}`,
          },
        });
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    canOverride: true, // Overlaps and availability can be overridden with manager reason
    conflicts,
  };
}

/**
 * Checks for staffing requirement shortages in a department for a specific day.
 */
export async function detectStaffingShortages(
  client: pg.PoolClient,
  businessId: string,
  departmentId: string,
  dayOfWeek: number
): Promise<ShortageConflictResult[]> {
  const shortages: ShortageConflictResult[] = [];

  // Fetch active staffing requirements for this weekday
  const reqRes = await client.query<{
    id: string;
    headcount: number;
    local_start: string;
    local_end: string;
    weekdays: number[];
  }>(
    `SELECT id, headcount, local_start, local_end, weekdays
     FROM staffing_requirements
     WHERE business_id = $1 AND department_id = $2 AND $3 = ANY(weekdays)`,
    [businessId, departmentId, dayOfWeek]
  );

  for (const req of reqRes.rows) {
    // Count distinct assigned workers on shifts matching this department
    const assignCountRes = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT a.membership_id) as count
       FROM shift_assignments a
       JOIN shifts s ON s.business_id = a.business_id AND s.id = a.shift_id
       WHERE a.business_id = $1
         AND s.department_id = $2
         AND s.status IN ('published', 'review')`,
      [businessId, departmentId]
    );

    const assignedCount = parseInt(assignCountRes.rows[0]?.count || '0', 10);
    if (assignedCount < req.headcount) {
      shortages.push({
        departmentId,
        requirementId: req.id,
        requiredHeadcount: req.headcount,
        assignedCount,
        shortage: req.headcount - assignedCount,
        timeWindow: {
          start: req.local_start,
          end: req.local_end,
        },
      });
    }
  }

  return shortages;
}
