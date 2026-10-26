import { getRedisClient, isRedisConnected } from './redis-client.ts';
import { env } from '../config/env.ts';

export interface SendEmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  sent: boolean;
  messageId: string;
  duplicate?: boolean;
  inFlight?: boolean;
  provider: 'simulated' | 'resend' | 'smtp';
}

export interface SentEmailRecord extends SendEmailOptions {
  messageId: string;
  sentAt: string;
  provider?: string;
}

// In-memory recorded emails for testing and development auditing
const sentEmailInbox: SentEmailRecord[] = [];

// Optional hook for simulating email transmission failure in tests
let simulatedEmailFailureHook: ((to: string) => void) | null = null;

// Pluggable fetch client (allows unit testing Resend API calls without network dependencies)
let customEmailFetch: typeof fetch = fetch;

export function getEmailInbox(): SentEmailRecord[] {
  return [...sentEmailInbox];
}

export function clearEmailInbox(): void {
  sentEmailInbox.length = 0;
  simulatedEmailFailureHook = null;
  customEmailFetch = fetch;
}

export function setSimulatedEmailFailure(hook: ((to: string) => void) | null): void {
  simulatedEmailFailureHook = hook;
}

export function setCustomEmailFetch(mockFetch: typeof fetch | null): void {
  customEmailFetch = mockFetch || fetch;
}

const RELEASE_SENDING_LOCK_LUA = `
  local key = KEYS[1]
  local val = redis.call('GET', key)
  if val == 'sending' then
    return redis.call('DEL', key)
  else
    return 0
  end
`;

/**
 * Dispatches an email through Resend's REST API.
 * Uses native fetch to avoid external runtime dependencies.
 */
async function sendViaResend(
  apiKey: string,
  from: string,
  options: SendEmailOptions
): Promise<string> {
  const payload: Record<string, any> = {
    from,
    to: [options.to],
    subject: options.subject,
  };
  if (options.html) payload.html = options.html;
  if (options.text) payload.text = options.text;

  const res = await customEmailFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errMessage = (data as any)?.message || res.statusText || 'Unknown error';
    throw new Error(`Resend API Error (${res.status}): ${errMessage}`);
  }

  const messageId = (data as any)?.id;
  if (!messageId || typeof messageId !== 'string') {
    throw new Error('Resend API returned response without valid message ID');
  }

  return messageId;
}

/**
 * Sends an email using either a live provider (Resend in production) or simulated delivery (dev/test).
 * Supports idempotency keys stored in Redis to prevent duplicate email transmissions on retries.
 * 
 * Safe state transition:
 * 1. Acquires a short-lived (60s) lease 'sending'.
 * 2. If acquired, delivers the email.
 * 3. On success, transitions state to 'sent' (24h TTL) to prevent duplicate side effects.
 * 4. On delivery error, immediately releases the 'sending' lease so retries are never permanently blocked.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { to, subject, text, html, idempotencyKey } = options;
  const redis = isRedisConnected() ? getRedisClient() : null;
  const lockKey = idempotencyKey ? `email:idem:${idempotencyKey}` : null;
  let lockAcquired = false;

  // 1. Idempotency lease check via Redis if key is provided
  if (lockKey && redis) {
    try {
      const setRes = await redis.set(lockKey, 'sending', 'EX', 60, 'NX');
      if (setRes === 'OK') {
        lockAcquired = true;
      } else {
        // Key already exists: check if delivery already finished or in-flight
        const currentVal = await redis.get(lockKey);
        if (currentVal === 'sent' || currentVal === 'sending') {
          return {
            sent: false,
            messageId: `duplicate_${idempotencyKey}`,
            duplicate: true,
            inFlight: currentVal === 'sending',
            provider: 'simulated',
          };
        }
        // Fallback retry acquisition
        const retrySet = await redis.set(lockKey, 'sending', 'EX', 60, 'NX');
        if (retrySet === 'OK') {
          lockAcquired = true;
        } else {
          return {
            sent: false,
            messageId: `duplicate_${idempotencyKey}`,
            duplicate: true,
            provider: 'simulated',
          };
        }
      }
    } catch (err: any) {
      console.warn('[Email Service] Idempotency check failed, proceeding with delivery:', err.message);
    }
  }

  try {
    // 2. Simulated failure hook for testing network/provider transmission errors
    if (simulatedEmailFailureHook) {
      simulatedEmailFailureHook(to);
    }

    // Determine target provider
    const isTest =
      (process.env.NODE_ENV || env.NODE_ENV) === 'test' ||
      process.env.NODE_TEST_CONTEXT !== undefined ||
      process.argv.some((a) => a.includes('--test') || a.includes('.test.'));
    const forcedProvider = process.env.EMAIL_PROVIDER || (isTest ? undefined : env.EMAIL_PROVIDER);
    const runtimeApiKey = (process.env.RESEND_API_KEY || '').trim();
    const fromAddress = (process.env.EMAIL_FROM || env.EMAIL_FROM || 'Rota <onboarding@resend.dev>').trim();
    const isProd = (process.env.NODE_ENV || env.NODE_ENV) === 'production';

    // Production guard: Reject silent simulated fallback in production when no provider is configured
    if (isProd && forcedProvider !== 'simulated' && !runtimeApiKey) {
      throw new Error(
        'EMAIL_CONFIGURATION_ERROR: Real email delivery is required in production, but RESEND_API_KEY is not configured'
      );
    }

    const hasCustomFetch = customEmailFetch !== fetch;
    const useResend =
      hasCustomFetch ||
      (isTest
        ? (forcedProvider === 'resend' && Boolean(runtimeApiKey))
        : (forcedProvider !== 'simulated' && Boolean(runtimeApiKey)));
    let messageId: string;
    let providerName: 'resend' | 'simulated';

    if (useResend) {
      messageId = await sendViaResend(runtimeApiKey, fromAddress, options);
      providerName = 'resend';
    } else {
      messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      providerName = 'simulated';
    }

    const record: SentEmailRecord = {
      to,
      subject,
      text,
      html,
      idempotencyKey,
      messageId,
      sentAt: new Date().toISOString(),
      provider: providerName,
    };

    sentEmailInbox.push(record);

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[Email Service] Delivered email via ${providerName} to ${to}: "${subject}" (messageId: ${messageId})`);
    }

    // 3. On success: Transition state from 'sending' to 'sent' with 24-hour TTL (86400s)
    if (lockKey && redis && lockAcquired) {
      try {
        await redis.set(lockKey, 'sent', 'EX', 86400);
      } catch (err: any) {
        console.warn('[Email Service] Failed to commit email idempotency key:', err.message);
      }
    }

    return {
      sent: true,
      messageId,
      provider: providerName,
    };
  } catch (deliveryError: any) {
    // 4. On failure: Atomically release the 'sending' lock so future retries are NOT blocked!
    if (lockKey && redis && lockAcquired) {
      try {
        await redis.eval(RELEASE_SENDING_LOCK_LUA, 1, lockKey);
      } catch (err: any) {
        console.warn('[Email Service] Failed to release email idempotency lock on error:', err.message);
      }
    }
    throw deliveryError;
  }
}
