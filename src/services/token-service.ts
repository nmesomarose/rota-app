import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';
import { controlPool } from '../db/connection.ts';
import { AppError } from '../utils/errors.ts';

export const ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_IDLE_DAYS = 30;
export const SESSION_ABSOLUTE_DAYS = 90;
export const GRACE_WINDOW_MS = 10 * 1000; // 10 seconds

export interface AccessTokenPayload {
  sub: string;
  email: string;
  sessionId: string;
  businessId: string | null;
  role: string | null;
  type: 'access';
}

export interface GeneratedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// In-memory cache for concurrent refresh race-condition grace window (15s TTL)
interface SuccessorCacheEntry {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
const recentSuccessors = new Map<string, SuccessorCacheEntry>();

function cleanSuccessorCache(): void {
  const now = Date.now();
  for (const [key, entry] of recentSuccessors.entries()) {
    if (entry.expiresAt <= now) {
      recentSuccessors.delete(key);
    }
  }
}

/**
 * Computes a SHA-256 hash of a raw token string.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generates an opaque cryptographically secure 64-hex refresh token.
 */
export function generateRawRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Signs a short-lived (15 minute) JWT access token.
 */
export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  return jwt.sign(
    {
      sub: payload.sub,
      email: payload.email,
      sessionId: payload.sessionId,
      businessId: payload.businessId,
      role: payload.role,
      type: 'access',
    },
    env.JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
      algorithm: 'HS256',
    }
  );
}

/**
 * Verifies and decodes a JWT access token.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (decoded.type !== 'access' || !decoded.sub || !decoded.sessionId) {
      throw new AppError(401, 'INVALID_TOKEN', 'Token payload is malformed or invalid type');
    }
    return {
      sub: decoded.sub,
      email: decoded.email as string,
      sessionId: decoded.sessionId as string,
      businessId: (decoded.businessId as string) || null,
      role: (decoded.role as string) || null,
      type: 'access',
    };
  } catch (err: unknown) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired');
    }
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or tampered access token');
  }
}

/**
 * Creates an initial refresh token for a newly created session.
 */
export async function createInitialRefreshToken(
  sessionId: string,
  familyId: string
): Promise<string> {
  const rawToken = generateRawRefreshToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_IDLE_DAYS * 24 * 60 * 60 * 1000);

  await controlPool.query(
    `INSERT INTO refresh_tokens (session_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, familyId, tokenHash, expiresAt]
  );

  return rawToken;
}

/**
 * Rotates a refresh token with family protection and a 10s grace window.
 *
 * Rules:
 * 1. If token is invalid or unknown -> 401 INVALID_REFRESH_TOKEN.
 * 2. If session is revoked or expired -> 401 SESSION_REVOKED.
 * 3. If token was already used:
 *    a. If within 10s grace window -> return cached successor tokens (AC-AUTH-01).
 *    b. If outside 10s grace window -> token reuse detected (SEC-020). Revoke entire family, terminate session -> 401 TOKEN_REUSE_REVOKED.
 * 4. If token is active and unused:
 *    Rotate: Mark old token used, insert successor token linked to parent, cache in recentSuccessors, return new tokens.
 */
export async function rotateRefreshToken(
  rawRefreshToken: string,
  activeBusinessOverride?: { businessId: string | null; role: string | null }
): Promise<GeneratedTokens> {
  cleanSuccessorCache();

  if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is required');
  }

  const incomingHash = hashToken(rawRefreshToken);

  // 1. Check database for token
  const tokenRes = await controlPool.query(
    `SELECT id, session_id, family_id, token_hash, expires_at, used_at, replaced_by
     FROM refresh_tokens
     WHERE token_hash = $1`,
    [incomingHash]
  );

  if (tokenRes.rowCount === 0) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token not recognized');
  }

  const tokenRecord = tokenRes.rows[0];

  // 2. Fetch session and user
  const sessionRes = await controlPool.query(
    `SELECT s.id, s.user_id, s.active_business_id, s.revoked_at, s.expires_at, u.email, u.status AS user_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [tokenRecord.session_id]
  );

  if (sessionRes.rowCount === 0) {
    throw new AppError(401, 'SESSION_NOT_FOUND', 'Session associated with token no longer exists');
  }

  const session = sessionRes.rows[0];

  if (session.revoked_at !== null) {
    throw new AppError(401, 'SESSION_REVOKED', 'Session has been revoked');
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Session has expired');
  }

  if (session.user_status !== 'active') {
    throw new AppError(401, 'USER_INACTIVE', 'User account is inactive');
  }

  if (new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token has expired');
  }

  // 3. Handle Already Used Token
  if (tokenRecord.used_at !== null) {
    const elapsedSinceUse = Date.now() - new Date(tokenRecord.used_at).getTime();

    if (elapsedSinceUse <= GRACE_WINDOW_MS) {
      // Within 10-second grace window -> return the same successor token
      const cached = recentSuccessors.get(tokenRecord.id);
      if (cached) {
        return {
          accessToken: cached.accessToken,
          refreshToken: cached.refreshToken,
          expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
        };
      }
    }

    // Outside 10-second grace window -> REUSE DETECTED (SEC-020, AC-AUTH-01)
    // Revoke the whole family and terminate the session
    await controlPool.query(
      `UPDATE sessions
       SET revoked_at = NOW(), revoked_reason = 'REFRESH_TOKEN_REUSE_DETECTED'
       WHERE id = $1`,
      [tokenRecord.session_id]
    );

    await controlPool.query(
      `UPDATE refresh_tokens
       SET used_at = COALESCE(used_at, NOW())
       WHERE family_id = $1`,
      [tokenRecord.family_id]
    );

    throw new AppError(
      401,
      'TOKEN_REUSE_REVOKED',
      'Refresh token reuse detected outside grace window. Session and token family revoked.'
    );
  }

  // 4. Token is valid and unused -> Rotate
  const newRawRefreshToken = generateRawRefreshToken();
  const newHash = hashToken(newRawRefreshToken);
  const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_IDLE_DAYS * 24 * 60 * 60 * 1000);

  // Determine active business context
  const activeBusinessId = activeBusinessOverride !== undefined
    ? activeBusinessOverride.businessId
    : session.active_business_id;

  let activeRole: string | null = activeBusinessOverride?.role ?? null;
  if (activeBusinessId && !activeRole) {
    // Check role in directory
    const dirRes = await controlPool.query(
      `SELECT role FROM membership_directory WHERE user_id = $1 AND business_id = $2 AND status = 'active'`,
      [session.user_id, activeBusinessId]
    );
    if (dirRes.rowCount && dirRes.rowCount > 0) {
      activeRole = dirRes.rows[0].role;
    }
  }

  const newAccessToken = signAccessToken({
    sub: session.user_id,
    email: session.email,
    sessionId: session.id,
    businessId: activeBusinessId,
    role: activeRole,
  });

  // Insert successor and update parent in controlPool
  const insertSuccessorRes = await controlPool.query(
    `INSERT INTO refresh_tokens (session_id, family_id, token_hash, parent_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [session.id, tokenRecord.family_id, newHash, tokenRecord.id, newExpiresAt]
  );
  const successorId = insertSuccessorRes.rows[0].id;

  await controlPool.query(
    `UPDATE refresh_tokens
     SET used_at = NOW(), replaced_by = $1
     WHERE id = $2`,
    [successorId, tokenRecord.id]
  );

  // Store in ephemeral cache for concurrent grace window calls
  recentSuccessors.set(tokenRecord.id, {
    accessToken: newAccessToken,
    refreshToken: newRawRefreshToken,
    expiresAt: Date.now() + GRACE_WINDOW_MS + 5000,
  });

  return {
    accessToken: newAccessToken,
    refreshToken: newRawRefreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
  };
}
