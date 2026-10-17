import { withTenantContext } from '../db/tenant-context.ts';
import { emitActivityEvent } from './activity-service.ts';
import { AppError } from '../utils/errors.ts';

export type AttendanceState = 'present' | 'late' | 'absent';

export interface RecordAttendanceInput {
  shiftAssignmentId: string;
  state: AttendanceState;
  notes?: string;
}

export interface AttendanceRecordRow {
  id: string;
  business_id: string;
  shift_id: string;
  shift_assignment_id: string;
  membership_id: string;
  department_id: string;
  state: AttendanceState;
  recorded_by: string;
  recorded_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListAttendanceOptions {
  shiftId?: string;
  membershipId?: string;
  departmentId?: string;
}

/**
 * Records attendance (present, late, absent) against a published shift (FR-ATT-001, FR-ATT-002, AC-SCH-07).
 * Authorised roles: Owner, GM, Supervisor of assigned department.
 * Staff recording is blocked.
 * Duplicate attendance for the same shift assignment is rejected with 409.
 */
export async function recordAttendance(
  businessId: string,
  actorMembershipId: string,
  actorRole: string,
  actorDeptId: string | null | undefined,
  input: RecordAttendanceInput
): Promise<AttendanceRecordRow> {
  const normRole = actorRole.toLowerCase();
  if (!['owner', 'gm', 'supervisor'].includes(normRole)) {
    throw new AppError(403, 'FORBIDDEN', 'Staff members cannot record attendance. Only managers can perform this action.');
  }

  if (!['present', 'late', 'absent'].includes(input.state)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'State must be one of: present, late, absent');
  }

  return withTenantContext(businessId, async (client) => {
    // 1. Fetch shift assignment and parent shift
    const assignRes = await client.query<{
      assignment_id: string;
      shift_id: string;
      membership_id: string;
      department_id: string;
      branch_id: string;
      shift_status: string;
    }>(
      `SELECT sa.id AS assignment_id, sa.shift_id, sa.membership_id, s.department_id, s.branch_id, s.status AS shift_status
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       WHERE sa.business_id = $1 AND sa.id = $2`,
      [businessId, input.shiftAssignmentId]
    );

    if (assignRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Shift assignment not found');
    }

    const assignment = assignRes.rows[0];

    // FR-ATT-001: Must be recorded against a published shift
    if (assignment.shift_status !== 'published') {
      throw new AppError(
        400,
        'SHIFT_NOT_PUBLISHED',
        `Attendance can only be recorded against published shifts (current shift status: ${assignment.shift_status})`
      );
    }

    // Supervisor department scope check
    if (normRole === 'supervisor' && actorDeptId && actorDeptId !== assignment.department_id) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Supervisors can only record attendance for shifts in their assigned department'
      );
    }

    // 2. Check for duplicate attendance record (Unique business_id, shift_assignment_id)
    const existingRes = await client.query(
      `SELECT id FROM attendance_records WHERE business_id = $1 AND shift_assignment_id = $2`,
      [businessId, input.shiftAssignmentId]
    );

    if (existingRes.rowCount && existingRes.rowCount > 0) {
      throw new AppError(
        409,
        'DUPLICATE_ATTENDANCE',
        'An attendance record has already been submitted for this shift assignment'
      );
    }

    // 3. Insert attendance record
    const insertRes = await client.query<AttendanceRecordRow>(
      `INSERT INTO attendance_records (
        business_id,
        shift_id,
        shift_assignment_id,
        membership_id,
        department_id,
        state,
        recorded_by,
        notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        businessId,
        assignment.shift_id,
        assignment.assignment_id,
        assignment.membership_id,
        assignment.department_id,
        input.state,
        actorMembershipId,
        input.notes || null,
      ]
    );

    const record = insertRes.rows[0];

    // 4. Record activity event
    await emitActivityEvent(businessId, {
      type: 'attendance.recorded',
      branchId: assignment.branch_id,
      departmentId: assignment.department_id,
      actorMembershipId,
      subjectMembershipId: assignment.membership_id,
      visibilityClass: 'attendance',
      payload: {
        recordId: record.id,
        shiftId: assignment.shift_id,
        shiftAssignmentId: assignment.assignment_id,
        state: input.state,
        notes: input.notes || null,
      },
    });

    // 5. FR-ATT-002, AC-SCH-07: Absence triggers a notification to the relevant manager
    if (input.state === 'absent') {
      await client.query(
        `INSERT INTO inbox_items (
          business_id,
          recipient_membership_id,
          recipient_user_id,
          category,
          title,
          body,
          payload,
          urgent
        )
        SELECT
          $1,
          m.id,
          m.user_id,
          'attendance',
          'Staff Absence Reported',
          'A staff member was marked absent for a published shift.',
          $2,
          true
        FROM memberships m
        WHERE m.business_id = $1
          AND m.status = 'active'
          AND (
            m.role IN ('owner', 'gm')
            OR (m.role = 'supervisor' AND m.department_id = $3)
          )`,
        [
          businessId,
          JSON.stringify({
            recordId: record.id,
            shiftId: assignment.shift_id,
            workerMembershipId: assignment.membership_id,
          }),
          assignment.department_id,
        ]
      );
    }

    return record;
  });
}

/**
 * Lists attendance records with role-based scoping (AC-ACT-01).
 * Staff can only view their own attendance records.
 * Supervisor can only view records for their department.
 * GM / Owner can view all.
 */
export async function listAttendance(
  businessId: string,
  userMembershipId: string,
  userRole: string,
  userDeptId: string | null | undefined,
  options: ListAttendanceOptions = {}
): Promise<AttendanceRecordRow[]> {
  const normRole = userRole.toLowerCase();

  return withTenantContext(businessId, async (client) => {
    const params: unknown[] = [businessId];
    const conditions: string[] = ['business_id = $1'];

    // Role-based scoping
    if (normRole === 'staff') {
      params.push(userMembershipId);
      conditions.push(`membership_id = $${params.length}`);
    } else if (normRole === 'supervisor' && userDeptId) {
      params.push(userDeptId);
      conditions.push(`department_id = $${params.length}`);
    }

    // Optional query filters
    if (options.shiftId) {
      params.push(options.shiftId);
      conditions.push(`shift_id = $${params.length}`);
    }

    if (options.membershipId && normRole !== 'staff') {
      params.push(options.membershipId);
      conditions.push(`membership_id = $${params.length}`);
    }

    if (options.departmentId && ['owner', 'gm'].includes(normRole)) {
      params.push(options.departmentId);
      conditions.push(`department_id = $${params.length}`);
    }

    const query = `
      SELECT *
      FROM attendance_records
      WHERE ${conditions.join(' AND ')}
      ORDER BY recorded_at DESC
    `;

    const res = await client.query<AttendanceRecordRow>(query, params);
    return res.rows;
  });
}
