# Rota: Project State & Workstream Tracker

## 1. Project Status Summary
- **Current Milestone**: **M1 — Tenant/Shard Proof Before Feature Work** (ACTIVE: Steps 1 & 2 Complete).
- **Implementation Status**: Local PostgreSQL 16 environment established (`rota-postgres` container). Schemas `rota_control`, `rota_shard_1`, and `rota_shard_2` created. Non-superuser application role `rota_app` provisioned without `BYPASSRLS`. Deterministic shard routing module implemented with pure SHA-256 hash modulo 2 logic; 10 unit/isolation tests passing (1,000-call stability `AC-SH-01`, 51.5%/48.5% distribution `AC-SH-02`).
- **PRD Version**: v0.3 (Draft, authoritative product decisions consolidated).

---

## 2. Milestone Sequencing & Progress (`PRD 18`, `19.9`)

| Milestone | Scope & Deliverables | Status | Blockers / Preconditions |
|---|---|---|---|
| **M0** | **Decisions & Feasibility**: Workspace specs, decision records `DR-01` to `DR-08`, architecture, security, and sharding documentation skeleton. | **DONE** | Decisions reviewed; working technical direction locked. |
| **M1** | **Tenant/Shard Proof Before Feature Work**: Control/tenant planes, 2 logical shards, transaction context (`SET LOCAL`), forced RLS, composite FKs, pool reuse safety, adversarial cross-tenant test harness. | **ACTIVE** | Steps 1 & 2 Complete. Step 3 (Initial migrations & schema drift check) queued. |
| **M2** | **Identity & Organisation Foundation**: Auth/session/revocation, business switching, branch switching, role matrix, branches, branch-owned departments, invitations, memberships, Owner protection, temporary suspension, transactional seat accounting. | QUEUED | M1 completion. Gate G-02 (Google OAuth optional). |
| **M3** | **Scheduling Core**: Staffing requirements (wall-clock), shifts (UTC), conflict engine, reasoned overrides, draft/review/publish, rostered manager roles, branch-scoped schedules, shift versioning, stale swap invalidation. | QUEUED | M2 completion. |
| **M4** | **Mobile/Offline & Notifications**: Read-only upcoming schedule cache, visible last-updated time, branch/business cache clearing, durable jobs, push/in-app notifications, deep links, retries. | QUEUED | M3 completion. Expo dev build setup. |
| **M5** | **Swaps, Attendance & Activity**: Same-branch swaps with version check, attendance history, scoped feed with 10k pagination tests. | QUEUED | M4 completion. |
| **M6** | **Simulated Billing**: Server quotes, deterministic FX fixtures, Owner confirmation, proration (`PR-01`–`16`), immutable ledger, payment-intent state machine, idempotency, renewal/grace/restricted-mode tests. | QUEUED | M5 completion. Gate G-01 unverified provider remains simulated (`D-25`). |
| **M7** | **Live Billing Integration (Conditional)**: Real Paystack/Flutterwave integration only if G-01 and FX-01 are formally closed; otherwise document simulator boundary. | BLOCKED | Gate G-01, Gate FX-01. |
| **M8** | **Performance, Resilience & Release Evidence**: 200-VU load test before/after caching, `EXPLAIN ANALYZE`, pool exhaustion/failure drills, sharding report, privacy/security docs, demo. | QUEUED | M6/M7 completion. Gate G-03 (NDPA review). |

---

## 3. Decision Gates & Blockers Tracking (`PRD 17.2`, `19.8`)

| Gate | Title | Current Status | Impact / Scope Blocked |
|---|---|---|---|
| **G-01** | **Payment Provider & Currencies** | `UNVERIFIED` | Real payment gateway integration blocked. M7 proceeds using `SimulatedPaymentProvider` (`D-25`). |
| **FX-01** | **Live Exchange-Rate Source** | `UNVERIFIED` | Chargeable live NGN quotes blocked. Automated tests use deterministic labelled test fixtures (`AC-FX-06`). |
| **G-02** | **Google OAuth Credentials** | `UNVERIFIED` | Native Google Sign-in blocked. Email/password authentication is the approved V1 baseline. |
| **G-03** | **NDPA Privacy & Retention Review** | `UNVERIFIED` | Production launch data retention schedule blocked. Erasure pipelines pseudonymize personal data without deleting financial ledgers. |
| **OQ-012** | **Maximum Seat Ceilings** | `OPEN` | Enforcing seat limits beyond plan included/additional pricing rules remains unconfigured. |
| **OQ-023** | **Restricted Mode Staff Actions** | `PARTIALLY RESOLVED` | Staff can view published shifts and sync settings; all other mutations are blocked (`BILL-030`). |

---

## 4. Current Workstream Action Items
1. **Milestone M1 Step 1 (COMPLETED)**:
   - Verified Docker availability and PostgreSQL port.
   - Initialized `.gitignore`, `.env.example`, `.env`, and `docker-compose.yml`.
   - Provisioned `rota-postgres` PostgreSQL 16 container.
   - Initialized schemas: `rota_control`, `rota_shard_1`, `rota_shard_2`.
   - Provisioned non-superuser application role `rota_app` without `BYPASSRLS`.
2. **Milestone M1 Step 2 (COMPLETED)**:
   - Implemented deterministic shard router in `src/sharding/shard-router.ts`.
   - Pure function using SHA-256 hash % 2, with strict UUID format validation.
   - Verified 1,000-iteration route stability (`AC-SH-01`: 100% stable).
   - Verified distribution over 1,000 random UUIDs (`AC-SH-02`: 51.5% Shard 1, 48.5% Shard 2).
   - 10 automated unit/isolation tests passing with zero failures.
3. **Milestone M1 Step 3 (COMPLETED)**:
   - Verified local PostgreSQL 16 environment and confirmed schemas `rota_control`, `rota_shard_1`, `rota_shard_2` and non-superuser role `rota_app`.
   - Wired migration runner (`scripts/migrate.ts`) using `node-pg-migrate` across `rota_control`, `rota_shard_1`, and `rota_shard_2`.
4. **Scaffolding Foundation (COMPLETED)**:
   - Established minimal coherent layout covering Express backend (`src/`), Expo mobile app (`mobile/`), and migrations (`migrations/`).
   - Implemented environment variable parsing & validation with Zod (`src/config/env.ts`) and protected `.env.example`.
   - Created Express 5 app factory (`src/app.ts`), server entry point (`src/index.ts`), and health check router (`src/routes/health.ts`).
   - Built Kysely + `pg` connection pools for control and shard schemas with live connection check and safe cleanup (`src/db/connection.ts`).
   - Extended `.gitignore` to protect mobile build artifacts, keystores, and credentials.
   - Scaffolded Expo SDK 58 mobile app with React Navigation 7 (`RootNavigator` with `AuthStack` and `MainTabs` per `DR-08`).
   - Documented setup and verification in `README.md`.
   - All 16 automated backend tests passing across 7 test suites (10 shard router, 4 config, 2 health check). TypeScript typecheck passing with 0 errors.


