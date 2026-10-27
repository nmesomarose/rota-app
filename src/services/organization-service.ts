import { randomUUID, randomBytes } from 'node:crypto';
import { controlPool } from '../db/connection.ts';
import { withTenantContext, validateBusinessId } from '../db/tenant-context.ts';
import { recordMembershipOutbox, syncEntryToDirectory } from './outbox-service.ts';
import { signAccessToken, ACCESS_TOKEN_EXPIRY_SECONDS, hashToken } from './token-service.ts';
import { AppError } from '../utils/errors.ts';
import { emitActivityEvent } from './activity-service.ts';
import { hashPassword, verifyPassword } from './password-service.ts';
import type { AuthenticatedUser } from '../middleware/auth-middleware.ts';
import { enqueueJob } from '../queue/job-queue.ts';
import { cacheService } from './cache-service.ts';

export interface OnboardBusinessInput {
  name: string;
  timezone?: string;
  branchName?: string;
  departments?: string[];
}

export interface OnboardBusinessResult {
  business: {
    id: string;
    name: string;
    timezone: string;
  };
  branch: {
    id: string;
    name: string;
  };
  departments: Array<{
    id: string;
    name: string;
  }>;
  membership: {
    id: string;
    role: string;
    status: string;
  };
  subscription: {
    plan: string;
    seatQuantity: number;
    status: string;
  };
  tokens: {
    accessToken: string;
    expiresIn: number;
  };
}

/**
 * Onboards a new business, creating business, default branch, initial departments,
 * initial owner membership, starter subscription (5 seats), and outbox directory synchronization.
 *
 * Atomicity:
 * - Tenant plane operations execute in a single isolated transaction via withTenantContext.
 * - Outbox row ensures directory eventual consistency even if control plane write fails.
 * - Control-plane directory copy updated immediately on success.
 */
export async function onboardBusiness(
  userId: string,
  userEmail: string,
  sessionId: string,
  input: OnboardBusinessInput
): Promise<OnboardBusinessResult> {
  const businessName = input.name?.trim();
  if (!businessName || businessName.length < 2) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Business name is required and must be at least 2 characters',
      { field: 'name' }
    );
  }

  const timezone = input.timezone?.trim() || 'UTC';
  const branchName = input.branchName?.trim() || 'Main Branch';
  const departmentNames = (input.departments && input.departments.length > 0)
    ? input.departments.map((d) => d.trim()).filter(Boolean)
    : ['Checkout', 'Stock/Inventory', 'Customer Service'];

  // Generate business UUID
  const businessId = randomUUID();

  // Execute tenant plane mutations inside a transaction on the assigned shard
  const tenantResult = await withTenantContext(businessId, async (client) => {
    // 1. Insert business
    const bizRes = await client.query<{ id: string; name: string; timezone: string }>(
      `INSERT INTO businesses (id, name, timezone)
       VALUES ($1, $2, $3)
       RETURNING id, name, timezone`,
      [businessId, businessName, timezone]
    );
    const business = bizRes.rows[0];

    // 2. Insert default branch
    const branchRes = await client.query<{ id: string; name: string }>(
      `INSERT INTO branches (business_id, name)
       VALUES ($1, $2)
       RETURNING id, name`,
      [businessId, branchName]
    );
    const branch = branchRes.rows[0];

    // 3. Insert initial departments
    const createdDepartments: Array<{ id: string; name: string }> = [];
    for (const deptName of departmentNames) {
      const deptRes = await client.query<{ id: string; name: string }>(
        `INSERT INTO departments (business_id, branch_id, name)
         VALUES ($1, $2, $3)
         RETURNING id, name`,
        [businessId, branch.id, deptName]
      );
      createdDepartments.push(deptRes.rows[0]);
    }

    // 4. Insert Owner membership
    const memberRes = await client.query<{ id: string; role: string; status: string }>(
      `INSERT INTO memberships (business_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')
       RETURNING id, role, status`,
      [businessId, userId]
    );
    const membership = memberRes.rows[0];

    // 5. Seed Starter subscription with 5 seats (D-09, D-20, PRD 9.3)
    const subRes = await client.query<{ plan: string; seat_quantity: number; status: string }>(
      `INSERT INTO subscriptions (business_id, plan, billing_currency, seat_quantity, status)
       VALUES ($1, 'starter', 'USD', 5, 'active')
       RETURNING plan, seat_quantity, status`,
      [businessId]
    );
    const subscription = subRes.rows[0];

    // 6. Record in transactional membership_outbox
    const outboxId = await recordMembershipOutbox(
      client,
      businessId,
      userId,
      businessName,
      'owner',
      'active',
      'upsert'
    );

    return {
      business,
      branch,
      departments: createdDepartments,
      membership,
      subscription: {
        plan: subscription.plan,
        seatQuantity: subscription.seat_quantity,
        status: subscription.status,
      },
      outboxId,
    };
  });

  // 7. Update control plane membership_directory
  await syncEntryToDirectory(
    userId,
    businessId,
    businessName,
    'owner',
    'active'
  );

  // Mark outbox entry as processed in tenant shard
  try {
    await withTenantContext(businessId, async (client) => {
      await client.query(
        `UPDATE membership_outbox
         SET processed_at = NOW(), attempts = attempts + 1
         WHERE business_id = $1 AND id = $2`,
        [businessId, tenantResult.outboxId]
      );
    });
  } catch (_outboxErr) {
    // If marking processed fails, the background reconciliation sweeper will handle it
  }

  // 8. Update current session's active business in control plane
  await controlPool.query(
    `UPDATE sessions SET active_business_id = $1, updated_at = NOW() WHERE id = $2`,
    [businessId, sessionId]
  );

  // 9. Issue newly scoped access token
  const newAccessToken = signAccessToken({
    sub: userId,
    email: userEmail,
    sessionId,
    businessId,
    role: 'owner',
  });

  return {
    business: tenantResult.business,
    branch: tenantResult.branch,
    departments: tenantResult.departments,
    membership: tenantResult.membership,
    subscription: tenantResult.subscription,
    tokens: {
      accessToken: newAccessToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    },
  };
}

export interface OrganizationMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  branchId: string | null;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  createdAt: string;
}

/**
 * Retrieves all team members for a business from tenant shard and control plane.
 */
export async function getOrganizationMembers(businessId: string): Promise<OrganizationMember[]> {
  const cacheKey = 'roster:members';
  const cached = await cacheService.get<OrganizationMember[]>(businessId, cacheKey);
  if (cached) {
    return cached;
  }

  const shardMembers = await withTenantContext(businessId, async (client) => {
    const res = await client.query<{
      id: string;
      user_id: string;
      role: string;
      status: string;
      branch_id: string | null;
      department_id: string | null;
      created_at: string;
      branch_name: string | null;
      department_name: string | null;
    }>(
      `SELECT m.id, m.user_id, m.role, m.status, m.branch_id, m.department_id, m.created_at,
              b.name as branch_name, d.name as department_name
       FROM memberships m
       LEFT JOIN branches b ON b.business_id = m.business_id AND b.id = m.branch_id
       LEFT JOIN departments d ON d.business_id = m.business_id AND d.id = m.department_id
       WHERE m.business_id = $1
       ORDER BY m.created_at ASC`,
      [businessId]
    );
    return res.rows;
  });

  if (shardMembers.length === 0) {
    await cacheService.set(businessId, cacheKey, [], 60);
    return [];
  }

  const userIds = shardMembers.map((m) => m.user_id);
  const usersRes = await controlPool.query<{ id: string; email: string; name: string | null }>(
    `SELECT id, email, name FROM users WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  const userMap = new Map(usersRes.rows.map((u) => [u.id, u]));

  const members = shardMembers.map((m) => {
    const user = userMap.get(m.user_id);
    return {
      id: m.id,
      userId: m.user_id,
      name: user?.name || user?.email.split('@')[0] || 'Team Member',
      email: user?.email || '',
      role: m.role,
      status: m.status,
      branchId: m.branch_id,
      branchName: m.branch_name,
      departmentId: m.department_id,
      departmentName: m.department_name,
      createdAt: m.created_at,
    };
  });

  await cacheService.set(businessId, cacheKey, members, 60);
  return members;
}

export interface InviteMemberInput {
  email: string;
  name?: string;
  role: 'owner' | 'co_owner' | 'gm' | 'supervisor' | 'staff';
  departmentId?: string;
  branchId?: string;
}

export interface InvitationResult {
  id: string;
  businessId: string;
  email: string;
  role: string;
  branchId: string | null;
  departmentId: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
  token?: string;
}

/**
 * Invites a team member by creating a secure, expiring, single-use invitation record (FR-AUTH-007, PRD 4.3).
 * Stored only as SHA-256 hash in tenant shard; token carries non-secret business ID routing prefix.
 */
export async function inviteOrganizationMember(
  businessId: string,
  actor: AuthenticatedUser,
  input: InviteMemberInput
): Promise<InvitationResult> {
  const actorRole = (actor.role || 'staff').toLowerCase();
  const targetRole = input.role.toLowerCase();

  // 1. Role-based permission checks (PRD 4.3, AC-INV-06)
  const allowedInviteRoles: Record<string, string[]> = {
    owner: ['owner', 'co_owner', 'gm', 'supervisor', 'staff'],
    co_owner: ['gm', 'supervisor', 'staff'],
    gm: ['supervisor', 'staff'],
    supervisor: ['staff'],
  };

  if (!allowedInviteRoles[actorRole]?.includes(targetRole)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      `Role '${actorRole}' is not permitted to assign or invite role '${targetRole}'`
    );
  }

  const trimmedEmail = input.email.trim().toLowerCase();

  return await withTenantContext(businessId, async (client) => {
    // 2. Fetch inviter's active membership in this business
    const inviterRes = await client.query<{
      id: string;
      role: string;
      branch_id: string | null;
      department_id: string | null;
      status: string;
    }>(
      `SELECT id, role, branch_id, department_id, status FROM memberships
       WHERE business_id = $1 AND user_id = $2 AND status = 'active'`,
      [businessId, actor.id]
    );

    if (inviterRes.rowCount === 0) {
      throw new AppError(403, 'FORBIDDEN', 'Inviter does not have an active membership in this business');
    }
    const inviter = inviterRes.rows[0];

    // Department Supervisor rule (PRD 4.3, AC-INV-06): Staff only, into inviter's assigned department
    let departmentId = input.departmentId || null;
    let branchId = input.branchId || null;

    if (inviter.role === 'supervisor') {
      if (!inviter.department_id) {
        throw new AppError(403, 'FORBIDDEN', 'Supervisor must be assigned to a department to invite staff');
      }
      if (departmentId && departmentId !== inviter.department_id) {
        throw new AppError(403, 'FORBIDDEN', 'Supervisors may only invite staff into their own assigned department');
      }
      departmentId = inviter.department_id;
      branchId = inviter.branch_id;
    }

    // 3. Authoritative subscription seat check (BILL-017, PRD 9.3)
    const subRes = await client.query<{ seat_quantity: number; status: string }>(
      'SELECT seat_quantity, status FROM subscriptions WHERE business_id = $1',
      [businessId]
    );
    const seatLimit = subRes.rows[0]?.seat_quantity || 5;

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM memberships WHERE business_id = $1 AND status = 'active'`,
      [businessId]
    );
    const activeCount = parseInt(countRes.rows[0]?.count || '0', 10);

    if (activeCount >= seatLimit) {
      throw new AppError(
        403,
        'SEAT_LIMIT_EXCEEDED',
        `Active seat limit of ${seatLimit} reached. Upgrade plan or purchase additional seats to invite more members.`
      );
    }

    // 4. Check if invited user is already an active member of this business
    const existingUser = await controlPool.query<{ id: string; name: string | null }>(
      'SELECT id, name FROM users WHERE email = $1',
      [trimmedEmail]
    );

    let targetUserName: string = input.name?.trim() || trimmedEmail.split('@')[0];

    if (existingUser.rowCount && existingUser.rows.length > 0) {
      const existingMember = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM memberships WHERE business_id = $1 AND user_id = $2',
        [businessId, existingUser.rows[0].id]
      );
      if (existingMember.rowCount && existingMember.rows[0].status === 'active') {
        throw new AppError(409, 'MEMBER_ALREADY_EXISTS', 'This user is already an active member of this business.');
      }
      if (existingUser.rows[0].name) {
        targetUserName = existingUser.rows[0].name;
      }
    } else {
      // Create invited placeholder user in control plane without unusable password hash (password_hash = NULL)
      await controlPool.query(
        `INSERT INTO users (email, password_hash, name, status)
         VALUES ($1, NULL, $2, 'invited')`,
        [trimmedEmail, targetUserName]
      );
    }

    // 5. Check branch / department validity if not explicitly set
    if (!branchId) {
      const defaultBranch = await client.query<{ id: string }>(
        'SELECT id FROM branches WHERE business_id = $1 ORDER BY created_at ASC LIMIT 1',
        [businessId]
      );
      branchId = defaultBranch.rows[0]?.id || null;
    }

    if (!departmentId && branchId) {
      const defaultDept = await client.query<{ id: string }>(
        'SELECT id FROM departments WHERE business_id = $1 AND branch_id = $2 ORDER BY created_at ASC LIMIT 1',
        [businessId, branchId]
      );
      departmentId = defaultDept.rows[0]?.id || null;
    }

    // 6. Generate cryptographically secure token with shard routing prefix (PRD 9.3)
    const randomHex = randomBytes(24).toString('hex');
    const rawToken = `inv_${businessId}_${randomHex}`;
    const tokenHash = hashToken(rawToken);

    // 7. Revoke any prior pending invitations for this email in this business
    await client.query(
      `UPDATE invitations
       SET status = 'revoked', updated_at = NOW()
       WHERE business_id = $1 AND email = $2 AND status = 'pending'`,
      [businessId, trimmedEmail]
    );

    // 8. Insert invitation with 72-hour expiry and token hash
    const insertRes = await client.query<{
      id: string;
      business_id: string;
      email: string;
      role: string;
      branch_id: string | null;
      department_id: string | null;
      status: string;
      expires_at: string;
      created_at: string;
    }>(
      `INSERT INTO invitations (
         business_id, email, role, branch_id, department_id,
         invited_by_membership_id, token_hash, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW() + INTERVAL '72 hours')
       RETURNING id, business_id, email, role, branch_id, department_id, status, expires_at, created_at`,
      [businessId, trimmedEmail, targetRole, branchId, departmentId, inviter.id, tokenHash]
    );
    const row = insertRes.rows[0];

    // 9. Emit activity event
    try {
      await emitActivityEvent(businessId, {
        type: 'membership.invited',
        visibilityClass: 'membership',
        actorMembershipId: inviter.id,
        subjectMembershipId: row.id,
        branchId: row.branch_id,
        departmentId: row.department_id,
        payload: {
          email: trimmedEmail,
          role: targetRole,
          actorEmail: actor.email,
        },
      });
    } catch (_evtErr) {
      // Activity event failure should not fail invitation creation
    }

    // 10. Enqueue invitation email background job
    try {
      await enqueueJob(
        'email.invitation',
        {
          businessId,
          invitationId: row.id,
          email: trimmedEmail,
          role: targetRole,
          inviterName: actor.email || 'Team Admin',
          rawToken,
        },
        { businessId }
      );
    } catch (_qErr: any) {
      console.warn('[OrganizationService] Could not enqueue invitation email job:', _qErr.message);
    }

    return {
      id: row.id,
      businessId: row.business_id,
      email: row.email,
      role: row.role,
      branchId: row.branch_id,
      departmentId: row.department_id,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      token: process.env.NODE_ENV !== 'production' ? rawToken : undefined,
    };
  });
}

/**
 * Validates and accepts a team invitation server-side (FR-AUTH-007, AC-INV-01..06, BILL-009, J-14).
 * Enforces email binding, inviter permission persistence, and atomic transactional seat limits.
 */
export async function acceptOrganizationInvitation(
  rawToken: string,
  user: AuthenticatedUser
): Promise<{ success: boolean; message: string; membership: unknown }> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invitation token is required');
  }

  const parts = rawToken.trim().split('_');
  if (parts.length < 3 || parts[0] !== 'inv') {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid invitation token format');
  }

  const businessId = parts[1];
  try {
    validateBusinessId(businessId);
  } catch (_e) {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid invitation token format');
  }

  const tokenHash = hashToken(rawToken.trim());

  const acceptResult = await withTenantContext(businessId, async (client) => {
    // 1. Fetch invitation with lock and join inviter's current membership status
    const invRes = await client.query<{
      id: string;
      business_id: string;
      email: string;
      role: string;
      branch_id: string | null;
      department_id: string | null;
      invited_by_membership_id: string;
      status: string;
      expires_at: string;
      inviter_role: string | null;
      inviter_status: string | null;
      inviter_dept_id: string | null;
    }>(
      `SELECT i.id, i.business_id, i.email, i.role, i.branch_id, i.department_id,
              i.invited_by_membership_id, i.status, i.expires_at,
              m.role as inviter_role, m.status as inviter_status, m.department_id as inviter_dept_id
       FROM invitations i
       LEFT JOIN memberships m ON m.business_id = i.business_id AND m.id = i.invited_by_membership_id
       WHERE i.business_id = $1 AND i.token_hash = $2
       FOR UPDATE OF i`,
      [businessId, tokenHash]
    );

    if (invRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Invitation not found');
    }

    const invitation = invRes.rows[0];

    // 2. Prevent token reuse
    if (invitation.status === 'accepted' || invitation.status === 'revoked') {
      throw new AppError(400, 'INVITATION_ALREADY_USED', 'Invitation has already been accepted or revoked');
    }

    // 3. Expiration check
    if (new Date(invitation.expires_at) < new Date() || invitation.status === 'expired') {
      await client.query(
        `UPDATE invitations SET status = 'expired', updated_at = NOW() WHERE business_id = $1 AND id = $2`,
        [businessId, invitation.id]
      );
      throw new AppError(400, 'INVITATION_EXPIRED', 'Invitation has expired');
    }

    // 4. Validate email binding (FR-AUTH-007: bound to verified invited email)
    const userEmail = (user.email || '').trim().toLowerCase();
    const inviteEmail = (invitation.email || '').trim().toLowerCase();
    if (userEmail !== inviteEmail) {
      throw new AppError(
        403,
        'FORBIDDEN',
        `This invitation was sent to ${invitation.email}. You are logged in as ${user.email}.`
      );
    }

    // 5. Inviter permission check (PRD FR-AUTH-007, AC-INV-06)
    if (!invitation.inviter_status || invitation.inviter_status !== 'active') {
      throw new AppError(
        403,
        'INVITATION_REVOKED',
        'The inviter is no longer an active member of this organization. Invitation has been revoked.'
      );
    }

    if (invitation.inviter_role === 'supervisor') {
      if (invitation.role !== 'staff' || invitation.inviter_dept_id !== invitation.department_id) {
        throw new AppError(
          403,
          'INVITATION_REVOKED',
          'The inviter no longer has permission to sponsor this invitation.'
        );
      }
    }

    // 6. Check existing membership
    const existingMember = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM memberships WHERE business_id = $1 AND user_id = $2`,
      [businessId, user.id]
    );
    if (existingMember.rowCount && existingMember.rows[0].status === 'active') {
      throw new AppError(409, 'MEMBER_ALREADY_EXISTS', 'You are already an active member of this business.');
    }

    // 7. Authoritative transactional seat admission check (BILL-009, J-14)
    const subRes = await client.query<{ seat_quantity: number; status: string }>(
      `SELECT seat_quantity, status FROM subscriptions WHERE business_id = $1 FOR UPDATE`,
      [businessId]
    );
    const seatLimit = subRes.rows[0]?.seat_quantity || 5;

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM memberships WHERE business_id = $1 AND status = 'active'`,
      [businessId]
    );
    const activeCount = parseInt(countRes.rows[0]?.count || '0', 10);

    if (activeCount >= seatLimit) {
      throw new AppError(
        409,
        'SEAT_LIMIT_REACHED',
        `Cannot accept invitation: business has reached its limit of ${seatLimit} active seats. Contact an organization owner.`
      );
    }

    // 8. Insert or reactivate membership
    let memberId: string;
    if (existingMember.rowCount && existingMember.rows.length > 0) {
      memberId = existingMember.rows[0].id;
      await client.query(
        `UPDATE memberships
         SET role = $1, status = 'active', branch_id = $2, department_id = $3, updated_at = NOW()
         WHERE business_id = $4 AND id = $5`,
        [invitation.role, invitation.branch_id, invitation.department_id, businessId, memberId]
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO memberships (business_id, user_id, role, branch_id, department_id, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id`,
        [businessId, user.id, invitation.role, invitation.branch_id, invitation.department_id]
      );
      memberId = inserted.rows[0].id;
    }

    // 9. Mark invitation accepted (single-use guarantee)
    await client.query(
      `UPDATE invitations
       SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE business_id = $1 AND id = $2`,
      [businessId, invitation.id]
    );

    // 10. Fetch business name for directory sync
    const bizRes = await client.query<{ name: string }>(
      'SELECT name FROM businesses WHERE id = $1',
      [businessId]
    );
    const businessName = bizRes.rows[0]?.name || 'Rota Business';

    // 11. Sync directory and outbox
    await syncEntryToDirectory(user.id, businessId, businessName, invitation.role, 'active');
    await recordMembershipOutbox(client, businessId, user.id, businessName, invitation.role, 'active', 'upsert');

    // 12. Create in-app welcome notification
    try {
      await client.query(
        `INSERT INTO inbox_items (business_id, recipient_membership_id, recipient_user_id, category, title, body, payload, mandatory, urgent)
         VALUES ($1, $2, $3, 'system', 'Welcome to the Team!', $4, $5, false, false)`,
        [
          businessId,
          memberId,
          user.id,
          `You have joined ${businessName} as ${invitation.role}. Check the Schedule tab for your assigned shifts.`,
          JSON.stringify({ role: invitation.role, businessName }),
        ]
      );
    } catch (_inboxErr) {
      // Non-fatal
    }

    // 13. Ensure user status is active in control plane
    await controlPool.query(
      `UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = 'invited'`,
      [user.id]
    );

    return {
      success: true,
      message: 'Invitation accepted successfully',
      membership: {
        id: memberId,
        userId: user.id,
        businessId,
        businessName,
        role: invitation.role,
        branchId: invitation.branch_id,
        departmentId: invitation.department_id,
        status: 'active',
      },
    };
  });

  await cacheService.invalidatePrefix(businessId, 'roster');
  await cacheService.invalidatePrefix(businessId, 'activity');
  return acceptResult;
}

/**
 * Retrieves public invitation metadata for deep link and onboarding preview.
 */
export async function getInvitationDetails(rawToken: string): Promise<{
  id: string;
  businessId: string;
  businessName: string;
  email: string;
  role: string;
  departmentName: string | null;
  status: string;
  expiresAt: string;
}> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invitation token is required');
  }

  const parts = rawToken.trim().split('_');
  if (parts.length < 3 || parts[0] !== 'inv') {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid invitation token format');
  }

  const businessId = parts[1];
  try {
    validateBusinessId(businessId);
  } catch (_e) {
    throw new AppError(400, 'INVALID_TOKEN', 'Invalid invitation token format');
  }

  const tokenHash = hashToken(rawToken.trim());

  return await withTenantContext(businessId, async (client) => {
    const res = await client.query<{
      id: string;
      business_id: string;
      email: string;
      role: string;
      status: string;
      expires_at: string;
      business_name: string;
      department_name: string | null;
    }>(
      `SELECT i.id, i.business_id, i.email, i.role, i.status, i.expires_at,
              b.name as business_name, d.name as department_name
       FROM invitations i
       JOIN businesses b ON b.id = i.business_id
       LEFT JOIN departments d ON d.business_id = i.business_id AND d.id = i.department_id
       WHERE i.business_id = $1 AND i.token_hash = $2`,
      [businessId, tokenHash]
    );

    if (res.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Invitation not found');
    }

    const row = res.rows[0];

    if (row.status === 'accepted' || row.status === 'revoked') {
      throw new AppError(400, 'INVITATION_ALREADY_USED', 'Invitation has already been accepted or revoked');
    }

    if (new Date(row.expires_at) < new Date() || row.status === 'expired') {
      throw new AppError(400, 'INVITATION_EXPIRED', 'Invitation has expired');
    }

    return {
      id: row.id,
      businessId: row.business_id,
      businessName: row.business_name,
      email: row.email,
      role: row.role,
      departmentName: row.department_name,
      status: row.status,
      expiresAt: row.expires_at,
    };
  });
}


/**
 * Updates a member's role with strict hierarchy and sole-owner protection.
 */
export async function updateOrganizationMemberRole(
  businessId: string,
  actor: AuthenticatedUser,
  memberId: string,
  newRole: string
): Promise<{ id: string; role: string }> {
  const actorRole = (actor.role || 'staff').toLowerCase();
  const targetRole = newRole.toLowerCase();

  const validRoles = ['owner', 'co_owner', 'gm', 'supervisor', 'staff'];
  if (!validRoles.includes(targetRole)) {
    throw new AppError(400, 'INVALID_ROLE', `Role '${newRole}' is not recognized`);
  }

  // Authorization: Only owner or co_owner can modify roles
  if (!['owner', 'co_owner'].includes(actorRole)) {
    throw new AppError(403, 'FORBIDDEN', 'Only business owners and co-owners can change team member roles');
  }

  // Only owner can appoint or demote owner/co_owner
  if (['owner', 'co_owner'].includes(targetRole) && actorRole !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Only primary owners can appoint or modify owner and co-owner roles');
  }

  const updated = await withTenantContext(businessId, async (client) => {
    const memberRes = await client.query<{ id: string; user_id: string; role: string; status: string }>(
      'SELECT id, user_id, role, status FROM memberships WHERE business_id = $1 AND id = $2',
      [businessId, memberId]
    );

    if (memberRes.rowCount === 0) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Team member not found in this business');
    }

    const member = memberRes.rows[0];

    // Cannot demote/change role if target is sole owner and newRole !== 'owner'
    if (member.role === 'owner' && targetRole !== 'owner') {
      const ownerCountRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM memberships WHERE business_id = $1 AND role = 'owner' AND status = 'active'`,
        [businessId]
      );
      const ownerCount = parseInt(ownerCountRes.rows[0]?.count || '1', 10);
      if (ownerCount <= 1) {
        throw new AppError(
          400,
          'CANNOT_REMOVE_LAST_OWNER',
          'Cannot demote the sole business owner. Appoint another owner or transfer ownership first.'
        );
      }
    }

    await client.query(
      `UPDATE memberships SET role = $1, updated_at = NOW() WHERE business_id = $2 AND id = $3`,
      [targetRole, businessId, memberId]
    );

    const bizRes = await client.query<{ name: string }>('SELECT name FROM businesses WHERE id = $1', [businessId]);
    const businessName = bizRes.rows[0]?.name || 'Rota Business';

    await syncEntryToDirectory(member.user_id, businessId, businessName, targetRole, member.status);
    await recordMembershipOutbox(client, businessId, member.user_id, businessName, targetRole, member.status, 'upsert');

    return { id: memberId, role: targetRole, oldRole: member.role };
  });

  try {
    await emitActivityEvent(businessId, {
      type: 'membership.role_changed',
      visibilityClass: 'membership',
      actorMembershipId: actor.membershipId || null,
      subjectMembershipId: updated.id,
      payload: {
        oldRole: updated.oldRole,
        newRole: updated.role,
        actorEmail: actor.email,
      },
    });
  } catch (_evtErr) {
    // Audit event failures should not abort the update
  }

  await cacheService.invalidatePrefix(businessId, 'roster');
  return { id: updated.id, role: updated.role };
}

/**
 * Removes or deactivates a member safely without deleting past attendance or ledger history.
 */
export async function removeOrganizationMember(
  businessId: string,
  actor: AuthenticatedUser,
  memberId: string
): Promise<{ success: boolean; message: string }> {
  const actorRole = (actor.role || 'staff').toLowerCase();

  if (!['owner', 'co_owner', 'gm'].includes(actorRole)) {
    throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions to remove team members');
  }

  const removed = await withTenantContext(businessId, async (client) => {
    const memberRes = await client.query<{ id: string; user_id: string; role: string; status: string }>(
      'SELECT id, user_id, role, status FROM memberships WHERE business_id = $1 AND id = $2',
      [businessId, memberId]
    );

    if (memberRes.rowCount === 0) {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Team member not found');
    }

    const member = memberRes.rows[0];

    // Cannot remove sole owner
    if (member.role === 'owner') {
      const ownerCountRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM memberships WHERE business_id = $1 AND role = 'owner' AND status = 'active'`
      );
      const ownerCount = parseInt(ownerCountRes.rows[0]?.count || '1', 10);
      if (ownerCount <= 1) {
        throw new AppError(400, 'CANNOT_REMOVE_LAST_OWNER', 'Cannot remove the sole business owner');
      }
      if (actorRole !== 'owner') {
        throw new AppError(403, 'FORBIDDEN', 'Only an owner can remove another owner');
      }
    }

    if (member.role === 'co_owner' && actorRole !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only an owner can remove a co-owner');
    }

    if (member.role === 'gm' && !['owner', 'co_owner'].includes(actorRole)) {
      throw new AppError(403, 'FORBIDDEN', 'Only owners or co-owners can remove a manager (GM)');
    }

    // Soft-deactivate membership to preserve attendance and audit history integrity
    await client.query(
      `UPDATE memberships SET status = 'inactive', updated_at = NOW() WHERE business_id = $1 AND id = $2`,
      [businessId, memberId]
    );

    // Unassign from upcoming future shifts (starts_at > NOW())
    await client.query(
      `DELETE FROM shift_assignments sa
       USING shifts s
       WHERE sa.business_id = $1 AND sa.shift_id = s.id AND sa.membership_id = $2 AND s.starts_at > NOW()`,
      [businessId, memberId]
    );

    // Cancel pending swap requests
    await client.query(
      `UPDATE swap_requests
       SET status = 'cancelled'
       WHERE business_id = $1 AND (requester_membership_id = $2 OR counterpart_membership_id = $2)
         AND status IN ('pending', 'peer_accepted')`,
      [businessId, memberId]
    );

    // Update directory and outbox
    const bizRes = await client.query<{ name: string }>('SELECT name FROM businesses WHERE id = $1', [businessId]);
    const businessName = bizRes.rows[0]?.name || 'Rota Business';

    await syncEntryToDirectory(member.user_id, businessId, businessName, member.role, 'inactive');
    await recordMembershipOutbox(client, businessId, member.user_id, businessName, member.role, 'inactive', 'upsert');

    // Revoke any active sessions scoped to this business
    await controlPool.query(
      `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'MEMBERSHIP_DEACTIVATED'
       WHERE user_id = $1 AND active_business_id = $2`,
      [member.user_id, businessId]
    );

    return {
      success: true,
      message: 'Team member removed successfully',
      removedUserId: member.user_id,
      role: member.role,
    };
  });

  try {
    await emitActivityEvent(businessId, {
      type: 'membership.removed',
      visibilityClass: 'membership',
      actorMembershipId: actor.membershipId || null,
      subjectMembershipId: memberId,
      payload: {
        removedUserId: removed.removedUserId,
        role: removed.role,
        actorEmail: actor.email,
      },
    });
  } catch (_evtErr) {
    // Non-blocking activity audit event
  }

  await cacheService.invalidatePrefix(businessId, 'roster');
  return { success: true, message: removed.message };
}

/**
 * Transfers business ownership to another active member.
 */
export async function transferOrganizationOwnership(
  businessId: string,
  actor: AuthenticatedUser,
  targetMemberId: string
): Promise<{ success: boolean; message: string }> {
  if (actor.role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Only the organization owner can transfer ownership');
  }

  const transferred = await withTenantContext(businessId, async (client) => {
    const targetRes = await client.query<{ id: string; user_id: string; role: string; status: string }>(
      'SELECT id, user_id, role, status FROM memberships WHERE business_id = $1 AND id = $2',
      [businessId, targetMemberId]
    );

    if (targetRes.rowCount === 0 || targetRes.rows[0].status !== 'active') {
      throw new AppError(404, 'MEMBER_NOT_FOUND', 'Target member is not an active member of this organization');
    }

    const target = targetRes.rows[0];

    // Promote target to owner
    await client.query(
      `UPDATE memberships SET role = 'owner', updated_at = NOW() WHERE business_id = $1 AND id = $2`,
      [businessId, targetMemberId]
    );

    // Demote current owner to co_owner
    if (actor.membershipId && actor.membershipId !== targetMemberId) {
      await client.query(
        `UPDATE memberships SET role = 'co_owner', updated_at = NOW() WHERE business_id = $1 AND id = $2`,
        [businessId, actor.membershipId]
      );
    }

    const bizRes = await client.query<{ name: string }>('SELECT name FROM businesses WHERE id = $1', [businessId]);
    const businessName = bizRes.rows[0]?.name || 'Rota Business';

    await syncEntryToDirectory(target.user_id, businessId, businessName, 'owner', 'active');
    if (actor.membershipId && actor.membershipId !== targetMemberId) {
      await syncEntryToDirectory(actor.id, businessId, businessName, 'co_owner', 'active');
    }

    return {
      success: true,
      message: 'Ownership transferred successfully',
      targetUserId: target.user_id,
    };
  });

  try {
    await emitActivityEvent(businessId, {
      type: 'business.ownership_transferred',
      visibilityClass: 'security',
      actorMembershipId: actor.membershipId || null,
      subjectMembershipId: targetMemberId,
      payload: {
        newOwnerId: transferred.targetUserId,
        previousOwnerId: actor.id,
      },
    });
  } catch (_evtErr) {
    // Non-blocking activity audit
  }

  await cacheService.invalidatePrefix(businessId, 'roster');
  return { success: true, message: transferred.message };
}

/**
 * Deactivates and deletes an organization.
 */
export async function deleteOrganization(
  businessId: string,
  actor: AuthenticatedUser
): Promise<{ success: boolean; message: string }> {
  if (actor.role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Only the organization owner can delete the organization');
  }

  return withTenantContext(businessId, async (client) => {
    // 1. Cancel future shifts
    await client.query(
      `UPDATE shifts SET status = 'cancelled' WHERE business_id = $1 AND starts_at > NOW()`,
      [businessId]
    );

    // 2. Cancel subscription
    await client.query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW() WHERE business_id = $1`,
      [businessId]
    );

    // 3. Deactivate all memberships in shard
    await client.query(
      `UPDATE memberships SET status = 'inactive', updated_at = NOW() WHERE business_id = $1`,
      [businessId]
    );

    // 4. Update control plane directory
    await controlPool.query(
      `UPDATE membership_directory SET status = 'inactive', updated_at = NOW() WHERE business_id = $1`,
      [businessId]
    );

    // 5. Revoke all active sessions scoped to this business
    await controlPool.query(
      `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'ORGANIZATION_DELETED' WHERE active_business_id = $1`,
      [businessId]
    );

    return { success: true, message: 'Organization deleted and deactivated successfully' };
  });
}

/**
 * Deletes a personal user account after verifying credentials and verifying sole-owner protection.
 */
export async function deleteUserAccount(
  userId: string,
  passwordVerify: string
): Promise<{ success: boolean; message: string }> {
  const userRes = await controlPool.query<{ id: string; password_hash: string; email: string }>(
    'SELECT id, password_hash, email FROM users WHERE id = $1',
    [userId]
  );

  if (userRes.rowCount === 0) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User account not found');
  }

  const user = userRes.rows[0];
  const isValidPassword = await verifyPassword(user.password_hash, passwordVerify);
  if (!isValidPassword) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect password. Account deletion aborted.');
  }

  // Check sole-ownership across all active businesses in membership_directory
  const ownedBizRes = await controlPool.query<{ business_id: string; business_name: string }>(
    `SELECT business_id, business_name
     FROM membership_directory
     WHERE user_id = $1 AND role = 'owner' AND status = 'active'`,
    [userId]
  );

  for (const biz of ownedBizRes.rows) {
    const otherOwners = await controlPool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM membership_directory
       WHERE business_id = $1 AND role = 'owner' AND status = 'active' AND user_id != $2`,
      [biz.business_id, userId]
    );
    const count = parseInt(otherOwners.rows[0]?.count || '0', 10);
    if (count === 0) {
      throw new AppError(
        409,
        'SOLE_OWNER_CANNOT_DELETE',
        `You are the sole owner of business "${biz.business_name}". You must transfer ownership or delete the business before deleting your personal account.`
      );
    }
  }

  // Deactivate memberships in directory
  await controlPool.query(
    `UPDATE membership_directory SET status = 'inactive', updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );

  // Soft-delete user in control plane: scramble email and mark deleted
  const anonymizedEmail = `deleted_${userId.slice(0, 8)}_${Date.now()}@rota.local`;
  await controlPool.query(
    `UPDATE users
     SET status = 'deleted', email = $1, name = 'Deleted User', updated_at = NOW()
     WHERE id = $2`,
    [anonymizedEmail, userId]
  );

  // Revoke all sessions
  await controlPool.query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'ACCOUNT_DELETED' WHERE user_id = $1`,
    [userId]
  );

  return { success: true, message: 'Account deleted and all active sessions revoked.' };
}

