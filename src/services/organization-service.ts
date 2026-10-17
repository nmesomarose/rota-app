import { randomUUID } from 'node:crypto';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { recordMembershipOutbox, syncEntryToDirectory } from './outbox-service.ts';
import { signAccessToken, ACCESS_TOKEN_EXPIRY_SECONDS } from './token-service.ts';
import { AppError } from '../utils/errors.ts';

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
