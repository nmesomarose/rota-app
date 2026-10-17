# Rota: Project State & Workstream Tracker

## 1. Project Status Summary
- **Current Milestone**: **M3 — Scheduling Core** (VERIFIED & COMPLETE).
- **Implementation Status**:
  - Local PostgreSQL 16 environment verified (`rota-postgres` container).
  - Schemas `rota_control`, `rota_shard_1`, and `rota_shard_2` provisioned with identical, symmetrical tenant plane tables.
  - Non-superuser application role `rota_app` provisioned without `SUPERUSER` or `BYPASSRLS`.
  - Migration 003 applied across tenant shards (`shifts`, `staffing_requirements`, `shift_assignments`, `availability_entries`, `audit_log` with forced RLS, composite foreign keys, and tenant isolation policies).
  - Timezone engine implemented: preserves local wall-clock hours in business IANA time zone across Daylight Saving Time (DST) clock changes (`AC-SCH-03`, `FR-SCH-009`).
  - Shifts lifecycle implemented: `draft` -> `review` -> `published` -> `cancelled`.
  - Schedule visibility permissions verified: Staff view only `published` shifts (`AC-SCH-02`); managers view all statuses.
  - Staff direct shift deletion prohibited: returns 403 `FORBIDDEN` (`AC-002`, `FR-RBAC-002`).
  - Single-department constraint enforced: Staff can only be assigned to shifts in their home department (`C-07`, `AC-DM-02`).
  - Conflict detection engine implemented: flags overlapping shifts (`BR-001`), availability conflicts (`BR-005`), and department mismatches.
  - Reasoned manager overrides implemented: allows privileged managers to override availability or overlap conflicts with a mandatory non-empty reason, storing `override_reason`, `override_by`, and `override_at` on the assignment, and generating a persistent `audit_log` entry with `request_id` (`AC-RBAC-03`, `FR-AVL-003`).
  - Shift versioning verified: monotonic version bumps on every edit (`FR-SWP-007`).
  - Cross-tenant scheduling isolation verified: cross-tenant shift queries return 0 rows and cross-tenant mutations return 404 `NOT_FOUND` (`SEC-015`, `AC-TEN-01`).
  - Automated test suite passing: 71 tests across 17 suites in ~11s (including all 41 M1 tenancy/isolation/router tests, 21 M2 auth/onboarding/switching tests, and 9 comprehensive M3 scheduling core tests).
  - TypeScript typecheck passing cleanly with 0 errors (`tsc --noEmit`).
- **PRD Version**: v0.3 (Draft, authoritative product decisions consolidated).

---

## 2. Milestone Sequencing & Progress (`PRD 18`, `19.9`)

| Milestone | Scope & Deliverables | Status | Blockers / Preconditions |
|---|---|---|---|
| **M0** | **Decisions & Feasibility**: Workspace specs, decision records `DR-01` to `DR-08`, architecture, security, and sharding documentation skeleton. | **DONE** | Engineering decisions evaluated and locked; external provider gates identified. |
| **M1** | **Tenant/Shard Proof Before Feature Work**: Control/tenant planes, 2 logical shards, transaction context (`SET LOCAL`), forced RLS, composite FKs, pool reuse safety, adversarial cross-tenant test harness. | **DONE** | Fully implemented, migrated, and verified by automated tests. |
| **M2** | **Identity & Organisation Foundation**: Auth/session/revocation, business switching, role matrix, branches, branch-owned departments, invitations foundation, memberships, Owner onboarding, transactional outbox & directory reconciliation. | **DONE** | Fully implemented, migrated, and verified by 62 automated tests. |
| **M3** | **Scheduling Core**: Staffing requirements (wall-clock), shifts (UTC), conflict engine, reasoned overrides, draft/review/publish, rostered manager roles, branch-scoped schedules, shift versioning, stale swap invalidation foundation. | **DONE** | Fully implemented, migrated, and verified by 71 automated tests. |
| **M4** | **Mobile/Offline & Notifications**: Read-only upcoming schedule cache, visible last-updated time, branch/business cache clearing, durable jobs, push/in-app notifications, deep links, retries. | **NEXT** | M3 complete. Expo dev build setup. |
| **M5** | **Swaps, Attendance & Activity**: Same-branch swaps with version check, attendance history, scoped feed with 10k pagination tests. | QUEUED | M4 completion. |
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
