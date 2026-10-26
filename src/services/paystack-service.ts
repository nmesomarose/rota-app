/**
 * Paystack Payment Provider Service (Test Mode Integration)
 *
 * Implements Paystack hosted checkout initialization, server-authoritative
 * transaction verification, and HMAC-SHA512 raw-body webhook signature verification.
 */

import crypto from 'node:crypto';
import { env } from '../config/env.ts';

// Environment variable configuration (secrets kept server-side only)
export function getPaystackConfig() {
  const secretKey = (process.env.PAYSTACK_SECRET_KEY || env.PAYSTACK_SECRET_KEY || '').trim();
  const publicKey = (process.env.PAYSTACK_PUBLIC_KEY || env.PAYSTACK_PUBLIC_KEY || '').trim();
  const baseUrl = (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').trim();
  const appBaseUrl = (process.env.APP_BASE_URL || env.APP_BASE_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
  const rawCallback = (process.env.PAYSTACK_CALLBACK_URL || env.PAYSTACK_CALLBACK_URL || `${appBaseUrl}/v1/billing/return`).trim();
  // Strip any accidental space after protocol e.g. "http:// " -> "http://"
  const callbackUrl = rawCallback.replace(/^(https?:\/\/)\s+/, '$1');

  const isProduction = (process.env.NODE_ENV || env.NODE_ENV) === 'production';
  const isRealKeyConfigured = Boolean(
    secretKey &&
      (secretKey.startsWith('sk_test_') || secretKey.startsWith('sk_live_'))
  );

  return {
    secretKey,
    publicKey,
    baseUrl,
    appBaseUrl,
    callbackUrl,
    isProduction,
    isRealKeyConfigured,
  };
}

export interface InitializePaystackParams {
  email: string;
  amountMinor: number; // minor units: kobo for NGN, cents for USD
  currency: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PaystackInitResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackVerificationResult {
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  reference: string;
  amountMinor: number;
  currency: string;
  paidAt?: string;
  gatewayResponse?: string;
  channel?: string;
  id?: number | string;
  metadata?: Record<string, unknown>;
}

// In-memory test mock registry for deterministic automated tests and offline runs
let mockModeExplicitlyEnabled: boolean | null = null;
const mockTransactions = new Map<string, PaystackVerificationResult>();

export function setPaystackMockMode(enabled: boolean): void {
  mockModeExplicitlyEnabled = enabled;
}

export function isPaystackMockMode(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false; // NEVER allowed in production
  }
  if (mockModeExplicitlyEnabled !== null) {
    return mockModeExplicitlyEnabled;
  }
  return process.env.NODE_ENV === 'test' || !getPaystackConfig().isRealKeyConfigured;
}

export function registerMockPaystackTransaction(result: PaystackVerificationResult): void {
  mockTransactions.set(result.reference, result);
}

export function clearPaystackMocks(): void {
  mockTransactions.clear();
}

/**
 * Computes Paystack HMAC-SHA512 webhook signature over the raw request payload.
 */
export function computePaystackSignature(rawBody: string | Buffer, secret: string): string {
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return crypto.createHmac('sha512', secret).update(bodyStr).digest('hex');
}

/**
 * Verifies Paystack HMAC-SHA512 webhook signature with timingSafeEqual defense.
 */
export function verifyPaystackSignature(
  rawBody: string | Buffer,
  signature: string,
  secret?: string
): boolean {
  try {
    const config = getPaystackConfig();
    const effectiveSecret = secret || config.secretKey;
    const expected = computePaystackSignature(rawBody, effectiveSecret);

    const expectedBuf = Buffer.from(expected, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');

    if (expectedBuf.length !== signatureBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

/**
 * Initializes a Paystack hosted checkout session.
 * In production/sandbox with valid credentials, calls https://api.paystack.co/transaction/initialize.
 * In test harness without outbound network, generates a deterministic test authorization URL.
 */
export async function initializePaystackCheckout(
  params: InitializePaystackParams
): Promise<PaystackInitResult> {
  const config = getPaystackConfig();

  // 1. Guard against missing credentials in production
  if (config.isProduction && !config.isRealKeyConfigured) {
    const error: any = new Error(
      'Paystack credentials are not configured for production. Live or test keys are required.'
    );
    error.code = 'PAYSTACK_CONFIG_ERROR';
    error.status = 500;
    throw error;
  }

  // 2. Explicit automated test mock mode (e.g. automated test suite calling setPaystackMockMode(true))
  if (mockModeExplicitlyEnabled === true) {
    if (!mockTransactions.has(params.reference)) {
      mockTransactions.set(params.reference, {
        status: 'success',
        reference: params.reference,
        amountMinor: params.amountMinor,
        currency: params.currency,
        paidAt: new Date().toISOString(),
        gatewayResponse: 'Successful',
        channel: 'card',
        id: Math.floor(Math.random() * 10000000),
        metadata: params.metadata,
      });
    }

    return {
      authorizationUrl: `https://checkout.paystack.com/${params.reference}`,
      accessCode: `access_${params.reference}`,
      reference: params.reference,
    };
  }

  // 3. Real Paystack API call (when valid test/live key is configured)
  if (config.isRealKeyConfigured) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(`${config.baseUrl}/transaction/initialize`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: params.email,
          amount: params.amountMinor,
          currency: params.currency,
          reference: params.reference,
          callback_url: params.callbackUrl || config.callbackUrl,
          metadata: params.metadata,
        }),
      });

      clearTimeout(timeoutId);

      let body: any;
      try {
        body = await response.json();
      } catch {
        body = { status: false, message: `Paystack returned non-JSON response (HTTP ${response.status})` };
      }

      if (!response.ok || !body.status) {
        const message = body.message || 'Paystack hosted checkout initialization failed';
        const error: any = new Error(
          params.currency === 'USD' && message.toLowerCase().includes('currency')
            ? `${message}. (Note: Paystack Nigerian test accounts require international currencies enabled on the Paystack dashboard or billing in NGN).`
            : message
        );
        error.code = 'PAYSTACK_INIT_ERROR';
        error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
        error.details = body;
        throw error;
      }

      return {
        authorizationUrl: body.data.authorization_url,
        accessCode: body.data.access_code,
        reference: body.data.reference || params.reference,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const error: any = new Error('Paystack initialization request timed out after 12 seconds');
        error.code = 'PAYSTACK_TIMEOUT';
        error.status = 504;
        throw error;
      }
      if (err.code === 'PAYSTACK_INIT_ERROR') {
        throw err;
      }
      console.error('[Paystack Checkout Network Error]', err);
      const error: any = new Error(
        `Unable to reach Paystack gateway (${err.message || 'network connection failed'}). Please verify your internet connection or Paystack keys in .env.`
      );
      error.code = 'PAYSTACK_NETWORK_ERROR';
      error.status = 502;
      error.details = err;
      throw error;
    }
  }

  // 4. Local development simulator (when in dev and NO key is configured)
  const mockCheckoutUrl = `${config.appBaseUrl}/v1/billing/mock-checkout?reference=${encodeURIComponent(params.reference)}`;
  return {
    authorizationUrl: mockCheckoutUrl,
    accessCode: `mock_access_${params.reference}`,
    reference: params.reference,
  };
}

/**
 * Verifies a transaction authoritatively against Paystack's verify API.
 * Never trusts client redirect claims.
 */
export async function verifyPaystackTransaction(
  reference: string
): Promise<PaystackVerificationResult> {
  const config = getPaystackConfig();

  if (config.isProduction && !config.isRealKeyConfigured) {
    const error: any = new Error('Paystack credentials missing in production.');
    error.code = 'PAYSTACK_CONFIG_ERROR';
    error.status = 500;
    throw error;
  }

  // Explicit mock mode or local mock simulator
  if (mockModeExplicitlyEnabled === true || !config.isRealKeyConfigured) {
    const mocked = mockTransactions.get(reference);
    if (mocked) {
      return mocked;
    }
    return {
      status: 'abandoned',
      reference,
      amountMinor: 0,
      currency: 'USD',
      gatewayResponse: 'Transaction reference not found in sandbox mock',
    };
  }

  // Real Paystack API call
  const response = await fetch(`${config.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      'Content-Type': 'application/json',
    },
  });

  const body = (await response.json()) as any;
  if (!response.ok || !body.status) {
    const error: any = new Error(body.message || 'Paystack verification failed');
    error.code = 'PAYSTACK_VERIFY_ERROR';
    error.status = response.status || 502;
    error.details = body;
    throw error;
  }

  const data = body.data;
  let status: 'success' | 'failed' | 'abandoned' | 'pending' = 'failed';
  if (data.status === 'success') {
    status = 'success';
  } else if (data.status === 'ongoing' || data.status === 'pending') {
    status = 'pending';
  } else if (data.status === 'abandoned') {
    status = 'abandoned';
  }

  return {
    status,
    reference: data.reference,
    amountMinor: data.amount,
    currency: data.currency,
    paidAt: data.paid_at,
    gatewayResponse: data.gateway_response,
    channel: data.channel,
    id: data.id,
    metadata: data.metadata,
  };
}
