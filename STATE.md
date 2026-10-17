# Rota: Project State & Workstream Tracker

## 1. Project Status Summary
- **Current Milestone**: **M6 — Simulated Billing and Subscription Lifecycle** (VERIFIED & COMPLETE).
- **Implementation Status**:
  - Local PostgreSQL 16 environment verified (`rota-postgres` container).
  - Schemas `rota_control`, `rota_shard_1`, and `rota_shard_2` provisioned with symmetrical tenant plane tables and control plane inbox.
  - Non-superuser application role `rota_app` provisioned without `SUPERUSER` or `BYPASSRLS`.
  - Migration 004 control (`payment_events` unique on `(provider, provider_event_id)`) applied.
  - Migration 006 tenant (`subscriptions` lifecycle extensions, `billing_quotes`, `payment_intents`, `ledger_entries`) applied across both shards with forced RLS and composite foreign keys.
  - Database trigger `trg_immutable_ledger` strictly prevents any direct `UPDATE` or `DELETE` on financial ledger entries (`C-08`, `BR-010`, `AC-013`).
  - Server-authoritative proration calculations implemented with integer arithmetic, passing all 16 proration test vectors `PR-01` through `PR-16` (`AC-009`).
  - Deterministic FX rate fixtures (`cbn_indicative_fixture`) implemented with 30-minute freshness validation, rejecting stale rates or outages with 503 (`AC-FX-01`..`06`).
  - Visibly labelled `SimulatedPaymentProvider` (`D-25`, `AC-BILL-01`) with raw-body HMAC-SHA256 signature verification (`AC-010`), durable inboxing, and deduplication (`BILL-007`).
  - Subscription lifecycle implemented: `active`, `past_due` (7-day grace period), `restricted` mode (`BILL-030`, blocks shifts/swaps/attendance/memberships mutations, preserves schedule reads and Owner renewal), and recovery.
  - Plan upgrades, scheduled downgrades, seat additions, seat reductions, and admission limit checks (`BILL-009`, `BILL-021`, `PR-12`, `PR-13`) implemented and tested.
  - Mobile Expo integration: `BillingScreen.tsx` connected to backend billing endpoints with plan selector, currency toggle, extra seat counter, server quote generation, simulated checkout, and append-only ledger display.
  - Automated test suite passing: 127 tests across 24 suites in ~50s (including 17 proration tests, 11 end-to-end billing lifecycle tests, 99 M1–M5 tests).
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
| **M5** | **Swaps, Attendance & Activity**: Same-branch swaps with version check, attendance history, scoped feed with 10k pagination tests. | **DONE** | Fully implemented, migrated, and verified by 99 automated tests. |
| **M6** | **Simulated Billing**: Server quotes, deterministic FX fixtures, Owner confirmation, proration (`PR-01`–`16`), immutable ledger, payment-intent state machine, idempotency, renewal/grace/restricted-mode tests. | **DONE** | Fully implemented, migrated, and verified by 127 automated tests. |
| **M7** | **Live Billing Integration (Conditional)**: Real Paystack/Flutterwave integration only if G-01 and FX-01 are formally closed; otherwise document simulator boundary. | **NEXT** | Gate G-01, Gate FX-01. |
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
