import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth-middleware.ts';
import {
  requestSwap,
  peerAcceptSwap,
  peerRejectSwap,
  approveSwap,
  cancelSwap,
  listSwaps,
} from '../services/swap-service.ts';
import { sendError, AppError } from '../utils/errors.ts';

export const swapsRouter = Router();

const RequestSwapSchema = z.object({
  requesterShiftId: z.string().uuid('Valid requester shift UUID is required'),
  counterpartMembershipId: z.string().uuid('Valid counterpart membership UUID is required'),
  counterpartShiftId: z.string().uuid('Valid counterpart shift UUID is required'),
  notes: z.string().optional(),
});

/**
 * POST /v1/swaps
 * Request a shift swap with an eligible colleague in the same department (FR-SWP-001..007).
 */
swapsRouter.post(
  '/v1/swaps',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestSwapSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const swap = await requestSwap(
        req.user!.businessId!,
        req.user!.membershipId!,
        parsed.data
      );
      res.status(201).json({ swap });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to request shift swap');
    }
  }
);

/**
 * GET /v1/swaps
 * Lists swap requests scoped to current membership role (AC-SCH-05).
 */
swapsRouter.get(
  '/v1/swaps',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const swaps = await listSwaps(
        req.user!.businessId!,
        req.user!.membershipId!,
        req.user!.role!,
        req.user!.departmentId
      );
      res.status(200).json({ swaps });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to list swap requests');
    }
  }
);

/**
 * POST /v1/swaps/:id/accept
 * Designated counterpart colleague accepts swap request (FR-SWP-002, AC-SCH-05).
 */
swapsRouter.post(
  '/v1/swaps/:id/accept',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const swapId = req.params.id as string;
    try {
      const swap = await peerAcceptSwap(
        req.user!.businessId!,
        swapId,
        req.user!.membershipId!
      );
      res.status(200).json({ swap });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to accept swap request');
    }
  }
);

/**
 * POST /v1/swaps/:id/reject
 * Designated counterpart colleague rejects swap request (FR-SWP-002).
 */
swapsRouter.post(
  '/v1/swaps/:id/reject',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const swapId = req.params.id as string;
    try {
      const swap = await peerRejectSwap(
        req.user!.businessId!,
        swapId,
        req.user!.membershipId!
      );
      res.status(200).json({ swap });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to reject swap request');
    }
  }
);

/**
 * POST /v1/swaps/:id/approve
 * Manager approves swap request after peer acceptance (FR-SWP-003, BR-004, AC-SCH-05).
 */
swapsRouter.post(
  '/v1/swaps/:id/approve',
  requireAuth,
  requireTenant,
  requireRole(['owner', 'gm', 'supervisor']),
  async (req: Request, res: Response): Promise<void> => {
    const swapId = req.params.id as string;
    try {
      const swap = await approveSwap(
        req.user!.businessId!,
        swapId,
        req.user!.membershipId!,
        req.user!.role!,
        req.user!.departmentId
      );
      res.status(200).json({ swap });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to approve swap request');
    }
  }
);

/**
 * POST /v1/swaps/:id/cancel
 * Cancels a swap request (by requester or manager).
 */
swapsRouter.post(
  '/v1/swaps/:id/cancel',
  requireAuth,
  requireTenant,
  async (req: Request, res: Response): Promise<void> => {
    const swapId = req.params.id as string;
    try {
      const swap = await cancelSwap(
        req.user!.businessId!,
        swapId,
        req.user!.membershipId!,
        req.user!.role!
      );
      res.status(200).json({ swap });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message);
        return;
      }
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to cancel swap request');
    }
  }
);
