import { type Request, type Response, type NextFunction } from 'express';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { verifyAccessToken, type AccessTokenPayload } from '../services/token-service.ts';
import { sendError, AppError } from '../utils/errors.ts';

export interface AuthenticatedUser {
  id: string;
  email: string;
  sessionId: string;
  businessId: string | null;
  role: string | null;
  membershipId?: string;
  branchId?: string | null;
  departmentId?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Extracts and validates the Bearer token, checks authoritative database session state,
 * and sets trusted req.user context.
 *
 * Security:
 * - Active business context is derived strictly from server-side verified token claims.
 * - Client-supplied business IDs in headers/body/query are never trusted for identity or scoping.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Bearer token is missing or malformed');
    return;
  }

  const rawToken = authHeader.slice(7).trim();
  let claims: AccessTokenPayload;
  try {
    claims = verifyAccessToken(rawToken);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message);
      return;
    }
    sendError(req, res, 401, 'INVALID_TOKEN', 'Failed to authenticate token');
    return;
  }

  try {
    // 1. Authoritative session verification in control-plane database (FR-AUTH-005, FR-AUTH-013)
    const sessionRes = await controlPool.query<{
      id: string;
      user_id: string;
      active_business_id: string | null;
      revoked_at: string | null;
      expires_at: string;
    }>(
      'SELECT id, user_id, active_business_id, revoked_at, expires_at FROM sessions WHERE id = $1',
      [claims.sessionId]
    );

    if (sessionRes.rowCount === 0) {
      sendError(req, res, 401, 'SESSION_REVOKED', 'Session no longer exists');
      return;
    }

    const session = sessionRes.rows[0];
    if (session.revoked_at !== null) {
      sendError(req, res, 401, 'SESSION_REVOKED', 'Session has been revoked');
      return;
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      sendError(req, res, 401, 'SESSION_EXPIRED', 'Session has expired');
      return;
    }

    // 2. Authoritative user account status verification
    const userRes = await controlPool.query<{ id: string; email: string; status: string }>(
      'SELECT id, email, status FROM users WHERE id = $1',
      [claims.sub]
    );

    if (userRes.rowCount === 0 || userRes.rows[0].status !== 'active') {
      sendError(req, res, 401, 'ACCOUNT_INACTIVE', 'User account is inactive or suspended');
      return;
    }

    // Context derived strictly from token claims (not client headers or params)
    const activeBusinessId = claims.businessId;

    req.user = {
      id: claims.sub,
      email: claims.email,
      sessionId: claims.sessionId,
      businessId: activeBusinessId,
      role: claims.role,
    };

    next();
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown database error';
    console.error('[AuthMiddleware Error]', errorMsg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Authentication verification failed');
  }
}

/**
 * Requires that the authenticated user has an active business context,
 * and authoritatively verifies tenant membership and role on the tenant shard (FR-RBAC-006).
 */
export async function requireTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
    return;
  }

  if (!req.user.businessId) {
    sendError(
      req,
      res,
      400,
      'BUSINESS_CONTEXT_REQUIRED',
      'This action requires an active business context. Please switch to a business first.'
    );
    return;
  }

  const businessId = req.user.businessId;
  const userId = req.user.id;

  try {
    // Authoritatively check membership status and role from tenant shard (FR-RBAC-006)
    const membership = await withTenantContext(businessId, async (client) => {
      const res = await client.query<{
        id: string;
        role: string;
        status: string;
        branch_id: string | null;
        department_id: string | null;
      }>(
        `SELECT id, role, status, branch_id, department_id
         FROM memberships
         WHERE business_id = $1 AND user_id = $2`,
        [businessId, userId]
      );
      return res.rows[0] || null;
    });

    if (!membership || membership.status !== 'active') {
      sendError(
        req,
        res,
        403,
        'MEMBERSHIP_INACTIVE',
        'Your membership in this business is inactive or revoked'
      );
      return;
    }

    // Role is taken strictly from the authoritative tenant database, not token claims
    req.user.role = membership.role;
    req.user.membershipId = membership.id;
    req.user.branchId = membership.branch_id;
    req.user.departmentId = membership.department_id;

    next();
  } catch (_err) {
    sendError(req, res, 404, 'NOT_FOUND', 'Target business not found or access denied');
  }
}

/**
 * Restricts access to specific roles.
 */
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.role) {
      sendError(req, res, 403, 'FORBIDDEN', 'Insufficient permissions');
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      sendError(req, res, 403, 'FORBIDDEN', `Role '${req.user.role}' is not authorized for this resource`);
      return;
    }

    next();
  };
}
