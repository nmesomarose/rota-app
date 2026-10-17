/**
 * Tenant-Scoped Caching Service
 * PRD Reference: 14.1 (AC-015), 14.2 (AC-TEN-05), 14.9 (AC-OPS-05, NFR-PERF-002, NFR-PERF-004)
 *
 * Implements a high-performance in-memory tenant cache with:
 * 1. Strict tenant key prefixing: 'tenant:{businessId}:{key}' (SEC-014, AC-TEN-05).
 * 2. Tenant-scoped invalidation: Invalidating Business A never touches Business B.
 * 3. Write-through invalidation on shift creation, updates, and publishing (AC-OPS-05).
 * 4. Dynamic toggle (before/after caching) for scientific A/B benchmarking (AC-015).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TenantCacheService {
  private store: Map<string, CacheEntry<unknown>> = new Map();
  private enabled: boolean = true;

  /**
   * Toggles caching globally for A/B performance measurement (NFR-PERF-002, AC-015).
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearAll();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generates a strictly tenant-isolated cache key (SEC-014, AC-TEN-05).
   */
  private formatKey(businessId: string, key: string): string {
    return `tenant:${businessId}:${key}`;
  }

  /**
   * Retrieves a cached value for a specific tenant.
   */
  public get<T>(businessId: string, key: string): T | null {
    if (!this.enabled) {
      return null;
    }

    const fullKey = this.formatKey(businessId, key);
    const entry = this.store.get(fullKey);

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(fullKey);
      return null;
    }

    return entry.value as T;
  }

  /**
   * Sets a value in the tenant's isolated cache partition with TTL in seconds.
   */
  public set<T>(businessId: string, key: string, value: T, ttlSeconds: number = 60): void {
    if (!this.enabled) {
      return;
    }

    const fullKey = this.formatKey(businessId, key);
    this.store.set(fullKey, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Invalidates tenant-specific keys by prefix without touching other tenants (AC-TEN-05, AC-OPS-05).
   */
  public invalidatePrefix(businessId: string, prefix: string = ''): number {
    const tenantPrefix = `tenant:${businessId}:${prefix}`;
    let count = 0;

    for (const key of this.store.keys()) {
      if (key.startsWith(tenantPrefix)) {
        this.store.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Invalidates all cached entries for a specific tenant.
   */
  public invalidateTenant(businessId: string): number {
    return this.invalidatePrefix(businessId, '');
  }

  /**
   * Clears the entire cache store.
   */
  public clearAll(): void {
    this.store.clear();
  }

  /**
   * Returns current cache statistics for observability.
   */
  public getStats(): { size: number; enabled: boolean } {
    return {
      size: this.store.size,
      enabled: this.enabled,
    };
  }
}

export const cacheService = new TenantCacheService();
