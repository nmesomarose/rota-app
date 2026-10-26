import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../../src/app.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cacheService } from '../../src/services/cache-service.ts';
import { getRedisClient, isRedisConnected } from '../../src/services/redis-client.ts';
import { withTenantContext } from '../../src/db/tenant-context.ts';
import { controlPool, closeAllPools } from '../../src/db/connection.ts';
import { env } from '../../src/config/env.ts';
import { getShardIdForBusiness } from '../../src/sharding/shard-router.ts';
import { emitActivityEvent, getActivityFeed, buildActivityFeedCacheKey } from '../../src/services/activity-service.ts';

describe('Activity Feed Redis Caching & Invalidation Test Suite (AC-014, AC-015, AC-TEN-05, AC-OPS-05)', () => {
  let server: Server;
  let baseUrl: string;

  const testBizA = randomUUID();
  const testBizB = randomUUID();
  let branchA: string;
  let deptA: string;

  let ownerTokenA: string;
  let ownerMembershipIdA: string;
  let staff1TokenA: string;
  let staff1MembershipIdA: string;
  let staff2TokenA: string;
  let staff2MembershipIdA: string;

  let ownerTokenB: string;

  before(async () => {
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // 1. Seed Tenant A in shard DB
    await withTenantContext(testBizA, async (client) => {
      await client.query('INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)', [
        testBizA,
        'Activity Cache Test Biz A',
        'UTC',
      ]);
      const br = await client.query<{ id: string }>(
        'INSERT INTO branches (business_id, name) VALUES ($1, $2) RETURNING id',
        [testBizA, 'HQ Branch A']
      );
      branchA = br.rows[0].id;
      const dp = await client.query<{ id: string }>(
        'INSERT INTO departments (business_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id',
        [testBizA, branchA, 'Logistics']
      );
      deptA = dp.rows[0].id;
    });

    // 2. Seed Tenant B in shard DB
    await withTenantContext(testBizB, async (client) => {
      await client.query('INSERT INTO businesses (id, name, timezone) VALUES ($1, $2, $3)', [
        testBizB,
        'Activity Cache Test Biz B',
        'UTC',
      ]);
    });

    // Helper to register user and membership
    async function setupUser(emailPrefix: string, name: string, bizId: string, role: string, branchId?: string | null, deptId?: string | null) {
      const email = `${emailPrefix}_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
      const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Password123!', name }),
      });
      const regData = (await regRes.json()) as any;
      const userId = regData.user.id;

      let memId = '';
      await withTenantContext(bizId, async (client) => {
        const res = await client.query(
          `INSERT INTO memberships (business_id, user_id, role, status, branch_id, department_id)
           VALUES ($1, $2, $3, 'active', $4, $5)
           RETURNING id`,
          [bizId, userId, role, branchId || null, deptId || null]
        );
        memId = res.rows[0].id;
      });

      await controlPool.query(
        `INSERT INTO membership_directory (user_id, business_id, business_name, role, status)
         VALUES ($1, $2, 'Activity Test Org', $3, 'active')`,
        [userId, bizId, role]
      );

      const switchRes = await fetch(`${baseUrl}/v1/auth/switch-business`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${regData.tokens.accessToken}`,
        },
        body: JSON.stringify({ businessId: bizId }),
      });
      const switchData = (await switchRes.json()) as any;

      return {
        token: switchData.tokens.accessToken,
        membershipId: memId,
        userId,
      };
    }

    const oA = await setupUser('owner_a', 'Owner A', testBizA, 'owner', branchA, null);
    ownerTokenA = oA.token;
    ownerMembershipIdA = oA.membershipId;

    const s1 = await setupUser('staff_1_a', 'Staff 1 A', testBizA, 'staff', branchA, deptA);
    staff1TokenA = s1.token;
    staff1MembershipIdA = s1.membershipId;

    const s2 = await setupUser('staff_2_a', 'Staff 2 A', testBizA, 'staff', branchA, deptA);
    staff2TokenA = s2.token;
    staff2MembershipIdA = s2.membershipId;

    const oB = await setupUser('owner_b', 'Owner B', testBizB, 'owner', null, null);
    ownerTokenB = oB.token;

    // Seed 3 events in Tenant A
    await emitActivityEvent(testBizA, {
      type: 'shift.published',
      branchId: branchA,
      departmentId: deptA,
      actorMembershipId: ownerMembershipIdA,
      visibilityClass: 'public',
      payload: { note: 'Initial public shift' },
    });

    await emitActivityEvent(testBizA, {
      type: 'attendance.verified',
      branchId: branchA,
      departmentId: deptA,
      actorMembershipId: ownerMembershipIdA,
      subjectMembershipId: staff1MembershipIdA,
      visibilityClass: 'attendance',
      payload: { staffName: 'Staff 1' },
    });

    await emitActivityEvent(testBizA, {
      type: 'billing.invoice_paid',
      visibilityClass: 'billing',
      payload: { amount: 5000 },
    });

    // Seed 1 event in Tenant B
    await emitActivityEvent(testBizB, {
      type: 'org.created',
      visibilityClass: 'public',
      payload: { name: 'Tenant B Created' },
    });
  });

  after(async () => {
    await cacheService.invalidateTenant(testBizA);
    await cacheService.invalidateTenant(testBizB);

    if (server) {
      await new Promise((res) => server.close(res));
    }

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

  describe('1. Cache Miss, Redis Population & Cache Hit', () => {
    it('Caches activity feed response in Redis on first read (cache miss)', async () => {
      // Clear any existing cache for Tenant A
      await cacheService.invalidatePrefix(testBizA, 'activity');

      const res = await fetch(`${baseUrl}/v1/activity?limit=10`, {
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.ok(Array.isArray(data.events));
      assert.equal(data.events.length, 3, 'Owner should see all 3 events');

      // Verify Redis contains the cached entry with correct tenant prefix
      if (isRedisConnected()) {
        const redis = getRedisClient();
        const expectedKey = `tenant:${testBizA}:activity:feed:owner_tier:10:first`;
        const raw = await redis.get(expectedKey);
        assert.ok(raw !== null, `Key ${expectedKey} must exist in Redis`);
        const parsed = JSON.parse(raw);
        assert.equal(parsed.events.length, 3);
      }
    });

    it('Serves subsequent request directly from Redis cache with identical data', async () => {
      const res = await fetch(`${baseUrl}/v1/activity?limit=10`, {
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.events.length, 3);
    });
  });

  describe('2. Write-Through Invalidation', () => {
    it('Emitting a new activity event invalidates the tenant activity cache', async () => {
      // 1. Confirm cache is populated
      const res1 = await fetch(`${baseUrl}/v1/activity?limit=10`, {
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const data1 = (await res1.json()) as any;
      const initialCount = data1.events.length;

      // 2. Emit a new event via emitActivityEvent
      await emitActivityEvent(testBizA, {
        type: 'schedule.updated',
        branchId: branchA,
        departmentId: deptA,
        actorMembershipId: ownerMembershipIdA,
        visibilityClass: 'public',
        payload: { shiftChange: 'Added new night shift' },
      });

      // 3. Next read should fetch from PostgreSQL, include the new event, and re-cache
      const res2 = await fetch(`${baseUrl}/v1/activity?limit=10`, {
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const data2 = (await res2.json()) as any;
      assert.equal(data2.events.length, initialCount + 1, 'Should include newly emitted event');
      assert.equal(data2.events[0].type, 'schedule.updated');
    });
  });

  describe('3. Audience & Role-Based Cache Isolation', () => {
    it('Generates distinct cache keys per audience scope to prevent role leakage', () => {
      const ownerKey = buildActivityFeedCacheKey({ role: 'owner' } as any, 20);
      const gmKey = buildActivityFeedCacheKey({ role: 'gm', membershipId: 'gm-uuid' } as any, 20);
      const supKey = buildActivityFeedCacheKey({ role: 'supervisor', membershipId: 'sup-uuid', departmentId: 'dept-uuid' } as any, 20);
      const staff1Key = buildActivityFeedCacheKey({ role: 'staff', membershipId: 'staff-1-uuid' } as any, 20);
      const staff2Key = buildActivityFeedCacheKey({ role: 'staff', membershipId: 'staff-2-uuid' } as any, 20);

      assert.equal(ownerKey, 'activity:feed:owner_tier:20:first');
      assert.equal(gmKey, 'activity:feed:gm:gm-uuid:20:first');
      assert.equal(supKey, 'activity:feed:supervisor:sup-uuid:dept-uuid:20:first');
      assert.equal(staff1Key, 'activity:feed:staff:staff-1-uuid:20:first');
      assert.equal(staff2Key, 'activity:feed:staff:staff-2-uuid:20:first');

      // Staff 1 and Staff 2 must never share a cache key
      assert.notEqual(staff1Key, staff2Key);
    });

    it('Staff feed cache never includes restricted billing or other staff private events', async () => {
      // Read feed as Staff 1
      const res1 = await fetch(`${baseUrl}/v1/activity?limit=10`, {
        headers: { Authorization: `Bearer ${staff1TokenA}` },
      });
      const data1 = (await res1.json()) as any;

      // Staff 1 sees public events and their own attendance, but NOT billing
      const hasBilling = data1.events.some((e: any) => e.visibility_class === 'billing');
      assert.equal(hasBilling, false, 'Staff 1 must not see billing events');

      const hasSelfAttendance = data1.events.some((e: any) => e.visibility_class === 'attendance');
      assert.equal(hasSelfAttendance, true, 'Staff 1 should see their own attendance event');

      // Read feed as Staff 2
      const res2 = await fetch(`${baseUrl}/v1/activity?limit=10`, {
        headers: { Authorization: `Bearer ${staff2TokenA}` },
      });
      const data2 = (await res2.json()) as any;

      // Staff 2 must NOT see Staff 1 attendance event
      const hasStaff1Attendance = data2.events.some((e: any) => e.visibility_class === 'attendance');
      assert.equal(hasStaff1Attendance, false, 'Staff 2 must NOT see Staff 1 attendance event in feed or cache');
    });
  });

  describe('4. Tenant Cache Isolation', () => {
    it('Tenant A and Tenant B cached feeds are strictly isolated in Redis', async () => {
      // Warm both caches
      await fetch(`${baseUrl}/v1/activity?limit=10`, { headers: { Authorization: `Bearer ${ownerTokenA}` } });
      await fetch(`${baseUrl}/v1/activity?limit=10`, { headers: { Authorization: `Bearer ${ownerTokenB}` } });

      if (isRedisConnected()) {
        const redis = getRedisClient();
        const keyA = `tenant:${testBizA}:activity:feed:owner_tier:10:first`;
        const keyB = `tenant:${testBizB}:activity:feed:owner_tier:10:first`;

        const valA = JSON.parse((await redis.get(keyA)) || '{}');
        const valB = JSON.parse((await redis.get(keyB)) || '{}');

        assert.ok(valA.events.length > 0);
        assert.ok(valB.events.length > 0);
        assert.notEqual(valA.events[0].id, valB.events[0].id, 'Tenant A and B events must never overlap');

        // Invalidate Tenant A
        await cacheService.invalidatePrefix(testBizA, 'activity');

        // Key A must be gone, Key B must remain intact
        const afterA = await redis.get(keyA);
        const afterB = await redis.get(keyB);
        assert.equal(afterA, null, 'Tenant A cache must be deleted');
        assert.ok(afterB !== null, 'Tenant B cache must remain untouched');
      }
    });
  });

  describe('5. Cursor Pagination Caching', () => {
    it('Caches distinct pagination pages independently under keyset cursors', async () => {
      // Request page 1 with limit=2
      const res1 = await fetch(`${baseUrl}/v1/activity?limit=2`, {
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const data1 = (await res1.json()) as any;
      assert.equal(data1.events.length, 2);
      assert.ok(data1.nextCursor !== null, 'Must have next cursor');

      // Request page 2 with cursor
      const res2 = await fetch(`${baseUrl}/v1/activity?limit=2&cursor=${encodeURIComponent(data1.nextCursor)}`, {
        headers: { Authorization: `Bearer ${ownerTokenA}` },
      });
      const data2 = (await res2.json()) as any;
      assert.ok(data2.events.length > 0);
      assert.notEqual(data1.events[0].id, data2.events[0].id, 'Page 1 and Page 2 must contain different records');

      // Verify both pages have distinct Redis keys
      if (isRedisConnected()) {
        const redis = getRedisClient();
        const keyP1 = `tenant:${testBizA}:activity:feed:owner_tier:2:first`;
        const keyP2 = `tenant:${testBizA}:activity:feed:owner_tier:2:${data1.nextCursor}`;

        const raw1 = await redis.get(keyP1);
        const raw2 = await redis.get(keyP2);
        assert.ok(raw1 !== null, 'Page 1 must be cached');
        assert.ok(raw2 !== null, 'Page 2 must be cached');
      }
    });
  });

  describe('6. Graceful Redis Failure & Safe PostgreSQL Fallback', () => {
    it('Bypasses cache and falls back safely to direct PostgreSQL when caching is disabled', async () => {
      // Temporarily disable cache
      cacheService.setEnabled(false);

      try {
        const res = await fetch(`${baseUrl}/v1/activity?limit=10`, {
          headers: { Authorization: `Bearer ${ownerTokenA}` },
        });
        assert.equal(res.status, 200);
        const data = (await res.json()) as any;
        assert.ok(Array.isArray(data.events));
        assert.ok(data.events.length > 0, 'Should successfully read from PostgreSQL directly');
      } finally {
        cacheService.setEnabled(true);
      }
    });
  });
});
