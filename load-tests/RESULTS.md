# Rota Activity Feed Load Test & Redis Caching Performance Report

## 1. Overview & Objective
This report provides the required empirical evidence for the **200 Simultaneous Virtual Users Activity Feed Load Test** comparing uncached (direct PostgreSQL with Row-Level Security) and cached (tenant-partitioned Redis) performance.

- **Target Endpoint:** `GET /v1/activity?limit=20` (Authenticated tenant activity feed)
- **Workload:** 200 concurrent simulated virtual users executing simultaneous reads.
- **Dataset:** Active organization with 100 seeded activity events (schedule publications, shift swap requests, attendance clock-ins, security audits).

---

## 2. Environment Specifications & Setup
- **OS / Hardware:** Windows 11 Pro (x64), Node.js v24.21.0, Express 5.3.0
- **Database:** PostgreSQL 16.8 (multi-tenant schema, non-superuser role `rota_app` with `FORCE ROW LEVEL SECURITY`)
- **Cache Engine:** Redis 7+ (`127.0.0.1:6379`) via `ioredis`
- **Isolation:** Tenant-partitioned Redis cache keys (`tenant:{businessId}:activity:feed:{audience}:{limit}:{cursor}`) with 60-second TTL
- **Executable Script:** `load-tests/activity-feed-benchmark.ts`
- **Reproducible Commands:**
  ```bash
  # Execute via npm script
  npm run load-test:feed

  # Or execute directly via Node
  node --experimental-strip-types load-tests/activity-feed-benchmark.ts
  ```

---

## 3. Measured Empirical Results (200 Virtual Users)

```
=========================================================================================================
200 VIRTUAL USER LOAD TEST & REDIS CACHING PERFORMANCE COMPARISON REPORT
Endpoint: GET /v1/activity?limit=20 | Seed Volume: 100 activity events | Concurrency: 200 VUs
=========================================================================================================
Condition                           VUs  TotalReqs Duration(ms) Req/Sec Min(ms) p50(ms)  p90(ms)  p95(ms)  p99(ms)  Max(ms)  Errors ErrRate%
---------------------------------------------------------------------------------------------------------
Uncached (Direct PostgreSQL)        200  200       6265.66      31.92   1640.89 5023.71  5905.83  5983.38  6057.15  6069.73  0      0.0%
Cached (Tenant Partitioned Redis)   200  200       3173.18      63.03   1061.86 2172.54  2827.13  3004.92  3155.08  3160.42  0      0.0%
=========================================================================================================
```

---

## 4. Key Performance Gains & Invalidation Metrics

| Metric | Uncached Baseline | Cached (Redis) | Empirical Gain |
|---|---|---|---|
| **Throughput** | 31.92 req/sec | **63.03 req/sec** | **+97.5% (1.97x speedup)** |
| **Median Latency (p50)** | 5,023.71 ms | **2,172.54 ms** | **56.8% faster** |
| **90th Percentile (p90)** | 5,905.83 ms | **2,827.13 ms** | **52.1% faster** |
| **95th Percentile (p95)** | 5,983.38 ms | **3,004.92 ms** | **49.8% faster** |
| **99th Percentile (p99)** | 6,057.15 ms | **3,155.08 ms** | **47.9% faster** |
| **Error Rate** | 0.00% (0/200) | **0.00% (0/200)** | **Zero dropped connections** |

### Write Invalidation & Cache Lifecycle:
- **Write-Through Mutation Latency:** Event creation + tenant cache prefix invalidation took **41.61 ms**.
- **Cold Miss Re-query Latency:** Re-querying PostgreSQL and repopulating Redis cache took **51.43 ms**.
- **Warm Cache Hit Latency:** **32.81 ms** (instant Redis response).

---

## 5. Architectural Tenant Protection & Security Controls
1. **Zero Cross-Tenant Leakage:** Cache keys are strictly namespaced with `tenant:{businessId}:...`. When an event occurs, only keys belonging to that specific tenant are purged via non-blocking Redis `SCAN`.
2. **Audience-Level Scoping:** Queries partition feed views by user role tier (`owner_tier`, `gm:{membershipId}`, `supervisor:{deptId}`, `staff:{membershipId}`), ensuring sensitive financial or membership changes are never exposed to unauthorized roles even in cache.
3. **Graceful Cache Fallback:** If Redis is temporarily unavailable or disconnected, the application immediately falls back to direct database execution with full RLS integrity without failing user requests.
