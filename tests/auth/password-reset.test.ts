import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { getRedisClient } from '../../src/services/redis-client.ts';

describe('Password Reset Flow (PRD 8.6, 9.2)', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const redis = getRedisClient();
    const keys = await redis.keys('ratelimit:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeAllPools();
  });

  const testEmail = `pw_reset_${Date.now()}@example.com`;
  const initialPassword = 'InitialPassword123!';
  const newPassword = 'NewSecurePassword456!';
  let resetToken: string;
  let initialRefreshToken: string;
  let initialAccessToken: string;

  it('1. Registers an account and logs in', async () => {
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: initialPassword,
        name: 'Reset Test User',
      }),
    });
    assert.strictEqual(regRes.status, 201);
    const body = (await regRes.json()) as any;
    initialAccessToken = body.tokens.accessToken;
    initialRefreshToken = body.tokens.refreshToken;
    assert.ok(initialAccessToken);
    assert.ok(initialRefreshToken);
  });

  it('2. Anti-enumeration: requesting reset for non-existent email returns generic 200 without token leakage', async () => {
    const nonExistentEmail = `does_not_exist_${Date.now()}@example.com`;
    const res = await fetch(`${baseUrl}/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: nonExistentEmail }),
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(
      body.message,
      'If an account exists with this email, a password reset link has been sent.'
    );
    assert.strictEqual(body.resetToken, undefined);
  });

  it('3. Requesting reset for existing account returns identical message and generates single-use token', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail }),
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(
      body.message,
      'If an account exists with this email, a password reset link has been sent.'
    );
    assert.ok(body.resetToken, 'Reset token should be present in test environment');
    resetToken = body.resetToken;
  });

  it('4. Attempting reset with an invalid or malformed token fails', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'invalid_token_1234567890abcdef',
        password: 'ValidPassword123!',
      }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_TOKEN');
  });

  it('5. Attempting reset with an expired token fails', async () => {
    // Generate an expired token directly in control plane
    const expiredRawToken = `expired_token_${Date.now()}_${Math.random()}`;
    const crypto = await import('node:crypto');
    const expiredHash = crypto.createHash('sha256').update(expiredRawToken).digest('hex');

    const userRes = await controlPool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      testEmail,
    ]);
    const userId = userRes.rows[0].id;

    await controlPool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() - INTERVAL '10 minutes')`,
      [userId, expiredHash]
    );

    const res = await fetch(`${baseUrl}/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: expiredRawToken,
        password: 'ValidPassword123!',
      }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'TOKEN_EXPIRED');
  });

  it('6. Successfully resets password with valid token and revokes all active sessions', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: resetToken,
        password: newPassword,
      }),
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.success, true);

    // Verify all prior sessions were revoked
    const sessionRes = await controlPool.query<{ revoked_at: string | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [testEmail]
    );
    assert.ok(sessionRes.rows.length > 0);
    for (const session of sessionRes.rows) {
      assert.ok(session.revoked_at !== null, 'Session must be revoked');
      assert.strictEqual(session.revoked_reason, 'PASSWORD_RESET');
    }

    // Verify old access token is immediately rejected on protected endpoint (AC-AUTH-02)
    const meRes = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${initialAccessToken}` },
    });
    assert.strictEqual(meRes.status, 401);
    const meBody = (await meRes.json()) as any;
    assert.strictEqual(meBody.error?.code, 'SESSION_REVOKED');

    // Verify old refresh token rotation fails due to revocation
    const refreshRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: initialRefreshToken }),
    });
    assert.strictEqual(refreshRes.status, 401);
  });

  it('7. Single-use enforcement: reusing the already-used token fails', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: resetToken,
        password: 'AnotherPassword789!',
      }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'TOKEN_ALREADY_USED');
  });

  it('8. Old password fails authentication; new password succeeds', async () => {
    // Old password
    const oldLoginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: initialPassword,
      }),
    });
    assert.strictEqual(oldLoginRes.status, 401);

    // New password
    const newLoginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: newPassword,
      }),
    });
    assert.strictEqual(newLoginRes.status, 200);
    const newLoginBody = (await newLoginRes.json()) as any;
    assert.ok(newLoginBody.tokens.accessToken);
  });

  it('9. Concurrency: race condition between two simultaneous reset requests results in exactly one winner', async () => {
    const concurrentEmail = `concurrent_pw_${Date.now()}@example.com`;
    const initialConcurrentPw = 'InitialConcurrent123!';
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: concurrentEmail,
        password: initialConcurrentPw,
        name: 'Concurrent User',
      }),
    });

    // Request reset token
    const forgotRes = await fetch(`${baseUrl}/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: concurrentEmail }),
    });
    const forgotBody = (await forgotRes.json()) as any;
    const sharedToken = forgotBody.resetToken;
    assert.ok(sharedToken, 'Token must be present in test environment');

    const candidatePasswordA = 'ConcurrentWinnerAlpha123!';
    const candidatePasswordB = 'ConcurrentWinnerBeta456!';

    // Simultaneously fire two requests using the exact same reset token
    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/v1/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sharedToken, password: candidatePasswordA }),
      }),
      fetch(`${baseUrl}/v1/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sharedToken, password: candidatePasswordB }),
      }),
    ]);

    const statuses = [resA.status, resB.status];
    assert.ok(statuses.includes(200), 'Exactly one concurrent request must succeed with 200');
    assert.ok(statuses.includes(400), 'Exactly one concurrent request must fail with 400');

    const winningRes = resA.status === 200 ? resA : resB;
    const losingRes = resA.status === 200 ? resB : resA;
    const winningPassword = resA.status === 200 ? candidatePasswordA : candidatePasswordB;
    const losingPassword = resA.status === 200 ? candidatePasswordB : candidatePasswordA;

    const winningBody = (await winningRes.json()) as any;
    const losingBody = (await losingRes.json()) as any;
    assert.strictEqual(winningBody.success, true);
    assert.strictEqual(losingBody.error?.code, 'TOKEN_ALREADY_USED');

    // Winning password must authenticate successfully
    const winLogin = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: concurrentEmail, password: winningPassword }),
    });
    assert.strictEqual(winLogin.status, 200);
    const winLoginBody = (await winLogin.json()) as any;
    assert.ok(winLoginBody.tokens.accessToken);

    // Reset login rate limit key for test IP before consecutive invalid login checks
    const redis = getRedisClient();
    const loginKeys = await redis.keys('ratelimit:login:*');
    if (loginKeys.length > 0) {
      await redis.del(...loginKeys);
    }

    // Losing password must fail authentication
    const loseLogin = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: concurrentEmail, password: losingPassword }),
    });
    assert.strictEqual(loseLogin.status, 401);

    // Initial password must fail authentication
    const initLogin = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: concurrentEmail, password: initialConcurrentPw }),
    });
    assert.strictEqual(initLogin.status, 401);
  });
});
