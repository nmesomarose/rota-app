import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth-middleware.ts';
import {
  createShift,
  updateShift,
  deleteShift,
  assignWorker,
  unassignWorker,
  createStaffingRequirement,
  generateShiftsFromRequirement,
  submitAvailability,
  publishSchedule,
  getSchedule,
} from '../services/scheduling-service.ts';
import { detectAssignmentConflicts } from '../services/conflict-service.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { sendError, AppError } from '../utils/errors.ts';

export const schedulingRouter = Router();

const CreateShiftSchema = z.object({
  branchId: z.string().uuid('Valid branch UUID is required').optional().nullable().or(z.literal('')),
  departmentId: z.string().uuid('Valid department UUID is required').optional().nullable().or(z.literal('')),
  startsAt: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'startsAt must be a valid ISO 8601 date string',
  }),
  endsAt: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'endsAt must be a valid ISO 8601 date string',
  }),
  timeZone: z.string().optional(),
  status: z.enum(['draft', 'review', 'published']).optional(),
});

const UpdateShiftSchema = z.object({
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  status: z.enum(['draft', 'review', 'published', 'cancelled']).optional(),
  departmentId: z.string().uuid().optional(),
});

const AssignWorkerSchema = z.object({
  membershipId: z.string().uuid('Valid membership UUID is required'),
  overrideReason: z.string().optional(),
});

const CreateRequirementSchema = z.object({
  branchId: z.string().uuid('Valid branch UUID is required'),
  departmentId: z.string().uuid('Valid department UUID is required'),
  roleLabel: z.string().min(1).optional(),
  headcount: z.number().int().positive().optional(),
  localStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM 24h format'),
  localEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM 24h format'),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  timeZone: z.string().optional(),
});

const GenerateShiftsSchema = z.object({
  dateStr: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD format'),
});

const SubmitAvailabilitySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM 24h format'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM 24h format'),
  preference: z.enum(['available', 'unavailable', 'preferred']).optional(),
});

const PublishScheduleSchema = z.object({
  shiftIds: z.array(z.string().uuid()).min(1),
});

/**
 * POST /v1/scheduling/shifts
 * Creates a shift in draft mode with version initialized to 1.
 */
schedulingRouter.post(
  '/v1/scheduling/shifts',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const shift = await createShift(req.user!.businessId!, parsed.data);
      res.status(201).json({ shift });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to create shift');
    }
  }
);

/**
 * PATCH /v1/scheduling/shifts/:id
 * Updates a shift and increments its monotonic version (FR-SWP-007).
 */
schedulingRouter.patch(
  '/v1/scheduling/shifts/:id',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const shiftId = req.params.id as string;
    const parsed = UpdateShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const updated = await updateShift(req.user!.businessId!, shiftId, parsed.data);
      res.status(200).json({ shift: updated });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to update shift');
    }
  }
);

/**
 * DELETE /v1/scheduling/shifts/:id
 * Deletes a shift. Direct shift deletion is forbidden for Staff (FR-RBAC-002, AC-002).
 */
schedulingRouter.delete(
  '/v1/scheduling/shifts/:id',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const shiftId = req.params.id as string;
    try {
      const result = await deleteShift(req.user!.businessId!, shiftId, req.user!.role!);
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to delete shift');
    }
  }
);

/**
 * POST /v1/scheduling/shifts/:id/assign
 * Assigns worker to a shift with conflict checking and reasoned manager overrides.
 */
schedulingRouter.post(
  '/v1/scheduling/shifts/:id/assign',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const shiftId = req.params.id as string;
    const parsed = AssignWorkerSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const result = await assignWorker(
        req.user!.businessId!,
        shiftId,
        parsed.data.membershipId,
        req.user!.membershipId!,
        req.user!.role!,
        req.id || 'unknown',
        parsed.data.overrideReason
      );

      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to assign worker to shift');
    }
  }
);

/**
 * DELETE /v1/scheduling/shifts/:id/assign/:membershipId
 * Unassigns a worker from a shift.
 */
schedulingRouter.delete(
  '/v1/scheduling/shifts/:id/assign/:membershipId',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const shiftId = req.params.id as string;
    const membershipId = req.params.membershipId as string;
    try {
      const result = await unassignWorker(
        req.user!.businessId!,
        shiftId,
        membershipId,
        req.user!.role!
      );
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to unassign worker');
    }
  }
);

/**
 * POST /v1/scheduling/requirements
 * Creates a recurring staffing requirement in local wall-clock time (FR-SCH-009).
 */
schedulingRouter.post(
  '/v1/scheduling/requirements',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateRequirementSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const requirement = await createStaffingRequirement(req.user!.businessId!, parsed.data);
      res.status(201).json({ requirement });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to create staffing requirement');
    }
  }
);

/**
 * POST /v1/scheduling/requirements/:id/generate
 * Generates shifts from recurring staffing requirements for a specific date (FR-SCH-009, AC-SCH-03).
 */
schedulingRouter.post(
  '/v1/scheduling/requirements/:id/generate',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const requirementId = req.params.id as string;
    const parsed = GenerateShiftsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const shifts = await generateShiftsFromRequirement(
        req.user!.businessId!,
        requirementId,
        parsed.data.dateStr
      );
      res.status(201).json({ shifts, count: shifts.length });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate shifts');
    }
  }
);

/**
 * POST /v1/scheduling/availability
 * Submits staff availability preference (FR-AVL-001).
 */
schedulingRouter.post(
  '/v1/scheduling/availability',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = SubmitAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const availability = await submitAvailability(
        req.user!.businessId!,
        req.user!.membershipId!,
        parsed.data
      );
      res.status(201).json({ availability });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to submit availability');
    }
  }
);

/**
 * POST /v1/scheduling/publish
 * Publishes a set of shifts, moving them from draft/review to published (AC-SCH-02).
 */
schedulingRouter.post(
  '/v1/scheduling/publish',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = PublishScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const published = await publishSchedule(req.user!.businessId!, parsed.data.shiftIds);
      res.status(200).json({ published, count: published.length });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to publish shifts');
    }
  }
);

/**
 * GET /v1/scheduling/shifts
 * Retrieves shifts schedule. Staff members see ONLY published shifts (AC-SCH-02).
 */
schedulingRouter.get(
  '/v1/scheduling/shifts',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const shifts = await getSchedule(req.user!.businessId!, req.user!.role!, {
        departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined,
        branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
      });

      res.status(200).json({ shifts });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve shifts');
    }
  }
);

/**
 * GET /v1/scheduling/conflicts
 * Inspects potential conflicts for an assignment before committing.
 */
schedulingRouter.get(
  '/v1/scheduling/conflicts',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'co_owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const shiftId = req.query.shiftId;
    const membershipId = req.query.membershipId;

    if (typeof shiftId !== 'string' || typeof membershipId !== 'string') {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'shiftId and membershipId query parameters are required');
      return;
    }

    try {
      const analysis = await withTenantContext(req.user!.businessId!, async (client) => {
        return detectAssignmentConflicts(client, req.user!.businessId!, shiftId, membershipId);
      });

      res.status(200).json(analysis);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to analyze conflicts');
    }
  }
);
