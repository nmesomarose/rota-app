import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import { Server } from 'node:http';
import {
  createRateLimiter,
  getClientIp,
  checkAccountLoginAttempts,
  recordAccountLoginFailure,
  clearAccountLoginFailures,
} from '../../src/middleware/rate-limiter.ts';
import {
  getRedisClient,
  ensureRedisConnected,
  setRedisClientForTesting,
  closeRedisClient,
} from '../../src/services/redis-client.ts';
import { sendError } from '../../src/utils/errors.ts';

describe('Shared Redis-Backed Rate Limiter Integration (SEC-004, PRD 11.2, NFR-REL-002)', () => {
  before(async () => {
    // Ensure Redis client is fully connected and ready
    const redis = await ensureRedisConnected();
    await redis.ping();
  });

  after(async () => {
    setRedisClientForTesting(null);
    await closeRedisClient();
  });

  beforeEach(async () => {
    // Flush test keys before each test
    const redis = getRedisClient();
    const keys = await redis.keys('ratelimit:test:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    const acctKeys = await redis.keys('ratelimit:login:account:test_*');
    if (acctKeys.length > 0) {
      await redis.del(...acctKeys);
    }
  });

  it('1. Allows requests within limits and sets correct rate limit headers', async () => {
    const app = express();
    app.set('trust proxy', false);

    const limiter = createRateLimiter({
      keyPrefix: 'test:within-limits',
      windowMs: 5000,
      max: 3,
      keyGenerator: (req) => req.headers['x-user-id'] as string || getClientIp(req),
    });

    app.get('/test-endpoint', limiter, (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const s = app.listen(0);
    const p = (s.address() as any).port;

    try {
      // 1st request (remaining: 2)
      const res1 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'user-1' },
      });
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.headers.get('RateLimit-Limit'), '3');
      assert.strictEqual(res1.headers.get('RateLimit-Remaining'), '2');

      // 2nd request (remaining: 1)
      const res2 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'user-1' },
      });
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.headers.get('RateLimit-Remaining'), '1');

      // 3rd request (remaining: 0)
      const res3 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'user-1' },
      });
      assert.strictEqual(res3.status, 200);
      assert.strictEqual(res3.headers.get('RateLimit-Remaining'), '0');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('2. Blocks requests exceeding limit with HTTP 429 and Retry-After header', async () => {
    const app = express();
    app.set('trust proxy', false);

    const limiter = createRateLimiter({
      keyPrefix: 'test:exceeded',
      windowMs: 10000,
      max: 2,
      keyGenerator: (req) => req.headers['x-user-id'] as string || getClientIp(req),
      message: 'Rate limit exceeded for test',
    });

    app.get('/test-endpoint', limiter, (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const s = app.listen(0);
    const p = (s.address() as any).port;

    try {
      // 1st & 2nd request consume quota
      await fetch(`http://127.0.0.1:${p}/test-endpoint`, { headers: { 'x-user-id': 'burst-user' } });
      await fetch(`http://127.0.0.1:${p}/test-endpoint`, { headers: { 'x-user-id': 'burst-user' } });

      // 3rd request must be blocked with 429
      const res3 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'burst-user' },
      });

      assert.strictEqual(res3.status, 429);
      const retryAfter = res3.headers.get('Retry-After');
      assert.ok(retryAfter, 'Retry-After header must be set');
      assert.ok(Number(retryAfter) >= 1, 'Retry-After must be positive seconds');

      const body = await res3.json() as any;
      assert.strictEqual(body.error.code, 'RATE_LIMITED');
      assert.strictEqual(body.error.message, 'Rate limit exceeded for test');
      assert.ok(body.error.details.retryAfter >= 1);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('3. Isolates rate limit buckets for independent identities', async () => {
    const app = express();
    app.set('trust proxy', false);

    const limiter = createRateLimiter({
      keyPrefix: 'test:identities',
      windowMs: 10000,
      max: 1,
      keyGenerator: (req) => req.headers['x-user-id'] as string || getClientIp(req),
    });

    app.get('/test-endpoint', limiter, (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const s = app.listen(0);
    const p = (s.address() as any).port;

    try {
      // User Alpha exhausts their quota
      const resAlpha1 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'alpha' },
      });
      assert.strictEqual(resAlpha1.status, 200);

      const resAlpha2 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'alpha' },
      });
      assert.strictEqual(resAlpha2.status, 429);

      // User Beta has independent quota and succeeds
      const resBeta1 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'x-user-id': 'beta' },
      });
      assert.strictEqual(resBeta1.status, 200);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('4. Enforces 5 failed logins per 15 minutes per account (AC-AUTH-06)', async () => {
    const testEmail = `test_account_${Date.now()}@example.com`;

    // Initially allowed
    const check0 = await checkAccountLoginAttempts(testEmail);
    assert.strictEqual(check0.allowed, true);

    // Simulate 5 failed logins
    for (let i = 1; i <= 5; i++) {
      await recordAccountLoginFailure(testEmail);
    }

    // 6th attempt must be rejected (AC-AUTH-06)
    const check6 = await checkAccountLoginAttempts(testEmail);
    assert.strictEqual(check6.allowed, false);
    assert.ok(check6.retryAfterSec && check6.retryAfterSec > 0);

    // Another distinct account is unaffected
    const otherEmail = `test_other_${Date.now()}@example.com`;
    const checkOther = await checkAccountLoginAttempts(otherEmail);
    assert.strictEqual(checkOther.allowed, true);

    // Successful login clears failures
    await clearAccountLoginFailures(testEmail);
    const checkAfterClear = await checkAccountLoginAttempts(testEmail);
    assert.strictEqual(checkAfterClear.allowed, true);
  });

  it('5. Fails closed with 503 DEPENDENCY_UNAVAILABLE when Redis fails (NFR-REL-002)', async () => {
    const app = express();
    app.set('trust proxy', false);

    const limiter = createRateLimiter({
      keyPrefix: 'test:fail-closed',
      windowMs: 5000,
      max: 10,
      keyGenerator: (req) => getClientIp(req),
    });

    app.get('/sensitive-endpoint', limiter, (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const s = app.listen(0);
    const p = (s.address() as any).port;

    // Create a mock Redis client that throws error on eval
    const brokenRedisMock = {
      status: 'connect',
      eval: async () => {
        throw new Error('Connection lost to Redis master');
      },
      on: () => {},
    } as any;

    try {
      setRedisClientForTesting(brokenRedisMock);

      const res = await fetch(`http://127.0.0.1:${p}/sensitive-endpoint`);
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.headers.get('Retry-After'), '60');

      const body = await res.json() as any;
      assert.strictEqual(body.error.code, 'DEPENDENCY_UNAVAILABLE');
      assert.strictEqual(body.error.details.retryAfter, 60);
    } finally {
      setRedisClientForTesting(null);
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('6. Does not trust spoofed X-Forwarded-For headers when trust proxy is disabled', async () => {
    const app = express();
    // Explicitly configure trust proxy to false
    app.set('trust proxy', false);

    const limiter = createRateLimiter({
      keyPrefix: 'test:proxy-spoof',
      windowMs: 10000,
      max: 1,
      keyGenerator: (req) => getClientIp(req),
    });

    app.get('/test-endpoint', limiter, (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const s = app.listen(0);
    const p = (s.address() as any).port;

    try {
      // 1st request with spoofed X-Forwarded-For: 203.0.113.195 consumes quota
      const res1 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'X-Forwarded-For': '203.0.113.195' },
      });
      assert.strictEqual(res1.status, 200);

      // 2nd request with different spoofed X-Forwarded-For: 198.51.100.42
      // Must STILL be rejected because trust proxy is false and socket remote address is the same
      const res2 = await fetch(`http://127.0.0.1:${p}/test-endpoint`, {
        headers: { 'X-Forwarded-For': '198.51.100.42' },
      });
      assert.strictEqual(res2.status, 429);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
