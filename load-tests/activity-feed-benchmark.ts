/**
 * Rota 200-Virtual-User Activity Feed Load Test & Redis Caching Benchmark
 * Requirement: Demonstrate 200 simultaneous virtual users loading the activity feed,
 * comparing uncached and cached response times.
 *
 * Simulates 200 concurrent virtual users against GET /v1/activity:
 * 1. Measures baseline performance with Redis caching disabled (direct PostgreSQL query execution with RLS).
 * 2. Measures performance with tenant-scoped Redis caching enabled under identical 200-VU concurrency.
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

function computeMetrics(name: string, concurrency: number, latencies: number[], errors: number, durationMs: number): BenchmarkMetrics {
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = sorted.length;
  const min = total > 0 ? Number(sorted[0].toFixed(2)) : 0;
  const max = total > 0 ? Number(sorted[total - 1].toFixed(2)) : 0;
  const throughput = durationMs > 0 ? Number(((total / durationMs) * 1000).toFixed(2)) : 0;

  return {
    name,
    concurrency,
    totalRequests: total,
    durationMs: Number(durationMs.toFixed(2)),
    throughputRps: throughput,
    minLatencyMs: min,
    p50LatencyMs: calculatePercentile(sorted, 50),
    p90LatencyMs: calculatePercentile(sorted, 90),
    p95LatencyMs: calculatePercentile(sorted, 95),
    p99LatencyMs: calculatePercentile(sorted, 99),
    maxLatencyMs: max,
    errorCount: errors,
    errorRatePercent: Number(((errors / total) * 100).toFixed(2)),
  };
}

async function runActivityFeedLoadTest() {
  console.log('='.repeat(90));
  console.log('  ROTA ACTIVITY FEED 200-VIRTUAL-USER LOAD TEST & REDIS BENCHMARK');
  console.log('  Endpoint: GET /v1/activity?limit=20 | Concurrency: 200 VUs');
  console.log('='.repeat(90));

  await ensureRedisConnected();
  const redisOk = isRedisConnected();
  if (!redisOk) {
    console.warn('[LoadTest] WARNING: Redis is unreachable. Cached test requires Redis running on localhost:6379.');
  }

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const CONCURRENCY = 200;

  try {
    // 1. Authenticate test owner to obtain valid JWT token
    const authRes = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@benchmark.local', password: 'Password123!' }),
    });

    let token = '';
    let businessId = '';
    if (authRes.ok) {
      const authData = await authRes.json() as any;
      token = authData.token || authData.accessToken;
      businessId = authData.business?.id || authData.user?.businessId;
    } else {
      console.log('[LoadTest] Creating temporary test owner account...');
      const regRes = await fetch(`${baseUrl}/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@benchmark.local',
          password: 'Password123!',
          firstName: 'LoadTest',
          lastName: 'Runner',
          businessName: 'LoadTest Benchmark Corp',
        }),
      });
      const regData = await regRes.json() as any;
      token = regData.token || regData.accessToken;
      businessId = regData.business?.id;
    }

    if (!token) {
      throw new Error('Failed to acquire authentication token for load test.');
    }

    // 2. Condition A: Uncached Baseline (Direct PostgreSQL with RLS)
    console.log(`\n[LoadTest] 1. Executing Uncached Baseline (${CONCURRENCY} concurrent VUs, Cache Disabled)...`);
    cacheService.setEnabled(false);
    const uncachedBatch = await runVirtualUserBatch(baseUrl, token, CONCURRENCY);
    const uncachedMetrics = computeMetrics('Uncached (PostgreSQL)', CONCURRENCY, uncachedBatch.latencies, uncachedBatch.errors, uncachedBatch.durationMs);

    // 3. Condition B: Cached (Tenant-Partitioned Redis Caching Enabled)
    console.log(`[LoadTest] 2. Executing Cached Workload (${CONCURRENCY} concurrent VUs, Redis Enabled)...`);
    cacheService.setEnabled(true);
    // Warm cache with 1 priming request
    await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });

    const cachedBatch = await runVirtualUserBatch(baseUrl, token, CONCURRENCY);
    const cachedMetrics = computeMetrics('Cached (Redis)', CONCURRENCY, cachedBatch.latencies, cachedBatch.errors, cachedBatch.durationMs);

    // 4. Test Write-Through Cache Invalidation
    console.log('[LoadTest] 3. Testing Write-Through Cache Invalidation on Event Creation...');
    const invalidationStart = performance.now();
    await emitActivityEvent({
      businessId,
      eventType: 'schedule.published',
      actorId: 'usr-loadtest',
      actorRole: 'owner',
      entityType: 'schedule',
      entityId: 'sch-loadtest',
      description: 'Published weekly roster during benchmark run',
    });
    const invalidationMs = Number((performance.now() - invalidationStart).toFixed(2));

    // Post-invalidation cold read
    const coldStart = performance.now();
    await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    const coldReadMs = Number((performance.now() - coldStart).toFixed(2));

    // Subsequent warm cached read
    const warmStart = performance.now();
    await fetch(`${baseUrl}/v1/activity?limit=20`, { headers: { Authorization: `Bearer ${token}` } });
    const warmReadMs = Number((performance.now() - warmStart).toFixed(2));

    // 5. Output Summary Table
    console.log('\n' + '='.repeat(105));
    console.log('200 VIRTUAL USER LOAD TEST & REDIS CACHING PERFORMANCE COMPARISON REPORT');
    console.log('='.repeat(105));
    console.log('Condition                     VUs  Reqs  Duration(ms) Req/Sec  Min(ms)  p50(ms)  p90(ms)  p95(ms)  p99(ms)  Max(ms)  Errors  Err%');
    console.log('-'.repeat(105));
    for (const m of [uncachedMetrics, cachedMetrics]) {
      console.log(
        `${m.name.padEnd(30)} ${String(m.concurrency).padEnd(4)} ${String(m.totalRequests).padEnd(5)} ` +
        `${m.durationMs.toFixed(2).padEnd(13)} ${m.throughputRps.toFixed(2).padEnd(8)} ` +
        `${m.minLatencyMs.toFixed(2).padEnd(8)} ${m.p50LatencyMs.toFixed(2).padEnd(8)} ` +
        `${m.p90LatencyMs.toFixed(2).padEnd(8)} ${m.p95LatencyMs.toFixed(2).padEnd(8)} ` +
        `${m.p99LatencyMs.toFixed(2).padEnd(8)} ${m.maxLatencyMs.toFixed(2).padEnd(8)} ` +
        `${String(m.errorCount).padEnd(7)} ${m.errorRatePercent.toFixed(1)}%`
      );
    }
    console.log('='.repeat(105));
    console.log(`Throughput Gain: ${(cachedMetrics.throughputRps / uncachedMetrics.throughputRps).toFixed(2)}x`);
    console.log(`p95 Latency Reduction: ${(((uncachedMetrics.p95LatencyMs - cachedMetrics.p95LatencyMs) / uncachedMetrics.p95LatencyMs) * 100).toFixed(1)}%`);
    console.log(`Event Invalidation Time: ${invalidationMs}ms | Cold Miss Re-fetch: ${coldReadMs}ms | Warm Hit: ${warmReadMs}ms\n`);

  } finally {
    server.close();
    await closeAllPools();
  }
}

// Allow direct execution: node --experimental-strip-types load-tests/activity-feed-benchmark.ts
if (process.argv[1]?.endsWith('activity-feed-benchmark.ts')) {
  runActivityFeedLoadTest().catch((err) => {
    console.error('[LoadTest Error]', err);
    process.exit(1);
  });
}
