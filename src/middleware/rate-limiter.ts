import { type Request, type Response, type NextFunction } from 'express';
import { getRedisClient } from '../services/redis-client.ts';
import { sendError } from '../utils/errors.ts';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyGenerator: (req: Request) => string | undefined | Promise<string | undefined>;
  message?: string;
  skip?: (req: Request) => boolean;
}

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxLimit = tonumber(ARGV[3])
local clearBefore = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)
local currentCount = redis.call('ZCARD', key)

if currentCount < maxLimit then
  local member = now .. ':' .. math.random(100000, 999999)
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  local remaining = maxLimit - currentCount - 1
  return { 1, remaining, 0 }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfterMs = windowMs
  if #oldest >= 2 then
    local oldestTime = tonumber(oldest[2])
    retryAfterMs = math.max(0, math.floor(oldestTime + windowMs - now))
  end
  local retryAfterSec = math.max(1, math.ceil(retryAfterMs / 1000))
  return { 0, 0, retryAfterSec }
end
`;

/**
 * Extracts normalized client IP address from the request.
 * Relies on Express req.ip which honors explicit trust proxy configuration.
 */
export function getClientIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  return ip.replace(/^::ffff:/, '');
}

/**
 * Creates an Express middleware enforcing a Redis-backed sliding-window rate limit.
 * If Redis is unavailable, it fails closed (NFR-REL-002, SEC-004) returning 503 DEPENDENCY_UNAVAILABLE.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const {
    windowMs,
    max,
    keyPrefix,
    keyGenerator,
    message = 'Too many requests. Please try again later.',
    skip,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (skip && skip(req)) {
      next();
      return;
    }

    // In automated test environments, bypass non-test rate limiters to avoid false-positive
    // quota exhaustion on localhost (127.0.0.1) across dozens of consecutive test suites.
    // In production (NODE_ENV === 'production'), rate limits are always strictly enforced.
    if (
      process.env.NODE_ENV !== 'production' &&
      (process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test' || process.env.RATE_LIMIT_DISABLED === 'true') &&
      !keyPrefix.startsWith('test:') &&
      !req.headers['x-enforce-rate-limit']
    ) {
      next();
      return;
    }

    let identifier: string | undefined;
    try {
      identifier = await keyGenerator(req);
    } catch (err) {
      console.error('[RateLimiter KeyGen Error]', err);
    }

    if (!identifier) {
      // If identifier cannot be resolved, fall back to client IP
      identifier = getClientIp(req);
    }

    const key = `ratelimit:${keyPrefix}:${identifier}`;
    const now = Date.now();

    try {
      const redis = getRedisClient();
      const result = (await redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now.toString(),
        windowMs.toString(),
        max.toString()
      )) as [number, number, number];

      const [allowed, remaining, retryAfterSec] = result;

      res.setHeader('RateLimit-Limit', max);
      res.setHeader('RateLimit-Remaining', Math.max(0, remaining));
      res.setHeader('RateLimit-Reset', Math.ceil(windowMs / 1000));

      if (allowed === 1) {
        next();
        return;
      }

      // Limit exceeded: return 429
      res.setHeader('Retry-After', retryAfterSec.toString());
      sendError(req, res, 429, 'RATE_LIMITED', message, {
        retryAfter: retryAfterSec,
      });
    } catch (err: unknown) {
      // Fail closed per NFR-REL-002 / SEC-004: Redis outage must block sensitive traffic safely
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[RateLimiter Redis Error] Fail-closed triggered for ${keyPrefix}:`, errMsg);
      res.setHeader('Retry-After', '60');
      sendError(
        req,
        res,
        503,
        'DEPENDENCY_UNAVAILABLE',
        'Rate limiting service is unavailable. Please try again later.',
        { retryAfter: 60 }
      );
    }
  };
}

/**
 * 1. Login IP Rate Limiter: 10 requests per minute per IP (PRD 11.2)
 */
export const loginIpLimiter = createRateLimiter({
  keyPrefix: 'login:ip',
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req) => getClientIp(req),
  message: 'Too many login attempts from this IP address. Please try again later.',
});

/**
 * Helper to check failed logins per account: 5 failures per 15 minutes (PRD 11.2, AC-AUTH-06)
 */
export async function checkAccountLoginAttempts(email: string): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  try {
    if (
      process.env.NODE_ENV !== 'production' &&
      (process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test' || process.env.RATE_LIMIT_DISABLED === 'true') &&
      !email.toLowerCase().startsWith('test_account_') &&
      process.env.ENFORCE_ACCOUNT_LOCKOUT !== 'true'
    ) {
      return { allowed: true };
    }

    const redis = getRedisClient();
    const key = `ratelimit:login:account:${email.toLowerCase().trim()}`;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxFailures = 5;

    // Remove expired failures
    await redis.zremrangebyscore(key, '-inf', (now - windowMs).toString());
    const count = await redis.zcard(key);

    if (count >= maxFailures) {
      const oldest = (await (redis as any).zrange(key, 0, 0)) as string[];
      let retryAfterMs = windowMs;
      if (oldest.length >= 1 && oldest[0]) {
        const oldestTime = Number(oldest[0].split(':')[0]);
        if (!isNaN(oldestTime)) {
          retryAfterMs = Math.max(0, oldestTime + windowMs - now);
        }
      }
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    return { allowed: true };
  } catch (err) {
    console.error('[RateLimiter checkAccountLoginAttempts Error]', err);
    // Fail closed
    return { allowed: false, retryAfterSec: 60 };
  }
}

/**
 * Records a failed login attempt for the account in Redis with 15-minute sliding TTL.
 */
export async function recordAccountLoginFailure(email: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = `ratelimit:login:account:${email.toLowerCase().trim()}`;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const member = `${now}:${Math.random().toString().slice(2, 8)}`;

    await redis.zadd(key, now, member);
    await redis.pexpire(key, windowMs);
  } catch (err) {
    console.error('[RateLimiter recordAccountLoginFailure Error]', err);
  }
}

/**
 * Clears failed login counter upon successful authentication.
 */
export async function clearAccountLoginFailures(email: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = `ratelimit:login:account:${email.toLowerCase().trim()}`;
    await redis.del(key);
  } catch (err) {
    console.error('[RateLimiter clearAccountLoginFailures Error]', err);
  }
}

/**
 * 2. Password Reset IP Limiter: 10 per hour per IP (PRD 11.2)
 */
export const passwordResetIpLimiter = createRateLimiter({
  keyPrefix: 'reset:ip',
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => getClientIp(req),
  message: 'Too many password reset attempts from this IP address. Please try again later.',
});

/**
 * 3. Password Reset Email Limiter: 3 per hour per email (PRD 11.2)
 */
export const passwordResetEmailLimiter = createRateLimiter({
  keyPrefix: 'reset:email',
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => {
    const email = req.body?.email;
    return typeof email === 'string' ? email.toLowerCase().trim() : undefined;
  },
  message: 'Too many password reset requests for this email address. Please try again later.',
});

/**
 * 4. Invitation Creation Limiter: 30 per hour per user/membership (PRD 11.2)
 */
export const invitationCreateLimiter = createRateLimiter({
  keyPrefix: 'invitation:create',
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  keyGenerator: (req) => req.user?.id || getClientIp(req),
  message: 'Invitation creation limit reached for this account. Please try again later.',
});

/**
 * 5. Invitation Acceptance Limiter: 10 per hour per IP (PRD 11.2)
 */
export const invitationAcceptLimiter = createRateLimiter({
  keyPrefix: 'invitation:accept',
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => getClientIp(req),
  message: 'Too many invitation acceptance attempts from this IP address. Please try again later.',
});

/**
 * 6. Payment Endpoints (Quote, Confirm): 10 per minute per user (PRD 11.2)
 */
export const paymentEndpointLimiter = createRateLimiter({
  keyPrefix: 'payment:user',
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req) => req.user?.id || getClientIp(req),
  message: 'Payment action limit reached. Please wait a moment before trying again.',
});
