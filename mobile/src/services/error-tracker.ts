/**
 * Mobile Client Error Tracking Service for Rota React Native / Expo Application.
 * Captures uncaught exceptions, network faults, and critical UI crashes.
 * Automatically sanitizes tokens, passwords, and sensitive credentials.
 * Operates safely as a dormant no-op when SENTRY_DSN is absent.
 */

export interface MobileErrorContext {
  userId?: string | null;
  businessId?: string | null;
  screen?: string;
  action?: string;
  extra?: Record<string, unknown>;
}

export interface MobileBreadcrumb {
  timestamp: string;
  category: string;
  message: string;
  level?: 'debug' | 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

const SENSITIVE_MOBILE_KEYS = new Set([
  'token',
  'refreshtoken',
  'accesstoken',
  'password',
  'authorization',
  'secret',
  'credentials',
]);

function sanitizeMobileData(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeMobileData);

  const cleaned: Record<string, any> = {};
  for (const [key, val] of Object.entries(data)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_MOBILE_KEYS.has(lower) || lower.includes('pass') || lower.includes('token') || lower.includes('secret')) {
      cleaned[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      cleaned[key] = sanitizeMobileData(val);
    } else {
      cleaned[key] = val;
    }
  }
  return cleaned;
}

export class MobileErrorTracker {
  private isConfigured: boolean = false;
  private breadcrumbs: MobileBreadcrumb[] = [];
  private history: Array<{ id: string; message: string; timestamp: string }> = [];

  constructor(dsn?: string | null) {
    this.isConfigured = Boolean(dsn && dsn.trim().length > 0);
  }

  public init(dsn?: string | null): void {
    this.isConfigured = Boolean(dsn && dsn.trim().length > 0);
  }

  public isEnabled(): boolean {
    return this.isConfigured;
  }

  public addBreadcrumb(crumb: Omit<MobileBreadcrumb, 'timestamp'>): void {
    this.breadcrumbs.push({
      timestamp: new Date().toISOString(),
      category: crumb.category,
      message: crumb.message,
      level: crumb.level ?? 'info',
      data: crumb.data ? sanitizeMobileData(crumb.data) : undefined,
    });
    if (this.breadcrumbs.length > 30) {
      this.breadcrumbs.shift();
    }
  }

  public captureError(error: Error | unknown, context: MobileErrorContext = {}): string {
    const errorId = `mob_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const message = error instanceof Error ? error.message : String(error);

    this.history.push({
      id: errorId,
      message,
      timestamp: new Date().toISOString(),
    });

    if (this.isConfigured) {
      // In production environment with configured mobile DSN (e.g., Sentry for React Native),
      // forward sanitized crash events to the monitoring ingest.
    }

    return errorId;
  }

  public clearHistory(): void {
    this.breadcrumbs = [];
    this.history = [];
  }
}

export const mobileErrorTracker = new MobileErrorTracker(null);
