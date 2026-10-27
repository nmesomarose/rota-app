import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { controlPool } from '../db/connection.ts';
import { env } from '../config/env.ts';
import { AppError } from '../utils/errors.ts';
import { verifyPassword } from './password-service.ts';
import {
  signAccessToken,
  createInitialRefreshToken,
  SESSION_ABSOLUTE_DAYS,
} from './token-service.ts';

export interface GoogleTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  iss: string;
  aud: string;
  exp: number;
}

export interface GoogleAuthResult {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  activeBusinessId: string | null;
  activeRole: string | null;
  businesses: Array<{
    business_id: string;
    business_name: string;
    role: string;
    status: string;
  }>;
  isNewUser: boolean;
}

export interface GoogleTokenVerifier {
  verify(idToken: string, audience: string): Promise<GoogleTokenPayload>;
}

export class GoogleAuthLibraryVerifier implements GoogleTokenVerifier {
  private client: OAuth2Client;

  constructor() {
    this.client = new OAuth2Client();
  }

  async verify(idToken: string, audience: string): Promise<GoogleTokenPayload> {
    const ticket = await this.client.verifyIdToken({
      idToken,
      audience,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw new AppError(401, 'INVALID_TOKEN', 'Google ID token payload is empty');
    }

    const aud = typeof payload.aud === 'string' ? payload.aud : (payload.aud?.[0] || '');

    return {
      sub: payload.sub,
      email: payload.email || '',
      email_verified: Boolean(payload.email_verified),
      name: payload.name,
      picture: payload.picture,
      iss: payload.iss,
      aud,
      exp: payload.exp,
    };
  }
}

let activeCustomVerifier: GoogleTokenVerifier | null = null;
const defaultGoogleVerifier = new GoogleAuthLibraryVerifier();

export function setGoogleTokenVerifier(verifier: GoogleTokenVerifier | null): void {
  activeCustomVerifier = verifier;
}

export function getGoogleTokenVerifier(): GoogleTokenVerifier {
  return activeCustomVerifier || defaultGoogleVerifier;
}

/**
 * Validates Google ID token cryptographically per PRD FR-AUTH-002, FR-AUTH-011, AC-AUTH-04, AC-AUTH-05.
 * Enforces cryptographic signature verification, audience, issuer, expiration, and email_verified status.
 * Fails closed if GOOGLE_CLIENT_ID is missing or empty.
 */
export async function verifyGoogleTokenPayload(idToken: string): Promise<GoogleTokenPayload> {
  if (!idToken || typeof idToken !== 'string') {
    throw new AppError(400, 'INVALID_TOKEN', 'Google ID token must be provided');
  }

  // Parse JWT parts - tokens must have header, payload and signature
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new AppError(400, 'INVALID_TOKEN', 'Malformed Google ID token');
  }

  // Require configured, nonempty GOOGLE_CLIENT_ID (Fail closed)
  const configuredClientId = env.GOOGLE_CLIENT_ID?.trim();
  if (!configuredClientId) {
    throw new AppError(
      500,
      'AUTH_CONFIG_ERROR',
      'GOOGLE_CLIENT_ID is not configured on the server. Google authentication is unavailable.'
    );
  }

  // Cryptographic signature and token verification
  const verifier = getGoogleTokenVerifier();
  let payload: GoogleTokenPayload;
  try {
    payload = await verifier.verify(idToken, configuredClientId);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : 'Google token verification failed';
    const lower = msg.toLowerCase();
    if (lower.includes('expired') || lower.includes('too late')) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Google ID token has expired');
    }
    if (lower.includes('audience') || lower.includes('recipient') || lower.includes('wrong recipient')) {
      throw new AppError(401, 'INVALID_AUDIENCE', 'Google ID token audience does not match configured client ID');
    }
    throw new AppError(401, 'INVALID_TOKEN', `Google ID token cryptographic verification failed: ${msg}`);
  }

  // 1. Validate Issuer (AC-AUTH-05)
  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) {
    throw new AppError(401, 'INVALID_TOKEN', `Invalid token issuer: ${payload.iss}`);
  }

  // 2. Validate Expiry (AC-AUTH-05)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSeconds) {
    throw new AppError(401, 'TOKEN_EXPIRED', 'Google ID token has expired');
  }

  // 3. Validate Audience against configured client ID (AC-AUTH-05)
  if (payload.aud !== configuredClientId) {
    throw new AppError(401, 'INVALID_AUDIENCE', 'Google ID token audience does not match configured client ID');
  }

  // 4. Validate Email Verification (FR-AUTH-011, AC-AUTH-04)
  if (payload.email_verified !== true) {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Google account email is not verified');
  }

  if (!payload.email || !payload.sub) {
    throw new AppError(400, 'INVALID_TOKEN', 'Google ID token missing required subject or email claims');
  }

  return payload;
}

/**
 * Authenticates or registers a user via Google Sign-In (FR-AUTH-002, D-07).
 * Safe account linking: if user exists with password, requires explicit password re-auth.
 */
export async function authenticateWithGoogle(
  idToken: string,
  deviceId?: string
): Promise<GoogleAuthResult> {
  const payload = await verifyGoogleTokenPayload(idToken);
  const normalizedEmail = payload.email.trim().toLowerCase();

  // Check if user already exists by google_id
  let userRes = await controlPool.query<{
    id: string;
    email: string;
    name: string | null;
    status: string;
    password_hash: string | null;
    google_id: string | null;
  }>(
    'SELECT id, email, name, status, password_hash, google_id FROM users WHERE google_id = $1',
    [payload.sub]
  );

  let user = userRes.rows[0];
  let isNewUser = false;

  if (!user) {
    // Check if user exists by email
    const emailRes = await controlPool.query<{
      id: string;
      email: string;
      name: string | null;
      status: string;
      password_hash: string | null;
      google_id: string | null;
    }>(
      'SELECT id, email, name, status, password_hash, google_id FROM users WHERE email = $1',
      [normalizedEmail]
    );

    if (emailRes.rows.length > 0) {
      const existingUser = emailRes.rows[0];

      // Never automatically reactivate suspended or deactivated accounts
      if (existingUser.status === 'suspended' || existingUser.status === 'deactivated') {
        throw new AppError(401, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
      }

      // Check if this is a pre-invited, unclaimed account
      if (existingUser.status === 'invited') {
        await controlPool.query(
          `UPDATE users
           SET google_id = $1,
               auth_provider = 'google',
               password_hash = NULL,
               status = 'active',
               name = COALESCE(name, $2),
               email_verified_at = NOW(),
               updated_at = NOW()
           WHERE id = $3`,
          [payload.sub, payload.name || normalizedEmail.split('@')[0], existingUser.id]
        );
        user = {
          ...existingUser,
          google_id: payload.sub,
          name: existingUser.name || payload.name || normalizedEmail.split('@')[0],
          status: 'active',
          password_hash: null,
        };
      } else if (existingUser.password_hash) {
        // Account exists with password and is not linked to Google: require password re-auth
        throw new AppError(
          409,
          'ACCOUNT_LINKING_REQUIRED',
          'An account already exists with this email address. Please sign in with your password to link your Google identity.',
          { email: normalizedEmail }
        );
      } else {
        // Link google_id if account had no password
        await controlPool.query(
          'UPDATE users SET google_id = $1, auth_provider = $2, updated_at = NOW() WHERE id = $3',
          [payload.sub, 'google', existingUser.id]
        );
        user = { ...existingUser, google_id: payload.sub };
      }
    } else {
      // Create new Google-authenticated user (PRD 517: password_hash is null for Google-only)
      const insertRes = await controlPool.query<{
        id: string;
        email: string;
        name: string | null;
        status: string;
      }>(
        `INSERT INTO users (email, name, google_id, auth_provider, password_hash, status, email_verified_at)
         VALUES ($1, $2, $3, 'google', NULL, 'active', NOW())
         RETURNING id, email, name, status`,
        [normalizedEmail, payload.name || normalizedEmail.split('@')[0], payload.sub]
      );
      user = {
        ...insertRes.rows[0],
        password_hash: null,
        google_id: payload.sub,
      };
      isNewUser = true;
    }
  }

  if (user.status !== 'active') {
    throw new AppError(401, 'ACCOUNT_INACTIVE', 'This account has been deactivated');
  }

  // Query directory memberships
  const dirRes = await controlPool.query<{
    business_id: string;
    business_name: string;
    role: string;
    status: string;
  }>(
    `SELECT business_id, business_name, role, status
     FROM membership_directory
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at ASC`,
    [user.id]
  );
  const businesses = dirRes.rows;

  let activeBusinessId: string | null = null;
  let activeRole: string | null = null;
  if (businesses.length === 1) {
    activeBusinessId = businesses[0].business_id;
    activeRole = businesses[0].role;
  }

  // Create session
  const sessionExpiresAt = new Date(Date.now() + SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000);
  const sessionRes = await controlPool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, active_business_id, device_id, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [user.id, activeBusinessId, deviceId || null, sessionExpiresAt]
  );
  const sessionId = sessionRes.rows[0].id;

  // Generate tokens
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
      expiresIn: 15 * 60,
    },
    activeBusinessId,
    activeRole,
    businesses,
    isNewUser,
  };
}

/**
 * Safely links a Google identity to an existing account with password re-authentication
 * (FR-AUTH-011, AC-AUTH-04, SEC-019).
 */
export async function linkGoogleAccount(
  email: string | undefined,
  currentPassword: string,
  idToken: string
): Promise<{ success: boolean; message: string }> {
  // 1. Validate Google ID token cryptographically first (FR-AUTH-002, AC-AUTH-04, AC-AUTH-05)
  const payload = await verifyGoogleTokenPayload(idToken);
  const tokenEmail = payload.email.trim().toLowerCase();

  // If email was provided and non-empty, ensure it matches the verified Google token email
  const providedEmail = email?.trim().toLowerCase();
  if (providedEmail && providedEmail !== tokenEmail) {
    throw new AppError(
      400,
      'EMAIL_MISMATCH',
      'The Google account email does not match the account you are attempting to link'
    );
  }

  // Canonical account email is anchored to the cryptographically verified Google email
  const normalizedEmail = tokenEmail;

  // 2. Verify local user exists and check password
  const userRes = await controlPool.query<{
    id: string;
    email: string;
    password_hash: string | null;
    google_id: string | null;
    status: string;
  }>(
    'SELECT id, email, password_hash, google_id, status FROM users WHERE email = $1',
    [normalizedEmail]
  );

  if (userRes.rows.length === 0) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }

  const user = userRes.rows[0];
  if (user.status !== 'active') {
    throw new AppError(401, 'ACCOUNT_INACTIVE', 'User account is inactive');
  }

  // Re-authentication check (FR-AUTH-011, SEC-019)
  if (user.password_hash) {
    const isValid = await verifyPassword(user.password_hash, currentPassword);
    if (!isValid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect current password. Re-authentication failed.');
    }
  }

  // 3. Guard against identity collisions (unique google_id)
  const existingGoogleUserRes = await controlPool.query<{ id: string }>(
    'SELECT id FROM users WHERE google_id = $1 AND id != $2',
    [payload.sub, user.id]
  );
  if (existingGoogleUserRes.rows.length > 0) {
    throw new AppError(
      409,
      'GOOGLE_ACCOUNT_ALREADY_LINKED',
      'This Google identity is already linked to another Rota account.'
    );
  }

  // 4. Update user record with google_id
  await controlPool.query(
    `UPDATE users
     SET google_id = $1,
         auth_provider = 'google_linked',
         email_verified_at = COALESCE(email_verified_at, NOW()),
         updated_at = NOW()
     WHERE id = $2`,
    [payload.sub, user.id]
  );

  return {
    success: true,
    message: 'Google identity linked successfully.',
  };
}
