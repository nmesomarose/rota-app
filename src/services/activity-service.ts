import { withTenantContext } from '../db/tenant-context.ts';
import type { AuthenticatedUser } from '../middleware/auth-middleware.ts';
import { AppError } from '../utils/errors.ts';

export type VisibilityClass =
  | 'schedule'
  | 'swap'
  | 'attendance'
  | 'membership'
  | 'override'
  | 'billing'
  | 'security'
  | 'public';

export interface EmitEventInput {
  type: string;
  branchId?: string | null;
  departmentId?: string | null;
  actorMembershipId?: string | null;
  subjectMembershipId?: string | null;
  visibilityClass: VisibilityClass;
  payload?: Record<string, unknown>;
}

export interface ActivityEvent {
  id: string;
  business_id: string;
  created_at: string;
  type: string;
  branch_id: string | null;
  department_id: string | null;
  actor_membership_id: string | null;
  subject_membership_id: string | null;
  visibility_class: VisibilityClass;
  payload: Record<string, unknown>;
}

export interface GetFeedOptions {
  limit?: number;
  cursor?: string;
}

export interface FeedResponse {
  events: ActivityEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  const payload: CursorPayload = { createdAt: iso, id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursorStr: string): CursorPayload {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.createdAt || !parsed.id) {
      throw new Error('Malformed cursor payload');
    }
    return parsed;
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'The supplied pagination cursor is invalid or malformed');
  }
}

/**
 * Emits an activity event into the tenant shard with forced RLS and tenant scoping (FR-ACT-005).
 */
export async function emitActivityEvent(
  businessId: string,
  input: EmitEventInput
): Promise<ActivityEvent> {
  return withTenantContext(businessId, async (client) => {
    const res = await client.query<ActivityEvent>(
      `INSERT INTO activity_events (
        business_id,
        type,
        branch_id,
        department_id,
        actor_membership_id,
        subject_membership_id,
        visibility_class,
        payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, business_id, created_at, type, branch_id, department_id,
                actor_membership_id, subject_membership_id, visibility_class, payload`,
      [
        businessId,
        input.type,
        input.branchId || null,
        input.departmentId || null,
        input.actorMembershipId || null,
        input.subjectMembershipId || null,
        input.visibilityClass,
        JSON.stringify(input.payload || {}),
      ]
    );

    return res.rows[0];
  });
}

/**
 * Retrieves cursor-paginated activity feed with role-based visibility resolution on the server (FR-ACT-001..007, AC-014, AC-ACT-01..05).
 */
export async function getActivityFeed(
  businessId: string,
  user: AuthenticatedUser,
  options: GetFeedOptions = {}
): Promise<FeedResponse> {
  const limit = Math.min(Math.max(1, Number(options.limit) || 50), 50);
  const membershipId = user.membershipId;
  const role = (user.role || 'staff').toLowerCase();
  const departmentId = user.departmentId;

  let cursorData: CursorPayload | null = null;
  if (options.cursor) {
    cursorData = decodeCursor(options.cursor);
  }

  return withTenantContext(businessId, async (client) => {
    // Build SQL query parameters and conditions
    const params: unknown[] = [businessId];
    const conditions: string[] = ['business_id = $1'];

    // 1. Role-based server-side audience filtering (Section 4.6, FR-ACT-005, FR-ACT-007, AC-ACT-01, AC-ACT-02)
    if (role === 'owner') {
      // Owners can see all event classes within their business
    } else if (role === 'gm') {
      // GM: No billing events; security events visible only if GM is actor or subject
      params.push(membershipId);
      const memParamIdx = params.length;
      conditions.push(`visibility_class <> 'billing'`);
      conditions.push(`(visibility_class <> 'security' OR actor_membership_id = $${memParamIdx} OR subject_membership_id = $${memParamIdx})`);
    } else if (role === 'supervisor') {
      // Supervisor: No billing events; security only if self; department events for own dept or self
      params.push(membershipId);
      const memParamIdx = params.length;
      params.push(departmentId);
      const deptParamIdx = params.length;

      conditions.push(`visibility_class <> 'billing'`);
      conditions.push(`(visibility_class <> 'security' OR actor_membership_id = $${memParamIdx} OR subject_membership_id = $${memParamIdx})`);
      conditions.push(`(
        actor_membership_id = $${memParamIdx}
        OR subject_membership_id = $${memParamIdx}
        OR department_id = $${deptParamIdx}
        OR visibility_class = 'public'
      )`);
    } else {
      // Staff (FR-ACT-005, AC-ACT-01):
      // - No billing, no member lifecycle events
      // - Security: only self
      // - Schedule: only if concerns them (actor/subject or in payload)
      // - Swap: participants only
      // - Availability override: subject only
      // - Attendance and absence: subject only (others' attendance does not appear)
      params.push(membershipId);
      const memParamIdx = params.length;

      conditions.push(`visibility_class NOT IN ('billing', 'membership')`);
      conditions.push(`(
        (visibility_class = 'security' AND (actor_membership_id = $${memParamIdx} OR subject_membership_id = $${memParamIdx}))
        OR (visibility_class = 'schedule' AND (actor_membership_id = $${memParamIdx} OR subject_membership_id = $${memParamIdx} OR payload->>'membershipId' = $${memParamIdx}::text OR payload->>'counterpartMembershipId' = $${memParamIdx}::text))
        OR (visibility_class = 'swap' AND (actor_membership_id = $${memParamIdx} OR subject_membership_id = $${memParamIdx}))
        OR (visibility_class = 'override' AND subject_membership_id = $${memParamIdx})
        OR (visibility_class = 'attendance' AND subject_membership_id = $${memParamIdx})
        OR visibility_class = 'public'
      )`);
    }

    // 2. Cursor condition (created_at < cursor.createdAt OR (created_at = cursor.createdAt AND id < cursor.id))
    if (cursorData) {
      params.push(new Date(cursorData.createdAt));
      const createdParamIdx = params.length;
      params.push(cursorData.id);
      const idParamIdx = params.length;

      conditions.push(`(
        created_at < $${createdParamIdx}
        OR (created_at = $${createdParamIdx} AND id < $${idParamIdx})
      )`);
    }

    // Fetch limit + 1 to determine if there are more records
    params.push(limit + 1);
    const limitParamIdx = params.length;

    const query = `
      SELECT
        id,
        business_id,
        created_at,
        type,
        branch_id,
        department_id,
        actor_membership_id,
        subject_membership_id,
        visibility_class,
        payload
      FROM activity_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParamIdx}
    `;

    const res = await client.query<ActivityEvent>(query, params);
    const rows = res.rows;

    const hasMore = rows.length > limit;
    if (hasMore) {
      rows.pop();
    }

    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor(last.created_at, last.id);
    }

    return {
      events: rows,
      nextCursor,
      hasMore,
    };
  });
}
