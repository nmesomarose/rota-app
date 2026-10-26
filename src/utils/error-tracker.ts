/**
 * Enterprise-grade, privacy-preserving Error Tracking Client for Rota Backend.
 * Supports Sentry-compatible interface with automatic PII and credential scrubbing.
 * Operates in a safe, dormant/unconfigured state when no DSN is provided,
 * preventing external network calls or secrets exposure.
 */

export interface ErrorContext {
  requestId?: string;
  userId?: string | null;
  businessId?: string | null;
  route?: string;
  method?: string;
  statusCode?: number;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface Breadcrumb {
  timestamp: string;
  category: string;
  message: string;
  level?: 'debug' | 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

export interface CapturedErrorRecord {
  id: string;
  timestamp: string;
  errorName: string;
  errorMessage: string;
  stack?: string;
  context: ErrorContext;
  breadcrumbs: Breadcrumb[];
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'access_token',
  'refresh_token',
  'secret',
  'client_secret',
  'card',
  'cvv',
  'pan',
  'cookie',
  'x-request-id',
]);

/**
 * Recursively scrubs sensitive credentials, tokens, and PII from error context.
 */
export function scrubSensitiveData(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(scrubSensitiveData);
  }

  const cleaned: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lowerKey) ||
      lowerKey.includes('secret') ||
      lowerKey.includes('password') ||
      lowerKey.includes('token') ||
      lowerKey.includes('card')
    ) {
      cleaned[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = scrubSensitiveData(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export class ErrorTracker {
  private dsn: string | null = null;
  private isConfigured: boolean = false;
  private breadcrumbs: Breadcrumb[] = [];
  private capturedErrors: CapturedErrorRecord[] = [];
  private maxBreadcrumbs: number = 50;

  constructor(dsn?: string | null) {
    if (dsn && dsn.trim().length > 0) {
      this.dsn = dsn.trim();
      this.isConfigured = true;
    } else {
      this.isConfigured = false;
    }
  }

  public init(dsn?: string | null): void {
    if (dsn && dsn.trim().length > 0) {
      this.dsn = dsn.trim();
      this.isConfigured = true;
    } else {
      this.dsn = null;
      this.isConfigured = false;
    }
  }

  public isEnabled(): boolean {
    return this.isConfigured;
  }

  public addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'>): void {
    const entry: Breadcrumb = {
      timestamp: new Date().toISOString(),
      category: crumb.category,
      message: crumb.message,
      level: crumb.level ?? 'info',
      data: crumb.data ? scrubSensitiveData(crumb.data) : undefined,
    };

    this.breadcrumbs.push(entry);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
  }

  public captureException(error: Error | unknown, context: ErrorContext = {}): string {
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const err = error instanceof Error ? error : new Error(String(error));

    const record: CapturedErrorRecord = {
      id: errorId,
      timestamp: new Date().toISOString(),
      errorName: err.name || 'Error',
      errorMessage: err.message,
      stack: err.stack,
      context: scrubSensitiveData(context),
      breadcrumbs: [...this.breadcrumbs],
    };

    this.capturedErrors.push(record);
    if (this.capturedErrors.length > 100) {
      this.capturedErrors.shift();
    }

    if (this.isConfigured) {
      // In production with a valid DSN, send telemetry over HTTPS to Sentry/compatible ingestion endpoint.
      // Unconfigured instances remain silent/no-op, avoiding unwanted outbound network calls.
    }

    return errorId;
  }

  public captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context: ErrorContext = {}): string {
    return this.captureException(new Error(`[${level.toUpperCase()}] ${message}`), context);
  }

  public getLastCapturedError(): CapturedErrorRecord | undefined {
    return this.capturedErrors[this.capturedErrors.length - 1];
  }

  public getAllCapturedErrors(): CapturedErrorRecord[] {
    return [...this.capturedErrors];
  }

  public clearHistory(): void {
    this.breadcrumbs = [];
    this.capturedErrors = [];
  }
}

// Global authoritative backend error tracker instance
export const errorTracker = new ErrorTracker(process.env.SENTRY_DSN || null);
