# Rule: Tenancy Isolation, Branch Scoping, and Context Management

## Behavior Enforced
This rule enforces strict multi-tenant isolation, two-shard logical routing, transaction-scoped database boundaries, server-side branch authorisation, and secure business/branch switching without data leakage.

## 1. Plane Separation and Sharding
- **Control Plane**: Unsharded database or schema for globally resolved entities prior to tenant determination: `users`, `auth_identities`, `auth_tokens`, `devices`, `sessions`, `refresh_tokens`, `push_tokens`, `user_settings`, `notification_preferences`, `membership_directory`, `payment_events`, `idempotency_keys`, and `deletion_requests`.
- **Tenant Plane**: Keyed strictly by `business_id` and routed across two simulated logical PostgreSQL shards via a deterministic hash of `business_id` (`SEC-013`, `NFR-SCALE-002`, `D-30`). All tenant queries must route through the central shard router. Cross-shard queries are forbidden except for control-plane lookups and explicit admin maintenance jobs.
- **Directory Outbox & Reconciliation**: The control-plane `membership_directory` is an eventually consistent read-copy of tenant memberships. Writes must use a transactional outbox and background reconciliation sweeper to repair drift (`AC-TEN-07`).

## 2. Server-Enforced Tenant Context (`SEC-010`)
- **Token-Derived Tenant**: The active `business_id` must come exclusively from the authenticated access token's validated business claim. Never trust client-supplied headers, query parameters, path variables, or body fields for tenant identity.
- **Transaction-Scoped Setting**: Before executing any tenant query, the server connection must execute a transaction-scoped setting (e.g. `SET LOCAL app.current_business_id = '...'`). Session-level settings (`SET`) on pooled connections are strictly prohibited.
- **Connection Return**: Database connections returned to the pool must be clean. Connection pool wrappers must verify the tenant setting is cleared after commit/rollback (`AC-TEN-04`).
- **Row-Level Security (RLS)**: RLS must be enabled and forced (`FORCE ROW LEVEL SECURITY`) on every table containing `business_id` (`C-03`, `SEC-011`). The application database user must not be a superuser or table owner and must not have `BYPASSRLS`.
- **Composite Foreign Keys**: All inter-entity relationships in the tenant plane must include `business_id` in composite primary and foreign keys (`C-02`, `SEC-012`) to prevent cross-tenant referencing.

## 3. Branch and Department Hierarchy (`D-31`, `D-32`, `D-33`, `D-34`, `Section 19.2`)
- **Entity Model**:
  - `Branch` belongs to exactly one `Business` (`business_id NOT NULL`, composite FK).
  - `Department` belongs to exactly one `Branch` (`business_id NOT NULL`, `branch_id NOT NULL`, composite FK). Department names are unique only within their parent branch.
  - A business may have multiple branches; there is no subscription-tier branch limit in V1 (`AC-BR-07`).
- **Staff Assignment**: Each Staff membership belongs to exactly one department in exactly one branch (`FR-ORG-007`, `D-33`). Staff cannot belong to multiple departments or branches simultaneously within the same business.
- **Role Scoping (`D-34`)**:
  - **Owner**: Authorised across all branches and departments in the business.
  - **General Manager (GM)**: Authorised across assigned branches and departments only.
  - **Supervisor**: Authorised strictly across assigned departments in assigned branches (`C-06`, `department_supervisors`).
  - **Staff**: Operational access restricted exclusively to their home department and branch.
- **No Resource Disclosure (`SEC-015`, `AC-TEN-01`, `AC-BR-04`)**:
  - Any request targeting a resource in another business, or a branch/department outside the user's authorised scope, must return HTTP `404 NOT_FOUND` (never `403 FORBIDDEN` or details revealing existence).

## 4. Context Switching and Cache Hygiene
- **Explicit Business Switching (`FR-AUTH-010`, `D-01`)**:
  - Switching business requires calling `/v1/auth/switch-business`.
  - The server issues a newly signed access token scoped to the selected business. The underlying refresh session is preserved.
  - On switch, logout, membership deactivation, or session revocation, the mobile client must immediately purge all tenant-scoped caches (Zustand store, TanStack query cache, offline shift storage, badge counts) (`FR-OFF-004`, `AC-OFF-01`).
- **Branch Context Switching**:
  - Branch switching is a client navigation event within the active business; it does not issue a new token.
  - Every branch-scoped request must validate the caller's membership permissions against the requested `branch_id`.
  - All cached branch data (rosters, calendars, shifts) must include both `business_id` and `branch_id` in their cache keys (`tenant:<biz_id>:branch:<branch_id>:...`). Switching branches must invalidate or re-scope local branch caches (`AC-BR-05`).
