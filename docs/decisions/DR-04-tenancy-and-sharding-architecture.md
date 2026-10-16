# DR-04: Multi-Tenancy Architecture, Two-Shard Simulation, and RLS Enforcement

## Status
`PROPOSED` (Awaiting Product Owner Approval)

## Context
Rota is a multi-tenant platform with multi-business identity (`D-01`). A single user identity may hold memberships in several businesses. Furthermore:
1. **Two-Shard Logical Simulation (`D-30`, `NFR-SCALE-002`)**: Rota requires a simulation of two logical tenant shards routed by hash of `business_id`.
2. **Plane Separation (`PRD 9.1`)**: Control plane (global users, sessions, directory, payment event inbox) must be separated from the Tenant plane (business-owned data).
3. **Database Security Invariants (`SEC-010` to `SEC-013`, `C-01` to `C-03`)**: Tenant isolation must be guaranteed at the database layer via composite foreign keys and PostgreSQL Row-Level Security (RLS) forced on all tenant tables.
4. **Branch Scoping (`D-31` to `D-34`, `PRD 19.2`)**: A business has multiple branches. Staff memberships belong to one department in one branch. Operational permissions must be branch-scoped.

## Alternatives Considered

### 1. Single Database Schema with Pure Application Filtering
- *Pros*: Simplest to implement.
- *Cons*: High risk of IDOR or cross-tenant leakage due to developer error or missing `WHERE business_id = ...` clauses. Explicitly violates `SEC-010` and `C-03`.

### 2. Physical Multi-Database Sharding with Distributed Transactions
- *Pros*: True physical isolation.
- *Cons*: Heavy infrastructure overhead, difficult to run and test locally, unneeded for V1/graduation project scope (`D-29`, `AGENTS.md` line 77: *"The two-shard requirement is a simulation unless the approved architecture explicitly requires production-grade distributed sharding"*).

### 3. Logical Two-Shard Simulation within PostgreSQL + RLS + Composite FKs (Recommended)
- *Pros*:
  - Simulates two tenant shards (`rota_shard_1` and `rota_shard_2` schemas or databases) managed by a central shard router using a deterministic hash (`hash(business_id) % 2`).
  - Control plane tables reside in an unsharded schema (`rota_control`).
  - Strict isolation via forced RLS (`FORCE ROW LEVEL SECURITY`) with `SET LOCAL app.current_business_id`.
  - Composite foreign keys `(business_id, id)` prevent cross-tenant references at the database engine level.
  - Full local reproducibility using a standard PostgreSQL container.
- *Cons*: Requires custom connection dispatch logic and dual-shard migration runners.

## Decision & Rationale
Adopt the **Logical Two-Shard Simulation with Forced RLS**:
1. **Shard Routing Function**:
   - `getShardForBusiness(businessId: string): ShardConnectionPool` computes a deterministic hash of the UUID (`murmur3` or `sha256`) modulo 2.
   - Same `business_id` routes to the exact same shard 100% of the time across process restarts (`AC-SH-01`).
   - Generates a balanced distribution across shards (`AC-SH-02`).
2. **Transaction Context Wrapper**:
   - Before executing queries on the checked-out shard connection, execute:
     `SET LOCAL app.current_business_id = '<businessId>';`
   - Connection return wrapper asserts that settings are wiped on release (`AC-TEN-04`).
3. **PostgreSQL RLS Policies (`C-03`)**:
   - Every tenant table has `FORCE ROW LEVEL SECURITY`.
   - Application user has no `BYPASSRLS` privileges.
4. **Branch Hierarchy (`PRD 19.2`)**:
   - Tables: `branches` (`business_id`, `id`, `name`), `departments` (`business_id`, `branch_id`, `id`, `name`), `memberships` (`business_id`, `user_id`, `role`, `department_id`, `branch_id`).
   - Staff assignments enforce that staff membership department equals shift department (`C-05`, `C-07`).

## Consequences
- **Positive**: Complete defense-in-depth against data leakage; fulfills all simulated sharding requirements without production infrastructure bloat; testable via automated catalog queries.
- **Negative**: Cross-shard queries (e.g. login listing a user's businesses) must query the control-plane `membership_directory`, which requires asynchronous outbox reconciliation (`AC-TEN-07`).

## Evidence & Verification
- 500-request pool interleaving test returning zero cross-tenant rows (`AC-TEN-04`).
- Direct SQL RLS catalog test asserting RLS is enabled and forced on all tables with `business_id` (`AC-TEN-02`).
- Cross-tenant composite FK violation rejection (`AC-TEN-03`).
- 1,000-iteration deterministic shard hash verification (`AC-SH-01`).
