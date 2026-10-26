import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth-middleware.ts';
import {
  getUserSettings,
  updateUserSettings,
  type UpdateSettingsInput,
} from '../services/settings-service.ts';
import { sendError, AppError } from '../utils/errors.ts';

export const settingsRouter = Router();

// Validation Schemas (PRD 6.10, 10, SEC-003)
const QuietHoursSchema = z.object({
  enabled: z.boolean(),
  start: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'start must be in 24-hour HH:mm format'),
  end: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'end must be in 24-hour HH:mm format'),
});

const NotificationCategoriesSchema = z
  .object({
    shifts: z.boolean().optional(),
    swaps: z.boolean().optional(),
    approvals: z.boolean().optional(),
    attendance: z.boolean().optional(),
    billing: z.boolean().optional(),
    security: z.boolean().optional(),
  })
  .strict();

const ThemeSchema = z.enum(['system', 'light', 'dark']);

const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid IANA time zone identifier' }
  );

const LanguageSchema = z
  .string()
  .min(2, 'Language code must be at least 2 characters')
  .max(10, 'Language code cannot exceed 10 characters');

const UpdateSettingsSchema = z
  .object({
    timeZone: TimeZoneSchema.optional(),
    quietHours: QuietHoursSchema.optional(),
    language: LanguageSchema.optional(),
    theme: ThemeSchema.optional(),
    notificationCategories: NotificationCategoriesSchema.optional(),
    clientTimestamps: z.record(z.string()).optional(),
    clientTimestamp: z.string().optional(),
  })
  .strict();

/**
 * GET /v1/settings
 * Retrieves authenticated user settings with per-field conflict resolution timestamps (SEC-017, FR-SET-001..005).
 */
settingsRouter.get(
  '/v1/settings',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;
      const settings = await getUserSettings(userId);
      res.status(200).json({ data: settings });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to retrieve settings';
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', msg);
    }
  }
);

/**
 * PUT /v1/settings
 * Updates authenticated user settings with per-field timestamp validation (FR-SET-005, AC-SET-01).
 */
settingsRouter.put(
  '/v1/settings',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const userId = req.user!.id;
      const updated = await updateUserSettings(
        userId,
        parsed.data as UpdateSettingsInput
      );
      res.status(200).json({ data: updated });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to update settings';
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', msg);
    }
  }
);
