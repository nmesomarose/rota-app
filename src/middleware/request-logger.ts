import { type Request, type Response, type NextFunction } from 'express';

export type RequestOutcome = 'SUCCESS' | 'CLIENT_ERROR' | 'SERVER_ERROR';

export interface StructuredRequestLog {
  timestamp: string;
  requestId: string;
  userId: string | null;
  businessId: string | null;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  outcome: RequestOutcome;
  userAgent?: string;
  ip?: string;
}

export type RequestLogSink = (log: StructuredRequestLog) => void;

// Default log sink writes structured JSON to standard output
let currentLogSink: RequestLogSink = (record: StructuredRequestLog) => {
  // In test environment, skip printing unless explicitly requested to prevent stdout noise
  if (process.env.NODE_ENV !== 'test') {
    console.log(JSON.stringify(record));
  }
};

/**
 * Sets a custom log sink (useful for unit testing and log aggregators).
 */
export function setRequestLogSink(sink: RequestLogSink): void {
  currentLogSink = sink;
}

/**
 * Resets the log sink back to default JSON console output.
 */
export function resetRequestLogSink(): void {
  currentLogSink = (record: StructuredRequestLog) => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(JSON.stringify(record));
    }
  };
}

/**
 * Determines canonical request outcome category based on HTTP status code.
 */
export function categorizeOutcome(statusCode: number): RequestOutcome {
  if (statusCode < 400) return 'SUCCESS';
  if (statusCode < 500) return 'CLIENT_ERROR';
  return 'SERVER_ERROR';
}

/**
 * Structured request-completion logging middleware.
 * Hooks into `res.on('finish')` to capture the true latency, HTTP outcome,
 * request ID, and authenticated user ID without ever logging sensitive credentials,
 * authorization headers, passwords, or request bodies (SEC-004, AUDIT-001).
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const endTime = process.hrtime.bigint();
      const durationMs = Number((endTime - startTime) / 1000000n);

      const userId = (req as any).user?.id ?? null;
      const businessId = (req as any).user?.businessId ?? (req.header('x-business-id') || null);
      const requestId = req.id || (res.getHeader('x-request-id') as string) || 'unknown';
      const statusCode = res.statusCode;
      const outcome = categorizeOutcome(statusCode);

      // Clean route string: strip potential sensitive query string values
      let sanitizedRoute = req.originalUrl || req.url;
      try {
        const urlObj = new URL(sanitizedRoute, 'http://localhost');
        // Redact any sensitive query params if present
        for (const [key] of urlObj.searchParams.entries()) {
          const lower = key.toLowerCase();
          if (lower.includes('token') || lower.includes('secret') || lower.includes('key') || lower.includes('password')) {
            urlObj.searchParams.set(key, '[REDACTED]');
          }
        }
        sanitizedRoute = urlObj.pathname + (urlObj.search || '');
      } catch {
        // Fallback to raw path if URL parsing fails
      }

      const logRecord: StructuredRequestLog = {
        timestamp: new Date().toISOString(),
        requestId,
        userId,
        businessId,
        method: req.method,
        route: sanitizedRoute,
        statusCode,
        durationMs,
        outcome,
        userAgent: req.header ? req.header('user-agent') : undefined,
        ip: req.ip || req.socket?.remoteAddress,
      };

      currentLogSink(logRecord);
    } catch {
      // Never let logging failure crash an active HTTP response
    }
  });

  next();
}
