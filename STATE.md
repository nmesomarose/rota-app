# Rota: Project State & Workstream Tracker

## 1. Project Status Summary
- **Current Milestone**: **M8 — Performance, Resilience and Release Evidence** (VERIFIED & COMPLETE).
- **Implementation Status**:
  - Local PostgreSQL 16 multi-schema environment verified (`rota_control`, `rota_shard_1`, `rota_shard_2`).
  - Restricted `rota_app` role verified with `FORCE ROW LEVEL SECURITY` across all tenant plane tables.
  - 200-virtual-user load test verified (`AC-015`, `NFR-PERF-002`): 142.61 req/sec cached, 0% errors across 400 requests.
  - Tenant-scoped caching with write-through invalidation (`cacheService`) verified: 2.1x throughput gain, 53.0% p95 latency reduction.
  - Real PostgreSQL query plans (`EXPLAIN ANALYZE`) documented for shifts aggregation, activity feed cursor pagination (0.17ms), and financial ledger replay (0.11ms).
  - Connection pool failure drills (`scripts/pool-exhaustion-drill.ts`) verified: pool saturation queuing (20/20 completed), clean error rollbacks, strict connection timeouts, and zero tenant context leakage (`AC-TEN-04`).
  - Logical shard distribution (`scripts/verify-sharding-distribution.ts`) verified on 1,000 UUIDs: 49.0% Shard 1 / 51.0% Shard 2 with 100% route stability (`AC-SH-01`, `AC-SH-02`).
  - NDPA 2023 compliance analysis and data retention / deletion pipeline documented.
  - Full automated backend test suite passing: 127 tests across 24 suites in ~50s.
  - Sharding test suite passing: 10 tests across 5 suites.
  - TypeScript typecheck passing cleanly across backend (`tsc --noEmit`) and mobile (`tsc --noEmit`).
  - Expo Android export verified: 1.3MB JS bundle (`dist/`) generated with exit code 0.
  - Physical device testing explicitly disclosed as not performed on physical hardware.
  - Comprehensive report authored in `docs/reports/RELEASE-EVIDENCE.md`.
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
| **M5** | **Swaps, Attendance & Activity**: Same-branch swaps with version check, attendance history, scoped feed with 10k pagination tests. | **DONE** | Fully implemented, migrated, and verified by 99 automated tests. |
| **M6** | **Simulated Billing**: Server quotes, deterministic FX fixtures, Owner confirmation, proration (`PR-01`–`16`), immutable ledger, payment-intent state machine, idempotency, renewal/grace/restricted-mode tests. | **DONE** | Fully implemented, migrated, and verified by 127 automated tests. |
| **M7** | **Live Billing Integration (Conditional)**: Real Paystack/Flutterwave integration only if G-01 and FX-01 are formally closed; otherwise document simulator boundary. | **CONDITIONAL** | Gate G-01, Gate FX-01. |
| **M8** | **Performance, Resilience & Release Evidence**: 200-VU load test before/after caching, `EXPLAIN ANALYZE`, pool exhaustion/failure drills, sharding report, privacy/security docs, release evidence report. | **DONE** | All 9 scopes verified with empirical evidence in `docs/reports/RELEASE-EVIDENCE.md`. |

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
