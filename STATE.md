# Rota: Project State & Workstream Tracker

## 1. Project Status Summary
- **Current Milestone**: **M2 — Identity, Authentication & Organization Foundation** (VERIFIED & COMPLETE).
- **Implementation Status**:
  - Local PostgreSQL 16 environment verified (`rota-postgres` container).
  - Schemas `rota_control`, `rota_shard_1`, and `rota_shard_2` provisioned with identical, symmetrical tenant plane tables.
  - Non-superuser application role `rota_app` provisioned without `SUPERUSER` or `BYPASSRLS`.
  - Migration 002 applied across control plane (`refresh_tokens`, `membership_directory`, user/session alterations) and tenant shards (`subscriptions`, `membership_outbox` with forced RLS and tenant isolation policies).
  - Argon2id password hashing implemented and verified (64MB memory, 3 iterations, 4 parallelism per `DR-05` and `SEC-008`).
  - Access token lifecycle implemented (15-minute expiration, HS256 JWT, trusted claims strictly derived from server-side verification).
  - Refresh token rotation implemented with opaque 64-hex tokens stored strictly as SHA-256 hashes, 30-day idle expiry, 90-day absolute session cap, 10-second grace window for concurrent mobile requests, and immediate token family revocation on reuse (`AC-AUTH-01`, `SEC-020`).
  - Session revocation tested and verified: `logout` and `logout-all` immediately invalidate active sessions and tokens on next request (`AC-AUTH-02`, `AC-004`).
  - Organization onboarding (`POST /v1/organizations`) implemented: atomic multi-entity transaction creating business, default branch, initial departments, Owner membership, starter subscription (5 seats), and outbox row on assigned tenant shard.
  - Control-plane `membership_directory` synchronized and crash reconciliation verified (`AC-TEN-07`).
  - Business switching (`POST /v1/auth/switch-business`) implemented with tenant membership verification and newly scoped access tokens. Unauthorized switches return 404 `NOT_FOUND` (`SEC-015`).
  - Client-supplied context spoofing prevented: tenant context derived strictly from authenticated server-side token claims, never client headers (`X-Business-Id`) or query params.
  - Immediate membership deactivation tested: deactivated memberships rejected on next request (`FR-RBAC-006`, `AC-TEN-06`).
  - Automated test suite passing: 62 tests across 16 suites in ~10s (including all 41 tenancy/isolation/router tests + 21 new auth, onboarding, switching, reconciliation tests).
  - TypeScript typecheck passing cleanly with 0 errors (`tsc --noEmit`).
- **PRD Version**: v0.3 (Draft, authoritative product decisions consolidated).

---

## 2. Milestone Sequencing & Progress (`PRD 18`, `19.9`)

| Milestone | Scope & Deliverables | Status | Blockers / Preconditions |
|---|---|---|---|
| **M0** | **Decisions & Feasibility**: Workspace specs, decision records `DR-01` to `DR-08`, architecture, security, and sharding documentation skeleton. | **DONE** | Engineering decisions evaluated and locked; external provider gates identified. |
| **M1** | **Tenant/Shard Proof Before Feature Work**: Control/tenant planes, 2 logical shards, transaction context (`SET LOCAL`), forced RLS, composite FKs, pool reuse safety, adversarial cross-tenant test harness. | **DONE** | Fully implemented, migrated, and verified by automated tests. |
| **M2** | **Identity & Organisation Foundation**: Auth/session/revocation, business switching, role matrix, branches, branch-owned departments, invitations foundation, memberships, Owner onboarding, transactional outbox & directory reconciliation. | **DONE** | Fully implemented, migrated, and verified by 62 automated tests. |
| **M3** | **Scheduling Core**: Staffing requirements (wall-clock), shifts (UTC), conflict engine, reasoned overrides, draft/review/publish, rostered manager roles, branch-scoped schedules, shift versioning, stale swap invalidation. | **NEXT** | M2 complete. |
| **M4** | **Mobile/Offline & Notifications**: Read-only upcoming schedule cache, visible last-updated time, branch/business cache clearing, durable jobs, push/in-app notifications, deep links, retries. | QUEUED | M3 completion. Expo dev build setup. |
| **M5** | **Swaps, Attendance & Activity**: Same-branch swaps with version check, attendance history, scoped feed with 10k pagination tests. | QUEUED | M4 completion. |
| **M6** | **Simulated Billing**: Server quotes, deterministic FX fixtures, Owner confirmation, proration (`PR-01`–`16`), immutable ledger, payment-intent state machine, idempotency, renewal/grace/restricted-mode tests. | QUEUED | M5 completion. Gate G-01 unverified provider remains simulated (`D-25`). |
| **M7** | **Live Billing Integration (Conditional)**: Real Paystack/Flutterwave integration only if G-01 and FX-01 are formally closed; otherwise document simulator boundary. | BLOCKED | Gate G-01, Gate FX-01. |
| **M8** | **Performance, Resilience & Release Evidence**: 200-VU load test before/after caching, `EXPLAIN ANALYZE`, pool exhaustion/failure drills, sharding report, privacy/security docs, demo. | QUEUED | M6/M7 completion. Gate G-03 (NDPA review). |

---

## 3. Decision Gates & Blockers Tracking (`PRD 17.2`, `19.8`)

| Gate | Title | Current Status | Impact / Scope Blocked |
|---|---|---|---|
| **G-01** | **Payment Provider & Currencies** | `UNVERIFIED` | Real payment gateway integration blocked. M6/M7 proceeds using `SimulatedPaymentProvider` (`D-25`). |
| **FX-01** | **Live Exchange-Rate Source** | `UNVERIFIED` | Chargeable live NGN quotes blocked. Automated tests use deterministic labelled test fixtures (`AC-FX-06`). |
| **G-02** | **Google OAuth Credentials** | `UNVERIFIED` | Native Google Sign-in blocked. Email/password authentication is the approved V1 baseline. |
| **G-03** | **NDPA Privacy & Retention Review** | `UNVERIFIED` | Production launch data retention schedule blocked. Erasure pipelines pseudonymize personal data without deleting financial ledgers. |
| **OQ-012** | **Maximum Seat Ceilings** | `OPEN` | Enforcing seat limits beyond plan included/additional pricing rules remains unconfigured. |
| **OQ-023** | **Restricted Mode Staff Actions** | `PARTIALLY RESOLVED` | Staff can view published shifts and sync settings; all other mutations are blocked (`BILL-030`). |

---

## 4. Current Workstream Action Items
1. **Milestone M1 Verification Evidence (COMPLETED)**:
   - Initial migrations applied across `rota_control`, `rota_shard_1`, and `rota_shard_2`.
   - `pg_class.relrowsecurity = true` and `pg_class.relforcerowsecurity = true` confirmed on all tenant tables.
   - Tenant isolation verified: Tenant A cannot read, update, or delete Tenant B rows.
   - Missing tenant context fails closed (0 rows on SELECT, policy violation on INSERT).
   - Composite foreign keys reject cross-tenant branch/department references at database level.
   - Interleaved concurrent transactions (30 alternating executions) confirm zero context leakage across pooled connections.
   - Failed/rolled-back transactions leave connection pool clean (`app.current_business_id` empty).
   - Dual-shard schema symmetry verified (identical tables, columns, RLS policies).
2. **Architecture Decisions DR-01 through DR-08 (COMPLETED)**:
   - Recorded justified engineering decisions within architect authority without fabricating human owner sign-off.
   - Explicitly preserved unresolved Gates G-01, FX-01, G-02, and G-03.
3. **Safe Git Baseline (COMPLETED)**:
   - Initialized Git repository for `Mobile-Apps\Rota App`.
   - Committed baseline `e3a3ce1` with `.env` strictly ignored and uncommitted.
