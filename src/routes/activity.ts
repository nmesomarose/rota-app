import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth-middleware.ts';
import { getActivityFeed, emitActivityEvent, type VisibilityClass } from '../services/activity-service.ts';
import { sendError, AppError } from '../utils/errors.ts';

export const activityRouter = Router();

const EmitEventSchema = z.object({
  type: z.string().min(1),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  subjectMembershipId: z.string().uuid().optional(),
  visibilityClass: z.enum([
    'schedule',
    'swap',
    'attendance',
    'membership',
    'override',
    'billing',
    'security',
    'public',
  ]),
  payload: z.record(z.unknown()).optional(),
});

/**
 * GET /v1/activity
 * Cursor-paginated activity feed with server-side role-based scoping (FR-ACT-001..007, AC-014, AC-ACT-01..05).
 */
activityRouter.get(
  '/v1/activity',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    try {
      const feed = await getActivityFeed(req.user!.businessId!, req.user!, {
        limit,
        cursor,
      });
      res.status(200).json(feed);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve activity feed');
    }
  }
);

/**
 * POST /v1/activity/events
 * Emits an activity event (Owner/GM or system operations).
 */
activityRouter.post(
  '/v1/activity/events',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'gm']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = EmitEventSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const event = await emitActivityEvent(req.user!.businessId!, {
        type: parsed.data.type,
        branchId: parsed.data.branchId,
        departmentId: parsed.data.departmentId,
        actorMembershipId: req.user!.membershipId,
        subjectMembershipId: parsed.data.subjectMembershipId,
        visibilityClass: parsed.data.visibilityClass as VisibilityClass,
        payload: parsed.data.payload,
      });
      res.status(201).json({ event });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to emit activity event');
    }
  }
);
