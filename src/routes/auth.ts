import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  register,
  login,
  logout,
  logoutAll,
  switchBusiness,
  requestPasswordReset,
  resetPassword,
} from '../services/auth-service.ts';
import { authenticateWithGoogle, linkGoogleAccount } from '../services/google-auth-service.ts';
import { deleteUserAccount } from '../services/organization-service.ts';
import { rotateRefreshToken, hashToken } from '../services/token-service.ts';
import { requireAuth } from '../middleware/auth-middleware.ts';
import {
  loginIpLimiter,
  checkAccountLoginAttempts,
  recordAccountLoginFailure,
  clearAccountLoginFailures,
  passwordResetIpLimiter,
  passwordResetEmailLimiter,
} from '../middleware/rate-limiter.ts';
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
    const msg =
      err instanceof Error && err.message
        ? err.message
        : (err as any)?.code || (err ? String(err) : 'Registration failed');
    console.error('[Register Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Registration failed');
  }
});

/**
 * POST /v1/auth/login
 */
authRouter.post('/v1/auth/login', loginIpLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  // Account-level lockout protection (5 failed logins per 15 minutes per account: PRD 11.2, AC-AUTH-06)
  const accountCheck = await checkAccountLoginAttempts(parsed.data.email);
  if (!accountCheck.allowed) {
    const retrySec = accountCheck.retryAfterSec || 60;
    res.setHeader('Retry-After', retrySec.toString());
    sendError(
      req,
      res,
      429,
      'RATE_LIMITED',
      'Too many failed login attempts for this account. Please try again later.',
      { retryAfter: retrySec }
    );
    return;
  }

  try {
    const result = await login(parsed.data.email, parsed.data.password, parsed.data.deviceId);
    await clearAccountLoginFailures(parsed.data.email);
    res.status(200).json(result);
  } catch (err: unknown) {
    await recordAccountLoginFailure(parsed.data.email);
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg =
      err instanceof Error && err.message
        ? err.message
        : (err as any)?.code || (err ? String(err) : 'Login failed');
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

const DeleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required to confirm account deletion'),
});

/**
 * DELETE /v1/auth/account
 * Deletes personal account, requiring password verification and enforcing sole-owner protection.
 */
authRouter.delete('/v1/auth/account', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = DeleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Password is required to confirm account deletion', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    if (!req.user) {
      sendError(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
      return;
    }

    const result = await deleteUserAccount(req.user.id, parsed.data.password);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Account deletion failed';
    console.error('[DeleteAccount Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to delete account');
  }
});

const ForgotPasswordSchema = z.object({
  email: z.string().email('Valid email is required'),
});

const ResetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * POST /v1/auth/forgot-password
 * Initiates single-use expiring password reset token generation.
 * Protected against account enumeration: identical 200 response returned regardless of user existence.
 */
authRouter.post(
  '/v1/auth/forgot-password',
  passwordResetIpLimiter,
  passwordResetEmailLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = ForgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    try {
      const result = await requestPasswordReset(parsed.data.email);
      res.status(200).json(result);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendError(req, res, err.statusCode, err.code, err.message, err.details);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Forgot password failed';
      console.error('[ForgotPassword Error]', msg);
      sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to process password reset request');
    }
  }
);

/**
 * POST /v1/auth/reset-password
 * Resets user password using single-use unexpired reset token and revokes all active sessions.
 */
authRouter.post(
  '/v1/auth/reset-password',
  passwordResetIpLimiter,
  async (req: Request, res: Response): Promise<void> => {
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Validation failed', {
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await resetPassword(parsed.data.token, parsed.data.password);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Reset password failed';
    console.error('[ResetPassword Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to reset password');
  }
});

/**
 * GET /v1/auth/reset-password
 * Responsive landing page & mobile deep-link bridge for password reset email links.
 * Automatically attempts to hand off to the Rota mobile app on mobile devices,
 * provides an "Open in Rota App" link, and offers an in-browser form on desktop.
 */
authRouter.get('/v1/auth/reset-password', async (req: Request, res: Response): Promise<void> => {
  const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';

  if (!rawToken || rawToken.length < 32) {
    res.status(400).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invalid Reset Link - Rota</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F3F6F9; margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #FFFFFF; border-radius: 16px; border: 1px solid #D8E1EA; max-width: 440px; width: 100%; padding: 32px; box-shadow: 0 4px 12px rgba(23, 50, 77, 0.08); text-align: center; }
    h1 { color: #B91C1C; font-size: 20px; margin-top: 0; }
    p { color: #64748B; font-size: 14px; line-height: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Invalid or Missing Reset Token</h1>
    <p>This password reset link is incomplete or missing a valid token. Please request a new password reset link from the Rota mobile app.</p>
  </div>
</body>
</html>`);
    return;
  }

  // Pre-validate token state from database
  let tokenError: string | null = null;
  try {
    const tokenHash = hashToken(rawToken);
    const tokenRes = await controlPool.query<{ id: string; expires_at: string; used_at: string | null }>(
      'SELECT id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1',
      [tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      tokenError = 'This password reset link is invalid or does not exist.';
    } else if (tokenRes.rows[0].used_at !== null) {
      tokenError = 'This password reset link has already been used. Please request a new reset link.';
    } else if (new Date(tokenRes.rows[0].expires_at) < new Date()) {
      tokenError = 'This password reset link has expired. Reset links are valid for 1 hour.';
    }
  } catch (dbErr) {
    tokenError = 'Unable to verify reset token. Please try again later.';
  }

  const appDeepLink = `rota://reset-password?token=${encodeURIComponent(rawToken)}`;

  res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset Password - Rota</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F3F6F9; color: #172B3A; margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #FFFFFF; border-radius: 16px; border: 1px solid #D8E1EA; max-width: 440px; width: 100%; padding: 32px; box-shadow: 0 4px 12px rgba(23, 50, 77, 0.08); text-align: center; }
    .brand-badge { width: 56px; height: 56px; background-color: #17324D; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; color: #FFFFFF; font-size: 24px; font-weight: bold; margin-bottom: 16px; }
    h1 { color: #172B3A; font-size: 22px; margin: 0 0 8px 0; font-weight: 700; }
    p { color: #64748B; font-size: 14px; line-height: 20px; margin: 0 0 24px 0; }
    .btn { display: inline-block; width: 100%; padding: 14px; border-radius: 10px; font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; border: none; text-align: center; transition: background 0.2s; }
    .btn-primary { background-color: #0F766E; color: #FFFFFF; margin-bottom: 12px; }
    .btn-primary:hover { background-color: #115E59; }
    .btn-secondary { background-color: #F1F5F9; color: #17324D; border: 1px solid #D8E1EA; }
    .error-box { background: #FEF2F2; border: 1px solid #FECACA; color: #991B1B; padding: 12px; border-radius: 8px; font-size: 13px; line-height: 18px; margin-bottom: 20px; text-align: left; }
    .divider { height: 1px; background: #E2E8F0; margin: 24px 0; }
    .form-group { text-align: left; margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #334155; margin-bottom: 6px; }
    input { width: 100%; padding: 12px; border-radius: 8px; border: 1.5px solid #D8E1EA; font-size: 15px; }
    input:focus { outline: none; border-color: #0F766E; }
    .success-box { background: #DCFCE7; border: 1px solid #BBF7D0; color: #166534; padding: 16px; border-radius: 8px; font-size: 14px; line-height: 20px; margin-bottom: 20px; }
  </style>
  <script>
    (function() {
      var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      var deepLink = ${JSON.stringify(appDeepLink)};
      var hasError = ${JSON.stringify(Boolean(tokenError))};
      if (isMobile && !hasError) {
        window.location.href = deepLink;
      }
    })();
  </script>
</head>
<body>
  <div class="card">
    <div class="brand-badge">R</div>
    <h1>Reset Your Password</h1>
    <p>Choose how you would like to reset your Rota account password.</p>

    ${
      tokenError
        ? `<div class="error-box">${tokenError}</div>`
        : `
        <a href="${appDeepLink}" class="btn btn-primary" id="openAppBtn">Open in Rota App</a>

        <div class="divider"></div>

        <div id="webFormContainer">
          <form id="resetForm">
            <input type="hidden" id="token" value="${rawToken}" />
            <div class="form-group">
              <label for="password">New Password (at least 8 chars)</label>
              <input type="password" id="password" required minlength="8" placeholder="Enter new password" />
            </div>
            <div class="form-group">
              <label for="confirmPassword">Confirm New Password</label>
              <input type="password" id="confirmPassword" required minlength="8" placeholder="Re-enter new password" />
            </div>
            <div id="formError" class="error-box" style="display: none;"></div>
            <div id="formSuccess" class="success-box" style="display: none;"></div>
            <button type="submit" class="btn btn-secondary" id="submitBtn">Reset Password in Browser</button>
          </form>
        </div>
        <script>
          document.getElementById('resetForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            var pwd = document.getElementById('password').value;
            var cpwd = document.getElementById('confirmPassword').value;
            var errBox = document.getElementById('formError');
            var succBox = document.getElementById('formSuccess');
            var submitBtn = document.getElementById('submitBtn');

            errBox.style.display = 'none';
            succBox.style.display = 'none';

            if (pwd !== cpwd) {
              errBox.textContent = 'Passwords do not match.';
              errBox.style.display = 'block';
              return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Resetting...';

            try {
              var res = await fetch('/v1/auth/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: '${rawToken}', password: pwd })
              });
              var data = await res.json().catch(function() { return {}; });
              if (res.ok) {
                document.getElementById('resetForm').style.display = 'none';
                succBox.textContent = data.message || 'Password has been reset successfully. Please log in with your new password on the Rota mobile app.';
                succBox.style.display = 'block';
              } else {
                errBox.textContent = (data.error && data.error.message) || 'Failed to reset password.';
                errBox.style.display = 'block';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Reset Password in Browser';
              }
            } catch (err) {
              errBox.textContent = 'Network error. Please try again.';
              errBox.style.display = 'block';
              submitBtn.disabled = false;
              submitBtn.textContent = 'Reset Password in Browser';
            }
          });
        </script>
      `
    }
  </div>
</body>
</html>`);
});

/**
 * GET /.well-known/assetlinks.json
 * Android App Links domain verification file.
 */
authRouter.get('/.well-known/assetlinks.json', (_req: Request, res: Response) => {
  res.status(200).json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.rota.app',
        sha256_cert_fingerprints: [
          'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C',
        ],
      },
    },
  ]);
});

/**
 * GET /.well-known/apple-app-site-association
 * Apple Universal Links domain verification file.
 */
authRouter.get('/.well-known/apple-app-site-association', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    applinks: {
      apps: [],
      details: [
        {
          appID: 'TEAMID.com.rota.app',
          paths: [
            '/v1/auth/reset-password*',
            '/reset-password*',
            '/v1/organizations/invitations/*',
            '/v1/invitations/*',
          ],
        },
      ],
    },
  });
});

/**
 * POST /v1/auth/google
 * Authenticates or registers a user via Google Sign-In (FR-AUTH-002, D-07, AC-AUTH-05).
 */
const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'idToken is required'),
  deviceId: z.string().optional(),
});

authRouter.post('/v1/auth/google', async (req: Request, res: Response): Promise<void> => {
  const parsed = googleAuthSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Invalid Google authentication payload', { issues: parsed.error.issues });
    return;
  }

  try {
    const result = await authenticateWithGoogle(parsed.data.idToken, parsed.data.deviceId);
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Google authentication failed';
    console.error('[Google Auth Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to authenticate with Google');
  }
});

/**
 * POST /v1/auth/google/link
 * Safely links a Google identity to an existing password-based account (FR-AUTH-011, AC-AUTH-04).
 * Requires explicit password re-authentication.
 */
const googleLinkSchema = z.object({
  email: z.string().email().optional().or(z.literal('')),
  currentPassword: z.string().min(1, 'Current password is required for account linking'),
  idToken: z.string().min(1, 'idToken is required'),
});

authRouter.post('/v1/auth/google/link', async (req: Request, res: Response): Promise<void> => {
  const parsed = googleLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(req, res, 400, 'VALIDATION_ERROR', 'Invalid Google link payload', { issues: parsed.error.issues });
    return;
  }

  try {
    const emailToUse = parsed.data.email?.trim() || undefined;
    const result = await linkGoogleAccount(emailToUse, parsed.data.currentPassword, parsed.data.idToken);
    res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendError(req, res, err.statusCode, err.code, err.message, err.details);
      return;
    }
    const msg = err instanceof Error ? err.message : 'Failed to link Google account';
    console.error('[Google Link Error]', msg);
    sendError(req, res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to link Google account');
  }
});


