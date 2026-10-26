import { withTenantContext } from '../db/tenant-context.ts';
import { localToUtc, isValidTimeZone } from './timezone-service.ts';
import { detectAssignmentConflicts, type ShiftConflictResult } from './conflict-service.ts';
import { notifyPublishedShifts, notifyShiftChange } from './notification-service.ts';
import { emitActivityEvent } from './activity-service.ts';
import { cacheService } from './cache-service.ts';
import { AppError } from '../utils/errors.ts';

export interface CreateShiftInput {
  branchId?: string | null;
  departmentId?: string | null;
  startsAt: string; // ISO UTC string
  endsAt: string;   // ISO UTC string
  timeZone?: string;
  status?: 'draft' | 'review' | 'published';
}

export interface UpdateShiftInput {
  startsAt?: string;
  endsAt?: string;
  status?: 'draft' | 'review' | 'published' | 'cancelled';
  departmentId?: string;
}

export interface CreateRequirementInput {
  branchId: string;
  departmentId: string;
  roleLabel?: string;
  headcount?: number;
  localStart: string; // '08:00'
  localEnd: string;   // '16:00'
  weekdays: number[]; // e.g. [1, 2, 3, 4, 5]
  timeZone?: string;
}

export interface AvailabilityInput {
  dayOfWeek: number;
  startTime: string; // '09:00'
  endTime: string;   // '17:00'
  preference?: 'available' | 'unavailable' | 'preferred';
}

/**
 * Creates a new shift in the tenant plane with version initialized to 1.
 */
export async function createShift(
  businessId: string,
  input: CreateShiftInput
) {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);

  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'startsAt and endsAt must be valid ISO date strings');
  }

  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'endsAt must be strictly after startsAt');
  }

  return withTenantContext(businessId, async (client) => {
    // Look up business time zone if not explicitly passed
    let timeZone = input.timeZone;
    if (!timeZone) {
      const bizRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM businesses WHERE id = $1',
        [businessId]
      );
      timeZone = bizRes.rows[0]?.timezone || 'UTC';
    }

    if (!isValidTimeZone(timeZone)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid IANA time zone '${timeZone}'`);
    }

    let branchId = input.branchId;
    let departmentId = input.departmentId;

    if (!branchId || branchId.startsWith('00000000')) {
      const bRes = await client.query<{ id: string }>(
        'SELECT id FROM branches WHERE business_id = $1 ORDER BY created_at ASC LIMIT 1',
        [businessId]
      );
      branchId = bRes.rows[0]?.id;
    }

    if (!departmentId || departmentId.startsWith('00000000')) {
      const dRes = await client.query<{ id: string }>(
        'SELECT id FROM departments WHERE business_id = $1 AND ($2::uuid IS NULL OR branch_id = $2) ORDER BY created_at ASC LIMIT 1',
        [businessId, branchId || null]
      );
      departmentId = dRes.rows[0]?.id;
    }

    if (!branchId || !departmentId) {
      throw new AppError(400, 'MISSING_ORG_STRUCTURE', 'Business branch or department not found. Please verify organization setup.');
    }

    const res = await client.query(
      `INSERT INTO shifts (business_id, branch_id, department_id, starts_at, ends_at, time_zone, status, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       RETURNING id, branch_id, department_id, starts_at, ends_at, time_zone, status, version, created_at`,
      [businessId, branchId, departmentId, startsAt, endsAt, timeZone, input.status || 'draft']
    );

    const created = res.rows[0];
    cacheService.invalidatePrefix(businessId, 'schedule');
    return created;
  });
}

/**
 * Updates a shift and increments its monotonic version (FR-SWP-007).
 */
export async function updateShift(
  businessId: string,
  shiftId: string,
  input: UpdateShiftInput
) {
  return withTenantContext(businessId, async (client) => {
    // 1. Fetch current shift
    const currentRes = await client.query<{ id: string; version: number; starts_at: Date; ends_at: Date }>(
      'SELECT id, version, starts_at, ends_at FROM shifts WHERE business_id = $1 AND id = $2',
      [businessId, shiftId]
    );

    if (currentRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    }

    const current = currentRes.rows[0];
    const startsAt = input.startsAt ? new Date(input.startsAt) : current.starts_at;
    const endsAt = input.endsAt ? new Date(input.endsAt) : current.ends_at;

    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'endsAt must be strictly after startsAt');
    }

    // 2. Update and increment monotonic version
    const res = await client.query(
      `UPDATE shifts
       SET starts_at = $1,
           ends_at = $2,
           status = COALESCE($3, status),
           department_id = COALESCE($4, department_id),
           version = version + 1,
           updated_at = NOW()
       WHERE business_id = $5 AND id = $6
       RETURNING id, branch_id, department_id, starts_at, ends_at, time_zone, status, version, updated_at`,
      [startsAt, endsAt, input.status || null, input.departmentId || null, businessId, shiftId]
    );

    const updated = res.rows[0];

    // If shift was cancelled or rescheduled, notify affected staff (AC-SCH-04, AC-NOT-01)
    if (input.status === 'cancelled' || (input.startsAt && input.startsAt !== current.starts_at.toISOString())) {
      await notifyShiftChange(
        businessId,
        shiftId,
        input.status === 'cancelled' ? 'cancelled' : 'updated',
        current.starts_at,
        startsAt
      );
    }

    cacheService.invalidatePrefix(businessId, 'schedule');
    return updated;
  });
}

/**
 * Deletes a shift. Direct shift deletion is forbidden for Staff (FR-RBAC-002, AC-002).
 */
export async function deleteShift(
  businessId: string,
  shiftId: string,
  callerRole: string
) {
  if (callerRole === 'Staff') {
    throw new AppError(403, 'FORBIDDEN', 'Staff cannot delete shifts directly');
  }

  return withTenantContext(businessId, async (client) => {
    const res = await client.query(
      'DELETE FROM shifts WHERE business_id = $1 AND id = $2 RETURNING id',
      [businessId, shiftId]
    );
    if (res.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Shift not found');
    }
    cacheService.invalidatePrefix(businessId, 'schedule');
    return { success: true, deletedId: shiftId };
  });
}

/**
 * Shift assignment role hierarchy:
 * - Owner: can assign shifts to owner, co_owner, gm, supervisor, staff
 * - Co-Owner: can assign shifts to co_owner, gm, supervisor, staff (cannot assign to owner)
 * - GM: can assign shifts to gm, supervisor, staff (cannot assign to owner, co_owner)
 * - Supervisor: can ONLY assign shifts to staff (cannot assign to owner, co_owner, gm, supervisor)
 * - Staff: cannot assign shifts
 */
export const ALLOWED_SHIFT_ASSIGNEE_ROLES: Record<string, string[]> = {
  owner: ['owner', 'co_owner', 'gm', 'supervisor', 'staff'],
  co_owner: ['co_owner', 'gm', 'supervisor', 'staff'],
  gm: ['gm', 'supervisor', 'staff'],
  supervisor: ['staff'],
  staff: [],
};

/**
 * Assigns a worker to a shift with conflict checking, reasoned manager overrides,
 * and strict role hierarchy enforcement (Supervisors cannot assign shifts to Owner or higher roles).
 */
export async function assignWorker(
  businessId: string,
  shiftId: string,
  membershipId: string,
  callerMembershipId: string,
  callerRole: string,
  requestId: string,
  overrideReason?: string
) {
  const result = await withTenantContext(businessId, async (client) => {
    // 0. Enforce role hierarchy on shift assignments
    const targetMemberRes = await client.query<{ id: string; role: string; status: string }>(
      'SELECT id, role, status FROM memberships WHERE business_id = $1 AND id = $2',
      [businessId, membershipId]
    );

    if (targetMemberRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Target team member not found');
    }

    const targetMember = targetMemberRes.rows[0];
    const callerNorm = (callerRole || '').toLowerCase();
    const targetNorm = (targetMember.role || '').toLowerCase();

    const allowed = ALLOWED_SHIFT_ASSIGNEE_ROLES[callerNorm];
    if (!allowed || !allowed.includes(targetNorm)) {
      if (callerNorm === 'supervisor' && targetNorm === 'owner') {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Supervisors cannot assign shifts to the Owner'
        );
      }
      if (callerNorm === 'supervisor' && ['co_owner', 'gm'].includes(targetNorm)) {
        throw new AppError(
          403,
          'FORBIDDEN',
          `Supervisors cannot assign shifts to higher role '${targetMember.role}'. Supervisors may only assign shifts to Staff.`
        );
      }
      if (callerNorm === 'supervisor' && targetNorm === 'supervisor') {
        throw new AppError(
          403,
          'FORBIDDEN',
          `Supervisors cannot assign shifts to fellow Supervisors. Supervisors may only assign shifts to Staff.`
        );
      }
      throw new AppError(
        403,
        'FORBIDDEN',
        `Role '${callerRole}' is not permitted to assign shifts to role '${targetMember.role}'`
      );
    }

    // 1. Detect conflicts
    const conflictResult = await detectAssignmentConflicts(client, businessId, shiftId, membershipId);

    // If department mismatch, hard reject (C-07, AC-DM-02)
    const deptMismatch = conflictResult.conflicts.find((c) => c.type === 'DEPARTMENT_MISMATCH');
    if (deptMismatch) {
      throw new AppError(400, 'DEPARTMENT_MISMATCH', deptMismatch.message, deptMismatch.details);
    }

    // 2. If overlap or availability conflict exists
    if (conflictResult.hasConflict) {
      const trimmedReason = overrideReason?.trim();
      if (!trimmedReason || trimmedReason.length === 0) {
        throw new AppError(
          409,
          'CONFLICT_DETECTED',
          'Shift assignment conflicts with worker availability or existing shift. A valid override reason is required.',
          { conflicts: conflictResult.conflicts }
        );
      }

      // Check manager authorization for override (AC-RBAC-03)
      if (callerRole !== 'owner' && callerRole !== 'gm' && callerRole !== 'supervisor') {
        throw new AppError(403, 'FORBIDDEN', 'Only managers can record conflict overrides');
      }

      // Insert assignment with override details
      const assignRes = await client.query(
        `INSERT INTO shift_assignments (business_id, shift_id, membership_id, override_reason, override_by, override_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, shift_id, membership_id, override_reason, override_by, override_at, created_at`,
        [businessId, shiftId, membershipId, trimmedReason, callerMembershipId]
      );

      // Write audit log entry (FR-RBAC-004, AC-RBAC-04)
      await client.query(
        `INSERT INTO audit_log (business_id, actor_membership_id, action, outcome, request_id, details)
         VALUES ($1, $2, 'availability_override', 'allowed', $3, $4)`,
        [
          businessId,
          callerMembershipId,
          requestId,
          JSON.stringify({
            shiftId,
            assignedMembershipId: membershipId,
            reason: trimmedReason,
            conflicts: conflictResult.conflicts,
          }),
        ]
      );

      const shiftRes = await client.query<{
        id: string;
        status: string;
        branch_id: string | null;
        department_id: string | null;
        starts_at: Date;
        ends_at: Date;
      }>(
        'SELECT id, status, branch_id, department_id, starts_at, ends_at FROM shifts WHERE business_id = $1 AND id = $2',
        [businessId, shiftId]
      );

      cacheService.invalidatePrefix(businessId, 'schedule');
      return {
        assignment: assignRes.rows[0],
        overridden: true,
        conflicts: conflictResult.conflicts,
        shiftInfo: shiftRes.rows[0] || null,
      };
    }

    // 3. Clean assignment with no conflicts
    const assignRes = await client.query(
      `INSERT INTO shift_assignments (business_id, shift_id, membership_id)
       VALUES ($1, $2, $3)
       RETURNING id, shift_id, membership_id, created_at`,
      [businessId, shiftId, membershipId]
    );

    const shiftRes = await client.query<{
      id: string;
      status: string;
      branch_id: string | null;
      department_id: string | null;
      starts_at: Date;
      ends_at: Date;
    }>(
      'SELECT id, status, branch_id, department_id, starts_at, ends_at FROM shifts WHERE business_id = $1 AND id = $2',
      [businessId, shiftId]
    );

    cacheService.invalidatePrefix(businessId, 'schedule');
    return {
      assignment: assignRes.rows[0],
      overridden: false,
      conflicts: [],
      shiftInfo: shiftRes.rows[0] || null,
    };
  });

  // Notify assigned worker if the shift is active/published
  if (result.shiftInfo?.status === 'published') {
    try {
      await notifyPublishedShifts(businessId, [shiftId]);
    } catch (notifyErr) {
      console.error('[AssignWorker Notification Warning]', notifyErr);
    }
  }

  // Emit activity event for Feed visibility (FR-ACT-005, AC-ACT-01)
  try {
    await emitActivityEvent(businessId, {
      type: 'schedule.shift_assigned',
      branchId: result.shiftInfo?.branch_id || null,
      departmentId: result.shiftInfo?.department_id || null,
      actorMembershipId: callerMembershipId,
      subjectMembershipId: membershipId,
      visibilityClass: 'schedule',
      payload: {
        shiftId,
        startsAt: result.shiftInfo?.starts_at,
        endsAt: result.shiftInfo?.ends_at,
      },
    });
  } catch (eventErr) {
    console.error('[AssignWorker Event Warning]', eventErr);
  }

  return {
    assignment: result.assignment,
    overridden: result.overridden,
    conflicts: result.conflicts,
  };
}

/**
 * Unassigns a worker from a shift, enforcing hierarchy permissions.
 */
export async function unassignWorker(
  businessId: string,
  shiftId: string,
  membershipId: string,
  callerRole?: string
) {
  return withTenantContext(businessId, async (client) => {
    if (callerRole) {
      const targetMemberRes = await client.query<{ id: string; role: string }>(
        'SELECT id, role FROM memberships WHERE business_id = $1 AND id = $2',
        [businessId, membershipId]
      );
      if (targetMemberRes.rowCount && targetMemberRes.rowCount > 0) {
        const targetMember = targetMemberRes.rows[0];
        const callerNorm = (callerRole || '').toLowerCase();
        const targetNorm = (targetMember.role || '').toLowerCase();
        const allowed = ALLOWED_SHIFT_ASSIGNEE_ROLES[callerNorm];
        if (!allowed || !allowed.includes(targetNorm)) {
          if (callerNorm === 'supervisor' && targetNorm === 'owner') {
            throw new AppError(403, 'FORBIDDEN', 'Supervisors cannot unassign shifts for the Owner');
          }
          if (callerNorm === 'supervisor') {
            throw new AppError(
              403,
              'FORBIDDEN',
              `Supervisors cannot unassign shifts for role '${targetMember.role}'. Supervisors may only manage shifts for Staff.`
            );
          }
          throw new AppError(
            403,
            'FORBIDDEN',
            `Role '${callerRole}' is not permitted to unassign shifts for role '${targetMember.role}'`
          );
        }
      }
    }

    const res = await client.query(
      'DELETE FROM shift_assignments WHERE business_id = $1 AND shift_id = $2 AND membership_id = $3 RETURNING id',
      [businessId, shiftId, membershipId]
    );
    if (res.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Assignment not found');
    }
    cacheService.invalidatePrefix(businessId, 'schedule');
    return { success: true };
  });
}

/**
 * Creates a recurring staffing requirement in wall-clock local time (FR-SCH-009).
 */
export async function createStaffingRequirement(
  businessId: string,
  input: CreateRequirementInput
) {
  if (!input.weekdays || input.weekdays.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'At least one weekday must be specified (0-6)');
  }

  return withTenantContext(businessId, async (client) => {
    let timeZone = input.timeZone;
    if (!timeZone) {
      const bizRes = await client.query<{ timezone: string }>(
        'SELECT timezone FROM businesses WHERE id = $1',
        [businessId]
      );
      timeZone = bizRes.rows[0]?.timezone || 'UTC';
    }

    if (!isValidTimeZone(timeZone)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid IANA time zone '${timeZone}'`);
    }

    const res = await client.query(
      `INSERT INTO staffing_requirements (business_id, branch_id, department_id, role_label, headcount, local_start, local_end, weekdays, time_zone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, branch_id, department_id, role_label, headcount, local_start, local_end, weekdays, time_zone, created_at`,
      [
        businessId,
        input.branchId,
        input.departmentId,
        input.roleLabel || 'Staff',
        input.headcount || 1,
        input.localStart,
        input.localEnd,
        input.weekdays,
        timeZone,
      ]
    );

    return res.rows[0];
  });
}

/**
 * Generates shifts from recurring staffing requirements on a given date (FR-SCH-009, AC-SCH-03).
 * Preserves local wall-clock hours across DST transitions.
 */
export async function generateShiftsFromRequirement(
  businessId: string,
  requirementId: string,
  dateStr: string
) {
  return withTenantContext(businessId, async (client) => {
    const reqRes = await client.query<{
      id: string;
      branch_id: string;
      department_id: string;
      local_start: string;
      local_end: string;
      time_zone: string;
      headcount: number;
    }>(
      'SELECT id, branch_id, department_id, local_start, local_end, time_zone, headcount FROM staffing_requirements WHERE business_id = $1 AND id = $2',
      [businessId, requirementId]
    );

    if (reqRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Staffing requirement not found');
    }

    const req = reqRes.rows[0];

    // Convert local start & end to exact UTC instants
    const startsAt = localToUtc(dateStr, req.local_start, req.time_zone);
    let endsAt = localToUtc(dateStr, req.local_end, req.time_zone);

    // If overnight shift (end time <= start time), end date is the next day
    if (endsAt.getTime() <= startsAt.getTime()) {
      const nextDay = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
      const nextDateStr = nextDay.toISOString().slice(0, 10);
      endsAt = localToUtc(nextDateStr, req.local_end, req.time_zone);
    }

    const createdShifts = [];
    for (let i = 0; i < req.headcount; i++) {
      const shiftRes = await client.query(
        `INSERT INTO shifts (business_id, branch_id, department_id, starts_at, ends_at, time_zone, status, version)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', 1)
         RETURNING id, branch_id, department_id, starts_at, ends_at, time_zone, status, version, created_at`,
        [businessId, req.branch_id, req.department_id, startsAt, endsAt, req.time_zone]
      );
      createdShifts.push(shiftRes.rows[0]);
    }

    cacheService.invalidatePrefix(businessId, 'schedule');
    return createdShifts;
  });
}

/**
 * Submits staff availability preference (FR-AVL-001).
 */
export async function submitAvailability(
  businessId: string,
  membershipId: string,
  input: AvailabilityInput
) {
  if (input.dayOfWeek < 0 || input.dayOfWeek > 6) {
    throw new AppError(400, 'VALIDATION_ERROR', 'dayOfWeek must be between 0 (Sunday) and 6 (Saturday)');
  }

  return withTenantContext(businessId, async (client) => {
    const res = await client.query(
      `INSERT INTO availability_entries (business_id, membership_id, day_of_week, start_time, end_time, preference)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, membership_id, day_of_week, start_time, end_time, preference, created_at`,
      [businessId, membershipId, input.dayOfWeek, input.startTime, input.endTime, input.preference || 'available']
    );
    return res.rows[0];
  });
}

/**
 * Publishes shifts, moving them from draft/review to published (AC-SCH-02).
 */
export async function publishSchedule(
  businessId: string,
  shiftIds: string[]
) {
  if (!shiftIds || shiftIds.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'shiftIds array cannot be empty');
  }

  const published = await withTenantContext(businessId, async (client) => {
    const res = await client.query(
      `UPDATE shifts
       SET status = 'published', version = version + 1, updated_at = NOW()
       WHERE business_id = $1 AND id = ANY($2::uuid[])
       RETURNING id, status, version`,
      [businessId, shiftIds]
    );
    return res.rows;
  });

  // Notify affected staff (AC-006, FR-SCH-006, BR-002)
  await notifyPublishedShifts(businessId, shiftIds);

  try {
    await emitActivityEvent(businessId, {
      type: 'schedule.published',
      branchId: null,
      departmentId: null,
      actorMembershipId: null,
      subjectMembershipId: null,
      visibilityClass: 'schedule',
      payload: {
        shiftIds,
        count: shiftIds.length,
      },
    });
  } catch (eventErr) {
    console.error('[PublishSchedule Event Warning]', eventErr);
  }

  cacheService.invalidatePrefix(businessId, 'schedule');
  return published;
}

/**
 * Retrieves shift schedule. Staff members see ONLY published shifts (AC-SCH-02).
 */
export async function getSchedule(
  businessId: string,
  callerRole: string,
  options?: { departmentId?: string; branchId?: string; status?: string }
) {
  // If caller is Staff, enforce status = 'published' (AC-SCH-02)
  const effectiveStatus = callerRole === 'Staff' ? 'published' : (options?.status || 'all');
  const cacheKey = `schedule:${callerRole}:${options?.departmentId || 'all'}:${options?.branchId || 'all'}:${effectiveStatus}`;

  const cached = await cacheService.get<unknown[]>(businessId, cacheKey);
  if (cached) {
    return cached;
  }

  const result = await withTenantContext(businessId, async (client) => {
    let statusFilter = options?.status;
    if (callerRole === 'Staff') {
      statusFilter = 'published';
    }

    let query = `
      SELECT s.id, s.branch_id, s.department_id, s.starts_at, s.ends_at, s.time_zone, s.status, s.version,
             COALESCE(
               json_agg(
                 json_build_object(
                   'assignmentId', a.id,
                   'membershipId', a.membership_id,
                   'overrideReason', a.override_reason,
                   'overrideBy', a.override_by,
                   'overrideAt', a.override_at
                 )
               ) FILTER (WHERE a.id IS NOT NULL), '[]'
             ) as assignments
      FROM shifts s
      LEFT JOIN shift_assignments a ON a.business_id = s.business_id AND a.shift_id = s.id
      WHERE s.business_id = $1
    `;

    const params: unknown[] = [businessId];

    if (statusFilter) {
      params.push(statusFilter);
      query += ` AND s.status = $${params.length}`;
    }

    if (options?.departmentId) {
      params.push(options.departmentId);
      query += ` AND s.department_id = $${params.length}`;
    }

    if (options?.branchId) {
      params.push(options.branchId);
      query += ` AND s.branch_id = $${params.length}`;
    }

    query += ' GROUP BY s.business_id, s.id, s.starts_at ORDER BY s.starts_at ASC';

    const res = await client.query(query, params);
    return res.rows;
  });

  await cacheService.set(businessId, cacheKey, result, 60);
  return result;
}
