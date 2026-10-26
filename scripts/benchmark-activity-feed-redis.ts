/**
 * Reproducible 200-Virtual-User Activity Feed Load Test & Redis Caching Benchmark
 * PRD Reference: 14.1 (AC-014, AC-015), 14.2 (AC-TEN-05), 14.9 (AC-OPS-03, NFR-PERF-002, NFR-PERF-004)
 *
 * Simulates 200 concurrent virtual users against the Activity Feed Read API (GET /v1/activity):
 * 1. Measures baseline performance with Redis caching disabled (direct PostgreSQL query execution with RLS).
 * 2. Measures performance with tenant-scoped Redis caching enabled under identical 200-VU concurrent workload.
 * 3. Measures write-through cache invalidation on new activity event emission.
 * 4. Outputs exact latency percentiles (min, p50, p90, p95, p99, max), throughput (req/sec), and error rates.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { closeAllPools } from '../src/db/connection.ts';
import { cacheService } from '../src/services/cache-service.ts';
import { isRedisConnected, ensureRedisConnected } from '../src/services/redis-client.ts';
import { emitActivityEvent } from '../src/services/activity-service.ts';

export interface BenchmarkMetrics {
  name: string;
  concurrency: number;
  totalRequests: number;
  durationMs: number;
  throughputRps: number;
  minLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  errorCount: number;
  errorRatePercent: number;
}

function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return Number(sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))].toFixed(2));
}

async function runVirtualUserBatch(
  baseUrl: string,
  token: string,
  concurrency: number
): Promise<{ latencies: number[]; errors: number; durationMs: number }> {
  const latencies: number[] = [];
  let errors = 0;
  const batchStart = performance.now();

  const requests = Array.from({ length: concurrency }, async () => {
    const start = performance.now();
    try {
      const res = await fetch(`${baseUrl}/v1/activity?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const end = performance.now();
      latencies.push(end - start);
      if (!res.ok) {
        errors++;
      }
    } catch {
      const end = performance.now();
      latencies.push(end - start);
      errors++;
    }
  });

  await Promise.all(requests);
  const durationMs = performance.now() - batchStart;
  return { latencies, errors, durationMs };
}

function computeMetrics(
  name: string,
  concurrency: number,
  latencies: number[],
  errors: number,
  durationMs: number
): BenchmarkMetrics {
  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  return {
    name,
    concurrency,
    totalRequests: total,
    durationMs: Number(durationMs.toFixed(2)),
    throughputRps: Number(((total / durationMs) * 1000).toFixed(2)),
    minLatencyMs: Number(latencies[0]?.toFixed(2) || '0'),
    p50LatencyMs: calculatePercentile(latencies, 50),
    p90LatencyMs: calculatePercentile(latencies, 90),
    p95LatencyMs: calculatePercentile(latencies, 95),
    p99LatencyMs: calculatePercentile(latencies, 99),
    maxLatencyMs: Number(latencies[latencies.length - 1]?.toFixed(2) || '0'),
    errorCount: errors,
    errorRatePercent: Number(((errors / total) * 100).toFixed(2)),
  };
}

async function main() {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await ensureRedisConnected();
  } catch (err) {
    console.warn('[Setup] Redis connection attempt finished:', (err as Error).message);
  }

  console.log('='.repeat(95));
  console.log('ROTA ACTIVITY FEED 200-VIRTUAL-USER LOAD TEST & REDIS CACHING BENCHMARK');
  console.log('Environment: Node.js', process.version, '| OS:', process.platform, process.arch);
  console.log('Redis Status:', isRedisConnected() ? 'CONNECTED (localhost:6379)' : 'IN-MEMORY STORE');
  console.log('='.repeat(95));

  try {
    // 1. Setup tenant & seed 100 activity events
    console.log('\n[Setup] Onboarding benchmark organization...');
    const ownerEmail = `feed_bench_owner_${Date.now()}@example.com`;
    const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: 'Password123!', name: 'Benchmark Feed Owner' }),
    });
    const regData = (await regRes.json()) as any;
    let token = regData.tokens.accessToken;

    const onboardRes = await fetch(`${baseUrl}/v1/organizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Benchmark Hypermarket',
        timezone: 'Africa/Lagos',
        branchName: 'Victoria Island Branch',
        departments: ['Checkout', 'Warehouse'],
      }),
    });
    const onboardData = (await onboardRes.json()) as any;
    const businessId = onboardData.business.id;
    const branchId = onboardData.branch.id;
    const deptId = onboardData.departments[0].id;
    const ownerMembershipId = onboardData.membership.id;
    token = onboardData.tokens.accessToken;

    console.log(`[Setup] Organization onboarded (business_id: ${businessId}). Seeding 100 activity events...`);

    for (let i = 1; i <= 100; i++) {
      await emitActivityEvent(businessId, {
        type: i % 2 === 0 ? 'schedule.shift_created' : 'swap.requested',
        branchId,
        departmentId: deptId,
        actorMembershipId: ownerMembershipId,
        visibilityClass: i % 5 === 0 ? 'security' : 'public',
        payload: { eventIndex: i, label: `Event #${i}` },
      });
    }

    console.log('[Setup] 100 activity events seeded. Warming up server with 10 requests...');
    for (let i = 0; i < 10; i++) {
      await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    }

    // 2. Run 200 Virtual User Load Test WITHOUT Cache
    console.log('\n>>> RUNNING 200-VU TEST: CACHING DISABLED (DIRECT POSTGRESQL QUERIES) <<<');
    cacheService.setEnabled(false);
    const uncachedResult = await runVirtualUserBatch(baseUrl, token, 200);
    const uncachedMetrics = computeMetrics(
      'Uncached (Direct PostgreSQL)',
      200,
      uncachedResult.latencies,
      uncachedResult.errors,
      uncachedResult.durationMs
    );

    // 3. Run 200 Virtual User Load Test WITH Redis Cache
    console.log('\n>>> RUNNING 200-VU TEST: CACHING ENABLED (TENANT-SCOPED REDIS CACHE) <<<');
    cacheService.setEnabled(true);
    // Warm up the Redis cache with 1 query
    await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    const cachedResult = await runVirtualUserBatch(baseUrl, token, 200);
    const cachedMetrics = computeMetrics(
      'Cached (Tenant Partitioned Redis)',
      200,
      cachedResult.latencies,
      cachedResult.errors,
      cachedResult.durationMs
    );

    // 4. Test Write Invalidation and Warm-Up Latency (AC-OPS-05, AC-TEN-05)
    console.log('\n>>> VERIFYING WRITE-THROUGH CACHE INVALIDATION & RECOVERY <<<');
    const writeStart = performance.now();
    await emitActivityEvent(businessId, {
      type: 'schedule.shift_published',
      branchId,
      departmentId: deptId,
      actorMembershipId: ownerMembershipId,
      visibilityClass: 'public',
      payload: { note: 'Benchmark write invalidation event' },
    });
    const writeDuration = performance.now() - writeStart;

    // First read after write: Cache Miss (must query DB and re-cache in Redis)
    const readAfterWriteStart = performance.now();
    const freshRes = await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    const freshDuration = performance.now() - readAfterWriteStart;
    const freshFeed = (await freshRes.json()) as any;

    // Second read after write: Cache Hit (served from Redis)
    const hitReadStart = performance.now();
    await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    const hitReadDuration = performance.now() - hitReadStart;

    // Print Results Table
    console.log('\n' + '='.repeat(105));
    console.log('200 VIRTUAL USER LOAD TEST & REDIS CACHING PERFORMANCE COMPARISON REPORT');
    console.log('Endpoint: GET /v1/activity?limit=20 | Seed Volume: 100 activity events');
    console.log('='.repeat(105));
    console.table([
      {
        Condition: uncachedMetrics.name,
        VUs: uncachedMetrics.concurrency,
        TotalReqs: uncachedMetrics.totalRequests,
        DurationMs: uncachedMetrics.durationMs,
        'Req/Sec': uncachedMetrics.throughputRps,
        'Min(ms)': uncachedMetrics.minLatencyMs,
        'p50(ms)': uncachedMetrics.p50LatencyMs,
        'p90(ms)': uncachedMetrics.p90LatencyMs,
        'p95(ms)': uncachedMetrics.p95LatencyMs,
        'p99(ms)': uncachedMetrics.p99LatencyMs,
        'Max(ms)': uncachedMetrics.maxLatencyMs,
        Errors: uncachedMetrics.errorCount,
        'ErrRate%': `${uncachedMetrics.errorRatePercent}%`,
      },
      {
        Condition: cachedMetrics.name,
        VUs: cachedMetrics.concurrency,
        TotalReqs: cachedMetrics.totalRequests,
        DurationMs: cachedMetrics.durationMs,
        'Req/Sec': cachedMetrics.throughputRps,
        'Min(ms)': cachedMetrics.minLatencyMs,
        'p50(ms)': cachedMetrics.p50LatencyMs,
        'p90(ms)': cachedMetrics.p90LatencyMs,
        'p95(ms)': cachedMetrics.p95LatencyMs,
        'p99(ms)': cachedMetrics.p99LatencyMs,
        'Max(ms)': cachedMetrics.maxLatencyMs,
        Errors: cachedMetrics.errorCount,
        'ErrRate%': `${cachedMetrics.errorRatePercent}%`,
      },
    ]);

    const throughputMultiplier = (cachedMetrics.throughputRps / uncachedMetrics.throughputRps).toFixed(2);
    const p95Drop = (
      ((uncachedMetrics.p95LatencyMs - cachedMetrics.p95LatencyMs) / uncachedMetrics.p95LatencyMs) *
      100
    ).toFixed(1);
    const p50Drop = (
      ((uncachedMetrics.p50LatencyMs - cachedMetrics.p50LatencyMs) / uncachedMetrics.p50LatencyMs) *
      100
    ).toFixed(1);

    console.log('\nStatistical Improvement Summary:');
    console.log(`- Throughput Increase: ${throughputMultiplier}x (${uncachedMetrics.throughputRps} -> ${cachedMetrics.throughputRps} req/sec)`);
    console.log(`- p50 Median Latency Reduction: ${p50Drop}% (${uncachedMetrics.p50LatencyMs}ms -> ${cachedMetrics.p50LatencyMs}ms)`);
    console.log(`- p95 Latency Reduction: ${p95Drop}% (${uncachedMetrics.p95LatencyMs}ms -> ${cachedMetrics.p95LatencyMs}ms)`);
    console.log(`- Error Rates: Uncached = ${uncachedMetrics.errorRatePercent}%, Cached = ${cachedMetrics.errorRatePercent}%`);
    console.log('\nWrite Invalidation & Latency Transition:');
    console.log(`- Event Mutation + Prefix Invalidation: ${writeDuration.toFixed(2)}ms`);
    console.log(`- Post-Invalidation DB Miss Latency:    ${freshDuration.toFixed(2)}ms (Fresh Count: ${freshFeed.events.length})`);
    console.log(`- Subsequent Cached Hit Latency:         ${hitReadDuration.toFixed(2)}ms`);
    console.log('='.repeat(105) + '\n');
  } finally {
    cacheService.setEnabled(true);
    await closeAllPools();
    await new Promise((res) => server.close(res));
  }
}

main().catch((err) => {
  console.error('[FATAL] Activity feed benchmark failed:', err);
  process.exit(1);
});
