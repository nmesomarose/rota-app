# Rota: Architectural Learning Log & Technical Notes

This living document captures technical discoveries, architectural trade-offs, and design patterns established during the development of Rota.

---

## Log Entry 01: Multi-Tenant Connection Pooling with Transaction-Scoped Settings
- **Date**: 2026-10-16
- **Context**: Milestone M0 / Tenant Context Planning (`SEC-010`, `AC-TEN-04`)
- **Discovery**:
  In a pooled PostgreSQL connection environment, setting connection-level variables (e.g. `SET app.current_business_id = '...'`) is dangerous because pooled connections are reused across different HTTP requests. If an error occurs or a connection is returned without explicit resetting, subsequent requests on that connection can inherit the prior tenant's context, creating critical cross-tenant data leaks.
- **Architectural Solution**:
  Use `SET LOCAL app.current_business_id = '...'` exclusively inside an explicit transaction block (`BEGIN ... COMMIT`). PostgreSQL automatically resets `SET LOCAL` variables upon transaction completion. Furthermore, connection pool wrappers must assert that the setting is cleared on connection release.

---

## Log Entry 02: ORM Selection for Simulated Shards and Forced RLS
- **Date**: 2026-10-16
- **Context**: Milestone M0 / Database Tooling Selection (`DR-07`)
- **Discovery**:
  High-level ORMs like Prisma hide low-level connection lifecycles behind their query engine binaries. Executing connection-specific `SET LOCAL` commands and managing multiple independent connection pools across simulated logical shards (`rota_shard_1`, `rota_shard_2`) requires complex raw query workarounds that negate the benefits of the ORM.
- **Architectural Solution**:
  Adopted **Kysely** with the native `pg` driver. Kysely provides compile-time TypeScript type safety while operating directly on standard `pg.PoolClient` connection instances. This allows explicit transaction wrapping (`await sql'SET LOCAL ...'`) and dynamic shard pool dispatch without impedance mismatch.

---

## Log Entry 03: Mobile Multi-Tenant Stack Hygiene and Expo Router vs React Navigation
- **Date**: 2026-10-16
- **Context**: Milestone M0 / Mobile Navigation Strategy (`DR-08`, `FR-AUTH-010`, `FR-OFF-004`)
- **Discovery**:
  When a user switches between businesses in Rota, the mobile client must guarantee that no screens, cached shifts, or state from the previous business remain in memory or in the back navigation stack. File-based routers like Expo Router maintain persistent URL-based history stacks that are cumbersome to programmatically wipe when transitioning between tenant contexts.
- **Architectural Solution**:
  Adopted **React Navigation v6/v7**. React Navigation provides imperative, synchronous stack resets (`navigation.reset(...)`) which cleanly dump previous navigation histories when switching business or branch contexts. Paired with `queryClient.clear()`, this guarantees zero cross-tenant state leakage on the mobile device.

---

## Log Entry 04: Redis Outage Durability for Webhooks and Notifications
- **Date**: 2026-10-16
- **Context**: Milestone M0 / Job Queue Architecture (`DR-03`, `BILL-007`, `NFR-REL-002`)
- **Discovery**:
  Redis is an in-memory datastore. In a failure scenario, enqueueing payment webhooks or notification jobs directly into BullMQ risks permanent data loss if Redis crashes or restarts before persistence.
- **Architectural Solution**:
  Adopted a **Dual-Layer Ingestion Architecture**. Webhooks are persisted first in the PostgreSQL control-plane `payment_events` table under a unique constraint before any BullMQ job is enqueued. A scheduled database sweeper polls for unprocessed inbox entries. If Redis is down, webhooks accumulate safely in PostgreSQL and are processed once Redis recovers (`AC-WH-04`).

---

## Log Entry 05: Dynamic NGN Quotes vs. Historical Ledger Immutability
- **Date**: 2026-10-16
- **Context**: Milestone M0 / Currency and Billing Strategy (`DR-01`, `D-23`, `AC-FX-04`)
- **Discovery**:
  Decision `D-23` requires that NGN subscription prices reflect current exchange rates derived from USD list prices. However, financial accounting requires that historical ledger records and confirmed quotes never mutate when FX rates fluctuate.
- **Architectural Solution**:
  Exchange-rate calculation occurs strictly at **quote generation time** on the server. The quote binds the retrieved FX rate, source, timestamp, rounding version, and expiry. Once confirmed, a payment intent and resulting ledger entries retain the exact currency, rate, and minor-unit amount originally locked in. Future rate changes only affect newly issued quotes.

---

## Log Entry 06: Expo SDK Version Verification and Environment Prerequisites
- **Date**: 2026-10-16
- **Context**: Milestone M0 to M1 Transition (`DR-08`, `ARCHITECTURE.md`)
- **Discovery**:
  The initial proposals recommended Expo SDK 51/52. A live query against npm dist-tags revealed that SDK 51 is end-of-life and SDK 52 is legacy (`52.0.49`). Expo's active stable release is SDK 58 (`latest: 58.0.13`), paired with React Native 0.88 and React 19. Additionally, initiating M1 requires a running PostgreSQL instance, which in turn depends on Docker Desktop. When inspecting the local host, the Docker CLI was present (`v29.8.0`) but the Docker Desktop daemon was not running due to the underlying WSL2 `docker-desktop` distribution being stopped.
- **Architectural Solution**:
  Updated `DR-08` and `ARCHITECTURE.md` to specify Expo SDK 58 with `expo-dev-client`. Flagged Docker Desktop startup as a mandatory blocking prerequisite before executing container provisioning commands or applying multi-schema database migrations.

---

## Log Entry 07: Multi-Schema Provisioning and Non-Superuser Role Isolation
- **Date**: 2026-10-16
- **Context**: Milestone M1 / Step 1 Local Database Environment (`C-03`, `SEC-011`, `PRD 9.1`)
- **Discovery**:
  To enforce PostgreSQL Row-Level Security (RLS) properly, the application database role must not have `SUPERUSER` or `BYPASSRLS` privileges. If the application connects as a superuser (e.g. `postgres`), PostgreSQL automatically bypasses RLS policies (`FORCE ROW LEVEL SECURITY` does not block a superuser in PostgreSQL; it only forces RLS on table owners who are not superusers). Furthermore, to simulate the two logical shards within a single development container without physical infrastructure overhead (`D-30`), we established three logical schemas: `rota_control`, `rota_shard_1`, and `rota_shard_2`.
- **Architectural Solution**:
  Provisioned a dedicated `rota_app` role configured with `NOSUPERUSER` and `NOBYPASSRLS`. Granted schema usage and default CRUD privileges on all three schemas. Admin migrations run under `DATABASE_URL` (admin), while runtime application queries run under `APP_DATABASE_URL` (`rota_app`).

---

## Log Entry 08: Deterministic Sharding Router and Malformed Input Rejection
- **Date**: 2026-10-16
- **Context**: Milestone M1 / Step 2 Shard Routing (`PRD 9.1`, `D-30`, `AC-SH-01`, `AC-SH-02`, `SEC-013`)
- **Discovery**:
  A naive hashing implementation that hashes any arbitrary input string creates dangerous failure modes: malformed strings, missing values, or SQL injection fragments could silently hash to a valid shard index, causing invalid requests to reach database connection pools and polluting error handling. Furthermore, client-supplied shard hints must never be trusted.
- **Architectural Solution**:
  Implemented `src/sharding/shard-router.ts` with strict UUID validation. Any non-UUID or malformed input immediately throws an explicit `InvalidBusinessIdError` before any hashing occurs. For valid UUIDs, the function normalizes casing and whitespace, computes a SHA-256 digest (`node:crypto`), reads the first 4 bytes as a 32-bit unsigned big-endian integer, and computes modulo 2. Automated tests proved 100% stability across 1,000 iterations for identical inputs (`AC-SH-01`) and demonstrated an even distribution across 1,000 random UUIDs (51.5% to Shard 1, 48.5% to Shard 2, comfortably surpassing the 40% minimum threshold of `AC-SH-02`).

---

## Log Entry 09: Connection Pool Lifecycle, Health Checks, and Test Teardown
- **Date**: 2026-10-16
- **Context**: Milestone M1 / Scaffolding Startup Infrastructure
- **Discovery**:
  PostgreSQL connection pools (`pg.Pool`) maintain persistent sockets and internal idle timers (default 30,000ms). When testing Express endpoints (such as `GET /health`) using Node's native test runner (`node --test`), a test can complete immediately, but the Node.js event loop will keep the process alive until every pooled connection socket times out, artificially inflating test durations from 200ms to 32 seconds.
- **Architectural Solution**:
  Added a centralized `closeAllPools()` helper in `src/db/connection.ts` that terminates idle connections across `controlPool`, `shard1Pool`, and `shard2Pool`. Test suites invoke this helper in their teardown hooks (`after()`), bringing test execution time down to ~2 seconds while preserving connection safety.

---

## Log Entry 10: Expo SDK 58, React 19 Peer Resolution, and Navigation Architecture
- **Date**: 2026-10-16
- **Context**: Milestone M0/M1 / Mobile Scaffolding & Dependency Verification (`DR-08`)
- **Discovery**:
  A live query against the npm registry confirmed that Expo SDK 58 (`~58.0.13`) is the active release, pairing React Native 0.88 with React 19. When resolving dependencies, `react-native@0.88.0` strictly requires `react@^19.3.0` as its peer dependency, making standard `react@19.0.0` fail resolution under modern npm `ERESOLVE` algorithms. Furthermore, `DR-08` proposed React Navigation over Expo Router because multi-tenant SaaS requires complete programmatic history wiping (`navigation.reset(...)`) when a user switches between businesses.
- **Architectural Solution**:
  Pinned `react: "^19.3.0"` and `@types/react: "^19.1.1"` in `mobile/package.json`. Scaffolded the proposed React Navigation architecture with `RootNavigator` (switching between `AuthStack` and `MainTabs`: Schedule, Feed, Team, Settings). This guarantees clean isolation between unauthenticated screens and multi-tenant authenticated operations.

---

## Log Entry 11: node-pg-migrate Execution Semantics and Raw SQL Up/Down Boundary Handling
- **Date**: 2026-10-16
- **Context**: Milestone M1 / Step 3 Migration Execution
- **Discovery**:
  When using `node-pg-migrate`, placing raw SQL scripts containing both `-- Up` and `-- Down` markers into a single file results in `node-pg-migrate` treating the entire file as the UP migration script. Consequently, PostgreSQL executes the `CREATE TABLE` and then immediately executes the `DROP TABLE` statements within the same migration transaction.
- **Architectural Solution**:
  Standardized on ES module `.js` migrations (`export async function up(pgm)` and `export async function down(pgm)`). Inside `up(pgm)`, `pgm.sql(...)` executes the forward DDL, RLS policies, and privilege grants. `down(pgm)` cleanly houses drop actions. This provides unambiguous execution semantics and 100% predictable migrations.

---

## Log Entry 12: PostgreSQL Superuser vs RLS Bypass Invariants and Forced RLS on Table Owners
- **Date**: 2026-10-16
- **Context**: Milestone M1 / Tenancy & Security Proof (`SEC-011`, `C-03`)
- **Discovery**:
  In PostgreSQL, `ALTER TABLE ... FORCE ROW LEVEL SECURITY` causes RLS policies to apply to table owners. However, PostgreSQL documentation and engine internals dictate that superuser roles (`rolsuper = true`) bypass RLS regardless of `FORCE ROW LEVEL SECURITY`. Therefore, relying on `postgres` as the application connection role completely invalidates RLS tenant isolation.
- **Architectural Solution**:
  Enforced a two-role model:
  1. Administrative role (`postgres`): Runs schema migrations and structural changes.
  2. Application role (`rota_app`): Configured strictly with `NOSUPERUSER` and `NOBYPASSRLS`. All backend queries execute through connection pools authenticated as `rota_app`.
  Automated tests in `tests/tenancy/isolation.test.ts` query `pg_roles` and execute queries as `rota_app` to verify RLS is actively enforced and cannot be bypassed.

---

## Log Entry 13: Transaction-Local Configuration (set_config(..., true)) vs Session Settings in Connection Pools
- **Date**: 2026-10-16
- **Context**: Milestone M1 / Tenant Context Isolation (`SEC-010`, `AC-TEN-04`)
- **Discovery**:
  Standard `SET app.current_business_id = '...'` persists at the connection session level. When a connection pool reuses that physical socket for another HTTP request, the new request inadvertently inherits the prior tenant's ID if an error or incomplete reset occurs.
- **Architectural Solution**:
  Implemented `withTenantContext` in `src/db/tenant-context.ts`:
  1. Validates the `businessId` using a strict UUIDv4 regex.
  2. Acquires a connection from the routed shard pool.
  3. Executes `BEGIN`.
  4. Calls `SELECT set_config('app.current_business_id', $1, true)` where the 3rd parameter (`is_local = true`) restricts the setting's lifespan strictly to the transaction.
  5. Upon `COMMIT` or `ROLLBACK`, PostgreSQL automatically clears the variable.
  6. As a defense-in-depth measure, the `finally` block executes `SELECT set_config('app.current_business_id', '', false)` and discards broken sockets via `client.release(true)` if an error state prevents resetting.
  Automated testing with 30 interleaved parallel requests proved zero context leakage across pooled connections.

---

## Log Entry 14: Refresh Token Rotation with Grace Window and Family Revocation
- **Date**: 2026-10-17
- **Context**: Milestone M2 / Authentication & Session Security (`DR-05`, `AC-AUTH-01`, `SEC-020`)
- **Discovery**:
  Mobile networks frequently suffer from packet drops, high latency, and duplicate retry requests. In standard refresh rotation, if a client emits two rapid requests with the same refresh token, the second request will fail or be flagged as an attack if rotation is purely single-use. However, naive long windows permit replay attacks.
- **Architectural Solution**:
  Implemented a dual-layer rotation defense:
  1. Refresh tokens are stored strictly as SHA-256 hashes in control-plane `refresh_tokens`.
  2. When rotated, the parent token is marked `used_at = NOW()` and links to its successor (`replaced_by`).
  3. The server maintains a short-lived ephemeral successor cache (15s TTL). If a concurrent request presents an already-used token within the 10-second grace window (`AC-AUTH-01`), the server returns the *exact same successor token pair*.
  4. If a token is reused *outside* the 10-second grace window, the server treats it as token theft (`SEC-020`), terminates the session in `sessions`, and revokes all tokens belonging to that `family_id`.

---

## Log Entry 15: Cross-Shard Directory Consistency via Transactional Outbox and Reconciliation
- **Date**: 2026-10-17
- **Context**: Milestone M2 / Multi-Tenant Sharding & Directory Lookup (`PRD 9.1`, `DR-03`, `AC-TEN-07`)
- **Discovery**:
  In a sharded multi-tenant architecture, querying all tenant shards to determine which businesses a user belongs to during login causes high database fan-out and latency. The control plane requires a `membership_directory` table. However, because PostgreSQL does not natively coordinate two-phase commits between independent schemas/shards without distributed transactions, a crash during onboarding could leave tenant memberships orphaned from the login directory.
- **Architectural Solution**:
  Adopted the **Transactional Outbox & Deep Reconciliation Pattern**:
  1. The tenant shard mutation transaction inserts into `businesses`, `branches`, `departments`, `memberships`, and `membership_outbox` atomically inside `withTenantContext`.
  2. The control plane `membership_directory` is updated immediately following commit.
  3. A reconciliation sweeper (`reconcileDirectoryForBusiness`) reads authoritative tenant memberships and repairs any missing directory records (`AC-TEN-07`).

---

## Log Entry 16: Daylight Saving Time (DST) Preservation in Wall-Clock Staffing Requirements
- **Date**: 2026-10-17
- **Context**: Milestone M3 / Scheduling Core Timezone Discipline (`FR-SCH-009`, `AC-SCH-03`)
- **Discovery**:
  Storing recurring schedule requirements as UTC offsets leads to operational errors when the host territory undergoes Daylight Saving Time (DST) clock changes (e.g. EST to EDT in New York or GMT to BST in London). If a requirement is stored as fixed UTC, an 08:00 morning shift inadvertently shifts to 09:00 or 07:00 local time after a clock change.
- **Architectural Solution**:
  Staffing requirements are strictly stored as local wall-clock times (`local_start: '08:00'`, `local_end: '16:00'`) tied to the business's IANA time zone identifier (e.g. `America/New_York`). Dynamic shift generation evaluates the calendar date against the IANA database using native `Intl.DateTimeFormat`, accurately generating `12:00:00Z` in summer (EDT, UTC-4) and `13:00:00Z` in winter (EST, UTC-5), preserving the true 08:00 local wall-clock start on both sides of any clock transition (`AC-SCH-03`).

---

## Log Entry 17: PostgreSQL Composite Primary Key Grouping in Multi-Tenant Schemas
- **Date**: 2026-10-17
- **Context**: Milestone M3 / Multi-Tenant Database Aggregations
- **Discovery**:
  When querying composite-key tenant tables where `PRIMARY KEY (business_id, id)` is defined, standard queries executing `SELECT s.id, s.branch_id, ... json_agg(...) FROM shifts s GROUP BY s.id` fail in PostgreSQL with: `column "s.branch_id" must appear in the GROUP BY clause or be used in an aggregate function`. PostgreSQL's functional dependency optimizer only recognizes primary key uniqueness when the complete primary key composite (`s.business_id, s.id`) is present in the `GROUP BY` clause.
- **Architectural Solution**:
  In all multi-tenant queries aggregating child rows (such as assignments on shifts), group clauses explicitly specify `GROUP BY s.business_id, s.id, s.starts_at`. This satisfies PostgreSQL's strict SQL engine while preventing redundant column listings.

---

## Defense Quick Reference: Core Architectural Concepts for the Owner
1. **Why Two Logical Shards?**
   Demonstrates multi-tenant database scaling architecture (horizontal partitioning) without requiring expensive distributed physical infrastructure. Sharding routing is deterministic: `sha256(business_id) % 2` guarantees stable, balanced routing.
2. **Why Forced RLS?**
   Even if an application developer forgets to add `WHERE business_id = $1` to a query, PostgreSQL Row-Level Security automatically filters the rows at the database engine level based on `current_setting('app.current_business_id')`.
3. **Why Composite Foreign Keys?**
   `departments` references `(business_id, branch_id)` rather than just `branch_id`. This guarantees that a department in Business A cannot be linked to a branch in Business B, even if application validation has a bug.
4. **Why Transaction-Scoped Context?**
   Database connections in modern web servers are pooled (shared). A transaction-scoped setting ensures that tenant credentials exist only for the duration of a single SQL transaction and are never inherited by the next request using that connection.


