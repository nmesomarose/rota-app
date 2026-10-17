import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { GRACE_WINDOW_MS } from '../../src/services/token-service.ts';

describe('Milestone M2: Authentication and Session Security', () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
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

  const testEmail = `auth_test_${Date.now()}@example.com`;
  const testPassword = 'StrongPassword123!';
  let accessToken: string;
  let refreshToken: string;
  let userId: string;

  it('1. Rejects registration with invalid email or short password (400 VALIDATION_ERROR)', async () => {
    // Short password
    const res1 = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'valid@example.com', password: 'short' }),
    });
    assert.strictEqual(res1.status, 400);
    const body1 = (await res1.json()) as any;
    assert.strictEqual(body1.error.code, 'VALIDATION_ERROR');
    assert.ok(body1.error.requestId);

    // Invalid email
    const res2 = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: testPassword }),
    });
    assert.strictEqual(res2.status, 400);
    const body2 = (await res2.json()) as any;
    assert.strictEqual(body2.error.code, 'VALIDATION_ERROR');
  });

  it('2. Registers a new account successfully with Argon2id hash (201 Created)', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        name: 'Ada Lovelace',
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;

    assert.ok(body.user.id);
    assert.strictEqual(body.user.email, testEmail.toLowerCase());
    assert.strictEqual(body.user.name, 'Ada Lovelace');
    assert.ok(body.tokens.accessToken);
    assert.ok(body.tokens.refreshToken);
    assert.strictEqual(body.tokens.expiresIn, 900); // 15 minutes

    userId = body.user.id;
    accessToken = body.tokens.accessToken;
    refreshToken = body.tokens.refreshToken;

    // Database verification: Password must be stored as Argon2id hash, not plaintext
    const dbRes = await controlPool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const hash = dbRes.rows[0].password_hash;
    assert.ok(hash.startsWith('$argon2id$'), 'Password must be hashed with Argon2id');
    assert.doesNotMatch(hash, new RegExp(testPassword), 'Hash must never reveal plaintext password');
  });

  it('3. Rejects duplicate email registration (409 EMAIL_ALREADY_EXISTS)', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail.toUpperCase(), // Case-insensitive normalization check
        password: 'AnotherPassword999!',
      }),
    });
    assert.strictEqual(res.status, 409);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error.code, 'EMAIL_ALREADY_EXISTS');
  });

  it('4. Rejects login with invalid credentials (401 INVALID_CREDENTIALS)', async () => {
    // Wrong password
    const res1 = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'WrongPassword!' }),
    });
    assert.strictEqual(res1.status, 401);
    const body1 = (await res1.json()) as any;
    assert.strictEqual(body1.error.code, 'INVALID_CREDENTIALS');

    // Non-existent email
    const res2 = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'AnyPassword123!' }),
    });
    assert.strictEqual(res2.status, 401);
    const body2 = (await res2.json()) as any;
    assert.strictEqual(body2.error.code, 'INVALID_CREDENTIALS');
  });

  it('5. Successfully logs in with valid credentials and receives tokens (200 OK)', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
        deviceId: 'device-test-01',
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;

    assert.strictEqual(body.user.email, testEmail.toLowerCase());
    assert.ok(body.tokens.accessToken);
    assert.ok(body.tokens.refreshToken);
    assert.strictEqual(body.tokens.expiresIn, 900);

    // Update tokens for subsequent tests
    accessToken = body.tokens.accessToken;
    refreshToken = body.tokens.refreshToken;
  });

  it('6. Authenticated route /v1/auth/me returns identity context', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.user.id, userId);
    assert.strictEqual(body.user.email, testEmail.toLowerCase());
  });

  it('7. Rejects requests without Authorization header (401 AUTHENTICATION_REQUIRED)', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/me`);
    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('8. Rejects requests with malformed or tampered token (401 INVALID_TOKEN)', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}tampered` },
    });
    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error.code, 'INVALID_TOKEN');
  });

  it('9. Rotates refresh token and issues newly paired tokens', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;

    assert.ok(body.tokens.accessToken);
    assert.ok(body.tokens.refreshToken);
    assert.notStrictEqual(body.tokens.refreshToken, refreshToken, 'Refresh token must rotate');

    // Update for subsequent tests
    const oldRefreshToken = refreshToken;
    const newRefreshToken = body.tokens.refreshToken;
    const successorAccessToken = body.tokens.accessToken;

    // 10. AC-AUTH-01: Concurrent refresh inside the 10-second grace window succeeds with SAME successor
    const graceRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: oldRefreshToken }),
    });
    assert.strictEqual(graceRes.status, 200);
    const graceBody = (await graceRes.json()) as any;
    assert.strictEqual(
      graceBody.tokens.refreshToken,
      newRefreshToken,
      'Concurrent refresh within 10s grace window must return same successor refresh token'
    );
    assert.strictEqual(
      graceBody.tokens.accessToken,
      successorAccessToken,
      'Concurrent refresh within 10s grace window must return same successor access token'
    );

    // Save newest token
    refreshToken = newRefreshToken;
    accessToken = successorAccessToken;
  });

  it('10. AC-AUTH-01 & SEC-020: Refresh token reuse outside grace window revokes the whole family and ends session', async () => {
    // 1. Perform a clean rotation
    const rotRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    assert.strictEqual(rotRes.status, 200);
    const rotBody = (await rotRes.json()) as any;
    const retiredToken = refreshToken;
    const activeToken = rotBody.tokens.refreshToken;

    // 2. Artificially advance used_at beyond the 10s grace window (e.g. 15 seconds ago)
    const retiredHash = (await controlPool.query(
      'SELECT token_hash FROM refresh_tokens WHERE token_hash IS NOT NULL'
    )).rows;
    await controlPool.query(
      `UPDATE refresh_tokens
       SET used_at = NOW() - INTERVAL '15 seconds'
       WHERE used_at IS NOT NULL`
    );

    // 3. Attempt to reuse the retired token
    const reuseRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: retiredToken }),
    });
    assert.strictEqual(reuseRes.status, 401);
    const reuseBody = (await reuseRes.json()) as any;
    assert.strictEqual(reuseBody.error.code, 'TOKEN_REUSE_REVOKED');

    // 4. Verify that the whole family was revoked: Even the active token is now rejected
    const activeAttemptRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: activeToken }),
    });
    assert.strictEqual(activeAttemptRes.status, 401);

    // 5. Verify the session was revoked in the database
    const sessionRes = await controlPool.query(
      `SELECT revoked_at, revoked_reason FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    assert.ok(sessionRes.rows[0].revoked_at !== null);
    assert.strictEqual(sessionRes.rows[0].revoked_reason, 'REFRESH_TOKEN_REUSE_DETECTED');
  });

  it('11. AC-AUTH-02 & AC-004: Logout immediately invalidates session and tokens', async () => {
    // 1. Log in fresh
    const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    assert.strictEqual(loginRes.status, 200);
    const loginBody = (await loginRes.json()) as any;
    const currentAccess = loginBody.tokens.accessToken;
    const currentRefresh = loginBody.tokens.refreshToken;

    // 2. Call logout
    const logoutRes = await fetch(`${baseUrl}/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentAccess}` },
    });
    assert.strictEqual(logoutRes.status, 200);

    // 3. Next request with same access token fails (FR-AUTH-005, AC-AUTH-02)
    const afterLogoutRes = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${currentAccess}` },
    });
    assert.strictEqual(afterLogoutRes.status, 401);
    const afterLogoutBody = (await afterLogoutRes.json()) as any;
    assert.strictEqual(afterLogoutBody.error.code, 'SESSION_REVOKED');

    // 4. Refresh token fails as well
    const refreshFailRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: currentRefresh }),
    });
    assert.strictEqual(refreshFailRes.status, 401);
  });

  it('12. AC-AUTH-02 & AC-004: Logout-all revokes all active sessions for the user', async () => {
    // 1. Create two separate sessions (e.g. Phone and Tablet)
    const s1Res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword, deviceId: 'phone' }),
    });
    const s1Body = (await s1Res.json()) as any;

    const s2Res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword, deviceId: 'tablet' }),
    });
    const s2Body = (await s2Res.json()) as any;

    // 2. From s1, call logout-all
    const logoutAllRes = await fetch(`${baseUrl}/v1/auth/logout-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s1Body.tokens.accessToken}` },
    });
    assert.strictEqual(logoutAllRes.status, 200);

    // 3. Both session 1 and session 2 must be immediately rejected on next request
    const check1 = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${s1Body.tokens.accessToken}` },
    });
    assert.strictEqual(check1.status, 401);

    const check2 = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${s2Body.tokens.accessToken}` },
    });
    assert.strictEqual(check2.status, 401);
  });
});
