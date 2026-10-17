import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { register, login, logout, logoutAll, switchBusiness } from '../services/auth-service.ts';
import { rotateRefreshToken } from '../services/token-service.ts';
import { requireAuth } from '../middleware/auth-middleware.ts';
import { sendError, AppError } from '../utils/errors.ts';
import { controlPool } from '../db/connection.ts';

export const authRouter = Router();

const RegisterSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).optional(),
});

const LoginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
  deviceId: z.string().optional(),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

const SwitchBusinessSchema = z.object({
  businessId: z.string().uuid('Valid business UUID is required'),
});

/**
 * POST /v1/auth/register
 */
authRouter.post('/v1/auth/register', async (req: Request, res: Response): Promise<void> => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await register(parsed.data.email, parsed.data.password, parsed.data.name);
    res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Registration failed';
    console.error('[Register Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Registration failed');
  }
});

/**
 * POST /v1/auth/login
 */
authRouter.post('/v1/auth/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await login(parsed.data.email, parsed.data.password, parsed.data.deviceId);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Login failed';
    console.error('[Login Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Login failed');
  }
});

/**
 * POST /v1/auth/refresh
 */
authRouter.post('/v1/auth/refresh', async (req: Request, res: Response): Promise<void> => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await rotateRefreshToken(parsed.data.refreshToken);
    res.status(200).json({ tokens: result });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Refresh failed';
    console.error('[Refresh Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Token refresh failed');
  }
});

/**
 * POST /v1/auth/logout
 */
authRouter.post('/v1/auth/logout', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
      return;
    }
    await logout(req.user.sessionId);
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Logout failed';
    console.error('[Logout Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Logout failed');
  }
});

/**
 * POST /v1/auth/logout-all
 */
authRouter.post('/v1/auth/logout-all', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
      return;
    }
    await logoutAll(req.user.id);
    res.status(200).json({ success: true, message: 'All sessions revoked successfully' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Logout-all failed';
    console.error('[LogoutAll Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Revocation failed');
  }
});

/**
 * POST /v1/auth/switch-business
 */
authRouter.post('/v1/auth/switch-business', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = SwitchBusinessSchema.safeParse(req.body);
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
    const result = await switchBusiness(req.user.id, req.user.sessionId, parsed.data.businessId);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Switch business failed';
    console.error('[SwitchBusiness Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to switch business');
  }
});

/**
 * GET /v1/auth/me
 */
authRouter.get('/v1/auth/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
      return;
    }

    // Fetch user details and active businesses
    const userRes = await controlPool.query(
      'SELECT id, email, name, status, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    const dirRes = await controlPool.query(
      `SELECT business_id, business_name, role, status
       FROM membership_directory
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at ASC`,
      [req.user.id]
    );

    res.status(200).json({
      user: userRes.rows[0],
      activeBusinessId: req.user.businessId,
      activeRole: req.user.role,
      businesses: dirRes.rows,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch user';
    console.error('[Me Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to fetch user details');
  }
});
