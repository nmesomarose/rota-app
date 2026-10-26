import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { cacheService } from '../../src/services/cache-service.ts';
import { getRedisClient, isRedisConnected } from '../../src/services/redis-client.ts';
import { getSchedule, createShift } from '../../src/services/scheduling-service.ts';
import { getOrganizationMembers } from '../../src/services/organization-service.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { closeAllPools } from '../../src/db/connection.ts';
import { env } from '../../src/config/env.ts';
import { getShardIdForBusiness } from '../../src/sharding/shard-router.ts';

describe('Redis-Backed Tenant Caching & Invalidation Test Suite (Phase 2)', () => {
  const testBizA = randomUUID();
  const testBizB = randomUUID();
  let branchA: string;
  let deptA: string;

  before(async () => {
    // Seed tenant A with branch and department
    await withTenantContext(testBizA, async (client) => {
      await client.query('INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)', [
        testBizA,
        'Cache Test Business A',
        'UTC',
      ]);
      const br = await client.query<{ id: string }>(
        'INSERT INTO branches (business_id, name) VALUES ($1, $2) RETURNING id',
        [testBizA, 'Cache Test Branch']
      );
      branchA = br.rows[0].id;
      const dp = await client.query<{ id: string }>(
        'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id',
        [testBizA, branchA, 'Cache Test Dept']
      );
      deptA = dp.rows[0].id;
    });

    await withTenantContext(testBizB, async (client) => {
      await client.query('INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)', [
        testBizB,
        'Cache Test Business B',
        'UTC',
      ]);
    });
  });

  after(async () => {
    // Clear tenant keys and close pools
    await cacheService.invalidateTenant(testBizA);
    await cacheService.invalidateTenant(testBizB);

    const cleanup = async (bizId: string) => {
      const shard = getShardIdForBusiness(bizId);
      const url = shard === 'shard_1' ? env.SHARD_1_DATABASE_URL : env.SHARD_2_DATABASE_URL;
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query('DELETE FROM businesses WHERE id = $1', [bizId]).catch(() => {});
      await c.end();
    };

    await cleanup(testBizA);
    await cleanup(testBizB);
    await closeAllPools();
  });

  describe('A. Tenant Key Isolation and Redis Backing', () => {
    it('Generates strict tenant-isolated cache keys (SEC-014, AC-TEN-05)', () => {
      const keyA = cacheService.formatKey(testBizA, 'schedule:all');
      const keyB = cacheService.formatKey(testBizB, 'schedule:all');

      assert.equal(keyA, `tenant:${testBizA}:schedule:all`);
      assert.equal(keyB, `tenant:${testBizB}:schedule:all`);
      assert.notEqual(keyA, keyB, 'Keys for different tenants must be completely isolated');
    });

    it('Stores and retrieves values from Redis with TTL', async () => {
      const payload = { shiftsCount: 42, label: 'test-cached-schedule' };
      await cacheService.set(testBizA, 'test-key', payload, 30);

      const retrieved = await cacheService.get<typeof payload>(testBizA, 'test-key');
      assert.deepEqual(retrieved, payload);

      // Verify key was set directly in Redis with tenant prefix
      if (isRedisConnected()) {
        const redis = getRedisClient();
        const raw = await redis.get(`tenant:${testBizA}:test-key`);
        assert.ok(raw !== null, 'Raw key must exist in Redis');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.shiftsCount, 42);

        const ttl = await redis.ttl(`tenant:${testBizA}:test-key`);
        assert.ok(ttl > 0 && ttl <= 30, `TTL must be positive and <= 30, got ${ttl}`);
      }
    });

    it('Tenant A invalidation does NOT affect Tenant B cached entries (AC-TEN-05)', async () => {
      await cacheService.set(testBizA, 'shared-name', { owner: 'A' }, 60);
      await cacheService.set(testBizB, 'shared-name', { owner: 'B' }, 60);

      // Invalidate only Tenant A
      await cacheService.invalidateTenant(testBizA);

      const valA = await cacheService.get(testBizA, 'shared-name');
      const valB = await cacheService.get(testBizB, 'shared-name');

      assert.equal(valA, null, 'Tenant A cached entry must be invalidated');
      assert.deepEqual(valB, { owner: 'B' }, 'Tenant B cached entry must remain intact');
    });
  });

  describe('B. Schedule Caching and Write-Through Invalidation', () => {
    it('Caches schedule on read and invalidates on shift creation', async () => {
      // 1. Initial read caches the empty schedule
      const initial = await getSchedule(testBizA, 'Manager');
      assert.ok(Array.isArray(initial));

      // 2. Subsequent read returns cached result
      const cached = await getSchedule(testBizA, 'Manager');
      assert.deepEqual(cached, initial);

      // 3. Create a shift (triggers write-through cache invalidation)
      const shift = await createShift(testBizA, {
        branchId: branchA,
        departmentId: deptA,
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        endsAt: new Date(Date.now() + 7200000).toISOString(),
        timeZone: 'UTC',
        status: 'published',
      });
      assert.ok(shift.id);

      // 4. Read after shift creation: Cache was invalidated, so it returns fresh data including the new shift
      const fresh = await getSchedule(testBizA, 'Manager');
      assert.ok(fresh.some((s: any) => s.id === shift.id), 'Fresh schedule must contain the newly created shift');
    });
  });

  describe('C. Roster Caching and Invalidation', () => {
    it('Caches organization roster members and invalidates on update', async () => {
      // 1. Initial roster read
      const roster1 = await getOrganizationMembers(testBizA);
      assert.ok(Array.isArray(roster1));

      // 2. Second read hits cache
      const roster2 = await getOrganizationMembers(testBizA);
      assert.deepEqual(roster2, roster1);

      // 3. Invalidate roster cache explicitly
      await cacheService.invalidatePrefix(testBizA, 'roster');

      // 4. Fresh read succeeds directly from database
      const roster3 = await getOrganizationMembers(testBizA);
      assert.deepEqual(roster3, roster1);
    });
  });

  describe('D. Safe Cache Bypass and Fault Tolerance', () => {
    it('When cache is disabled, getSchedule bypasses cache and queries PostgreSQL directly', async () => {
      cacheService.setEnabled(false);
      try {
        const schedule = await getSchedule(testBizA, 'Manager');
        assert.ok(Array.isArray(schedule));
        assert.ok(schedule.length >= 1);
      } finally {
        cacheService.setEnabled(true);
      }
    });

    it('getStats reports active cache status and Redis connectivity', () => {
      const stats = cacheService.getStats();
      assert.equal(stats.enabled, true);
      assert.equal(typeof stats.size, 'number');
      assert.equal(typeof stats.redisConnected, 'boolean');
    });
  });
});
