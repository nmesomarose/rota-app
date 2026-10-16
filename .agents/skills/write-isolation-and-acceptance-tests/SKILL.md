---
name: write-isolation-and-acceptance-tests
description: >-
  Use this skill when authoring, expanding, or running acceptance tests,
  cross-tenant isolation suites, cross-branch permission checks, database
  RLS verification, and concurrency race tests across Rota.
---

# Skill: Write Acceptance and Cross-Tenant Regression Tests

This workflow guides the implementation and execution of rigorous regression test suites, negative authorization checks, and multi-tenant isolation proofs.

## When to Use
- Writing acceptance tests mapped to PRD criteria (`AC-xxx`).
- Generating automated cross-tenant and cross-branch negative test matrices.
- Authoring concurrency race tests for seat limits or shift swaps.
- Writing database RLS catalog checks and pool interleaving tests.
- Preparing exit evidence for milestone transitions (e.g. M1, M2, M3).

## Steps to Follow

### 1. Map Tests to PRD Acceptance Criteria
- Explicitly tag every test with its corresponding PRD criteria ID (e.g. `// Verifies AC-TEN-01, SEC-015`).
- Ensure no acceptance criteria are weakened or bypassed.

### 2. Table-Driven Cross-Tenant Harness (`SEC-016`, `AC-001`, `AC-TEN-01`)
- Extract all registered API routes from the application router.
- Seed two distinct test tenants: `Tenant_A` and `Tenant_B`.
- For each route:
  1. Authenticate as a user belonging to `Tenant_A`.
  2. Issue request targeting an entity belonging to `Tenant_B`.
  3. Assert the response returns HTTP 404 `NOT_FOUND` (never 200 or 403).
  4. Query the database to assert that zero rows in `Tenant_B` were mutated.

### 3. Cross-Branch Isolation Harness (`PRD 19.2`, `AC-BR-04`)
- Within a single business, seed `Branch_1` and `Branch_2`.
- Authenticate as a Supervisor assigned strictly to `Branch_1`.
- Attempt to:
  - Read shifts, rosters, or staff in `Branch_2`.
  - Create shifts or assign workers in `Branch_2`.
  - Access resources via guessed `branch_id` or deep links.
- Assert that every attempt returns HTTP 404 `NOT_FOUND` without leaking resource existence.

### 4. Database Row-Level Security Catalog Test (`C-03`, `AC-TEN-02`)
- Write an automated SQL catalog assertion:
  ```sql
  SELECT tablename 
  FROM pg_tables 
  WHERE schemaname = 'public' 
    AND tablename IN (SELECT table_name FROM information_schema.columns WHERE column_name = 'business_id')
    AND rowsecurity = false;
  ```
- Assert that the query returns zero rows.
- Connect as the application runtime role; attempt direct queries against another tenant's data; verify zero rows returned.

### 5. Pool Interleaving Concurrency Test (`SEC-010`, `AC-TEN-04`)
- Configure a connection pool restricted to 5 connections.
- Launch 500 interleaved asynchronous requests from `Tenant_A` and `Tenant_B`.
- Assert that:
  - Zero requests return data from the other tenant.
  - The transaction-scoped tenant setting `app.current_business_id` is completely empty after every request.

### 6. Seat Limit Concurrency Race (`BILL-009`, `BR-007`, `AC-SEAT-01`)
- Seed a business with 4 active memberships and a 5-seat plan limit.
- Issue 20 parallel invitation acceptance requests using valid tokens.
- Assert that:
  - Exactly 1 acceptance succeeds (HTTP 200/201).
  - Exactly 19 acceptances return HTTP 409 `SEAT_LIMIT_REACHED`.
  - Database row count of active memberships equals exactly 5.

### 7. Negative Authorization Matrix (`AC-RBAC-01`, `AC-002`)
- Execute a matrix test covering every role (Owner, GM, Supervisor, Staff) across all operations in `PRD 4.5`.
- Assert that unauthorized actions return HTTP 403 and are written to `audit_log`.

### 8. Performance and Scale Verification (`NFR-PERF-001` to `003`, `AC-015`, `AC-ACT-05`, `AC-OPS-04`)
- Author and execute load test scripts (e.g. k6) simulating 200 concurrent virtual users querying the activity feed before and after Redis caching (`AC-015`).
- Seed at least 10,000 activity events; record `EXPLAIN ANALYZE` execution plans for each audience filter (`AC-ACT-05`, `AC-014`).
- Execute connection pool exhaustion test; verify proper request queuing without connection dropouts (`AC-OPS-04`).

## Verification
1. Run test runner targeting the acceptance and isolation suites.
2. Confirm that tests execute against actual running databases (simulated shards) and Redis, not mock-bypassed stubs.
3. Verify that all failure assertions pass cleanly without masking underlying errors.
4. Execute performance/load test scripts and capture concrete `EXPLAIN ANALYZE` query plan artifacts.

## Required Output
- Test suite files located under test directories.
- Exact CLI test execution commands and full output reports.
- Traceability table mapping executed tests to PRD `AC-xxx` IDs.
- Load test scripts (e.g. k6) and documented performance benchmark reports (`NFR-PERF-002`, `AC-015`).
