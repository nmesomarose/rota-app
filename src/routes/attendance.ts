import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth-middleware.ts';
import { recordAttendance, listAttendance } from '../services/attendance-service.ts';
import { sendError, AppError } from '../utils/errors.ts';

export const attendanceRouter = Router();

const RecordAttendanceSchema = z.object({
  shiftAssignmentId: z.string().uuid('Valid shift assignment UUID is required'),
  state: z.enum(['present', 'late', 'absent']),
  notes: z.string().optional(),
});

/**
 * POST /v1/attendance
 * Records present, late, or absent for a published shift (FR-ATT-001, FR-ATT-002, AC-SCH-07).
 * Managers only (Owner, GM, Supervisor).
 */
attendanceRouter.post(
  '/v1/attendance',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RecordAttendanceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const record = await recordAttendance(
        req.user!.businessId!,
        req.user!.membershipId!,
        req.user!.role!,
        req.user!.departmentId,
        parsed.data
      );
      res.status(201).json({ attendance: record });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to record attendance');
    }
  }
);

/**
 * GET /v1/attendance
 * Lists attendance records with role-based scoping (AC-ACT-01).
 */
attendanceRouter.get(
  '/v1/attendance',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const shiftId = typeof req.query.shiftId === 'string' ? req.query.shiftId : undefined;
    const membershipId = typeof req.query.membershipId === 'string' ? req.query.membershipId : undefined;
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined;

    try {
      const records = await listAttendance(
        req.user!.businessId!,
        req.user!.membershipId!,
        req.user!.role!,
        req.user!.departmentId,
        { shiftId, membershipId, departmentId }
      );
      res.status(200).json({ attendance: records });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to list attendance records');
    }
  }
);
