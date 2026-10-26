import { env } from '../config/env.ts';
import { invalidatePushToken } from './notification-service.ts';

export interface SendPushOptions {
  pushToken: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  urgent?: boolean;
}

export interface SendPushResult {
  success: boolean;
  ticketId: string;
  status: 'ok' | 'error';
  message?: string;
  errorDetail?: string;
  provider: 'expo' | 'simulated';
}

export interface DispatchedPushRecord extends SendPushOptions {
  ticketId: string;
  dispatchedAt: string;
}

// In-memory record for automated test assertions
const pushDispatchHistory: DispatchedPushRecord[] = [];

// Optional hook for simulating network/transient failures in tests
let simulatedFailureHook: ((token: string) => void) | null = null;

// Optional custom fetch hook for hermetic Expo REST API adapter testing
export type PushFetchHook = (url: string, init?: RequestInit) => Promise<Response>;
let customPushFetch: PushFetchHook | null = null;

export function getPushDispatchHistory(): DispatchedPushRecord[] {
  return [...pushDispatchHistory];
}

export function clearPushDispatchHistory(): void {
  pushDispatchHistory.length = 0;
  simulatedFailureHook = null;
  customPushFetch = null;
}

export function setSimulatedPushFailure(hook: ((token: string) => void) | null): void {
  simulatedFailureHook = hook;
}

export function setCustomPushFetch(hook: PushFetchHook | null): void {
  customPushFetch = hook;
}

/**
 * Validates whether a token string is a valid Expo Push token.
 */
export function isValidExpoPushToken(token: string): boolean {
  return (
    typeof token === 'string' &&
    (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) &&
    token.endsWith(']')
  );
}

/**
 * Dispatches a push notification via Expo Push REST API (https://exp.host/--/api/v2/push/send)
 * Handles ticket errors and automatically invalidates tokens on DeviceNotRegistered.
 */
async function sendViaExpo(options: SendPushOptions): Promise<SendPushResult> {
  const { pushToken, title, body, data, urgent } = options;
  const fetchFn = customPushFetch || fetch;

  const payload = {
    to: pushToken,
    title,
    body,
    data,
    priority: urgent ? 'high' : 'default',
    sound: 'default',
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (env.EXPO_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }

  const response = await fetchFn('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Expo push HTTP ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as any;
  const ticketData = Array.isArray(result?.data) ? result.data[0] : result?.data;

  if (ticketData?.status === 'ok') {
    const ticketId = ticketData.id || `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const record: DispatchedPushRecord = {
      pushToken,
      title,
      body,
      data,
      urgent,
      ticketId,
      dispatchedAt: new Date().toISOString(),
    };
    pushDispatchHistory.push(record);

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[Push Service] Dispatched push via Expo to ${pushToken}: "${title}" (ticketId: ${ticketId})`);
    }

    return {
      success: true,
      ticketId,
      status: 'ok',
      provider: 'expo',
    };
  }

  if (ticketData?.status === 'error') {
    const errorType = ticketData.details?.error;
    if (errorType === 'DeviceNotRegistered') {
      await invalidatePushToken(pushToken);
      return {
        success: false,
        ticketId: '',
        status: 'error',
        message: ticketData.message || 'DeviceNotRegistered',
        errorDetail: 'DeviceNotRegistered',
        provider: 'expo',
      };
    }

    throw new Error(`Expo push error: ${ticketData.message || errorType || 'Unknown error'}`);
  }

  const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  return {
    success: true,
    ticketId,
    status: 'ok',
    provider: 'expo',
  };
}

/**
 * Dispatches a push notification via Expo or in-memory simulator.
 * Throws transient errors if simulated failure hook or network fails, enabling the queue worker to backoff and retry.
 */
export async function sendPushNotification(options: SendPushOptions): Promise<SendPushResult> {
  const { pushToken, title, body, data, urgent } = options;

  if (!isValidExpoPushToken(pushToken)) {
    throw new Error(`INVALID_PUSH_TOKEN: '${pushToken}' is not a valid Expo push token format`);
  }

  // Trigger simulated failure if test hook configured
  if (simulatedFailureHook) {
    simulatedFailureHook(pushToken);
  }

  const isTest =
    (process.env.NODE_ENV || env.NODE_ENV) === 'test' ||
    process.env.NODE_TEST_CONTEXT !== undefined ||
    process.argv.some((a) => a.includes('--test') || a.includes('.test.'));
  const forcedProvider = process.env.PUSH_PROVIDER || (isTest ? undefined : env.PUSH_PROVIDER);
  const shouldUseExpo = isTest
    ? (customPushFetch !== null || forcedProvider === 'expo')
    : (customPushFetch !== null ||
       forcedProvider === 'expo' ||
       ((process.env.NODE_ENV || env.NODE_ENV) === 'production' && forcedProvider !== 'simulated'));

  if (shouldUseExpo) {
    return await sendViaExpo(options);
  }

  // Simulated transport (default in dev/test)
  const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const record: DispatchedPushRecord = {
    pushToken,
    title,
    body,
    data,
    urgent,
    ticketId,
    dispatchedAt: new Date().toISOString(),
  };

  pushDispatchHistory.push(record);

  if (process.env.NODE_ENV !== 'test') {
    console.log(`[Push Service] Dispatched push to ${pushToken}: "${title}" (ticketId: ${ticketId})`);
  }

  return {
    success: true,
    ticketId,
    status: 'ok',
    provider: 'simulated',
  };
}
