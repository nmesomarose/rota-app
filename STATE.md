# Rota: Project State & Workstream Tracker

## 1. Project Status Summary
- **Current Milestone**: **M4 — Mobile Integration, Offline Behaviour & Notifications** (VERIFIED & COMPLETE).
- **Implementation Status**:
  - Local PostgreSQL 16 environment verified (`rota-postgres` container).
  - Schemas `rota_control`, `rota_shard_1`, and `rota_shard_2` provisioned with identical, symmetrical tenant plane tables.
  - Non-superuser application role `rota_app` provisioned without `SUPERUSER` or `BYPASSRLS`.
  - Migrations 003 control (`push_tokens`) and 004 tenant (`notification_deliveries`, `inbox_items`) applied across shards with forced RLS and tenant isolation.
  - Mobile authentication flow (`LoginScreen.tsx`) integrated with `/v1/auth/login`, Zod-aligned request/response envelopes, and secure token storage in `expo-secure-store` (`AC-AUTH-07`).
  - Multi-business organization selection (`BusinessSelectScreen.tsx`) integrated with `/v1/organizations/memberships` and `/v1/organizations/switch-business`.
  - Offline upcoming shift cache (`ScheduleScreen.tsx`, `offline-cache.ts`) implemented with 14-day duration, visible last-updated watermark, and synchronous cache purging on business switch or logout (`AC-OFF-01`, `AC-OFF-02`, `FR-OFF-004`).
  - In-app inbox and notification dispatcher (`FeedScreen.tsx`, `notification-service.ts`) implemented with schedule publication alerts, shift cancellation alerts, urgent 12-hour detection (`D-14`, `AC-NOT-01`), deduplication (`C-10`), and read receipt updates.
  - Automated test suite passing: 79 tests across 19 suites in ~12s (including 41 M1 tenancy tests, 21 M2 auth/switching tests, 9 M3 scheduling tests, 5 M4 notification integration tests, and 3 M4 mobile offline/security tests).
  - TypeScript typecheck passing cleanly across both backend (`tsc --noEmit`) and mobile (`tsc --noEmit`).
  - Expo Android bundle verification passing (`npx expo export -p android --no-bytecode` exiting code 0).
- **PRD Version**: v0.3 (Draft, authoritative product decisions consolidated).

---

## 2. Milestone Sequencing & Progress (`PRD 18`, `19.9`)

| Milestone | Scope & Deliverables | Status | Blockers / Preconditions |
|---|---|---|---|
| **M0** | **Decisions & Feasibility**: Workspace specs, decision records `DR-01` to `DR-08`, architecture, security, and sharding documentation skeleton. | **DONE** | Engineering decisions evaluated and locked; external provider gates identified. |
| **M1** | **Tenant/Shard Proof Before Feature Work**: Control/tenant planes, 2 logical shards, transaction context (`SET LOCAL`), forced RLS, composite FKs, pool reuse safety, adversarial cross-tenant test harness. | **DONE** | Fully implemented, migrated, and verified by automated tests. |
| **M2** | **Identity & Organisation Foundation**: Auth/session/revocation, business switching, role matrix, branches, branch-owned departments, invitations foundation, memberships, Owner onboarding, transactional outbox & directory reconciliation. | **DONE** | Fully implemented, migrated, and verified by 62 automated tests. |
| **M3** | **Scheduling Core**: Staffing requirements (wall-clock), shifts (UTC), conflict engine, reasoned overrides, draft/review/publish, rostered manager roles, branch-scoped schedules, shift versioning, stale swap invalidation foundation. | **DONE** | Fully implemented, migrated, and verified by 71 automated tests. |
| **M4** | **Mobile/Offline & Notifications**: Read-only upcoming schedule cache, visible last-updated time, branch/business cache clearing, durable jobs, push/in-app notifications, deep links, retries. | **DONE** | Fully implemented, migrated, and verified by 79 automated tests. |
| **M5** | **Swaps, Attendance & Activity**: Same-branch swaps with version check, attendance history, scoped feed with 10k pagination tests. | **NEXT** | M4 complete. Shift versioning baseline ready. |
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
