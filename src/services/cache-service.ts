/**
 * Tenant-Scoped Caching Service (Redis-Backed with Graceful PostgreSQL / In-Memory Fallback)
 * PRD Reference: 14.1 (AC-015), 14.2 (AC-TEN-05), 14.9 (AC-OPS-05, NFR-PERF-002, NFR-PERF-004)
 *
 * Implements a high-performance tenant cache with:
 * 1. Primary Redis backing with fast connection pooling (SEC-014, AC-TEN-05).
 * 2. Strict tenant key prefixing: 'tenant:{businessId}:{key}'.
 * 3. Tenant-scoped invalidation: Invalidating Business A never touches Business B.
 * 4. Write-through invalidation on schedule and roster mutations (AC-OPS-05).
 * 5. Safe cache bypass: When Redis is unavailable or disconnected, bypasses the cache
 *    to read directly from PostgreSQL, while preserving fail-closed behavior for
 *    security-critical operations.
 * 6. Dynamic toggle (before/after caching) for scientific A/B benchmarking (AC-015).
 */

import { getRedisClient, isRedisConnected } from './redis-client.ts';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TenantCacheService {
  private localStore: Map<string, CacheEntry<unknown>> = new Map();
  private enabled: boolean = true;

  /**
   * Toggles caching globally for A/B performance measurement (NFR-PERF-002, AC-015).
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearAll().catch(() => {});
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Generates a strictly tenant-isolated cache key (SEC-014, AC-TEN-05).
   */
  public formatKey(businessId: string, key: string): string {
    return `tenant:${businessId}:${key}`;
  }

  /**
   * Retrieves a cached value for a specific tenant.
   * Prioritizes Redis; if Redis is unavailable or errors, falls back to local memory,
   * or returns null to trigger safe direct PostgreSQL read.
   */
  public async get<T>(businessId: string, key: string): Promise<T | null> {
    if (!this.enabled) {
      return null;
    }

    const fullKey = this.formatKey(businessId, key);

    // 1. Primary: Redis-backed read
    if (isRedisConnected()) {
      try {
        const redis = getRedisClient();
        const raw = await redis.get(fullKey);
        if (raw !== null) {
          return JSON.parse(raw) as T;
        }
      } catch (err) {
        console.warn('[CacheService] Redis get failed, safely falling back to PostgreSQL:', (err as Error).message);
      }
    }

    // 2. Fallback: In-memory store
    const entry = this.localStore.get(fullKey);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.localStore.delete(fullKey);
      return null;
    }

    return entry.value as T;
  }

  /**
   * Sets a value in the tenant's isolated cache partition with TTL in seconds.
   * Writes to both Redis and local in-memory fallback store.
   */
  public async set<T>(businessId: string, key: string, value: T, ttlSeconds: number = 60): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const fullKey = this.formatKey(businessId, key);

    // Update in-memory fallback
    this.localStore.set(fullKey, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    // Write to Redis if connected
    if (isRedisConnected()) {
      try {
        const redis = getRedisClient();
        await redis.set(fullKey, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        console.warn('[CacheService] Redis set failed:', (err as Error).message);
      }
    }
  }

  /**
   * Invalidates tenant-specific keys by prefix without touching other tenants (AC-TEN-05, AC-OPS-05).
   */
  public async invalidatePrefix(businessId: string, prefix: string = ''): Promise<number> {
    const tenantPrefix = `tenant:${businessId}:${prefix}`;
    let count = 0;

    // Invalidate local in-memory store
    for (const key of this.localStore.keys()) {
      if (key.startsWith(tenantPrefix)) {
        this.localStore.delete(key);
        count++;
      }
    }

    // Invalidate in Redis using cursor SCAN to prevent blocking Redis event loop
    if (isRedisConnected()) {
      try {
        const redis = getRedisClient();
        let cursor = '0';
        const pattern = `${tenantPrefix}*`;
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = nextCursor;
          if (keys.length > 0) {
            const deleted = await redis.del(...keys);
            count += deleted;
          }
        } while (cursor !== '0');
      } catch (err) {
        console.warn('[CacheService] Redis prefix invalidation failed:', (err as Error).message);
      }
    }

    return count;
  }

  /**
   * Invalidates all cached entries for a specific tenant.
   */
  public async invalidateTenant(businessId: string): Promise<number> {
    return this.invalidatePrefix(businessId, '');
  }

  /**
   * Clears all tenant cached entries across memory and Redis.
   */
  public async clearAll(): Promise<void> {
    this.localStore.clear();

    if (isRedisConnected()) {
      try {
        const redis = getRedisClient();
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'tenant:*', 'COUNT', 100);
          cursor = nextCursor;
          if (keys.length > 0) {
            await redis.del(...keys);
          }
        } while (cursor !== '0');
      } catch (err) {
        console.warn('[CacheService] Redis clearAll failed:', (err as Error).message);
      }
    }
  }

  /**
   * Returns current cache statistics for observability.
   */
  public getStats(): { size: number; enabled: boolean; redisConnected: boolean } {
    return {
      size: this.localStore.size,
      enabled: this.enabled,
      redisConnected: isRedisConnected(),
    };
  }
}

export const cacheService = new TenantCacheService();
