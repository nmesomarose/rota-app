import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { getRedisClient } from '../../src/services/redis-client.ts';
import { hashPassword } from '../../src/services/password-service.ts';
import { env } from '../../src/config/env.ts';
import { AppError } from '../../src/utils/errors.ts';
import {
  setGoogleTokenVerifier,
  type GoogleTokenVerifier,
  type GoogleTokenPayload,
} from '../../src/services/google-auth-service.ts';

const TEST_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

// Generate primary trusted RSA-2048 key pair for genuine cryptographic verification
const { publicKey: trustedPublicKeyPem, privateKey: trustedPrivateKeyPem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Generate secondary untrusted RSA-2048 key pair to test "wrong signing key"
const { privateKey: untrustedPrivateKeyPem } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

class ControlledRsaTokenVerifier implements GoogleTokenVerifier {
  private trustedPublicKeyPem: string;

  constructor(trustedPublicKeyPem: string) {
    this.trustedPublicKeyPem = trustedPublicKeyPem;
  }

  async verify(idToken: string, audience: string): Promise<GoogleTokenPayload> {
    const parts = idToken.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new AppError(400, 'INVALID_TOKEN', 'Malformed token format');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Cryptographic signature check with trusted public key
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();

    const signatureBuf = Buffer.from(signatureB64, 'base64url');
    const isSignatureValid = verifier.verify(this.trustedPublicKeyPem, signatureBuf);

    if (!isSignatureValid) {
      throw new AppError(401, 'INVALID_TOKEN', 'Cryptographic signature verification failed');
    }

    // Decode and return payload
    const decoded = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded) as GoogleTokenPayload;
    return payload;
  }
}

function createSignedTestToken(payload: Record<string, unknown>, signingKeyPem: string = trustedPrivateKeyPem): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-id' };
  const base64UrlEncode = (obj: unknown) =>
    Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');

  const headerB64 = base64UrlEncode(header);
  const payloadB64 = base64UrlEncode(payload);
  const dataToSign = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(dataToSign);
  signer.end();
  const signatureB64 = signer.sign(signingKeyPem, 'base64url');

  return `${dataToSign}.${signatureB64}`;
}

function createForgedToken(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-id' };
  const base64UrlEncode = (obj: unknown) =>
    Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');

  return `${base64UrlEncode(header)}.${base64UrlEncode(payload)}.forged_signature_bytes_not_matching_key`;
}

describe('Google OAuth Cryptographic Signature Verification & Identity Linking', () => {
  let server: Server;
  let baseUrl: string;
  let originalClientId: string | undefined;

  before(async () => {
    originalClientId = env.GOOGLE_CLIENT_ID;
    env.GOOGLE_CLIENT_ID = TEST_CLIENT_ID;

    // Install controlled RSA cryptographic verifier
    setGoogleTokenVerifier(new ControlledRsaTokenVerifier(trustedPublicKeyPem));

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
    // Reset verifier and configuration
    setGoogleTokenVerifier(null);
    env.GOOGLE_CLIENT_ID = originalClientId;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closeAllPools();
  });

  it('1. Rejects malformed Google ID token string', async () => {
    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'not-a-jwt' }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_TOKEN');
  });

  it('2. Rejects token with missing signature component', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        sub: 'sub_missing_sig',
        aud: TEST_CLIENT_ID,
        email: 'nosig@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString('base64url');

    const tokenWithoutSig = `${header}.${payload}`;

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: tokenWithoutSig }),
    });

    assert.strictEqual(res.status, 400);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_TOKEN');
  });

  it('3. Rejects forged token with valid-looking payload and invalid signature', async () => {
    const forgedToken = createForgedToken({
      iss: 'https://accounts.google.com',
      sub: 'forged_google_sub',
      aud: TEST_CLIENT_ID,
      email: 'attacker@example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: forgedToken }),
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_TOKEN');
  });

  it('4. Rejects token signed with wrong / untrusted signing key', async () => {
    // Signed with untrustedPrivateKeyPem instead of trustedPrivateKeyPem
    const wrongKeyToken = createSignedTestToken(
      {
        iss: 'https://accounts.google.com',
        sub: 'wrong_key_user',
        aud: TEST_CLIENT_ID,
        email: 'wrongkey@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      untrustedPrivateKeyPem
    );

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: wrongKeyToken }),
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_TOKEN');
  });

  it('5. Rejects Google ID token with untrusted issuer (AC-AUTH-05)', async () => {
    const token = createSignedTestToken({
      iss: 'https://evil-issuer.com',
      sub: 'google_user_untrusted',
      aud: TEST_CLIENT_ID,
      email: 'user@example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_TOKEN');
  });

  it('6. Rejects expired Google ID token (AC-AUTH-05)', async () => {
    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: 'google_user_expired',
      aud: TEST_CLIENT_ID,
      email: 'expired@example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'TOKEN_EXPIRED');
  });

  it('7. Rejects Google ID token with incorrect audience (aud mismatch)', async () => {
    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: 'google_user_wrong_aud',
      aud: 'different-app-client-id.apps.googleusercontent.com',
      email: 'wrongaud@example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'INVALID_AUDIENCE');
  });

  it('8. Rejects Google ID token if email is not verified (FR-AUTH-011, AC-AUTH-04)', async () => {
    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: 'google_user_unverified',
      aud: TEST_CLIENT_ID,
      email: 'unverified@example.com',
      email_verified: false,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'EMAIL_NOT_VERIFIED');
  });

  it('9. Fails closed with 500 AUTH_CONFIG_ERROR when GOOGLE_CLIENT_ID is not configured', async () => {
    // Temporarily unset GOOGLE_CLIENT_ID
    env.GOOGLE_CLIENT_ID = undefined;

    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: 'google_user_test',
      aud: TEST_CLIENT_ID,
      email: 'noclientid@example.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(res.status, 500);
    const body = (await res.json()) as any;
    assert.strictEqual(body.error?.code, 'AUTH_CONFIG_ERROR');

    // Restore GOOGLE_CLIENT_ID
    env.GOOGLE_CLIENT_ID = TEST_CLIENT_ID;
  });

  it('10. Valid cryptographically signed token is accepted, creates user and issues session tokens', async () => {
    const googleSub = `google_sub_${Date.now()}`;
    const googleEmail = `google_user_${Date.now()}@gmail.com`;

    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: googleSub,
      aud: TEST_CLIENT_ID,
      email: googleEmail,
      email_verified: true,
      name: 'Cryptographically Verified User',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const res = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as any;
    assert.strictEqual(body.isNewUser, true);
    assert.strictEqual(body.user.email, googleEmail);
    assert.ok(body.tokens.accessToken, 'Access token must be returned');
    assert.ok(body.tokens.refreshToken, 'Refresh token must be returned');

    // Verify user in database
    const userRes = await controlPool.query<{
      google_id: string;
      auth_provider: string;
      password_hash: string | null;
      email_verified_at: string | null;
    }>('SELECT google_id, auth_provider, password_hash, email_verified_at FROM users WHERE email = $1', [
      googleEmail,
    ]);

    assert.strictEqual(userRes.rows.length, 1);
    assert.strictEqual(userRes.rows[0].google_id, googleSub);
    assert.strictEqual(userRes.rows[0].auth_provider, 'google');
    assert.strictEqual(userRes.rows[0].password_hash, null, 'Google-only user password_hash must be null (PRD 517)');
    assert.ok(userRes.rows[0].email_verified_at !== null, 'Google user email should be verified');

    // Verify access token against protected endpoint
    const meRes = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${body.tokens.accessToken}` },
    });
    assert.strictEqual(meRes.status, 200);
    const meBody = (await meRes.json()) as any;
    assert.strictEqual(meBody.user.email, googleEmail);
  });

  it('11. Account Linking Protection: linking existing password account requires re-authentication (FR-AUTH-011, AC-AUTH-04)', async () => {
    const existingEmail = `existing_local_${Date.now()}@example.com`;
    const password = 'Password123!Secure';
    const pwdHash = await hashPassword(password);

    // Create existing local password account
    await controlPool.query(
      `INSERT INTO users (email, name, password_hash, status, email_verified_at)
       VALUES ($1, 'Local User', $2, 'active', NOW())`,
      [existingEmail, pwdHash]
    );

    const linkingGoogleSub = `google_link_${Date.now()}`;
    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: linkingGoogleSub,
      aud: TEST_CLIENT_ID,
      email: existingEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // 1. Direct Google sign-in must be rejected with ACCOUNT_LINKING_REQUIRED
    const directRes = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(directRes.status, 409);
    const directBody = (await directRes.json()) as any;
    assert.strictEqual(directBody.error?.code, 'ACCOUNT_LINKING_REQUIRED');
    assert.strictEqual(directBody.error?.details?.email, existingEmail);

    // 2. Linking endpoint rejects forged tokens even with correct password
    const forgedToken = createForgedToken({
      iss: 'https://accounts.google.com',
      sub: linkingGoogleSub,
      aud: TEST_CLIENT_ID,
      email: existingEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const forgedLinkRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existingEmail,
        currentPassword: password,
        idToken: forgedToken,
      }),
    });
    assert.strictEqual(forgedLinkRes.status, 401);
    const forgedLinkBody = (await forgedLinkRes.json()) as any;
    assert.strictEqual(forgedLinkBody.error?.code, 'INVALID_TOKEN');

    // 3. Linking attempt with wrong password fails re-authentication
    const wrongLinkRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existingEmail,
        currentPassword: 'WrongPassword!',
        idToken: token,
      }),
    });

    assert.strictEqual(wrongLinkRes.status, 401);
    const wrongLinkBody = (await wrongLinkRes.json()) as any;
    assert.strictEqual(wrongLinkBody.error?.code, 'INVALID_CREDENTIALS');

    // 4. Linking attempt with correct password and valid cryptographically signed token succeeds
    const successLinkRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: existingEmail,
        currentPassword: password,
        idToken: token,
      }),
    });

    assert.strictEqual(successLinkRes.status, 200);
    const successLinkBody = (await successLinkRes.json()) as any;
    assert.strictEqual(successLinkBody.success, true);

    // 5. Subsequent Google sign-in succeeds immediately now that account is safely linked
    const afterLinkRes = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    assert.strictEqual(afterLinkRes.status, 200);
    const afterLinkBody = (await afterLinkRes.json()) as any;
    assert.strictEqual(afterLinkBody.isNewUser, false);
    assert.strictEqual(afterLinkBody.user.email, existingEmail);
    assert.ok(afterLinkBody.tokens.accessToken);
  });

  it('12. Android Dev APK Regression: empty or omitted email in link payload uses verified token email (no Invalid Google link payload error)', async () => {
    const apkEmail = `apk_user_${Date.now()}@example.com`;
    const password = 'ApkPassword123!';
    const pwdHash = await hashPassword(password);

    await controlPool.query(
      `INSERT INTO users (email, name, password_hash, status, email_verified_at)
       VALUES ($1, 'APK User', $2, 'active', NOW())`,
      [apkEmail, pwdHash]
    );

    const apkSub = `google_apk_${Date.now()}`;
    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: apkSub,
      aud: TEST_CLIENT_ID,
      email: apkEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Android APK previously sent email: "" when details.email was missing, which failed with "Invalid Google link payload"
    const apkLinkRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: '', // Empty string as sent by unpatched mobile clients
        currentPassword: password,
        idToken: token,
      }),
    });

    assert.strictEqual(apkLinkRes.status, 200);
    const apkLinkBody = (await apkLinkRes.json()) as any;
    assert.strictEqual(apkLinkBody.success, true);

    // Subsequent Google Sign-In succeeds
    const apkSignInRes = await fetch(`${baseUrl}/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    assert.strictEqual(apkSignInRes.status, 200);
    const apkSignInBody = (await apkSignInRes.json()) as any;
    assert.strictEqual(apkSignInBody.user.email, apkEmail);
  });

  it('13. Linking endpoint rejects mismatched email with 400 EMAIL_MISMATCH', async () => {
    const userEmail = `mismatch_${Date.now()}@example.com`;
    const password = 'MismatchPassword123!';
    const pwdHash = await hashPassword(password);

    await controlPool.query(
      `INSERT INTO users (email, name, password_hash, status, email_verified_at)
       VALUES ($1, 'Mismatch User', $2, 'active', NOW())`,
      [userEmail, pwdHash]
    );

    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: `google_mismatch_${Date.now()}`,
      aud: TEST_CLIENT_ID,
      email: userEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const mismatchRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'attacker_target@example.com', // Deliberate mismatch
        currentPassword: password,
        idToken: token,
      }),
    });

    assert.strictEqual(mismatchRes.status, 400);
    const mismatchBody = (await mismatchRes.json()) as any;
    assert.strictEqual(mismatchBody.error?.code, 'EMAIL_MISMATCH');
  });

  it('14. Linking endpoint rejects expired Google ID token with 401 TOKEN_EXPIRED', async () => {
    const expiredEmail = `expired_link_${Date.now()}@example.com`;
    const password = 'ExpiredPassword123!';
    const pwdHash = await hashPassword(password);

    await controlPool.query(
      `INSERT INTO users (email, name, password_hash, status, email_verified_at)
       VALUES ($1, 'Expired User', $2, 'active', NOW())`,
      [expiredEmail, pwdHash]
    );

    const expiredToken = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: `google_expired_${Date.now()}`,
      aud: TEST_CLIENT_ID,
      email: expiredEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) - 120, // Expired 2 minutes ago
    });

    const expiredRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: expiredEmail,
        currentPassword: password,
        idToken: expiredToken,
      }),
    });

    assert.strictEqual(expiredRes.status, 401);
    const expiredBody = (await expiredRes.json()) as any;
    assert.strictEqual(expiredBody.error?.code, 'TOKEN_EXPIRED');
  });

  it('15. Linking endpoint rejects linking a Google identity that is already linked to another account', async () => {
    const primaryEmail = `primary_${Date.now()}@example.com`;
    const secondaryEmail = `secondary_${Date.now()}@example.com`;
    const password = 'SharedPassword123!';
    const pwdHash = await hashPassword(password);
    const sharedGoogleSub = `google_shared_${Date.now()}`;

    // Create primary user already linked to sharedGoogleSub
    await controlPool.query(
      `INSERT INTO users (email, name, password_hash, google_id, auth_provider, status, email_verified_at)
       VALUES ($1, 'Primary User', $2, $3, 'google_linked', 'active', NOW())`,
      [primaryEmail, pwdHash, sharedGoogleSub]
    );

    // Create secondary user attempting to link the same Google sub
    await controlPool.query(
      `INSERT INTO users (email, name, password_hash, status, email_verified_at)
       VALUES ($1, 'Secondary User', $2, 'active', NOW())`,
      [secondaryEmail, pwdHash]
    );

    const token = createSignedTestToken({
      iss: 'https://accounts.google.com',
      sub: sharedGoogleSub,
      aud: TEST_CLIENT_ID,
      email: secondaryEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const dupRes = await fetch(`${baseUrl}/v1/auth/google/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: secondaryEmail,
        currentPassword: password,
        idToken: token,
      }),
    });

    assert.strictEqual(dupRes.status, 409);
    const dupBody = (await dupRes.json()) as any;
    assert.strictEqual(dupBody.error?.code, 'GOOGLE_ACCOUNT_ALREADY_LINKED');
  });
});
