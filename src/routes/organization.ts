import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../middleware/auth-middleware.ts';
import { invitationCreateLimiter, invitationAcceptLimiter } from '../middleware/rate-limiter.ts';
import {
  onboardBusiness,
  getOrganizationMembers,
  inviteOrganizationMember,
  acceptOrganizationInvitation,
  getInvitationDetails,
  updateOrganizationMemberRole,
  removeOrganizationMember,
  transferOrganizationOwnership,
  deleteOrganization,
} from '../services/organization-service.ts';
import { sendError, AppError } from '../utils/errors.ts';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';

export const organizationRouter = Router();

const OnboardSchema = z.object({
  name: z.string().min(2, 'Business name must be at least 2 characters'),
  timezone: z.string().optional(),
  branchName: z.string().min(1).optional(),
  departments: z.array(z.string().min(1)).optional(),
});

/**
 * POST /v1/organizations
 * Onboards a new business, creating business, default branch, initial departments,
 * owner membership, starter subscription (5 seats), and directory synchronization.
 */
organizationRouter.post(
  '/v1/organizations',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      if (!req.user) {
        sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
        return;
      }

      const result = await onboardBusiness(
        req.user.id,
        req.user.email,
        req.user.sessionId,
        parsed.data
      );

      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Onboarding failed';
      console.error('[Onboarding Error]', msg);
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to onboard organization');
    }
  }
);

/**
 * GET /v1/organizations
 * Lists all organizations where the authenticated user holds an active membership.
 */
organizationRouter.get(
  '/v1/organizations',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
        return;
      }

      const dirRes = await controlPool.query(
        `SELECT business_id, business_name, role, status, created_at
         FROM membership_directory
         WHERE user_id = $1 AND status = 'active'
         ORDER BY created_at ASC`,
        [req.user.id]
      );

      res.status(200).json({ organizations: dirRes.rows });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to list organizations';
      console.error('[List Organizations Error]', msg);
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to list organizations');
    }
  }
);

/**
 * GET /v1/organizations/:id
 * Fetches organization details for the active business.
 * Strictly verifies that the requested business matches the authenticated business context.
 * Cross-business attempts return 404 NOT_FOUND per SEC-015 and AC-TEN-01.
 */
organizationRouter.get(
  '/v1/organizations/:id',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id;

    // Reject cross-tenant access with 404 NOT_FOUND (never 403 or disclosure)
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    try {
      const businessData = await withTenantContext(requestedId, async (client) => {
        const bizRes = await client.query(
          'SELECT id, name, timezone, created_at FROM businesses WHERE id = $1',
          [requestedId]
        );
        if (bizRes.rowCount === 0) return null;

        const branchRes = await client.query(
          'SELECT id, name, created_at FROM branches WHERE business_id = $1',
          [requestedId]
        );

        const deptRes = await client.query(
          'SELECT id, branch_id, name, created_at FROM departments WHERE business_id = $1',
          [requestedId]
        );

        const subRes = await client.query(
          'SELECT plan, billing_currency, seat_quantity, status FROM subscriptions WHERE business_id = $1',
          [requestedId]
        );

        return {
          business: bizRes.rows[0],
          branches: branchRes.rows,
          departments: deptRes.rows,
          subscription: subRes.rows[0] || null,
        };
      });

      if (!businessData) {
        sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
        return;
      }

      res.status(200).json(businessData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error fetching organization';
      console.error('[Get Organization Error]', msg);
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve organization details');
    }
  }
);

const InviteSchema = z.object({
  email: z.string().email('Valid email is required'),
  name: z.string().min(1).optional(),
  role: z.enum(['owner', 'co_owner', 'gm', 'supervisor', 'staff']),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
});

const UpdateRoleSchema = z.object({
  role: z.enum(['owner', 'co_owner', 'gm', 'supervisor', 'staff']),
});

const TransferOwnershipSchema = z.object({
  targetMemberId: z.string().uuid('Valid target member UUID is required'),
});

/**
 * GET /v1/organizations/:id/members
 * Lists all team members within the active business context.
 */
organizationRouter.get(
  '/v1/organizations/:id/members',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id;
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    try {
      const members = await getOrganizationMembers(requestedId);
      res.status(200).json({ members });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to load team members');
    }
  }
);

/**
 * POST /v1/organizations/:id/members/invite
 * Invites a team member with role-based authorization and subscription seat validation.
 */
organizationRouter.post(
  '/v1/organizations/:id/members/invite',
  requireAuth,
  requireTenant,
  invitationCreateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id;
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    const parsed = InviteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const invitation = await inviteOrganizationMember(requestedId, req.user!, parsed.data);
      res.status(201).json({ invitation });
    } catch (err: unknown) {
      console.error('[Invite Error]', err);
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to invite team member');
    }
  }
);

const AcceptInvitationSchema = z.object({
  token: z.string().min(1, 'Invitation token is required'),
});

/**
 * GET /v1/organizations/invitations/:token and GET /v1/invitations/:token
 * Public preview endpoint for team invitations.
 */
const getInvitationHandler = async (req: Request, res: Response): Promise<void> => {
  const token = req.params.token as string;
  try {
    const invitation = await getInvitationDetails(token);
    res.status(200).json({ invitation });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Failed to retrieve invitation';
    console.error('[GetInvitation Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve invitation');
  }
};

organizationRouter.get('/v1/organizations/invitations/:token', getInvitationHandler);
organizationRouter.get('/v1/invitations/:token', getInvitationHandler);

/**
 * POST /v1/organizations/invitations/accept and POST /v1/invitations/accept
 * Server-side invitation acceptance enforcing email binding, permission persistence, and atomic seat limits.
 */
const acceptInvitationHandler = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
    return;
  }

  const parsed = AcceptInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await acceptOrganizationInvitation(parsed.data.token, req.user);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Failed to accept invitation';
    console.error('[AcceptInvitation Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to accept invitation');
  }
};

organizationRouter.post('/v1/organizations/invitations/accept', requireAuth, invitationAcceptLimiter, acceptInvitationHandler);
organizationRouter.post('/v1/invitations/accept', requireAuth, invitationAcceptLimiter, acceptInvitationHandler);


/**
 * PATCH /v1/organizations/:id/members/:memberId/role
 * Updates a member's role (supervisor appointment, manager promotion, etc.)
 */
organizationRouter.patch(
  '/v1/organizations/:id/members/:memberId/role',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id as string;
    const memberId = req.params.memberId as string;
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    const parsed = UpdateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const result = await updateOrganizationMemberRole(requestedId, req.user!, memberId, parsed.data.role);
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to update member role');
    }
  }
);

/**
 * DELETE /v1/organizations/:id/members/:memberId
 * Deactivates or removes a team member safely.
 */
organizationRouter.delete(
  '/v1/organizations/:id/members/:memberId',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id as string;
    const memberId = req.params.memberId as string;
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    try {
      const result = await removeOrganizationMember(requestedId, req.user!, memberId);
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to remove member');
    }
  }
);

/**
 * POST /v1/organizations/:id/transfer-ownership
 * Transfers organization ownership to another active member.
 */
organizationRouter.post(
  '/v1/organizations/:id/transfer-ownership',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id;
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    const parsed = TransferOwnershipSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const result = await transferOrganizationOwnership(requestedId, req.user!, parsed.data.targetMemberId);
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to transfer ownership');
    }
  }
);

/**
 * DELETE /v1/organizations/:id
 * Owner deletes and deactivates the organization.
 */
organizationRouter.delete(
  '/v1/organizations/:id',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const requestedId = req.params.id;
    if (requestedId !== req.user?.businessId) {
      sendError(req, res, 404, 'NOT_FOUND', 'Organization not found');
      return;
    }

    try {
      const result = await deleteOrganization(requestedId, req.user!);
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to delete organization');
    }
  }
);

