# Rota: Multi-Tenant Team Scheduling SaaS — Graduation Submission Document

**Candidate / Repository:** `Mobile-Apps/Rota App`  
**Submission Date:** 19 October 2026  
**Degree / Milestone:** Graduation Capstone Project  
**Component Scope:** Mobile Application (React Native / Expo SDK 57) & Multi-Tenant Scheduling Backend (Express 5 / Node.js 24 / PostgreSQL 18)

---

## 1. Project Purpose & Scope

Rota is an enterprise-grade, multi-tenant workforce management platform designed for shift-based businesses (retail, hospitality, logistics, healthcare). It solves the operational challenge of complex shift scheduling, role-based delegation, daylight-saving wall-clock integrity, peer shift-swapping, and multi-currency subscription billing.

### Architectural Core Invariants
- **Multi-Tenant Logical Sharding:** Operational data is deterministically partitioned across two logical PostgreSQL shards (`rota_shard_1`, `rota_shard_2`) using `SHA-256(business_id) % 2`. Global identities and sessions reside in an unsharded control plane (`rota_control`).
- **Database-Enforced Security:** Zero reliance on developer memory for tenant isolation. Every tenant table enforces PostgreSQL `FORCE ROW LEVEL SECURITY` executed strictly under the non-superuser role `rota_app` (`NOSUPERUSER NOBYPASSRLS`).
- **Offline Resilience:** Non-sensitive 14-day schedule caching partitioned by business and user in mobile `AsyncStorage`. Cryptographic access/refresh tokens are isolated in hardware-backed `expo-secure-store` on iOS Keychain and Android Keystore (`AC-AUTH-07`).

---

## 2. System Architecture & Evidence Documents

Detailed architectural design records, threat matrices, and product specifications are linked below:

| Artifact | File Reference | Summary |
|---|---|---|
| **Product Requirements (PRD)** | [PRD.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/PRD.md) | Authoritative requirements document (v0.3), user stories, acceptance criteria, and constraints |
| **System Architecture** | [ARCHITECTURE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/ARCHITECTURE.md) | High-level data plane separation, technology stack decisions, and request lifecycle |
| **Security & Threat Matrix** | [SECURITY.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/SECURITY.md) | Threat modeling, cryptographic hygiene (Argon2id, HS256 JWT, SHA-256 tokens), RLS policies |
| **Logical Sharding Architecture** | [SHARDING.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/SHARDING.md) | Deterministic shard routing algorithms, composite foreign key design, and fail-closed context |
| **Empirical Release Evidence** | [docs/reports/RELEASE-EVIDENCE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/docs/reports/RELEASE-EVIDENCE.md) | 200-VU load test logs, EXPLAIN ANALYZE execution plans, pool exhaustion failure drills |
| **Load Test Report** | [load-tests/RESULTS.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/load-tests/RESULTS.md) | 200-VU activity feed load test comparing direct PostgreSQL vs Redis caching |
| **Design System (Code-First)** | [docs/design-system/DESIGN-SYSTEM.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/docs/design-system/DESIGN-SYSTEM.md) | Design tokens (navy/teal palette), semantic tokens, typography, radii, and component catalog |
| **Architectural Decision Records** | [docs/decisions/](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/docs/decisions/) | 8 formal decision records (DR-01 through DR-08) covering HTTP, queueing, storage, and mobile UX |

---

## 2.1 Mandatory Graduation Deliverables Status (Mobile Task A)

| # | Mandatory Deliverable | Implementation / Evidence Location | Verification Status | Notes / Blocker |
|---|---|---|:---:|---|
| **1** | **Public GitHub repository** | Repository root (Branch `master`) | **PENDING USER ACTION** | Codebase cleaned and secured locally. Remote creation and push require human GitHub credentials. |
| **2** | **Downloadable Android development build** | Expo EAS Build `0115b4d4-bfeb-4da0-bcfc-a39b6055664d` | **PASS (VERIFIED)** | [Download APK](https://expo.dev/artifacts/eas/DuAGBQlTtWP18pSd7rHuAvZegMeZpFsSgLC58QqUpDI.apk) (Built with debug keystore matching Google Sign-In). |
| **3** | **Deployed backend** | `src/index.ts`, `docker-compose.yml` | **BLOCKED (₦0/NO-CARD)** | Local multi-database & Redis backend fully verified on `0.0.0.0:3000`. Cloud PaaS blocked by strict ₦0/no-card requirement; Cloudflare Tunnel ready for temporary HTTPS access. |
| **4** | **`README.md`** | [README.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/README.md) | **PASS (VERIFIED)** | Comprehensive project overview, installation, testing, and operations guide. |
| **5** | **`ARCHITECTURE.md`** | [ARCHITECTURE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/ARCHITECTURE.md) | **PASS (VERIFIED)** | Full technology stack, logical sharding, and threat mitigation architecture. |
| **6** | **`STATE.md`** | [STATE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/STATE.md) | **PASS (VERIFIED)** | Project progress, verified milestones M1 through M8, and release readiness. |
| **7** | **`SECURITY.md`** | [SECURITY.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/SECURITY.md) | **PASS (VERIFIED)** | Argon2id, JWT HS256, token family rotation, fail-closed tenant RLS policies. |
| **8** | **`SHARDING.md`** | [SHARDING.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/SHARDING.md) | **PASS (VERIFIED)** | Two physical shards, SHA-256 routing, large-team indexing/keyset pagination, cross-shard mitigation, and shard key trade-offs. |
| **9** | **`LEARNING-LOG.md`** | [LEARNING-LOG.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/LEARNING-LOG.md) | **PASS (VERIFIED)** | 22 detailed engineering incident reflections and lessons learned. |
| **10** | **Architecture diagram** | Mermaid diagrams in [ARCHITECTURE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/ARCHITECTURE.md) & [SHARDING.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/SHARDING.md) | **PASS (VERIFIED)** | Visual data plane separation, connection pooling, and request dispatch diagrams. |
| **11** | **Test evidence (Permissions, Isolation, Proration)** | `tests/auth/`, `tests/tenancy/`, `tests/billing/` | **PASS (VERIFIED)** | 54/54 passing tests across permissions, RLS under `rota_app` (`NOBYPASSRLS`), and PR-01..16 proration. |
| **12** | **Load test report** | [load-tests/RESULTS.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/load-tests/RESULTS.md) & [RELEASE-EVIDENCE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/docs/reports/RELEASE-EVIDENCE.md) | **PASS (VERIFIED)** | 200 VUs benchmark: 1.97x throughput gain (31.92 -> 63.03 req/s), 56.8% p50 latency reduction with Redis caching. |
| **13** | **Three-minute demonstration video** | [docs/Rota app demo video.mp4](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/docs/Rota%20app%20demo%20video.mp4) | **PASS (VERIFIED)** | Exact duration: 2m 53.1s (173.10s), 576x1200, H.264/AAC, demonstrates schedule creation, activity feed, settings sync, Paystack billing, dark mode, and offline swaps. |
| **14** | **LinkedIn engineering-decision post** | Draft prepared below; pending user post | **PENDING USER ACTION** | Post explaining *Why Rota Enforces Tenant Isolation via Database-Level Forced RLS & Transaction-Scoped Context (`SET LOCAL app.current_business_id`)* ready for user copy-paste. |
| **15** | **Working evidence links recorded in `SUBMISSION.md`** | [SUBMISSION.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/SUBMISSION.md) | **PARTIAL** | All local file references and EAS APK links verified; external GitHub & LinkedIn URLs pending user publication. |


---

## 3. Database Architecture & Schema Layout

The relational schema is divided into three distinct PostgreSQL schemas:

### A. Control Plane Schema (`rota_control`)
- `users`: Global identities, email verification, Argon2id password hashes (`FR-AUTH-001`).
- `sessions`: Active device sessions, 90-day absolute expiration cap, revocation tracking (`FR-AUTH-005`).
- `refresh_tokens`: SHA-256 hashed rotation tokens with family reuse detection (`FR-AUTH-004`, `SEC-020`).
- `membership_directory`: Synchronized read-only directory populated via outbox to list businesses at login without cross-shard joins (`AC-TEN-07`).
- `push_tokens`: Device push notification tokens (`FR-NOT-002`).

### B. Logical Shards (`rota_shard_1`, `rota_shard_2`)
- `businesses`, `branches`, `departments`: Core organization hierarchy.
- `memberships`: Role-based member assignments (`owner`, `co_owner`, `gm`, `supervisor`, `staff`).
- `membership_outbox`: Transactional outbox table ensuring eventual consistency between shard mutations and control directory.
- `shifts`, `shift_assignments`: Schedule instances with timezone metadata, monotonic versioning, and availability override audit details.
- `swap_requests`: Peer shift-swap state machine records.
- `attendance_records`: Manager-verified clock-in and absence tracking.
- `inbox_items`: Tenant-partitioned in-app employee notification inbox.
- `subscriptions`, `billing_quotes`, `payment_intents`, `ledger_entries`: Billing state and append-only financial ledger.
- `activity_events`: Audit trail for timeline events and feed pagination.

---

## 4. Key Functional Capabilities & Role Hierarchy

### Role Permission Matrix

| Role | Business Onboarding | Invite Team Members | Change Member Roles | Delete / Transfer Org | Create / Edit Shifts | Publish Schedule | Record Attendance | Request Swaps | View Published Shifts |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Owner** | Yes | Yes (All roles) | Yes (All roles) | Yes | Yes | Yes | Yes | Yes | Yes |
| **Co-Owner** | No | Yes (GM, Sup, Staff) | Yes (GM, Sup, Staff) | No | Yes | Yes | Yes | Yes | Yes |
| **Manager (GM)** | No | Yes (Sup, Staff) | No | No | Yes | Yes | Yes | Yes | Yes |
| **Supervisor** | No | No | No | No | Yes (Override) | Yes | Yes | Yes | Yes |
| **Staff** | No | No | No | No | No | No | No | Yes | Yes (Assigned only) |

### Core Workflow Validations
- **Sole-Owner Protection (`CANNOT_REMOVE_LAST_OWNER`):** A business owner cannot be demoted or removed if they are the last active owner. Ownership transfer must occur first.
- **Sole-Owner Account Deletion Guard (`SOLE_OWNER_CANNOT_DELETE`):** An owner cannot delete their global identity while remaining sole owner of any active business.
- **Single-Department Assignment Constraint (`AC-DM-02`, `C-07`):** Staff members assigned to a department cannot be scheduled for shifts in another department without explicit branch/department reassignment.
- **Shift Assignment Role Hierarchy (`assignWorker` / `unassignWorker`):** Strict hierarchy enforcement ensures Supervisors cannot assign or unassign shifts to the Owner, Co-Owner, GM, or peer Supervisors. Supervisors may only assign shifts to Staff. The mobile UI filters ineligible assignees for clarity, and the backend strictly enforces the rule (HTTP 403 `FORBIDDEN`) preventing forged API requests from bypassing the hierarchy.
- **Availability Conflict & Override Audit:** Overlapping shifts trigger a 409 conflict. Supervisors and managers can record overrides by supplying a mandatory reason, which is permanently recorded in `audit_log`.

---

## 5. Billing & Financial Integrity (Paystack Test Mode & Proration Engine)

Rota implements subscription billing with rigorous mathematical modeling and real payment provider integration in test mode:
- **Authoritative Proration Engine:** Evaluates exact billing cycle lengths (28, 29, 30, 31 days) with `Africa/Lagos` anchor preservation (`PR-01` through `PR-16`).
- **Paystack Hosted Checkout & Server-Side Verification:** Replaced the simulated-only checkout with Paystack hosted checkout in test mode (`provider: 'paystack'`). The backend creates a persistent payment intent (`rotapay_...`), opens Paystack's hosted payment page, and verifies transactions server-side using Paystack's official API (`GET /transaction/verify/:reference`) without trusting client redirects.
- **HMAC-SHA512 Raw-Body Webhooks:** Webhook events (`charge.success`) are verified using constant-time HMAC-SHA512 (`x-paystack-signature`) against raw request buffers with replay and duplicate event rejection (`payment_events` unique constraint).
- **Fallback Simulation for Isolated Testing:** The simulated provider adapter remains available (`provider: 'simulated'`) for deterministic test-suite execution.
- **Deterministic FX Fixtures:** Base prices are defined in USD minor units (Starter: $20/mo, Team: $50/mo + $3/seat, Business: $120/mo + $2/seat). Conversion to Nigerian Naira (NGN kobo) uses a CBN indicative rate fixture (`1,550.0 NGN/USD`) with a strict 30-minute staleness rejection threshold (`AC-FX-03`).
- **Append-Only Financial Ledger:** Subscription entitlements (plan and seat count) are updated only when verified payment conditions are met, replaying immutable `ledger_entries` records ordered by monotonic sequence number `seq`.

---

## 6. Verification Commands & Empirical Results

All checks and test suites were executed directly against the repository code and a live PostgreSQL 18 instance:

| Verification Suite | Exact Command | Exit Code | Tests / Modules | Result / Outcome |
|---|---|:---:|:---:|---|
| **Backend Typecheck** | `npm.cmd run typecheck` | `0` | Full backend tree | **PASS:** 0 TypeScript compilation errors. |
| **Mobile Typecheck** | `npm.cmd run typecheck` (in `mobile/`) | `0` | Full mobile tree | **PASS:** 0 TypeScript compilation errors. |
| **Expo Doctor** | `npx.cmd expo-doctor` (in `mobile/`) | `0` | 21 checks | **PASS:** 21/21 checks passed. No version conflicts. |
| **Expo Dependencies** | `npx.cmd expo install --check` | `0` | Expo SDK 57 | **PASS:** All dependencies up to date. |
| **Android Bundle Export** | `npx.cmd expo export --platform android` | `0` | 934 modules | **PASS:** Metro bundled in 14.6s; bytecode bundle `App-*.hbc` (2.5MB) emitted to `dist/`. |
| **Unit Tests (M6 & Sharding)** | `node --test tests/config.test.ts tests/billing/proration.test.ts tests/sharding/shard-router.test.ts` | `0` | 31 tests | **PASS:** 16/16 proration invariant tests passed; 10/10 sharding tests passed. |
| **Auth & Team Lifecycle Tests** | `node --test tests/auth/auth.test.ts tests/organization/team-management.test.ts` | `0` | 19 tests | **PASS:** Argon2id hashing, token rotation, sole-owner demotion guards passed. |
| **Onboarding & Scheduling Tests** | `node --test tests/organization/onboarding.test.ts tests/organization/switching.test.ts tests/scheduling/scheduling.test.ts` | `0` | 18 tests | **PASS:** Multi-tenant isolation, DST wall-clock preservation, single-department rule passed. |
| **Shift Assignment Hierarchy Tests** | `node --test tests/scheduling/assignment-hierarchy.test.ts` | `0` | 7 tests | **PASS:** Supervisor -> Staff allowed, Supervisor -> Owner/higher/peer forbidden (403), Owner-authorized assignments passed. |
| **Paystack Integration & Security Tests** | `node --test --experimental-strip-types tests/billing/paystack-integration.test.ts` | `0` | 9 tests | **PASS:** Successful payment, failed/pending states, currency/amount mismatch, HMAC-SHA512 verification, idempotency, concurrent webhooks, forged redirect rejection, quote expiry, tenant isolation. |
| **End-to-End Operational Suites** | `node --test tests/billing/billing-lifecycle.test.ts tests/notifications/notifications.test.ts tests/swaps/swaps.test.ts tests/attendance/attendance.test.ts tests/activity/activity-feed.test.ts tests/tenancy/isolation.test.ts tests/health.test.ts tests/mobile/offline-flow.test.ts` | `0` | 66 tests | **PASS:** 10,000-event cursor pagination, RLS isolation (`NOBYPASSRLS`), webhook idempotency passed. |
| **Mobile Connectivity Recovery** | `node --test tests/mobile/connectivity-recovery.test.ts` | `0` | 5 tests | **PASS:** Real-time online/offline transition, network vs backend differentiation, AppState recovery, unsubscription cleanup passed. |
| **Full Regression Suite** | `npm test` | `0` | 157 tests | **PASS:** 157/157 passing tests across 28 test suites (0 failures). |
| **Health Check Endpoint** | HTTP GET `http://localhost:3000/health` & `http://172.20.10.13:3000/health` | `200` | Local & LAN IP | **PASS:** `{"status":"ok","checks":{"server":"healthy","database":"connected"}}`. |

---

## 7. Performance & Resilience Benchmarks (From `RELEASE-EVIDENCE.md`)

Empirical measurements conducted directly against PostgreSQL 16/18 and documented in [RELEASE-EVIDENCE.md](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/docs/reports/RELEASE-EVIDENCE.md):

1. **200 Virtual User Redis Activity Feed Benchmark (`scripts/benchmark-activity-feed-redis.ts`):**
   - **Methodology:** 200 concurrent Virtual Users issuing real HTTP `GET /v1/activity?limit=20` requests over loopback TCP to the live Express server with full JWT authentication, authorization, and tenant isolation.
   - **Uncached Baseline (Direct PostgreSQL):** 31.92 req/sec, p50 latency 5,023.71ms, p95 latency 5,983.38ms, 0% errors across 200 requests.
   - **Cached (Tenant-Partitioned Redis):** 63.03 req/sec (**1.97x throughput gain**), p50 latency 2,172.54ms (**56.8% reduction**), p95 latency 3,004.92ms (**49.8% reduction**), 0% errors across 200 requests.
   - **Write Invalidation Latency:** Shift mutation + cache purge took **41.61ms**, subsequent DB query miss took **51.43ms**, and next read hit Redis in **32.81ms**.
2. **200 Virtual User Shift Schedule Load Test (`AC-015`, `NFR-PERF-002`):**
   - **Uncached Baseline:** 67.50 req/sec, p95 latency 2,850.02ms, 0% error rate.
   - **Cached (Tenant-Partitioned Memory Cache):** 142.61 req/sec (**2.1x throughput gain**), p95 latency 1,340.68ms (**53.0% reduction**), 0% error rate across 400 requests.
   - **Write Invalidation Latency:** Shift mutation + cache purge took **46.42ms**.
3. **Database Query Execution Plans (`EXPLAIN ANALYZE`):**
   - **Activity Feed Keyset Cursor Pagination:** `Index Scan using idx_activity_events_feed` completed in **0.168ms** (3 shared buffer hits, zero sort overhead across 10,000 rows).
   - **Financial Ledger Entitlement Replay:** `Index Scan using idx_ledger_seq` completed in **0.111ms** (2 shared buffer hits).
4. **Connection Pool Saturation & Failure Drills (`scripts/pool-exhaustion-drill.ts`):**
   - 20 concurrent transactions dispatched against a 10-connection pool: 20 completed, 0 failed, max queued latency 671.63ms.
   - Zero Context Poisoning: Simulated crash under Tenant A left pooled connection clean (`app.current_business_id = ''`).
5. **Deterministic Shard Routing Stability:**
   - 1,000 random UUIDs evaluated: Shard 1 = 490 (49.0%), Shard 2 = 510 (51.0%). Route stability violations: 0 across 10,000 lookups.

---

## 8. Graduation Deliverables & Verification Status Matrix

| Graduation Requirement / Workstream | Implementation Artifact | Verification Level | Current Status |
|---|---|---|:---:|
| **Backend REST API & Sharding Router** | `src/`, `src/db/shard-router.ts` | Automated Integration Tests (Exit 0) | **VERIFIED** |
| **Row-Level Security & Tenant Isolation** | `src/db/tenant-context.ts`, RLS policies | Automated Security Suite (Exit 0) | **VERIFIED** |
| **Authentication, Sessions & Token Rotation** | `src/services/auth-service.ts`, `token-service.ts` | Automated Auth Suite (Exit 0) | **VERIFIED** |
| **Team Management, Roles & Safeguards** | `src/services/organization-service.ts` | Automated Team Suite (Exit 0) | **VERIFIED** |
| **Scheduling, DST & Availability Overrides** | `src/services/scheduling-service.ts` | Automated Scheduling Suite (Exit 0) | **VERIFIED** |
| **Shift Swaps & Manager Approval** | `src/services/swap-service.ts` | Automated Swaps Suite (Exit 0) | **VERIFIED** |
| **Attendance Verification & Absences** | `src/services/attendance-service.ts` | Automated Attendance Suite (Exit 0) | **VERIFIED** |
| **Billing Proration Engine (16 Invariants)** | `src/services/proration-engine.ts` | Authoritative Unit Tests (Exit 0) | **VERIFIED** |
| **Financial Ledger & Idempotent Webhooks** | `src/services/billing-service.ts` | Automated Billing Lifecycle (Exit 0) | **VERIFIED** |
| **Paystack Test Checkout & Return Verification** | `src/services/paystack-service.ts`, `BillingScreen.tsx` | Automated Paystack Suite (Exit 0) | **VERIFIED** |
| **Mobile Offline Cache (Non-Sensitive Shifts)** | `mobile/src/services/offline-cache.ts` | Automated Offline Flow Suite (Exit 0) | **VERIFIED** |
| **Mobile Token Storage in SecureStore** | `mobile/src/services/storage.ts` | Static AST Code Scan (Exit 0) | **VERIFIED** |
| **Android Production Hermes Bytecode Export** | `mobile/dist/` (Metro Bundler) | Automated Build Export (Exit 0) | **VERIFIED** |
| **Android Installable Development APK** | Expo EAS Build `0115b4d4-bfeb-4da0-bcfc-a39b6055664d` | [Download APK](https://expo.dev/artifacts/eas/DuAGBQlTtWP18pSd7rHuAvZegMeZpFsSgLC58QqUpDI.apk) | **VERIFIED (AVAILABLE)** |
| **Android Installable Preview APK** | Expo EAS Build `9daa1f08-14ba-4e58-be1c-ace90719e05b` | [Download APK](https://expo.dev/artifacts/eas/jxGQTA6V16YqHE3pAXkT65AgyQmX9YJA2OosdaAG0ds.apk) | **VERIFIED (AVAILABLE)** |
| **Design System Rollout (Navy & Teal)** | `mobile/src/theme/tokens.ts`, `components.tsx` | Static Code Audit & Mobile Typecheck (Exit 0) | **VERIFIED** |
| **In-App Notification Inbox & Feed** | `src/services/activity-service.ts` | Automated Activity Suite (Exit 0) | **VERIFIED** |
| **Redis Activity Feed Caching & Invalidation** | `src/services/activity-service.ts`, Redis 6379 | Automated 200-VU HTTP Benchmark & Lifecycle Tests | **VERIFIED** |
| **Settings Synchronization & Per-Field Merge** | `src/routes/settings.ts`, `SettingsScreen.tsx` | Automated Settings Suite (Exit 0) | **VERIFIED** |
| **Hardware Push Notifications (APNs / FCM)** | Not installed in mobile client | Architectural Scope Analysis | **NOT IMPLEMENTED (In-App Only)** |
| **Physical iPhone Dev Server Connectivity** | Local LAN bind `0.0.0.0:3000` | Host Network Handshake (HTTP 200) | **IMPLEMENTED, AWAITING PHYSICAL DEVICE** |
| **Job Preparation Workstream** | Outside repository (`Job-preparation/`) | Separate Workspace | **OUTSIDE ROTA SCOPE** |
| **Matinee Cinema Booking App** | Outside repository (`Mobile-Apps/Matinee App/`) | Separate Workspace | **OUTSIDE ROTA SCOPE** |
| **RAG Pipeline & Evaluation Project** | Outside repository (`RAG-Project/`) | Separate Workspace | **OUTSIDE ROTA SCOPE** |
| **Independent System Design Repository** | Outside repository (`System-Design/`) | Separate Workspace | **OUTSIDE ROTA SCOPE** |

---

## 9. Known Limitations & Demonstration Guidance

1. **Native Push Notifications:** Rota delivers notifications to the user's in-app inbox (`inbox_items`) and records mock push delivery records in `notification_deliveries`. Hardware push banners via APNs / FCM are not implemented because `expo-notifications` is omitted from the mobile client.
2. **Payment Processing:** Integrated with Paystack in **Test Mode** (`sk_test_*` credentials and test cards). Live charges are strictly forbidden. The simulated provider adapter (`sim_ref_*`) is retained for isolated unit testing.
3. **FX Rates:** Currency conversions between USD and NGN use a static indicative fixture (`1,550 NGN/USD`) with freshness validation, not a live financial market feed.
4. **Physical Device Wi-Fi Connectivity:**
   - The backend runs on `0.0.0.0:3000`.
   - The host machine Wi-Fi IP is `172.20.10.13` (connected via iPhone Personal Hotspot).
   - If the iPhone connects to a different network, `EXPO_PUBLIC_API_URL` in `mobile/.env` must be updated to match the new host IP.

---

## 10. Manual Instructions for Physical iPhone Demonstration

To execute the live demonstration on an iPhone:

### Terminal 1: Backend Server (Must remain open)
```powershell
cd "C:\Users\HomePC\Desktop\Graduation Project\Mobile-Apps\Rota App"
node --experimental-strip-types src/index.ts
```
*Expected Output:* `[Rota Backend] Server running in development mode on 0.0.0.0:3000`

### Terminal 2: Expo Mobile Dev Server (Must remain open)
```powershell
cd "C:\Users\HomePC\Desktop\Graduation Project\Mobile-Apps\Rota App\mobile"
npx expo start --lan
```
*Action:* Open the camera on the iPhone, scan the QR code displayed in the terminal, and open in **Expo Go**.

### Step-by-Step Device Flow:
1. **Pre-Flight:** Open Safari on the iPhone and browse to `http://172.20.10.13:3000/health`. Confirm `{"status":"ok"}` displays.
2. **Launch:** Open Expo Go; log in or tap **Create an Account**.
3. **Onboard:** Register an organization (`Lagos Central Branch`, Timezone `Africa/Lagos`).
4. **Schedule:** Create a shift (09:00 - 17:00), assign staff, and tap **Publish**.
5. **Offline Test:** Enable **Airplane Mode** on the iPhone and pull down to refresh in Schedule. Observe the amber `Viewing Offline Schedule (Cached: ...)` banner appear with read-only shifts intact. Disable Airplane Mode and observe live recovery.
6. **Billing (Paystack Test Checkout):** Navigate to Settings -> Manage Subscription. Select Team or Business plan. Tap **Calculate Quote & Proceed to Paystack**. Tap **Confirm & Pay (Paystack Test Mode)**. Safari opens Paystack's hosted checkout. Enter a Paystack test card (e.g. `4084 0840 8408 4081`, any future expiry, any 3-digit CVV, PIN `1111`, OTP `123456`). When payment completes, return to Rota and tap **Verify Payment Status**. The backend verifies Paystack's API server-to-server and updates the subscription plan, seat limit, and append-only ledger.
7. **Logout:** Navigate to Settings, tap **Log Out**, and confirm all hardware-backed credentials and offline caches are purged.
