import { withTenantContext } from '../db/tenant-context.ts';
import { emitActivityEvent } from './activity-service.ts';
import { AppError } from '../utils/errors.ts';

export interface RequestSwapInput {
  requesterShiftId: string;
  counterpartMembershipId: string;
  counterpartShiftId: string;
  notes?: string;
}

export interface SwapRequestRow {
  id: string;
  business_id: string;
  branch_id: string;
  department_id: string;
  requester_membership_id: string;
  requester_shift_id: string;
  requester_shift_version: number;
  counterpart_membership_id: string;
  counterpart_shift_id: string;
  counterpart_shift_version: number;
  status: 'pending' | 'peer_accepted' | 'peer_rejected' | 'approved' | 'cancelled' | 'stale';
  peer_responded_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Creates a shift swap request between two staff members in the same department (FR-SWP-001..007, BR-003, AC-SCH-05).
 */
export async function requestSwap(
  businessId: string,
  requesterMembershipId: string,
  input: RequestSwapInput
): Promise<SwapRequestRow> {
  if (requesterMembershipId === input.counterpartMembershipId) {
    throw new AppError(400, 'SELF_SWAP_DISALLOWED', 'You cannot swap shifts with yourself');
  }

  if (input.requesterShiftId === input.counterpartShiftId) {
    throw new AppError(400, 'IDENTICAL_SHIFTS', 'Requester shift and counterpart shift must be distinct');
  }

  return withTenantContext(businessId, async (client) => {
    // 1. Verify requester membership and department
    const reqMemRes = await client.query<{
      id: string;
      department_id: string;
      branch_id: string;
      status: string;
    }>(
      `SELECT id, department_id, branch_id, status FROM memberships WHERE business_id = $1 AND id = $2`,
      [businessId, requesterMembershipId]
    );

    if (reqMemRes.rowCount === 0 || reqMemRes.rows[0].status !== 'active') {
      throw new AppError(403, 'MEMBERSHIP_INACTIVE', 'Requester membership is not active');
    }
    const requesterMem = reqMemRes.rows[0];

    // 2. Verify counterpart membership and department
    const cpartMemRes = await client.query<{
      id: string;
      department_id: string;
      branch_id: string;
      status: string;
    }>(
      `SELECT id, department_id, branch_id, status FROM memberships WHERE business_id = $1 AND id = $2`,
      [businessId, input.counterpartMembershipId]
    );

    if (cpartMemRes.rowCount === 0 || cpartMemRes.rows[0].status !== 'active') {
      throw new AppError(404, 'COUNTERPART_NOT_FOUND', 'Counterpart worker not found or inactive');
    }
    const counterpartMem = cpartMemRes.rows[0];

    // Same-department constraint (FR-SWP-006, D-05, C-07, AC-SCH-05)
    if (requesterMem.department_id !== counterpartMem.department_id) {
      throw new AppError(
        400,
        'CROSS_DEPARTMENT_SWAP_UNSUPPORTED',
        'Cross-department shift swaps are not supported in V1. Both workers must belong to the same department.'
      );
    }

    // 3. Verify requester shift assignment and shift version
    const reqAssignRes = await client.query<{
      shift_id: string;
      version: number;
      department_id: string;
      branch_id: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT sa.shift_id, s.version, s.department_id, s.branch_id, s.starts_at, s.ends_at
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       WHERE sa.business_id = $1 AND sa.shift_id = $2 AND sa.membership_id = $3`,
      [businessId, input.requesterShiftId, requesterMembershipId]
    );

    if (reqAssignRes.rowCount === 0) {
      throw new AppError(400, 'NOT_ASSIGNED_TO_SHIFT', 'Requester is not currently assigned to the specified shift');
    }
    const reqShift = reqAssignRes.rows[0];

    // 4. Verify counterpart shift assignment and shift version
    const cpartAssignRes = await client.query<{
      shift_id: string;
      version: number;
      department_id: string;
      branch_id: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT sa.shift_id, s.version, s.department_id, s.branch_id, s.starts_at, s.ends_at
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       WHERE sa.business_id = $1 AND sa.shift_id = $2 AND sa.membership_id = $3`,
      [businessId, input.counterpartShiftId, input.counterpartMembershipId]
    );

    if (cpartAssignRes.rowCount === 0) {
      throw new AppError(400, 'COUNTERPART_NOT_ASSIGNED', 'Counterpart is not currently assigned to the specified shift');
    }
    const cpartShift = cpartAssignRes.rows[0];

    // Verify both shifts belong to the same department
    if (
      reqShift.department_id !== requesterMem.department_id ||
      cpartShift.department_id !== requesterMem.department_id
    ) {
      throw new AppError(
        400,
        'CROSS_DEPARTMENT_SWAP_UNSUPPORTED',
        'Shifts must belong to the workers home department'
      );
    }

    // 5. Overlap Conflict Check (FR-SWP-006, BR-001, AC-SCH-05)
    // Check if requester taking counterpart's shift overlaps any other shift requester has
    const reqOverlapRes = await client.query(
      `SELECT s.id
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       WHERE sa.business_id = $1
         AND sa.membership_id = $2
         AND s.id <> $3
         AND s.status <> 'cancelled'
         AND s.starts_at < $4
         AND s.ends_at > $5`,
      [businessId, requesterMembershipId, input.requesterShiftId, cpartShift.ends_at, cpartShift.starts_at]
    );

    if (reqOverlapRes.rowCount && reqOverlapRes.rowCount > 0) {
      throw new AppError(
        409,
        'OVERLAPPING_SHIFT',
        'Counterpart shift overlaps with another existing shift assigned to requester'
      );
    }

    // Check if counterpart taking requester's shift overlaps any other shift counterpart has
    const cpartOverlapRes = await client.query(
      `SELECT s.id
       FROM shift_assignments sa
       JOIN shifts s ON s.business_id = sa.business_id AND s.id = sa.shift_id
       WHERE sa.business_id = $1
         AND sa.membership_id = $2
         AND s.id <> $3
         AND s.status <> 'cancelled'
         AND s.starts_at < $4
         AND s.ends_at > $5`,
      [businessId, input.counterpartMembershipId, input.counterpartShiftId, reqShift.ends_at, reqShift.starts_at]
    );

    if (cpartOverlapRes.rowCount && cpartOverlapRes.rowCount > 0) {
      throw new AppError(
        409,
        'OVERLAPPING_SHIFT',
        'Requester shift overlaps with another existing shift assigned to counterpart'
      );
    }

    // Invalidate any existing pending swap requests referencing modified shift versions (BR-003, FR-SWP-004)
    await client.query(
      `UPDATE swap_requests sr
       SET status = 'stale', updated_at = NOW()
       FROM shifts s1, shifts s2
       WHERE sr.business_id = $1
         AND sr.status IN ('pending', 'peer_accepted')
         AND s1.business_id = sr.business_id AND s1.id = sr.requester_shift_id
         AND s2.business_id = sr.business_id AND s2.id = sr.counterpart_shift_id
         AND (sr.requester_shift_version <> s1.version OR sr.counterpart_shift_version <> s2.version)`,
      [businessId]
    );

    // 6. Check for active/pending swap requests on either shift
    const existingRes = await client.query(
      `SELECT id FROM swap_requests
       WHERE business_id = $1
         AND status IN ('pending', 'peer_accepted')
         AND (
           requester_shift_id = $2 OR counterpart_shift_id = $2
           OR requester_shift_id = $3 OR counterpart_shift_id = $3
         )`,
      [businessId, input.requesterShiftId, input.counterpartShiftId]
    );

    if (existingRes.rowCount && existingRes.rowCount > 0) {
      throw new AppError(
        409,
        'CONFLICTING_SWAP',
        'An active swap request already exists for one of the specified shifts'
      );
    }

    // 7. Insert swap request storing shift versions at request time (FR-SWP-007, BR-003)
    const insertRes = await client.query<SwapRequestRow>(
      `INSERT INTO swap_requests (
        business_id,
        branch_id,
        department_id,
        requester_membership_id,
        requester_shift_id,
        requester_shift_version,
        counterpart_membership_id,
        counterpart_shift_id,
        counterpart_shift_version,
        status,
        notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
      RETURNING *`,
      [
        businessId,
        requesterMem.branch_id,
        requesterMem.department_id,
        requesterMembershipId,
        input.requesterShiftId,
        reqShift.version,
        input.counterpartMembershipId,
        input.counterpartShiftId,
        cpartShift.version,
        input.notes || null,
      ]
    );

    const swap = insertRes.rows[0];

    // 8. Record activity event and inbox notification
    await emitActivityEvent(businessId, {
      type: 'swap.requested',
      branchId: requesterMem.branch_id,
      departmentId: requesterMem.department_id,
      actorMembershipId: requesterMembershipId,
      subjectMembershipId: input.counterpartMembershipId,
      visibilityClass: 'swap',
      payload: {
        swapId: swap.id,
        requesterShiftId: input.requesterShiftId,
        counterpartShiftId: input.counterpartShiftId,
      },
    });

    // Notify counterpart in inbox
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
      ) SELECT $1, m.id, m.user_id, 'swap', 'Shift Swap Request', 'A colleague requested to swap shifts with you.', $2, false
        FROM memberships m WHERE m.business_id = $1 AND m.id = $3`,
      [
        businessId,
        JSON.stringify({ swapId: swap.id, requesterMembershipId }),
        input.counterpartMembershipId,
      ]
    );

    return swap;
  });
}

/**
 * Peer accepts a swap request (FR-SWP-002, BR-004, AC-SCH-05).
 * Validates shift version freshness (FR-SWP-004, FR-SWP-007, BR-003, AC-007).
 */
export async function peerAcceptSwap(
  businessId: string,
  swapId: string,
  counterpartMembershipId: string
): Promise<SwapRequestRow> {
  return withTenantContext(businessId, async (client) => {
    // 1. Fetch swap request
    const swapRes = await client.query<SwapRequestRow>(
      `SELECT * FROM swap_requests WHERE business_id = $1 AND id = $2`,
      [businessId, swapId]
    );

    if (swapRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Swap request not found');
    }

    const swap = swapRes.rows[0];

    if (swap.counterpart_membership_id !== counterpartMembershipId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the designated counterpart can accept this swap request');
    }

    if (swap.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', `Swap request cannot be accepted from status: ${swap.status}`);
    }

    // 2. Optimistic concurrency / Stale check (FR-SWP-004, FR-SWP-007, BR-003, AC-007)
    const shiftsRes = await client.query<{ id: string; version: number }>(
      `SELECT id, version FROM shifts WHERE business_id = $1 AND id IN ($2, $3)`,
      [businessId, swap.requester_shift_id, swap.counterpart_shift_id]
    );

    const shiftVersionMap = new Map(shiftsRes.rows.map((s) => [s.id, s.version]));
    const reqVer = shiftVersionMap.get(swap.requester_shift_id);
    const cpartVer = shiftVersionMap.get(swap.counterpart_shift_id);

    if (reqVer !== swap.requester_shift_version || cpartVer !== swap.counterpart_shift_version) {
      // Mark as stale and commit before throwing 409
      await client.query(
        `UPDATE swap_requests SET status = 'stale', updated_at = NOW() WHERE business_id = $1 AND id = $2`,
        [businessId, swapId]
      );
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_business_id = '${businessId}'`);
      throw new AppError(
        409,
        'STALE_SWAP',
        'A shift has changed since the swap was requested. The swap request is stale; please submit a new request.'
      );
    }

    // 3. Update status to peer_accepted
    const updateRes = await client.query<SwapRequestRow>(
      `UPDATE swap_requests
       SET status = 'peer_accepted',
           peer_responded_at = NOW(),
           updated_at = NOW()
       WHERE business_id = $1 AND id = $2
       RETURNING *`,
      [businessId, swapId]
    );

    const updated = updateRes.rows[0];

    // 4. Emit activity event
    await emitActivityEvent(businessId, {
      type: 'swap.peer_accepted',
      branchId: updated.branch_id,
      departmentId: updated.department_id,
      actorMembershipId: counterpartMembershipId,
      subjectMembershipId: updated.requester_membership_id,
      visibilityClass: 'swap',
      payload: { swapId: updated.id },
    });

    return updated;
  });
}

/**
 * Peer rejects a swap request (FR-SWP-002).
 */
export async function peerRejectSwap(
  businessId: string,
  swapId: string,
  counterpartMembershipId: string
): Promise<SwapRequestRow> {
  return withTenantContext(businessId, async (client) => {
    const swapRes = await client.query<SwapRequestRow>(
      `SELECT * FROM swap_requests WHERE business_id = $1 AND id = $2`,
      [businessId, swapId]
    );

    if (swapRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Swap request not found');
    }

    const swap = swapRes.rows[0];

    if (swap.counterpart_membership_id !== counterpartMembershipId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the designated counterpart can reject this swap request');
    }

    if (swap.status !== 'pending') {
      throw new AppError(400, 'INVALID_STATUS', `Swap request cannot be rejected from status: ${swap.status}`);
    }

    const updateRes = await client.query<SwapRequestRow>(
      `UPDATE swap_requests
       SET status = 'peer_rejected',
           peer_responded_at = NOW(),
           updated_at = NOW()
       WHERE business_id = $1 AND id = $2
       RETURNING *`,
      [businessId, swapId]
    );

    const updated = updateRes.rows[0];

    await emitActivityEvent(businessId, {
      type: 'swap.peer_rejected',
      branchId: updated.branch_id,
      departmentId: updated.department_id,
      actorMembershipId: counterpartMembershipId,
      subjectMembershipId: updated.requester_membership_id,
      visibilityClass: 'swap',
      payload: { swapId: updated.id },
    });

    return updated;
  });
}

/**
 * Manager approves a swap request after peer acceptance (FR-SWP-003, BR-004, AC-SCH-05).
 * Atomically exchanges shift assignments and bumps both shift versions inside withTenantContext.
 */
export async function approveSwap(
  businessId: string,
  swapId: string,
  managerMembershipId: string,
  managerRole: string,
  managerDeptId?: string | null
): Promise<SwapRequestRow> {
  const normRole = managerRole.toLowerCase();
  if (!['owner', 'gm', 'supervisor'].includes(normRole)) {
    throw new AppError(403, 'FORBIDDEN', 'Only managers (Owner, GM, Supervisor) can approve shift swaps');
  }

  return withTenantContext(businessId, async (client) => {
    // 1. Fetch swap request
    const swapRes = await client.query<SwapRequestRow>(
      `SELECT * FROM swap_requests WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, swapId]
    );

    if (swapRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Swap request not found');
    }

    const swap = swapRes.rows[0];

    // Supervisor scope check: supervisor must manage the shift's department
    if (normRole === 'supervisor' && managerDeptId && managerDeptId !== swap.department_id) {
      throw new AppError(403, 'FORBIDDEN', 'Supervisors can only approve swaps within their assigned department');
    }

    // BR-004: Swap approval requires acceptance first
    if (swap.status === 'pending') {
      throw new AppError(
        400,
        'SWAP_NOT_ACCEPTED',
        'Swap approval requires acceptance by the colleague first'
      );
    }

    if (swap.status !== 'peer_accepted') {
      throw new AppError(400, 'INVALID_STATUS', `Swap request cannot be approved from status: ${swap.status}`);
    }

    // 2. Optimistic concurrency check inside transaction (FR-SWP-004, FR-SWP-007, BR-003, AC-007)
    const shiftsRes = await client.query<{ id: string; version: number }>(
      `SELECT id, version FROM shifts WHERE business_id = $1 AND id IN ($2, $3) FOR UPDATE`,
      [businessId, swap.requester_shift_id, swap.counterpart_shift_id]
    );

    const shiftVersionMap = new Map(shiftsRes.rows.map((s) => [s.id, s.version]));
    const reqVer = shiftVersionMap.get(swap.requester_shift_id);
    const cpartVer = shiftVersionMap.get(swap.counterpart_shift_id);

    if (reqVer !== swap.requester_shift_version || cpartVer !== swap.counterpart_shift_version) {
      await client.query(
        `UPDATE swap_requests SET status = 'stale', updated_at = NOW() WHERE business_id = $1 AND id = $2`,
        [businessId, swapId]
      );
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_business_id = '${businessId}'`);
      throw new AppError(
        409,
        'STALE_SWAP',
        'A shift has changed since the swap was requested. The swap request is stale; approval is rejected.'
      );
    }

    // 3. Atomically exchange shift assignments
    // Requester shift: reassign to counterpart
    await client.query(
      `UPDATE shift_assignments
       SET membership_id = $1, updated_at = NOW()
       WHERE business_id = $2 AND shift_id = $3 AND membership_id = $4`,
      [swap.counterpart_membership_id, businessId, swap.requester_shift_id, swap.requester_membership_id]
    );

    // Counterpart shift: reassign to requester
    await client.query(
      `UPDATE shift_assignments
       SET membership_id = $1, updated_at = NOW()
       WHERE business_id = $2 AND shift_id = $3 AND membership_id = $4`,
      [swap.requester_membership_id, businessId, swap.counterpart_shift_id, swap.counterpart_membership_id]
    );

    // 4. Bump version on both shifts (FR-SWP-007)
    await client.query(
      `UPDATE shifts
       SET version = version + 1, updated_at = NOW()
       WHERE business_id = $1 AND id IN ($2, $3)`,
      [businessId, swap.requester_shift_id, swap.counterpart_shift_id]
    );

    // 5. Update swap request status to approved
    const updateRes = await client.query<SwapRequestRow>(
      `UPDATE swap_requests
       SET status = 'approved',
           approved_by = $1,
           approved_at = NOW(),
           updated_at = NOW()
       WHERE business_id = $2 AND id = $3
       RETURNING *`,
      [managerMembershipId, businessId, swapId]
    );

    const updated = updateRes.rows[0];

    // 6. Record activity event and inbox notifications for both workers
    await emitActivityEvent(businessId, {
      type: 'swap.approved',
      branchId: updated.branch_id,
      departmentId: updated.department_id,
      actorMembershipId: managerMembershipId,
      subjectMembershipId: updated.requester_membership_id,
      visibilityClass: 'swap',
      payload: {
        swapId: updated.id,
        requesterMembershipId: updated.requester_membership_id,
        counterpartMembershipId: updated.counterpart_membership_id,
      },
    });

    return updated;
  });
}

/**
 * Cancels a swap request (by requester or manager).
 */
export async function cancelSwap(
  businessId: string,
  swapId: string,
  actorMembershipId: string,
  actorRole: string
): Promise<SwapRequestRow> {
  const normRole = actorRole.toLowerCase();

  return withTenantContext(businessId, async (client) => {
    const swapRes = await client.query<SwapRequestRow>(
      `SELECT * FROM swap_requests WHERE business_id = $1 AND id = $2`,
      [businessId, swapId]
    );

    if (swapRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Swap request not found');
    }

    const swap = swapRes.rows[0];

    const isRequester = swap.requester_membership_id === actorMembershipId;
    const isManager = ['owner', 'gm', 'supervisor'].includes(normRole);

    if (!isRequester && !isManager) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to cancel this swap request');
    }

    if (['approved', 'cancelled'].includes(swap.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot cancel a swap request in status: ${swap.status}`);
    }

    const updateRes = await client.query<SwapRequestRow>(
      `UPDATE swap_requests
       SET status = 'cancelled',
           updated_at = NOW()
       WHERE business_id = $1 AND id = $2
       RETURNING *`,
      [businessId, swapId]
    );

    const updated = updateRes.rows[0];

    await emitActivityEvent(businessId, {
      type: 'swap.cancelled',
      branchId: updated.branch_id,
      departmentId: updated.department_id,
      actorMembershipId,
      subjectMembershipId: updated.requester_membership_id,
      visibilityClass: 'swap',
      payload: { swapId: updated.id },
    });

    return updated;
  });
}

/**
 * Lists swap requests with role-based scoping.
 */
export async function listSwaps(
  businessId: string,
  membershipId: string,
  role: string,
  departmentId?: string | null
): Promise<SwapRequestRow[]> {
  const normRole = role.toLowerCase();

  return withTenantContext(businessId, async (client) => {
    if (normRole === 'owner' || normRole === 'gm') {
      const res = await client.query<SwapRequestRow>(
        `SELECT * FROM swap_requests WHERE business_id = $1 ORDER BY created_at DESC`,
        [businessId]
      );
      return res.rows;
    } else if (normRole === 'supervisor' && departmentId) {
      const res = await client.query<SwapRequestRow>(
        `SELECT * FROM swap_requests
         WHERE business_id = $1 AND (department_id = $2 OR requester_membership_id = $3 OR counterpart_membership_id = $3)
         ORDER BY created_at DESC`,
        [businessId, departmentId, membershipId]
      );
      return res.rows;
    } else {
      // Staff: only swaps where they are requester or counterpart
      const res = await client.query<SwapRequestRow>(
        `SELECT * FROM swap_requests
         WHERE business_id = $1 AND (requester_membership_id = $2 OR counterpart_membership_id = $2)
         ORDER BY created_at DESC`,
        [businessId, membershipId]
      );
      return res.rows;
    }
  });
}
