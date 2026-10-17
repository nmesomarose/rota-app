import { randomUUID } from 'node:crypto';
import { controlPool } from '../db/connection.ts';
import { withTenantContext } from '../db/tenant-context.ts';
import { hashPassword, verifyPassword } from './password-service.ts';
import {
  signAccessToken,
  createInitialRefreshToken,
  rotateRefreshToken,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  SESSION_ABSOLUTE_DAYS,
  type GeneratedTokens,
} from './token-service.ts';
import { AppError } from '../utils/errors.ts';

export interface UserSummary {
  id: string;
  email: string;
  name: string | null;
}

export interface BusinessSummary {
  business_id: string;
  business_name: string;
  role: string;
  status: string;
}

export interface AuthResult {
  user: UserSummary;
  tokens: GeneratedTokens;
  activeBusinessId: string | null;
  businesses: BusinessSummary[];
  requiresBusinessSelection: boolean;
}

/**
 * Normalizes an email address to trimmed lowercase.
 */
export function normalizeEmail(email: string): string {
  if (!email || typeof email !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Email is required and must be a string');
  }
  return email.trim().toLowerCase();
}

/**
 * Registers a new global identity with email and password.
 */
export async function register(
  rawEmail: string,
  rawPassword: string,
  name?: string
): Promise<AuthResult> {
  const email = normalizeEmail(rawEmail);

  if (!rawPassword || typeof rawPassword !== 'string' || rawPassword.length < 8) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Password must be at least 8 characters long',
      { field: 'password' }
    );
  }

  // 1. Check if email already registered
  const existingRes = await controlPool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );
  if (existingRes.rowCount && existingRes.rowCount > 0) {
    throw new AppError(
      409,
      'EMAIL_ALREADY_EXISTS',
      'An account with this email address already exists'
    );
  }

  // 2. Hash password with Argon2id
  const passwordHash = await hashPassword(rawPassword);

  // 3. Insert into users
  const userRes = await controlPool.query<{ id: string; email: string; name: string | null }>(
    `INSERT INTO users (email, password_hash, name, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', NOW())
     RETURNING id, email, name`,
    [email, passwordHash, name?.trim() || null]
  );
  const user = userRes.rows[0];

  // 4. Create initial session (90-day absolute expiration cap per DR-05)
  const sessionExpiresAt = new Date(Date.now() + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000);
  const sessionRes = await controlPool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, active_business_id, expires_at)
     VALUES ($1, NULL, $2)
     RETURNING id`,
    [user.id, sessionExpiresAt]
  );
  const sessionId = sessionRes.rows[0].id;

  // 5. Create initial refresh token & access token
  const familyId = randomUUID();
  const rawRefreshToken = await createInitialRefreshToken(sessionId, familyId);
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    sessionId,
    businessId: null,
    role: null,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    tokens: {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    },
    activeBusinessId: null,
    businesses: [],
    requiresBusinessSelection: false,
  };
}

/**
 * Authenticates an existing user via email and password.
 */
export async function login(
  rawEmail: string,
  rawPassword: string,
  deviceId?: string
): Promise<AuthResult> {
  const email = normalizeEmail(rawEmail);

  if (!rawPassword || typeof rawPassword !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Password is required');
  }

  // 1. Fetch user by email
  const userRes = await controlPool.query<{
    id: string;
    email: string;
    password_hash: string;
    name: string | null;
    status: string;
  }>(
    'SELECT id, email, password_hash, name, status FROM users WHERE email = $1',
    [email]
  );

  if (userRes.rowCount === 0) {
    // Constant-time dummy verify to mitigate timing attacks
    await verifyPassword(
      '$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummy$dummyhashdummyhashdummy',
      rawPassword
    );
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const user = userRes.rows[0];

  if (user.status !== 'active') {
    throw new AppError(401, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
  }

  // 2. Verify password
  const isValid = await verifyPassword(user.password_hash, rawPassword);
  if (!isValid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // 3. Query directory memberships from control plane
  const dirRes = await controlPool.query<BusinessSummary>(
    `SELECT business_id, business_name, role, status
     FROM membership_directory
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at ASC`,
    [user.id]
  );
  const businesses = dirRes.rows;

  // 4. Resolve active business context per AC-AUTH-09 & FR-AUTH-010:
  // - Exactly 1 active business: scoped automatically.
  // - More than 1: BUSINESS_CONTEXT_REQUIRED / unselected until explicit choice.
  // - 0: unscoped.
  let activeBusinessId: string | null = null;
  let activeRole: string | null = null;

  if (businesses.length === 1) {
    activeBusinessId = businesses[0].business_id;
    activeRole = businesses[0].role;
  }

  // 5. Create new session
  const sessionExpiresAt = new Date(Date.now() + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000);
  const sessionRes = await controlPool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, active_business_id, device_id, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [user.id, activeBusinessId, deviceId || null, sessionExpiresAt]
  );
  const sessionId = sessionRes.rows[0].id;

  // 6. Generate refresh token & access token
  const familyId = randomUUID();
  const rawRefreshToken = await createInitialRefreshToken(sessionId, familyId);
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    sessionId,
    businessId: activeBusinessId,
    role: activeRole,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    tokens: {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    },
    activeBusinessId,
    businesses,
    requiresBusinessSelection: businesses.length > 1 && activeBusinessId === null,
  };
}

/**
 * Explicit business switching (FR-AUTH-010, D-01).
 * Verifies active membership on tenant shard and issues newly scoped access token.
 */
export async function switchBusiness(
  userId: string,
  sessionId: string,
  targetBusinessId: string
): Promise<{ activeBusinessId: string; role: string; tokens: { accessToken: string; expiresIn: number } }> {
  if (!targetBusinessId || typeof targetBusinessId !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'business_id is required');
  }

  // 1. Authoritative membership verification in the tenant shard
  let membership: { role: string; status: string } | null = null;
  try {
    membership = await withTenantContext(targetBusinessId, async (client) => {
      const res = await client.query<{ role: string; status: string }>(
        `SELECT role, status FROM memberships
         WHERE business_id = $1 AND user_id = $2 AND status = 'active'`,
        [targetBusinessId, userId]
      );
      return res.rows[0] || null;
    });
  } catch (_err) {
    // If invalid UUID or shard error, return 404 to avoid disclosure
    throw new AppError(404, 'NOT_FOUND', 'Target business not found or access denied');
  }

  if (!membership || membership.status !== 'active') {
    // Return 404 NOT_FOUND per tenancy-branch-and-context.md Rule 3
    throw new AppError(404, 'NOT_FOUND', 'Target business not found or access denied');
  }

  // 2. Fetch session and user email from control plane
  const sessionRes = await controlPool.query<{ user_id: string; email: string; revoked_at: string | null }>(
    `SELECT s.user_id, u.email, s.revoked_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [sessionId]
  );

  if (sessionRes.rowCount === 0 || sessionRes.rows[0].revoked_at !== null) {
    throw new AppError(401, 'SESSION_REVOKED', 'Active session required to switch business');
  }

  // 3. Update session active business
  await controlPool.query(
    `UPDATE sessions SET active_business_id = $1, updated_at = NOW() WHERE id = $2`,
    [targetBusinessId, sessionId]
  );

  // 4. Issue newly scoped access token
  const newAccessToken = signAccessToken({
    sub: userId,
    email: sessionRes.rows[0].email,
    sessionId,
    businessId: targetBusinessId,
    role: membership.role,
  });

  return {
    activeBusinessId: targetBusinessId,
    role: membership.role,
    tokens: {
      accessToken: newAccessToken,
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    },
  };
}

/**
 * Revokes the current session and marks its refresh tokens used (AC-AUTH-02).
 */
export async function logout(sessionId: string): Promise<void> {
  await controlPool.query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'USER_LOGOUT' WHERE id = $1`,
    [sessionId]
  );
  await controlPool.query(
    `UPDATE refresh_tokens SET used_at = COALESCE(used_at, NOW()) WHERE session_id = $1`,
    [sessionId]
  );
}

/**
 * Revokes all sessions for a user (AC-AUTH-02, AC-004).
 */
export async function logoutAll(userId: string): Promise<void> {
  await controlPool.query(
    `UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'USER_LOGOUT_ALL'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  await controlPool.query(
    `UPDATE refresh_tokens
     SET used_at = COALESCE(used_at, NOW())
     WHERE session_id IN (SELECT id FROM sessions WHERE user_id = $1)`,
    [userId]
  );
}
