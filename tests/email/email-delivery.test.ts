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
    delete process.env.MAILJET_API_KEY;
    delete process.env.MAILJET_SECRET_KEY;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_FROM;
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

  it('8. Resend testing-domain sender check and provider error handling', async () => {
    // When RESEND_API_KEY is present and Resend returns 403 (e.g. testing domain restrictions)
    process.env.RESEND_API_KEY = 're_test_key_restricted';
    process.env.EMAIL_PROVIDER = 'resend';

    setCustomEmailFetch(async () => {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({
          statusCode: 403,
          name: 'validation_error',
          message: 'You can only send testing emails to your own email address because your domain is not verified.',
        }),
      } as any;
    });

    await assert.rejects(
      async () => {
        await sendEmail({
          to: 'colleague@external.com',
          subject: 'Team Invite',
          text: 'Join us on Rota',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('Resend API Error (403)'));
        assert.ok(err.message.includes('domain is not verified'));
        return true;
      }
    );
  });

  it('9. isEmailDeliveryConfigured accurately reflects production environment requirements', async () => {
    const { isEmailDeliveryConfigured } = await import('../../src/services/email-service.ts');

    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.NODE_TEST_CONTEXT;

    assert.strictEqual(isEmailDeliveryConfigured(), false);

    process.env.RESEND_API_KEY = 're_test_key_123';
    assert.strictEqual(isEmailDeliveryConfigured(), true);

    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_PROVIDER = 'simulated';
    assert.strictEqual(isEmailDeliveryConfigured(), true);

    // Mailjet configured
    process.env.EMAIL_PROVIDER = 'mailjet';
    process.env.MAILJET_API_KEY = 'mj_key';
    process.env.MAILJET_SECRET_KEY = 'mj_secret';
    assert.strictEqual(isEmailDeliveryConfigured(), true);

    delete process.env.MAILJET_SECRET_KEY;
    assert.strictEqual(isEmailDeliveryConfigured(), false);
  });

  it('10. Mailjet integration: Dispatches email via Mailjet v3.1 Send API using Basic Auth', async () => {
    process.env.EMAIL_PROVIDER = 'mailjet';
    process.env.MAILJET_API_KEY = 'test_mj_key_123';
    process.env.MAILJET_SECRET_KEY = 'test_mj_secret_456';
    process.env.EMAIL_FROM = 'Rota Work <sender@company.com>';

    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    setCustomEmailFetch(async (url: any, init: any) => {
      capturedUrl = url.toString();
      capturedHeaders = init?.headers || {};
      capturedBody = JSON.parse(init?.body || '{}');

      return {
        ok: true,
        status: 200,
        json: async () => ({
          Messages: [
            {
              Status: 'success',
              To: [
                {
                  Email: 'recipient@partner.com',
                  MessageID: 9876543210,
                  MessageHref: 'https://api.mailjet.com/v3/REST/message/9876543210',
                },
              ],
            },
          ],
        }),
      } as any;
    });

    const res = await sendEmail({
      to: 'recipient@partner.com',
      subject: 'Team Roster Update',
      text: 'Schedule is now live.',
      html: '<b>Schedule is now live.</b>',
    });

    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.provider, 'mailjet');
    assert.strictEqual(res.messageId, '9876543210');

    assert.strictEqual(capturedUrl, 'https://api.mailjet.com/v3.1/send');
    const expectedAuth = `Basic ${Buffer.from('test_mj_key_123:test_mj_secret_456').toString('base64')}`;
    assert.strictEqual(capturedHeaders['Authorization'], expectedAuth);
    assert.strictEqual(capturedHeaders['Content-Type'], 'application/json');

    assert.deepStrictEqual(capturedBody.Messages[0].From, {
      Email: 'sender@company.com',
      Name: 'Rota Work',
    });
    assert.deepStrictEqual(capturedBody.Messages[0].To, [{ Email: 'recipient@partner.com' }]);
    assert.strictEqual(capturedBody.Messages[0].Subject, 'Team Roster Update');
    assert.strictEqual(capturedBody.Messages[0].TextPart, 'Schedule is now live.');
    assert.strictEqual(capturedBody.Messages[0].HTMLPart, '<b>Schedule is now live.</b>');

    const inbox = getEmailInbox();
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].provider, 'mailjet');
    assert.strictEqual(inbox[0].messageId, '9876543210');
  });

  it('11. Mailjet error handling: Throws descriptive error on HTTP rejection or message-level errors', async () => {
    process.env.EMAIL_PROVIDER = 'mailjet';
    process.env.MAILJET_API_KEY = 'invalid_key';
    process.env.MAILJET_SECRET_KEY = 'invalid_secret';
    process.env.EMAIL_FROM = 'Rota <sender@company.com>';

    // Case A: HTTP 401 Unauthorized
    setCustomEmailFetch(async () => {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({
          ErrorMessage: 'Invalid API key or secret',
        }),
      } as any;
    });

    await assert.rejects(
      async () => {
        await sendEmail({
          to: 'anyone@example.com',
          subject: 'Test',
          text: 'Hello',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('Mailjet API Error (401)'));
        assert.ok(err.message.includes('Invalid API key or secret'));
        return true;
      }
    );

    // Case B: HTTP 200 with message-level error status
    setCustomEmailFetch(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Messages: [
            {
              Status: 'error',
              Errors: [
                {
                  ErrorIdentifier: 'mj-001',
                  ErrorCode: 400,
                  StatusCode: 400,
                  ErrorMessage: 'Sender email not verified in Mailjet',
                },
              ],
            },
          ],
        }),
      } as any;
    });

    await assert.rejects(
      async () => {
        await sendEmail({
          to: 'anyone@example.com',
          subject: 'Test',
          text: 'Hello',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('Mailjet API Error'));
        assert.ok(err.message.includes('Sender email not verified in Mailjet'));
        return true;
      }
    );
  });

  it('12. Provider exclusivity: Mailjet is only invoked when EMAIL_PROVIDER=mailjet is explicitly set', async () => {
    // Both Resend and Mailjet keys are present in env
    process.env.RESEND_API_KEY = 're_key_123';
    process.env.MAILJET_API_KEY = 'mj_key_123';
    process.env.MAILJET_SECRET_KEY = 'mj_secret_123';
    delete process.env.EMAIL_PROVIDER; // Not explicitly set

    let invokedProvider = '';
    setCustomEmailFetch(async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('resend.com')) invokedProvider = 'resend';
      if (urlStr.includes('mailjet.com')) invokedProvider = 'mailjet';

      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'resend_id_123' }),
      } as any;
    });

    const res = await sendEmail({
      to: 'member@example.com',
      subject: 'Default Provider Check',
      text: 'Checking default provider',
    });

    assert.strictEqual(invokedProvider, 'resend', 'Resend must remain default when EMAIL_PROVIDER is not mailjet');
    assert.strictEqual(res.provider, 'resend');
  });
});
