---
name: implement-scoped-data-access
description: >-
  Use this skill when creating or modifying database entities, migrations,
  repositories, queries, or caches in the tenant plane to enforce two-shard
  routing, transaction-scoped tenant context, RLS, composite foreign keys,
  and branch hierarchy.
---

# Skill: Implement Scoped Data Access

This workflow guides the implementation of tenant- and branch-scoped persistence layers, ensuring zero cross-tenant leakage and robust data integrity.

## When to Use
- Adding or modifying database migrations, tables, or relations.
- Writing repository queries, ORM models, or data access objects.
- Implementing caching logic for tenant- or branch-specific resources.
- Updating sharding router logic or shard connection dispatchers.

## Steps to Follow

### 1. Plane Determination
- Verify whether the entity belongs to the **Control Plane** (unsharded, global identity, sessions, directory, webhook inbox) or the **Tenant Plane** (keyed by `business_id`, stored on one of two simulated shards).

### 2. Schema and Migration Constraints (`PRD 9.4`, `19.2`)
- Ensure every tenant-plane table includes:
  - `business_id UUID NOT NULL` (`C-01`).
  - Primary key `(business_id, id)` (`C-02`).
  - Composite foreign keys for all tenant relationships that include `business_id` (e.g. `FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id)`).
- For branch and department hierarchy (`PRD 19.2`):
  - `branches`: `business_id`, `id`, `name`, `status`.
  - `departments`: `business_id`, `branch_id`, `id`, `name`.
  - `memberships`: For Staff, enforce `department_id NOT NULL` and `branch_id NOT NULL` matching the department's branch (`C-05`, `D-33`).

### 3. PostgreSQL Row-Level Security (RLS) Configuration (`C-03`, `SEC-011`)
- In migrations, enable and force RLS on the table:
  ```sql
  ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;
  ALTER TABLE <table_name> FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation_policy ON <table_name>
    USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
  ```
- Ensure the application database role does not possess `SUPERUSER` or `BYPASSRLS` privileges.

### 4. Repository Context Execution (`SEC-010`)
- Structure repository access so that tenant queries cannot run without an established tenant context.
- Wrap all tenant operations in a transaction that executes:
  ```sql
  SET LOCAL app.current_business_id = '<business_id>';
  ```
- Prevent raw connection usage from bypassing the tenant context middleware.

### 5. Two-Shard Router Dispatch (`SEC-013`, `NFR-SCALE-002`, `D-30`)
- Route connection requests via the central shard router using a deterministic hash of `business_id` (e.g. `hash(business_id) % 2`).
- Ensure all queries for a given business execute against its assigned shard connection pool.

### 6. Cache Key Scoping and Invalidation (`SEC-014`)
- Prefix every tenant cache key with the tenant identifier:
  `tenant:<business_id>:<resource>:<id>`
- For branch-scoped data (schedules, rosters), include both identifiers:
  `tenant:<business_id>:branch:<branch_id>:<resource>:<id>`
- Invalidation helpers must support tenant-wide and branch-scoped purges.

## Verification
1. **RLS Catalog Assertion (`AC-TEN-02`)**: Query `pg_tables` and `pg_class` to verify that RLS is enabled and forced on all tables containing `business_id`.
2. **Composite FK Rejection (`AC-TEN-03`)**: Attempt to insert a child row with `business_id = Tenant_A` referencing a parent row with `business_id = Tenant_B`; verify database foreign key constraint violation.
3. **Connection Pool Reset (`AC-TEN-04`)**: Run interleaved queries across multiple tenants over a shared pool; assert that `current_setting('app.current_business_id', true)` is cleared after each transaction.
4. **Deterministic Sharding (`AC-SH-01`)**: Run 1,000 routing checks on the same `business_id`; assert 100% route consistency across process restarts.

## Required Output
- Database migration files with RLS and composite constraints.
- Repository layer implementations requiring tenant context.
- Shard routing and cache key helper functions.
- Automated tests proving RLS enforcement, foreign key rejection, and pool hygiene.
