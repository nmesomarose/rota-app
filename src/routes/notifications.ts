import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../middleware/auth-middleware.ts';
import {
  registerPushToken,
  getInboxItems,
  markInboxItemRead,
} from '../services/notification-service.ts';
import { sendError, AppError } from '../utils/errors.ts';

export const notificationsRouter = Router();

const RegisterPushTokenSchema = z.object({
  token: z.string().min(1, 'Push token is required'),
  deviceId: z.string().min(1, 'Device ID is required'),
  platform: z.enum(['expo', 'ios', 'android']).optional(),
});

/**
 * POST /v1/notifications/push-token
 * Registers or updates a device push token for the authenticated user (FR-NOT-002, AC-NOT-09).
 * Control-plane operation; does not require active business context.
 */
notificationsRouter.post(
  '/v1/notifications/push-token',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RegisterPushTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const record = await registerPushToken({
        userId: req.user!.id,
        deviceId: parsed.data.deviceId,
        token: parsed.data.token,
        platform: parsed.data.platform,
      });

      res.status(200).json({ pushToken: record });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to register push token');
    }
  }
);

/**
 * GET /v1/notifications/inbox
 * Retrieves in-app inbox notifications for the active business membership (FR-NOT-014).
 */
notificationsRouter.get(
  '/v1/notifications/inbox',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const items = await getInboxItems(
        req.user!.businessId!,
        req.user!.membershipId!,
        req.user!.id
      );

      res.status(200).json({ inbox: items, count: items.length });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve inbox items');
    }
  }
);

/**
 * POST /v1/notifications/inbox/:id/read
 * Marks an in-app inbox item as read (FR-NOT-014).
 */
notificationsRouter.post(
  '/v1/notifications/inbox/:id/read',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id || typeof id !== 'string') {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Notification ID is required');
      return;
    }

    try {
      const updated = await markInboxItemRead(
        req.user!.businessId!,
        id,
        req.user!.membershipId!
      );

      res.status(200).json({ item: updated });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to mark inbox item as read');
    }
  }
);
