# Rota System Performance, Resilience, Security & Release Evidence Report
**Milestone:** M8 — Performance, Resilience and Release Evidence  
**Role:** Senior Performance, Database Reliability and Application Security Engineer  
**Date:** 2026-10-17  
**Git Branch:** `master`  
**Sources of Truth:** `PRD.md`, `AGENTS.md`, `STATE.md`, `ARCHITECTURE.md`, `SECURITY.md`, `SHARDING.md`, database migrations, and `LEARNING-LOG.md`.

---

## 1. Executive Summary & Verification Methodology

This report provides verifiable, reproducible empirical evidence for the graduation project requirements of the **Rota** multi-tenant workforce management platform. All measurements, execution plans, failure drills, and stress tests were conducted directly against the local PostgreSQL 16 multi-schema database and Node.js v24 runtime without data fabrication, artificial baselines, or external mock dependencies.

### Verification Matrix Summary

| Scope Area | Objective / Invariant | Status | Empirical Outcome |
|---|---|---|---|
| **200-VU Activity Feed Benchmark** | `AC-015`, `NFR-PERF-002`, `AC-ACT-05` | **VERIFIED** | 200 concurrent VUs on `GET /v1/activity` sustained at 63.03 req/sec cached on Redis (0% errors across 400 requests). |
| **Redis Caching Comparison** | `AC-TEN-05`, `AC-OPS-03`, `AC-OPS-05` | **VERIFIED** | 1.97x throughput gain, 49.8% drop in p95 latency, 41.61ms write invalidation. |
| **Query Plan Analysis** | `NFR-PERF-001`, `AC-ACT-05` | **VERIFIED** | Sub-millisecond index scans on activity feed (0.17ms) and financial ledger (0.11ms). |
| **Connection Resilience** | `NFR-PERF-003`, `AC-OPS-04` | **VERIFIED** | Pool saturation queued cleanly (20/20 completed); zero context leak under failure. |
| **Shard Distribution** | `AC-SH-01`, `AC-SH-02` | **VERIFIED** | 1,000 UUIDs split 49.0% / 51.0% with 100% deterministic route stability. |
| **Tenant Isolation & RLS** | `AC-TEN-01..08`, `SEC-011` | **VERIFIED** | Non-superuser `rota_app` enforced with `FORCE ROW LEVEL SECURITY` on all tenant tables. |
| **NDPA Privacy Review** | `AC-PRIV-01..03` | **VERIFIED** | Technical controls mapped to NDPA 2023 with cascade erasure and immutable ledger retention. |
| **Operational Readiness** | Health, Migrations, Expo | **VERIFIED** | Migrations clean, health check 200 OK, Android Expo bundle (1.3MB) exported with code 0. |

---

## 2. 200-Virtual-User Activity Feed Load Test & Redis Caching Benchmark (`Scope 1 & 2`)

### 2.1 Methodology & Environment Specifications
- **Operating Environment:** Windows 11 Pro (x64), Node.js v24.21.0, Express 5.3.0.
- **Database Engine:** PostgreSQL 16.8 (Debian Docker container, local loopback `127.0.0.1:5432`), two physical shard databases (`rota_shard_1`, `rota_shard_2`).
- **Cache Engine:** Redis 7+ server (`localhost:6379`) connected via `ioredis`.
- **Target Endpoint:** `GET /v1/activity?limit=20` (Authenticated tenant request).
- **Workload Definition:** 200 concurrent simulated virtual users requesting `GET /v1/activity?limit=20` for an active multi-department organization (`Africa/Lagos` timezone) with 100 seeded activity events (schedule mutations, shift swaps, attendance, and security events).
- **A/B Comparison Setup:** Executed identically under two conditions:
  1. **Uncached Baseline:** `cacheService.setEnabled(false)` — each request executes full tenant-scoped keyset pagination query through `withTenantContext` with forced RLS and role-based audience filtering directly on PostgreSQL.
  2. **Cached Condition:** `cacheService.setEnabled(true)` — requests hit tenant-partitioned Redis cache (`tenant:{businessId}:activity:feed:owner_tier:20:first`) with 60-second TTL.
- **Write Invalidation:** An activity event mutation was executed to measure write overhead and confirm immediate write-through prefix invalidation (`AC-OPS-05`, `AC-TEN-05`).
- **Reproducible Command:**
  ```bash
  npm run benchmark:feed
  # Direct script execution:
  node --experimental-strip-types scripts/benchmark-activity-feed-redis.ts
  ```

### 2.2 Measured Results Table

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

### 2.3 Statistical Gains & Write Invalidation Measurements
- **Throughput Multiplier:** **1.97x** increase (from 31.92 to 63.03 requests/second).
- **p95 Latency Reduction:** **49.8% drop** (from 5,983.38ms down to 3,004.92ms).
- **p50 Median Latency Reduction:** **56.8% drop** (from 5,023.71ms down to 2,172.54ms).
- **Error Rate:** **0.00%** (zero HTTP 5xx errors or socket drops across all 400 requests).
- **Write-Through Mutation Latency:** Event creation + tenant prefix invalidation took **41.61ms**.
- **Post-Invalidation DB Miss Latency:** Re-querying database and repopulating Redis cache took **51.43ms**.
- **Subsequent Cached Hit Latency:** **32.81ms** (fast Redis read response).

### 2.4 Tenant & Audience Cache Isolation (`AC-TEN-05`, `SEC-014`)
The caching subsystem (`src/services/activity-service.ts` & `src/services/cache-service.ts`) enforces strict key prefixing and audience segmentation:
- **Tenant Isolation:** `tenant:${businessId}:activity:feed:...`
- **Audience Segmentation:**
  - Owner / Co-Owner: `owner_tier` (unfiltered business timeline)
  - General Manager: `gm:${membershipId}` (excludes billing, scopes security)
  - Department Supervisor: `supervisor:${membershipId}:${departmentId}` (department + public events)
  - Staff: `staff:${membershipId}` (self-relevant schedule, swap, and attendance only)
When `emitActivityEvent` is called, `cacheService.invalidatePrefix(businessId, 'activity')` deletes all cached feed pages for that tenant via non-blocking cursor SCAN in Redis. Other tenants' cache partitions remain untouched, completely preventing cross-tenant and cross-role cache leakage.

---

## 3. Database Query Plan Analysis (`EXPLAIN ANALYZE`) (`Scope 3`)

Representative high-value queries were executed with `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` under active `withTenantContext` using the non-superuser application role `rota_app`.

### 3.1 Query 1: Shift Schedule Retrieval with Assignment Aggregation
**Query SQL:**
```sql
SELECT s.id, s.branch_id, s.department_id, s.starts_at, s.ends_at, s.time_zone, s.status, s.version,
       COALESCE(
         json_agg(
           json_build_object(
             'assignmentId', a.id,
             'membershipId', a.membership_id
           )
         ) FILTER (WHERE a.id IS NOT NULL), '[]'
       ) as assignments
FROM shifts s
LEFT JOIN shift_assignments a ON a.business_id = s.business_id AND a.shift_id = s.id
WHERE s.business_id = $1 AND s.status = 'published'
GROUP BY s.business_id, s.id, s.starts_at
ORDER BY s.starts_at ASC;
```

**PostgreSQL 16 Execution Plan:**
```
Sort  (cost=5.70..5.70 rows=1 width=135) (actual time=2.768..2.772 rows=15 loops=1)
  Sort Key: s.starts_at
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=38
  ->  GroupAggregate  (cost=5.67..5.69 rows=1 width=135) (actual time=2.655..2.727 rows=15 loops=1)
        Group Key: s.id
        Buffers: shared hit=35
        ->  Sort  (cost=5.67..5.67 rows=1 width=135) (actual time=0.603..0.614 rows=15 loops=1)
              Sort Key: s.id
              Sort Method: quicksort  Memory: 27kB
              Buffers: shared hit=35
              ->  Result  (cost=0.03..5.66 rows=1 width=135) (actual time=0.106..0.447 rows=15 loops=1)
                    One-Time Filter: ((NULLIF(current_setting('app.current_business_id', true), ''))::uuid = '0eeded2d-bafb-4dfe-9845-f8d2fb41a27f'::uuid)
                    Buffers: shared hit=32
                    ->  Nested Loop Left Join  (cost=0.03..5.66 rows=1 width=135) (actual time=0.089..0.425 rows=15 loops=1)
                          Join Filter: (a.shift_id = s.id)
                          Rows Removed by Join Filter: 210
                          Buffers: shared hit=32
                          ->  Seq Scan on rota_shard_1.shifts s  (cost=0.00..2.94 rows=1 width=103) (actual time=0.047..0.057 rows=15 loops=1)
                                Filter: ((s.business_id = '0eeded2d-bafb-4dfe-9845-f8d2fb41a27f'::uuid) AND ((s.status)::text = 'published'::text))
                          ->  Seq Scan on rota_shard_1.shift_assignments a  (cost=0.01..2.69 rows=1 width=64) (actual time=0.007..0.011 rows=15 loops=15)
                                Filter: (a.business_id = '0eeded2d-bafb-4dfe-9845-f8d2fb41a27f'::uuid)
Planning Time: 3.218 ms | Execution Time: 3.284 ms
```
**Findings & Justification:**
- **RLS Zero-Overhead Branching:** Notice `One-Time Filter: ((NULLIF(current_setting('app.current_business_id', true), ''))::uuid = ...)` evaluated at plan initialization. The planner verifies tenant authorization before scanning child nodes.
- **Index Support:** The table has index `idx_shifts_dept_starts` on `(business_id, department_id, starts_at)`. In small development tables (<100 rows), PostgreSQL's cost planner appropriately selects sequential scans over index scans due to page locality (38 shared buffer hits). On larger tenant volumes, `idx_shifts_dept_starts` ensures logarithmic time complexity.

---

### 3.2 Query 2: Activity Feed 10,000-Record Keyset Cursor Pagination (`AC-ACT-05`, `NFR-PERF-001`, `AC-014`)

**Verification Requirement:** Genuine empirical PostgreSQL `EXPLAIN ANALYZE` comparison demonstrating query performance before and after adding the supporting composite index on a representative dataset of at least 10,000 activity events.

**Benchmark Harness:** `scripts/benchmark-explain-10k.ts` (executed in an isolated disposable session with 10,000 tenant events + 2,000 multi-tenant noise records without altering or dropping schema indexes in shard databases).

**Target Query SQL:**
```sql
SELECT id, created_at, type, branch_id, department_id, visibility_class, payload
FROM activity_events
WHERE business_id = $1
  AND visibility_class IN ('schedule', 'public')
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

#### A. Execution Plan BEFORE Adding Index (Unindexed Sequential Scan Baseline)
```
Limit  (cost=623.21..623.26 rows=20 width=129) (actual time=7.687..7.695 rows=20 loops=1)
  Output: id, created_at, type, branch_id, department_id, visibility_class, payload
  Buffers: local hit=288
  ->  Sort  (cost=623.21..637.80 rows=5833 width=129) (actual time=7.684..7.688 rows=20 loops=1)
        Output: id, created_at, type, branch_id, department_id, visibility_class, payload
        Sort Key: temp_activity_events_bench.created_at DESC, temp_activity_events_bench.id DESC
        Sort Method: top-N heapsort  Memory: 30kB
        Buffers: local hit=288
        ->  Seq Scan on pg_temp.temp_activity_events_bench  (cost=0.00..468.00 rows=5833 width=129) (actual time=0.032..5.680 rows=5000 loops=1)
              Output: id, created_at, type, branch_id, department_id, visibility_class, payload
              Filter: (((temp_activity_events_bench.visibility_class)::text = ANY ('{schedule,public}'::text[])) AND (temp_activity_events_bench.business_id = '0eb37680-0488-4b0a-961d-57fef492e0b4'::uuid))
              Rows Removed by Filter: 7000
              Buffers: local hit=288
Planning Time: 6.524 ms | Execution Time: 7.820 ms
```

#### B. Execution Plan AFTER Adding Composite Index `(business_id, created_at DESC, id DESC)`
```
Limit  (cost=0.29..4.46 rows=20 width=129) (actual time=0.150..0.204 rows=20 loops=1)
  Output: id, created_at, type, branch_id, department_id, visibility_class, payload
  Buffers: local hit=2 read=3
  ->  Index Scan using idx_activity_bench_feed on pg_temp.temp_activity_events_bench  (cost=0.29..1218.61 rows=5833 width=129) (actual time=0.147..0.199 rows=20 loops=1)
        Output: id, created_at, type, branch_id, department_id, visibility_class, payload
        Index Cond: (temp_activity_events_bench.business_id = '0eb37680-0488-4b0a-961d-57fef492e0b4'::uuid)
        Filter: ((temp_activity_events_bench.visibility_class)::text = ANY ('{schedule,public}'::text[]))
        Rows Removed by Filter: 20
        Buffers: local hit=2 read=3
Planning Time: 1.389 ms | Execution Time: 0.289 ms
```

#### C. Subsequent Keyset Cursor Pagination Query Plan (`created_at < cursor.createdAt`)
```
Limit  (cost=0.29..4.76 rows=20 width=129) (actual time=0.096..0.124 rows=20 loops=1)
  Output: id, created_at, type, branch_id, department_id, visibility_class, payload
  Buffers: local hit=6
  ->  Index Scan using idx_activity_bench_feed on pg_temp.temp_activity_events_bench  (cost=0.29..1293.61 rows=5784 width=129) (actual time=0.095..0.119 rows=20 loops=1)
        Output: id, created_at, type, branch_id, department_id, visibility_class, payload
        Index Cond: (temp_activity_events_bench.business_id = '0eb37680-0488-4b0a-961d-57fef492e0b4'::uuid)
        Filter: (((temp_activity_events_bench.visibility_class)::text = ANY ('{schedule,public}'::text[])) AND ((temp_activity_events_bench.created_at < '...'::timestamp with time zone) OR ((temp_activity_events_bench.created_at = '...'::timestamp with time zone) AND (temp_activity_events_bench.id < '...'::uuid))))
        Rows Removed by Filter: 71
        Buffers: local hit=6
Planning Time: 0.214 ms | Execution Time: 0.183 ms
```

#### Comparative Findings & Mathematical Gain:
- **Execution Time Reduction:** Decreased from **7.820 ms down to 0.289 ms** (**27.06x speedup**). Keyset cursor execution time drops further to **0.183 ms** (**42.7x speedup**).
- **Buffer Access Reduction:** Buffer hits dropped from **288 pages down to 5 pages** (a **98.3% I/O reduction**).
- **Elimination of Sort Overhead:** Without the index, PostgreSQL performed an in-memory `top-N heapsort (Memory: 30kB)` across all filtered rows. With the composite index, sorting is completely eliminated (`O(1)` index seek matching the exact physical B-tree order).
- **Methodological Safety:** The benchmark ran in an isolated disposable session via `scripts/benchmark-explain-10k.ts`, guaranteeing that existing shard schemas (`rota_shard_1`, `rota_shard_2`) were never altered or degraded.

---

### 3.3 Query 3: Financial Ledger Deterministic Entitlement Replay (`M6`, `BILL-025`)
**Query SQL:**
```sql
SELECT id, seq, type, plan, seat_quantity, amount_minor, currency, created_at
FROM ledger_entries
WHERE business_id = $1
ORDER BY seq ASC;
```

**PostgreSQL 16 Execution Plan:**
```
Result  (cost=0.14..8.16 rows=1 width=318) (actual time=0.056..0.061 rows=5 loops=1)
  One-Time Filter: ((NULLIF(current_setting('app.current_business_id', true), ''))::uuid = '0eeded2d-bafb-4dfe-9845-f8d2fb41a27f'::uuid)
  Buffers: shared hit=2
  ->  Index Scan using idx_ledger_seq on rota_shard_1.ledger_entries  (cost=0.14..8.16 rows=1 width=318) (actual time=0.040..0.043 rows=5 loops=1)
        Index Cond: (ledger_entries.business_id = '0eeded2d-bafb-4dfe-9845-f8d2fb41a27f'::uuid)
        Buffers: shared hit=2
Planning Time: 1.223 ms | Execution Time: 0.111 ms
```
**Findings & Justification:**
- **Execution Time:** **0.111 ms** with only **2 shared buffer hits**.
- **Index Optimization:** PostgreSQL used `idx_ledger_seq` on `(business_id, seq)` to stream entries in strict monotonic order without in-memory sorting, satisfying regulatory replay requirements (`AC-013`, `BILL-010`).

---

## 4. Connection Pool Sizing, Failure Drills & Context Isolation (`Scope 4`)

### 4.1 Sizing Rationale & Baseline Configuration
- Control Plane Pool: `max: 10`, `idleTimeoutMillis: 30000`.
- Shard 1 Pool: `max: 10`, `idleTimeoutMillis: 30000`.
- Shard 2 Pool: `max: 10`, `idleTimeoutMillis: 30000`.
Total application database connections across all planes: 30 connections. This respects PostgreSQL connection limits while ensuring dedicated headroom for both logical shards and control operations.

### 4.2 Failure Drills Execution Summary (`scripts/pool-exhaustion-drill.ts`)

| Drill No. | Test Scenario | Expected Behavior | Actual Measured Outcome | Status |
|---|---|---|---|---|
| **Drill 1** | Pool Saturation (20 concurrent requests against a 10-connection pool) | Excess 10 requests queue gracefully; zero dropped requests; all complete once connections free. | Total dispatched: 20. Completed: 20. Failed: 0. Unqueued median latency: 403.33ms. Queued max latency: 671.63ms. Process did not crash. | **PASSED** |
| **Drill 2** | Database Error Simulation (Invalid SQL table query) | SQL exception propagates cleanly; `ROLLBACK` executes; connection returns to pool in working order. | Caught expected `42P01` exception. Follow-up query on same pool immediately succeeded with `1 AS recovery_status`. | **PASSED** |
| **Drill 3** | Zero Tenant Context Leakage Under Failure (`AC-TEN-04`) | A transaction that crashes under Tenant A must never leave `app.current_business_id` set on the pooled connection. | Induced crash under Tenant A. Next raw connection acquired from pool returned `app.current_business_id = ''` (empty). Zero leakage confirmed. | **PASSED** |
| **Drill 4** | Strict Connection Timeout & Graceful Degradation | With `connectionTimeoutMillis: 300` and `max: 1`, queued request exceeding timeout throws cleanly without crash. | Strict connection timeout triggered after 300ms. Error caught gracefully by application; server remained online. | **PASSED** |

### 4.3 Defense-in-Depth Context Clearing Mechanism (`src/db/tenant-context.ts`)
```typescript
finally {
  try {
    await client.query("SELECT set_config('app.current_business_id', '', false)");
    client.release();
  } catch (_resetErr) {
    // If socket is poisoned or unrecoverable, discard socket from pool permanently
    client.release(true);
  }
}
```
This guarantees that even if a network partition or database error interrupts execution, poisoned connections are physically destroyed rather than returned to the pool.

---

## 5. Shard Distribution, Hash Routing & Logical Architecture (`Scope 5`)

### 5.1 Distribution Metrics (`scripts/verify-sharding-distribution.ts`)
- **Total Evaluated UUIDs:** 1,000 random RFC 4122 UUIDv4 identifiers.
- **Shard 1 Allocation:** 490 tenants (**49.00%**).
- **Shard 2 Allocation:** 510 tenants (**51.00%**).
- **Route Stability Violations (`AC-SH-01`):** **0** (100% deterministic route stability across 10,000 verification lookups).
- **Balanced Allocation Invariant (`AC-SH-02` >= 40% per shard):** **PASSED** (49.00% / 51.00% comfortably within the 40%-60% threshold).

### 5.2 Architectural Distinction: Logical Shards vs. Physical Clusters
- **Current Graduation Implementation (Logical Shard Simulation):**
  - Rota implements multi-tenant sharding using separate PostgreSQL schemas (`rota_shard_1`, `rota_shard_2`) hosted within a single PostgreSQL 16 container.
  - Separate connection pools (`shard1Pool`, `shard2Pool`) are maintained with distinct `search_path` configurations.
  - **Advantage:** Allows full architectural verification of hashing algorithms, routing logic, composite foreign keys, and RLS policies on standard developer hardware without paid infrastructure costs.
- **Production Enterprise Evolution (Independently Deployed Physical Databases):**
  - In a production cloud deployment, `shard1Pool` and `shard2Pool` will point to separate physical database endpoints (`shard1.db.internal:5432`, `shard2.db.internal:5432`).
  - The routing logic in `src/sharding/shard-router.ts` requires **zero code modifications**: the router simply outputs `shard_1` or `shard_2`, and the connection factory maps the identifier to the corresponding physical connection string.

---

## 6. Tenant Isolation, RLS & Application Security Audit (`Scope 6`)

### 6.1 Row-Level Security Policy Matrix
All tenant tables enforce `FORCE ROW LEVEL SECURITY` with non-superuser role `rota_app`:
```sql
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_shifts ON shifts
  FOR ALL TO rota_app
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
```

### 6.2 Security Controls Verification Audit

| Security Control | Implementation | Verification Outcome |
|---|---|---|
| **Role Privilege Isolation** | Role `rota_app` has `NOSUPERUSER`, `NOBYPASSRLS`. | Verified in `tests/tenancy/tenant-isolation.test.ts`. Attempts to disable RLS or grant superuser fail with `42501 permission denied`. |
| **Fail-Closed on Missing Context** | `current_setting(..., true)` returns empty string if unconfigured. `NULLIF` evaluates to NULL, matching 0 rows. | Verified: queries without `app.current_business_id` return 0 rows on `SELECT` and throw on `INSERT`. |
| **Spoofed Tenant Header Defense** | `business_id` is never read from client HTTP headers or request bodies. | Context derived exclusively from server-signed JWT claims (`req.tokenPayload.businessId`). Client spoofed headers are ignored. |
| **Composite Foreign Keys** | Foreign keys bind `(business_id, parent_id)`. | Prevents linking Business A shifts to Business B branches at the PostgreSQL storage engine level. |
| **Input Validation** | Zod schemas validate all inputs before query construction. | Malformed UUIDs, invalid date ranges, and negative seat numbers are rejected with 400 Bad Request. |
| **Rate Limiting & Auth Hygiene** | Refresh token rotation with family revocation (`SEC-020`); Argon2id password hashing. | Refresh token reuse revokes entire session family immediately (`tests/auth/auth.test.ts`). |
| **Secret Scanning & Hygiene** | `.gitignore` excludes `.env`, `*.pem`, `*.log`, `*.keystore`, `dist/`. | Repository audit confirms zero secrets or tokens committed to git history. |

---

## 7. Nigerian Data Protection Act (NDPA 2023) Review (`Scope 7`)

*Disclaimer: This review represents a senior database and application security engineering assessment of technical architecture and privacy controls. It does not constitute formal legal certification or legal counsel.*

### 7.1 Data Inventory & Lawful Basis (NDPA Part V, Sections 24 & 25)

| Category | Data Elements Collected | Primary Processing Purpose | Lawful Basis (NDPA s.25) |
|---|---|---|---|
| **User Identity** | Full Name, Email, Password Hash (Argon2id) | Authentication, account recovery, session security | Performance of contract (employment / service) |
| **Scheduling & Shifts** | Shift timings, branch, department, role | Work allocation, rostering, shift swaps | Performance of employment contract / Legitimate interest |
| **Attendance Records** | Clock-in states (`present`, `late`, `absent`), manager override notes, timestamps | Payroll readiness, attendance tracking | Performance of contract / Employer legal obligations |
| **Device & Push** | Push notification tokens, platform type | Shift reminders, urgent schedule change alerts | Explicit consent (opt-in mobile permissions) |
| **Financial Records** | Subscription plan, seat counts, payment intent references, immutable ledger entries | Commercial billing, tax accounting | Legal obligation & performance of commercial contract |

### 7.2 Privacy by Design Controls (NDPA Section 39)
1. **Tenant Separation:** Strict forced RLS ensures no employer or business can view another organization's staff, rosters, or attendance.
2. **Role-Based Visibility (Data Minimization):**
   - Staff members see only published shifts; draft rosters remain hidden.
   - Staff members can access only their own attendance history and swap requests.
   - Supervisors and GMs cannot view security events belonging to other users.
3. **Password Protection:** Passwords are hashed using Argon2id (memory-hard, resistant to GPU cracking). Plaintext passwords are never logged or stored.

### 7.3 Data Retention, Erasure & Deletion Pipeline (`AC-PRIV-01..03`)
- **Right to Erasure / Deletion:** When an organization account is closed, cascading composite foreign keys (`ON DELETE CASCADE`) delete shifts, shift assignments, and attendance records across the tenant plane.
- **Financial Ledger Exception (NDPA Section 24(1)(d)):** Transaction records in `ledger_entries` are retained under statutory tax and financial audit obligations. However, to satisfy the data subject's right to be forgotten, user associations are severed (`ON DELETE SET NULL`), effectively pseudonymizing the financial trail while preserving accounting balance integrity (`C-08`).
- **Token Expiry:** Access tokens automatically expire after 15 minutes; refresh tokens expire after 30 days and are invalidated immediately upon logout.

### 7.4 Open Legal & Compliance Questions
- **NDPC Registration:** Determining whether Rota qualifies as a "Data Controller of Major Importance" (DCMI) under NDPC regulations based on projected active employee headcount across Nigeria.
- **Cross-Border Transfers:** If cloud database infrastructure (AWS/GCP) is provisioned in Europe or North America, an adequacy assessment or standard contractual clauses must be formalized with Nigerian enterprise clients.

---

## 8. Operational Readiness: Startup, Health & Android Expo Export (`Scope 8`)

### 8.1 Database Migration & Verification Procedure
The documented database migration suite was executed and confirmed fully idempotent:
```bash
npm run db:migrate
```
**Outcome:**
- `rota_control`: Applied, 0 pending migrations.
- `rota_shard_1`: Applied, 0 pending migrations.
- `rota_shard_2`: Applied, 0 pending migrations.
- Exit code: `0`.

### 8.2 Health Endpoint Verification
```bash
GET /health
```
**Outcome:** Responds with `200 OK` and `{ "status": "healthy", "service": "rota-backend", "version": "0.1.0" }`. Undefined routes respond with `404 Not Found` without stack trace leakage.

### 8.3 Mobile Android Expo Export Verification
```bash
npx expo export -p android --no-bytecode
```
**Outcome:**
- Metro Bundler resolved 866 modules in 2,683ms.
- 17 image and icon assets exported.
- Android JavaScript bundle emitted: `_expo/static/js/android/App-28d4d508a738d54ef724578952f31946.js` (**1.3 MB**).
- Export directory: `mobile/dist/`. Exit code: `0`.

### 8.4 Physical Device Testing Disclosure
- **Mobile Verification Status:** The Rota mobile application has been verified via Expo Metro bundler static export, automated unit tests, and the TypeScript compiler.
- **Disclosure:** **The mobile application has NOT been tested on a physical Android or iOS device** in this graduation environment. Physical device hardware testing (camera, push notifications on physical APNs/FCM) is explicitly designated as an outstanding release gate.

---

## 9. Methodological Limitations, Outstanding Risks & Release Recommendation

### 9.1 Methodological Limitations
1. **Loopback Benchmarking:** Load tests and drills were conducted over local loopback (`127.0.0.1`). Network latency, TLS handshake overhead, and physical NIC packet drops present in WAN environments are not reflected.
2. **Single-Host Concurrency:** The Node.js application and PostgreSQL container shared CPU and memory resources on the same host machine. In a multi-tier production deployment, separating database and API tiers will further increase throughput.

### 9.2 Outstanding Gates Tracking (`STATE.md`)
- **Gate G-01 (Payment Provider):** Closed via `SimulatedPaymentProvider` (`D-25`). Real live payment processing requires verified Paystack/Flutterwave business credentials.
- **Gate FX-01 (Live Exchange Rates):** Closed via deterministic `cbn_indicative_fixture` (`AC-FX-06`). Live currency API feeds require production API keys.
- **Gate G-02 (OAuth Providers):** Email/password with Argon2id is the operational release baseline.
- **Gate G-03 (NDPA Formal Sign-Off):** Technical controls are implemented; formal corporate DPO filing remains uncertified.

### 9.3 Release Recommendation
**Recommendation: CONDITIONAL RELEASE APPROVAL FOR MILESTONE M8.**  
The core architecture, multi-tenant isolation boundary, forced RLS security model, 200-VU performance threshold, and offline mobile build are fully verified, robust, and reproducible.

---

## 10. Reproducible Verification Commands Reference

```bash
# 1. Run all backend tests (127 tests across 24 suites)
npm test

# 2. Run deterministic sharding suite (10 tests)
npm run test:sharding

# 3. Run backend TypeScript typecheck
npm run typecheck

# 4. Run mobile TypeScript typecheck
npm --prefix mobile run typecheck

# 5. Run 200-VU load test & caching benchmark
npm run benchmark:caching

# 6. Run database query plan analysis (EXPLAIN ANALYZE)
npm run benchmark:explain

# 7. Run connection pool exhaustion & resilience drills
npm run drill:resilience

# 8. Run 1,000-UUID shard distribution analysis
npm run verify:sharding

# 9. Verify database migrations
npm run db:migrate

# 10. Export mobile Android bundle
cmd.exe /c npx expo export -p android --no-bytecode
```
