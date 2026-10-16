# DR-07: Database Access Layer and Migration Tooling

## Status
`PROPOSED` (Awaiting Product Owner Approval)

## Context
The Rota database layer has unique, non-negotiable security and architecture constraints:
1. **Transaction-Scoped Tenant Context (`SEC-010`)**: Every tenant query must run within a transaction where `SET LOCAL app.current_business_id = '...'` has executed.
2. **Forced Row-Level Security (`C-03`, `SEC-011`)**: Tables must declare `FORCE ROW LEVEL SECURITY`.
3. **Composite Foreign Keys (`C-02`, `SEC-012`)**: Every relationship includes `business_id` in composite keys.
4. **Append-Only Financial Ledger Triggers (`C-08`, `BILL-010`)**: Database triggers must block all `UPDATE` and `DELETE` queries on `ledger_entries`.
5. **Two Simulated Logical Shards (`D-30`)**: Migrations must apply cleanly and identically across `rota_control`, `rota_shard_1`, and `rota_shard_2`.

## Alternatives Considered

### 1. Prisma ORM
- *Pros*: Popular TypeScript ORM, intuitive schema format.
- *Cons*: Does not support connection-level `SET LOCAL` cleanly within its query engine without wrapping every query in interactive `$transaction`; cannot natively express PostgreSQL table triggers, RLS policies, or custom composite join conditions without raw SQL bypasses; struggles with multi-connection pool dispatch across logical shards.

### 2. Drizzle ORM
- *Pros*: Lightweight, SQL-like syntax, good TypeScript type inference.
- *Cons*: RLS policy declarations and migration generation for complex multi-shard schemas can be brittle; raw SQL migration control is less mature than dedicated migration tools.

### 3. Kysely (TypeScript SQL Query Builder) + `node-pg-migrate` (Recommended)
- *Pros*:
  - **Type-Safe SQL**: Kysely provides 100% type-safe query construction without ORM magic or hidden query generation.
  - **Explicit Connection Management**: Works directly with standard `pg.Pool` connection instances. Checking out a connection, executing `SET LOCAL`, running queries, and committing is completely transparent and reliable.
  - **Raw Migration Control**: `node-pg-migrate` uses plain SQL or JavaScript migration scripts, allowing full declarative control over `CREATE POLICY`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, and custom PL/pgSQL triggers (`C-08`).
  - **Multi-Shard Execution**: A single migration command can iterate through each shard connection pool and execute migrations identically, verifying zero schema drift (`AC-SH-06`).
- *Cons*: Requires manually maintaining TypeScript database interface types (can be automated via `kysely-codegen`).

## Decision & Rationale
Adopt **Kysely with `pg` (node-postgres) + `node-pg-migrate`**:
1. **Repository Layer**: Encapsulate all database operations in typed repository classes that accept a tenant context and enforce `SET LOCAL` execution before invoking Kysely queries.
2. **Migration Tooling**: Use `node-pg-migrate` with raw SQL scripts to define:
   - Control-plane schema (`users`, `sessions`, `payment_events`, etc.).
   - Sharded tenant-plane schema (`businesses`, `branches`, `departments`, `memberships`, `shifts`, `ledger_entries`).
   - RLS policies and append-only triggers.
3. **Dual-Shard Migration Runner**: A custom npm script (`npm run db:migrate`) runs migrations against `rota_control`, `rota_shard_1`, and `rota_shard_2` in sequence.
4. **RLS Simplicity & Transaction Scope (`SEC-010`, `SEC-011`)**:
   - Keep RLS policies strictly single-table equality checks: `USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)` and `WITH CHECK (...)`. No subqueries or cross-table joins inside RLS expressions, ensuring high performance and predictable execution plans (`NFR-PERF-001`).
   - Tenant context management is encapsulated in a lightweight `withTenantContext(shardPool, businessId, callback)` transaction helper that guarantees `SET LOCAL app.current_business_id` is executed inside a transaction and automatically cleared on connection release, preventing pool contamination (`AC-TEN-04`).

## Consequences
- **Positive**: Complete control over low-level Postgres features (RLS, triggers, transaction settings); zero impedance mismatch with simulated sharding; high runtime performance.
- **Negative**: Developers write structured SQL queries rather than high-level active record methods.

## Evidence & Verification
- Automated migration runner applying schema to both simulated shards without drift (`AC-SH-06`).
- SQL catalog assertions proving RLS and triggers are active (`AC-TEN-02`, `AC-013`).
