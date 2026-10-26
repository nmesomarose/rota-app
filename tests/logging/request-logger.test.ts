import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestLoggerMiddleware,
  setRequestLogSink,
  resetRequestLogSink,
  categorizeOutcome,
  type StructuredRequestLog,
} from '../../src/middleware/request-logger.ts';
import { errorTracker, scrubSensitiveData } from '../../src/utils/error-tracker.ts';
import { mobileErrorTracker } from '../../mobile/src/services/error-tracker.ts';

describe('Structured Request Logging and Error Tracking Tests', () => {
  let capturedLogs: StructuredRequestLog[] = [];

  beforeEach(() => {
    capturedLogs = [];
    setRequestLogSink((log) => {
      capturedLogs.push(log);
    });
    errorTracker.clearHistory();
    mobileErrorTracker.clearHistory();
  });

  afterEach(() => {
    resetRequestLogSink();
  });

  it('categorizes HTTP status codes into canonical outcomes', () => {
    assert.equal(categorizeOutcome(200), 'SUCCESS');
    assert.equal(categorizeOutcome(201), 'SUCCESS');
    assert.equal(categorizeOutcome(304), 'SUCCESS');
    assert.equal(categorizeOutcome(400), 'CLIENT_ERROR');
    assert.equal(categorizeOutcome(401), 'CLIENT_ERROR');
    assert.equal(categorizeOutcome(404), 'CLIENT_ERROR');
    assert.equal(categorizeOutcome(429), 'CLIENT_ERROR');
    assert.equal(categorizeOutcome(500), 'SERVER_ERROR');
    assert.equal(categorizeOutcome(502), 'SERVER_ERROR');
    assert.equal(categorizeOutcome(503), 'SERVER_ERROR');
  });

  it('emits structured request completion log with requestId, user, route, duration, and outcome', async () => {
    const listeners: Record<string, () => void> = {};
    const req: any = {
      id: 'req-test-uuid-1234',
      method: 'GET',
      originalUrl: '/v1/activity/feed?limit=20',
      header: (name: string) => {
        if (name === 'user-agent') return 'Rota-Mobile/1.0';
        if (name === 'x-business-id') return 'biz-test-01';
        return undefined;
      },
      user: {
        id: 'usr-admin-888',
        businessId: 'biz-test-01',
      },
    };

    const res: any = {
      statusCode: 200,
      getHeader: (name: string) => (name.toLowerCase() === 'x-request-id' ? 'req-test-uuid-1234' : undefined),
      on: (event: string, callback: () => void) => {
        listeners[event] = callback;
      },
    };

    await new Promise<void>((resolve) => {
      requestLoggerMiddleware(req, res, () => {
        if (listeners['finish']) {
          listeners['finish']();
        }
        resolve();
      });
    });

    assert.equal(capturedLogs.length, 1, 'Exactly one request log record emitted');
    const log = capturedLogs[0];
    assert.equal(log.requestId, 'req-test-uuid-1234');
    assert.equal(log.userId, 'usr-admin-888');
    assert.equal(log.businessId, 'biz-test-01');
    assert.equal(log.method, 'GET');
    assert.equal(log.route, '/v1/activity/feed?limit=20');
    assert.equal(log.statusCode, 200);
    assert.equal(log.outcome, 'SUCCESS');
    assert.ok(typeof log.durationMs === 'number' && log.durationMs >= 0);
    assert.ok(typeof log.timestamp === 'string');
  });

  it('redacts sensitive query string tokens from logged routes', async () => {
    const listeners: Record<string, () => void> = {};
    const req: any = {
      id: 'req-leak-test',
      method: 'GET',
      originalUrl: '/v1/auth/verify?token=secret_jwt_token_value&apiKey=supersecret',
      header: () => undefined,
    };

    const res: any = {
      statusCode: 200,
      getHeader: () => 'req-leak-test',
      on: (event: string, callback: () => void) => {
        listeners[event] = callback;
      },
    };

    await new Promise<void>((resolve) => {
      requestLoggerMiddleware(req, res, () => {
        listeners['finish']?.();
        resolve();
      });
    });

    assert.equal(capturedLogs.length, 1);
    const log = capturedLogs[0];
    assert.doesNotMatch(log.route, /secret_jwt_token_value/, 'Must not leak secret token value');
    assert.match(log.route, /REDACTED/);
    assert.equal(log.userId, null, 'Unauthenticated requests log null userId');
  });

  it('handles client errors and server errors with proper outcome tag', () => {
    let captured: any = null;
    setRequestLogSink((l) => {
      captured = l;
    });

    const mockComplete = (status: number) => {
      let cb: () => void = () => {};
      const req: any = { id: 'req-err-test', method: 'POST', originalUrl: '/v1/shifts', header: () => undefined };
      const res: any = {
        statusCode: status,
        getHeader: () => 'req-err-test',
        on: (_e: string, fn: () => void) => {
          cb = fn;
        },
      };
      requestLoggerMiddleware(req, res, () => {
        cb();
      });
    };

    mockComplete(404);
    assert.equal(captured?.outcome, 'CLIENT_ERROR');
    assert.equal(captured?.statusCode, 404);

    mockComplete(500);
    assert.equal(captured?.outcome, 'SERVER_ERROR');
    assert.equal(captured?.statusCode, 500);
  });

  it('verifies backend errorTracker scrubSensitiveData redacts passwords, tokens, and cards', () => {
    const dirty = {
      password: 'PlaintextPassword123!',
      nested: {
        authorization: 'Bearer eyJhbGciOi...',
        refreshToken: 'refresh-token-xyz',
        creditCard: '4111222233334444',
      },
      safeField: 'harmless_metric',
    };

    const scrubbed = scrubSensitiveData(dirty);
    assert.equal(scrubbed.password, '[REDACTED]');
    assert.equal(scrubbed.nested.authorization, '[REDACTED]');
    assert.equal(scrubbed.nested.refreshToken, '[REDACTED]');
    assert.equal(scrubbed.nested.creditCard, '[REDACTED]');
    assert.equal(scrubbed.safeField, 'harmless_metric');
  });

  it('verifies backend errorTracker captures exceptions safely without external calls when unconfigured', () => {
    assert.equal(errorTracker.isEnabled(), false, 'Default errorTracker is safely unconfigured/dormant');

    const err = new Error('Database connection failed');
    const errId = errorTracker.captureException(err, {
      requestId: 'req-error-id',
      userId: 'usr-999',
      extra: { secretKey: 'sensitive-dev-key' },
    });

    assert.ok(errId.startsWith('err_'), 'Returns generated error ID');
    const last = errorTracker.getLastCapturedError();
    assert.ok(last);
    assert.equal(last?.errorMessage, 'Database connection failed');
    assert.equal(last?.context.requestId, 'req-error-id');
    assert.equal(last?.context.extra?.secretKey, '[REDACTED]', 'Sensitive context was scrubbed');
  });

  it('verifies mobile errorTracker captures errors and breadcrumbs safely', () => {
    assert.equal(mobileErrorTracker.isEnabled(), false, 'Mobile error tracker is safely dormant when no DSN is provided');

    mobileErrorTracker.addBreadcrumb({
      category: 'navigation',
      message: 'User navigated to FeedScreen',
      data: { token: 'jwt-to-strip', screen: 'FeedScreen' },
    });

    const mobId = mobileErrorTracker.captureError(new Error('Mobile network timeout'), {
      screen: 'FeedScreen',
      userId: 'usr-mobile-1',
    });

    assert.ok(mobId.startsWith('mob_'));
  });
});
