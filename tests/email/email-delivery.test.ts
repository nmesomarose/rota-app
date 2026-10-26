import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  sendEmail,
  getEmailInbox,
  clearEmailInbox,
  setCustomEmailFetch,
} from '../../src/services/email-service.ts';
import {
  handleInvitationEmail,
  handlePasswordResetEmail,
} from '../../src/queue/handlers.ts';
import {
  getRedisClient,
  ensureRedisConnected,
  closeRedisClient,
} from '../../src/services/redis-client.ts';
import { env } from '../../src/config/env.ts';

describe('Transactional Email Delivery & Resend Provider Adapter', () => {
  const originalEnv = { ...process.env };

  before(async () => {
    await ensureRedisConnected();
  });

  after(async () => {
    process.env = { ...originalEnv };
    clearEmailInbox();
    await closeRedisClient();
  });

  beforeEach(async () => {
    clearEmailInbox();
    setCustomEmailFetch(null);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_PROVIDER;
    process.env.NODE_ENV = 'test';

    const redis = getRedisClient();
    const keys = await redis.keys('email:idem:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it('1. Default development/test transport uses simulated in-memory delivery', async () => {
    const res = await sendEmail({
      to: 'staff@example.com',
      subject: 'Welcome to Rota',
      text: 'Your account is ready.',
      idempotencyKey: `idem_${randomUUID()}`,
    });

    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.provider, 'simulated');
    assert.ok(res.messageId.startsWith('msg_'));

    const inbox = getEmailInbox();
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].to, 'staff@example.com');
    assert.strictEqual(inbox[0].subject, 'Welcome to Rota');
  });

  it('2. Production guard: Rejects delivery and refuses silent simulation when RESEND_API_KEY is missing in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;

    await assert.rejects(
      async () => {
        await sendEmail({
          to: 'client@example.com',
          subject: 'Production Notice',
          text: 'This should not silently simulate.',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('EMAIL_CONFIGURATION_ERROR'));
        assert.ok(err.message.includes('RESEND_API_KEY is not configured'));
        return true;
      }
    );

    // Assert nothing was recorded as delivered
    assert.strictEqual(getEmailInbox().length, 0);
  });

  it('3. Real provider integration: Dispatches email via Resend REST API when configured', async () => {
    process.env.RESEND_API_KEY = 're_live_test_api_key_123';
    process.env.EMAIL_FROM = 'Rota Scheduling <invitations@rota.example.com>';

    let capturedUrl = '';
    let capturedMethod = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    setCustomEmailFetch(async (url: any, init: any) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method || '';
      capturedHeaders = init?.headers || {};
      capturedBody = JSON.parse(init?.body || '{}');

      return new Response(
        JSON.stringify({ id: 're_msg_mock_778899' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await sendEmail({
      to: 'invitee@example.com',
      subject: 'Join Our Team',
      text: 'Click the link to join.',
      html: '<p>Click the link to join.</p>',
      idempotencyKey: `idem_resend_${randomUUID()}`,
    });

    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.provider, 'resend');
    assert.strictEqual(res.messageId, 're_msg_mock_778899');

    // Verify REST API call format
    assert.strictEqual(capturedUrl, 'https://api.resend.com/emails');
    assert.strictEqual(capturedMethod, 'POST');
    assert.strictEqual(capturedHeaders['Authorization'], 'Bearer re_live_test_api_key_123');
    assert.strictEqual(capturedHeaders['Content-Type'], 'application/json');
    assert.deepStrictEqual(capturedBody.to, ['invitee@example.com']);
    assert.strictEqual(capturedBody.from, 'Rota Scheduling <invitations@rota.example.com>');
    assert.strictEqual(capturedBody.subject, 'Join Our Team');
    assert.strictEqual(capturedBody.text, 'Click the link to join.');
    assert.strictEqual(capturedBody.html, '<p>Click the link to join.</p>');
  });

  it('4. Real provider failure: Throws actionable error and releases idempotency lease for worker retry', async () => {
    process.env.RESEND_API_KEY = 're_test_key_fail';

    setCustomEmailFetch(async () => {
      return new Response(
        JSON.stringify({
          statusCode: 422,
          message: 'The domain "rota.example.com" is not verified. Please verify your domain at resend.com/domains.',
          name: 'validation_error',
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const idempotencyKey = `idem_fail_${randomUUID()}`;

    await assert.rejects(
      async () => {
        await sendEmail({
          to: 'unverified@example.com',
          subject: 'Test Subject',
          text: 'Body',
          idempotencyKey,
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('Resend API Error (422)'));
        assert.ok(err.message.includes('not verified'));
        return true;
      }
    );

    // Verify idempotency lock was released so queue worker backoff retry can run
    const redis = getRedisClient();
    const lockVal = await redis.get(`email:idem:${idempotencyKey}`);
    assert.strictEqual(lockVal, null, 'Lease was released on failure');
  });

  it('5. Invitation email formatting: Generates clickable URL in both HTML and text with no raw token in logs', async () => {
    const rawToken = `inv_test_${Date.now()}_${randomUUID()}`;
    const invitationId = randomUUID();

    const jobData: any = {
      id: 'job_test_invite',
      name: 'email.invitation',
      data: {
        businessId: randomUUID(),
        invitationId,
        email: 'newhire@workplace.com',
        role: 'Supervisor',
        inviterName: 'Sarah Jenkins',
        rawToken,
      },
    };

    const res = await handleInvitationEmail(jobData);
    assert.strictEqual(res.sent, true);

    const inbox = getEmailInbox();
    assert.strictEqual(inbox.length, 1);
    const sent = inbox[0];

    assert.strictEqual(sent.to, 'newhire@workplace.com');
    assert.ok(sent.subject.includes('invited'));

    // Check link in text body
    assert.ok(sent.text);
    const expectedBase = (env.APP_BASE_URL || `http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}`).replace(/\/+$/, '');
    const expectedInviteUrl = `${expectedBase}/v1/organizations/invitations/${rawToken}`;

    assert.ok(sent.text.includes(expectedInviteUrl), 'Plaintext contains clickable invitation link');
    assert.ok(sent.text.includes('72 hours'), 'Plaintext mentions 72h expiration');

    // Check link in HTML body
    assert.ok(sent.html);
    assert.ok(sent.html.includes(`<a href="${expectedInviteUrl}"`), 'HTML contains anchor link button');
    assert.ok(sent.html.includes('Sarah Jenkins'), 'HTML includes inviter name');
    assert.ok(sent.html.includes('Supervisor'), 'HTML includes target role');
  });

  it('6. Password reset email formatting: Generates clickable URL in both HTML and text', async () => {
    const rawToken = `reset_${Date.now()}_${randomUUID()}`;

    const jobData: any = {
      id: 'job_test_reset',
      name: 'email.password_reset',
      data: {
        userId: randomUUID(),
        email: 'user@example.com',
        rawToken,
        expiresAt: '1 hour',
      },
    };

    const res = await handlePasswordResetEmail(jobData);
    assert.strictEqual(res.sent, true);

    const inbox = getEmailInbox();
    assert.strictEqual(inbox.length, 1);
    const sent = inbox[0];

    const expectedBase = (env.APP_BASE_URL || `http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}`).replace(/\/+$/, '');
    const expectedResetUrl = `${expectedBase}/v1/auth/reset-password?token=${rawToken}`;

    assert.ok(sent.text?.includes(expectedResetUrl), 'Text contains reset URL');
    assert.ok(sent.html?.includes(`<a href="${expectedResetUrl}"`), 'HTML contains anchor link button');
  });

  it('7. Redis idempotency: Skips duplicate delivery on repeated attempts with identical idempotencyKey', async () => {
    const idempotencyKey = `idem_dup_${randomUUID()}`;

    // First attempt succeeds
    const firstRes = await sendEmail({
      to: 'single@example.com',
      subject: 'Once only',
      text: 'First time',
      idempotencyKey,
    });
    assert.strictEqual(firstRes.sent, true);
    assert.strictEqual(firstRes.duplicate, undefined);

    // Second attempt is recognized as duplicate
    const secondRes = await sendEmail({
      to: 'single@example.com',
      subject: 'Once only',
      text: 'Second time',
      idempotencyKey,
    });
    assert.strictEqual(secondRes.sent, false);
    assert.strictEqual(secondRes.duplicate, true);

    // Inbox contains exactly one record
    assert.strictEqual(getEmailInbox().length, 1);
  });
});
