# Rota: Mobile-First Workforce Scheduling and Team Management Platform

Rota is a multi-tenant, mobile-first workforce scheduling and team operations platform built for organizations with shift-based operations, including retail stores, healthcare clinics, hospitality venues, and logistics centers.

The platform provides role-scoped schedule planning, conflict detection, structured shift swaps, attendance tracking, activity audit trails, and subscription billing with mathematical proration. Rota enforces strict multi-tenant boundary isolation at the database level and provides resilient offline mobile support.

---

## Key Features

### Shift Scheduling and Availability
- Conflict-Aware Scheduling: Automatically flags overlapping shift assignments and double-booked staff members.
- Wall-Clock Timezone Preservation: Maintains consistent shift start and end times across daylight saving time transitions.
- Quick Shift Presets: Standardized shift creation templates for day, evening, and custom operational windows.
- Availability Overrides: Supervisors can override worker availability by supplying a mandatory, permanently audited reason.
- Publishing Workflow: Schedules transition from draft state to published state, with real-time mobile updates.

### Structured Shift Swaps
- Peer-to-Peer Requests: Staff members can initiate shift swaps directly with eligible coworkers.
- Manager Approval Workflow: Swaps transition through pending peer, peer accepted, and manager approved states before updating the active schedule.
- Conflict Prevention: The system validates that both swapping workers remain free from schedule conflicts prior to final approval.

### Team and Role Management
- Multi-Tier Role Hierarchy: Granular permissions for Owner, Co-Owner, General Manager, Supervisor, and Staff.
- Organizational Scoping: Branches and departments isolate operational teams within a single business account.
- Single-Department Assignment Guard: Staff assigned to one department cannot be scheduled in another department without explicit reassignment.
- Ownership Protection: Prevents demoting or deleting the final active owner of an organization.

### Attendance and Clock-In Verification
- Real-Time Attendance Tracking: Managers record and verify worker clock-in and absence states.
- Audited Exceptions: Lateness and unverified absences require supervisory notes recorded in the permanent audit trail.

### Activity Feed and Notification Inbox
- Keyset Cursor Pagination: Event timelines load in constant time using deterministic cursor pagination based on timestamps and unique IDs.
- Role-Scoped Visibility: Owners view full business timelines, while supervisors and staff receive visibility strictly limited to their relevant departments and shifts.
- In-App Inbox: System alerts, schedule publications, and swap notifications arrive in a dedicated mobile inbox.

### Subscription Billing and Proration
- Mathematical Proration Engine: Evaluates exact billing cycle lengths (28, 29, 30, and 31 days) anchored to company timezones across 16 formal invariant test cases.
- Tiered Plans: Starter (fixed seats), Team (base price plus seat add-ons), and Business (higher base capacity plus seat add-ons).
- Paystack Test Checkout: Generates verified payment sessions in Nigerian Naira (NGN) using official test credentials and server-side verification.
- Append-Only Financial Ledger: Entitlements update only upon verified transaction confirmation, replaying immutable ledger entries ordered by monotonic sequence numbers.

### Device Synchronization and Offline Working
- Conflict Resolution: Settings synchronize across multiple devices using server timestamps and per-field merge logic.
- Quiet Hours Enforcement: Notification delivery automatically respects user-configured local quiet hours.
- Offline Schedule Cache: Non-sensitive 14-day schedule data is securely cached on the mobile device, allowing workers to review upcoming shifts during network outages.
- Optimistic Updates with Rollback: Mobile state updates immediately and rolls back cleanly if the server rejects a change.

### Secure Authentication
- Password Security: Password hashing implemented with Argon2id.
- Session Management: Cryptographic JWT access tokens paired with SHA-256 hashed refresh tokens.
- Token Family Rotation: Detects refresh token reuse and immediately revokes the compromised session family.
- Hardware-Backed Storage: Mobile tokens reside in iOS Keychain and Android Keystore via Expo SecureStore.
- Google OAuth Integration: Mobile Google Sign-In with server-side token validation.

---

## Technology Stack

### Mobile Application
- Framework: React Native with Expo (SDK 57)
- Language: TypeScript
- Navigation: React Navigation (Bottom Tabs, Stack Navigator, Drawer)
- Server State: TanStack Query (React Query) with tenant-scoped query cache keys
- Local Storage: Expo SecureStore (cryptographic tokens), React Native AsyncStorage (offline schedule cache)
- Iconography: Ionicons via `@expo/vector-icons`

### Backend Services
- Runtime: Node.js (v24 LTS or v22.6.0+) with native TypeScript type stripping (`--experimental-strip-types`)
- Web Framework: Express 5
- Schema Validation: Zod
- Asynchronous Processing: Redis-backed worker queues for notification dispatch and sweeper tasks

### Data and Storage
- Database: PostgreSQL 16 (LTS) with dedicated connection pooling (`pg`)
- Multi-Tenant Sharding: Two physically separate tenant shard databases plus one unsharded control database
- Cache Store: Redis 7 (`ioredis`) for query caching, distributed rate limiting, and queue locking
- Database Migrations: `node-pg-migrate` across control and tenant schemas

---

## System Architecture

Rota separates global control-plane responsibilities from tenant-plane operational data.

```mermaid
graph TD
    Client["React Native Mobile App (iOS / Android)"]
    API["Express 5 REST API Server (Stateless)"]
    Worker["Background Queue Worker (Daemon)"]
    Redis["Redis 7 (Cache, Rate Limits, Job Queues)"]
    
    subgraph DataPlane ["Database Tier (PostgreSQL 16 LTS)"]
        ControlDB["Control Database (rota)<br/>• Users & Sessions<br/>• Global Membership Directory<br/>• Push Tokens"]
        Shard1["Tenant Shard 1 (rota_shard_1)<br/>• Schedules & Shifts<br/>• Memberships & Roles<br/>• Financial Ledger"]
        Shard2["Tenant Shard 2 (rota_shard_2)<br/>• Schedules & Shifts<br/>• Memberships & Roles<br/>• Financial Ledger"]
    end

    Client -->|HTTPS REST with JWT| API
    API -->|Read / Write Global Data| ControlDB
    API -->|SHA-256 Shard 1 Route| Shard1
    API -->|SHA-256 Shard 2 Route| Shard2
    API -->|Cache Get / Put / Invalidate| Redis
    API -->|Enqueue Tasks| Redis
    Redis -->|Dequeue Jobs| Worker
    Worker -->|Execute Background Tasks| ControlDB
    Worker -->|Update Tenant Data| Shard1
    Worker -->|Update Tenant Data| Shard2
```

### Architectural Components
1. Control Plane (`rota`): Stores global user accounts, password hashes, active sessions, mobile push tokens, and the global membership directory.
2. Tenant Shard 1 (`rota_shard_1`): Dedicated physical PostgreSQL database storing organizations, branches, departments, memberships, shifts, swaps, attendance, and billing ledger entries for tenants routed to Shard 1.
3. Tenant Shard 2 (`rota_shard_2`): Symmetrical dedicated physical PostgreSQL database storing identical tenant structures for tenants routed to Shard 2.
4. Redis Cache and Queue: Provides sub-millisecond query responses, sliding-window rate limiting, and reliable queue processing.
5. Background Worker: Standalone process that executes scheduled maintenance, cleans expired tokens, and dispatches in-app notifications.

---

## Security Architecture

Multi-tenant security in Rota does not rely on developer memory or application-level filtering. Instead, isolation is enforced by the database engine:

1. Non-Superuser Execution: The application connects to PostgreSQL using the `rota_app` role, configured with `NOSUPERUSER` and `NOBYPASSRLS`.
2. Forced Row-Level Security: Every tenant table enforces PostgreSQL `FORCE ROW LEVEL SECURITY`. Queries cannot bypass tenant boundaries even if an application filter is omitted.
3. Transaction-Scoped Context: Requests execute within transactions parameterized by `SET LOCAL app.current_business_id = '<business_id>'`.
4. Pool Poisoning Defense: When connections return to the pool, session settings are explicitly cleared, preventing context leakage between requests.
5. Composite Foreign Keys: Relationships enforce compound keys (`business_id`, `id`) so child records cannot reference parent records belonging to a different tenant.

---

## Database Sharding Strategy

Operational tenant data is partitioned across two physically separate PostgreSQL databases using deterministic hash routing:

```typescript
import { createHash } from 'node:crypto';

export function getShardIdForBusiness(businessId: string): 'shard_1' | 'shard_2' {
  const normalized = businessId.trim().toLowerCase();
  const digest = createHash('sha256').update(normalized).digest();
  const numericValue = digest.readUInt32BE(0);
  return numericValue % 2 === 0 ? 'shard_1' : 'shard_2';
}
```

- Complete Request Isolation: All operational queries for an organization run entirely within its assigned shard database, avoiding distributed queries.
- Control-Plane Directory: A synchronized directory table in the control plane maps user memberships, allowing fast login without cross-shard broadcasts.
- For complete details on large-team indexing, keyset pagination, capacity limits, and trade-offs, refer to [SHARDING.md](SHARDING.md).

---

## Getting Started

### Prerequisites
- Node.js: `v24.21.0` LTS (or `v22.6.0+` with native TypeScript type stripping)
- Package Manager: `npm` (Use `npm.cmd` on Windows PowerShell if execution policies restrict script execution)
- Docker & Docker Compose: For PostgreSQL 16 and Redis 7 containers
- Mobile Tooling: Expo CLI (`npx expo`)

### 1. Repository Setup
Clone the repository and install root dependencies:
```bash
git clone https://github.com/<your-username>/rota-app.git
cd rota-app
npm install
```

Install mobile dependencies:
```bash
cd mobile
npm install
cd ..
```

### 2. Environment Configuration
Copy the sample environment file and configure local credentials:
```bash
cp .env.example .env
```
Key development settings in `.env`:
- `PORT=3000`
- `DATABASE_URL=postgresql://db_admin_user:admin_local_secret@localhost:5432/rota`
- `APP_DATABASE_URL=postgresql://rota_app:app_local_secret@localhost:5432/rota`
- `SHARD_1_DATABASE_URL=postgresql://db_admin_user:admin_local_secret@localhost:5432/rota_shard_1`
- `APP_SHARD_1_DATABASE_URL=postgresql://rota_app:app_local_secret@localhost:5432/rota_shard_1`
- `SHARD_2_DATABASE_URL=postgresql://db_admin_user:admin_local_secret@localhost:5432/rota_shard_2`
- `APP_SHARD_2_DATABASE_URL=postgresql://rota_app:app_local_secret@localhost:5432/rota_shard_2`
- `REDIS_URL=redis://localhost:6379`
- `JWT_SECRET=your_development_jwt_secret_32_characters_minimum`
- `REFRESH_TOKEN_SECRET=your_development_refresh_token_secret_32_chars`

### 3. Database Initialization and Migrations
Start the local PostgreSQL and Redis containers:
```bash
docker compose up -d
```

Run database initialization and migrations:
```bash
# 1. Initialize control schema and non-superuser application role
npm run db:init

# 2. Provision physical shard databases (rota_shard_1 and rota_shard_2)
npm run db:setup-shards

# 3. Apply declarative migrations across control and shard databases
npm run db:migrate
```

### 4. Running the Application Locally

Start the backend API server:
```bash
npm run dev
```
The API boots on `http://localhost:3000`. Test the health check endpoint:
```bash
curl http://localhost:3000/health
```

Start the background worker in a separate terminal:
```bash
npm run start:worker
```

Start the Expo mobile development server:
```bash
cd mobile
npm start
```

---

## Automated Testing and Verification

The repository contains extensive automated test suites covering unit logic, integration endpoints, security invariants, and mobile components.

### Test Commands
```bash
# Run complete test suite (450+ tests across 99 suites)
npm test

# Run deterministic shard router verification
npm run test:sharding

# Run backend TypeScript typecheck
npm run typecheck

# Run mobile TypeScript typecheck
cd mobile && npm run typecheck && cd ..

# Run mobile unit and integration tests
node --test tests/mobile/**/*.test.ts

# Run core tenancy and security tests
node --test tests/tenancy/isolation.test.ts

# Run billing proration invariant tests
node --test tests/billing/proration.test.ts
```

### Verified Test Results
- Full Test Suite: 450 passing tests across 99 test suites (0 failures).
- Sharding Stability: 10/10 tests passing. Over 1,000 UUIDs, routes maintained 100% stability with a balanced 52.2% to 47.8% distribution across shards.
- Mobile Suite: 143/143 tests passing across 39 suites covering offline flow, theme switching, session expiration, and swap cancellations.
- Proration Invariants: 16/16 mathematical invariant tests passing across varying month lengths and timezone anchors.
- Security Invariants: Zero tenant cross-read or cross-write leakage under the unprivileged `rota_app` role.

---

## Performance and Load Testing

A simulated 200 virtual user load test was executed directly against the authenticated activity feed endpoint (`GET /v1/activity?limit=20`) to measure the performance gain of tenant-partitioned Redis caching:

| Metric | Uncached Baseline (PostgreSQL) | Cached (Redis) | Empirical Gain |
|---|---|---|---|
| Throughput | 31.92 requests/second | 63.03 requests/second | 1.97x speedup (+97.5%) |
| Median Latency (p50) | 5,023.71 ms | 2,172.54 ms | 56.8% faster |
| 90th Percentile (p90) | 5,905.83 ms | 2,827.13 ms | 52.1% faster |
| 95th Percentile (p95) | 5,983.38 ms | 3,004.92 ms | 49.8% faster |
| 99th Percentile (p99) | 6,057.15 ms | 3,155.08 ms | 47.9% faster |
| Error Rate | 0.00% (0 / 200) | 0.00% (0 / 200) | Zero connection drops |

- Database Execution Plans: PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` confirms that composite index `idx_activity_events_feed` executes keyset pagination queries in 0.168 ms across 10,000 seeded events.
- Cache Invalidation: Write mutations trigger non-blocking prefix invalidation, completing in 41.61 ms.
- Complete documentation and methodology are recorded in [load-tests/RESULTS.md](load-tests/RESULTS.md) and [docs/reports/RELEASE-EVIDENCE.md](docs/reports/RELEASE-EVIDENCE.md).

---

## Android Mobile Application Build

An installable Android development build is available for evaluation:

- Build Profile: Expo Application Services (EAS) Development Client
- Package Name: `com.rota.app`
- Download Link: [Download Android Development APK](https://expo.dev/artifacts/eas/DuAGBQlTtWP18pSd7rHuAvZegMeZpFsSgLC58QqUpDI.apk)
- Signing Credentials: Built with the standard development keystore matching the registered Google OAuth 2.0 client ID (`02:74:fe:...`). Google Sign-In, navigation, and dashboard access are functional on physical Android hardware.

### Backend URL Resolution in the Mobile Build
The React Native mobile client resolves its API endpoint via `mobile/src/services/api-config.ts`:
- Compile-Time Static Inlining: In Expo and React Native, environment variables prefixed with `EXPO_PUBLIC_` (such as `EXPO_PUBLIC_API_URL`) are read by the Metro bundler and inlined as static string literals into the compiled JavaScript bundle at build time.
- Already-Installed APK Behavior: Modifying `EXPO_PUBLIC_API_URL` in a local `.env` file or in `eas.json` has zero effect on an APK already installed on a physical device. Standalone native APK binaries do not reload environment variables over the air.
- Existing Development Build: The provided development APK was compiled with `EXPO_PUBLIC_API_URL` set to the development host IP (`http://172.20.10.13:3000`).
- Development Runtime Override: In development builds, triple-tapping the Rota logo on the Sign In screen opens a connection configuration modal where a tester can manually enter a custom backend URL (such as a temporary HTTPS tunnel URL) without recompiling.
- Production Build Requirement: For production releases where the runtime override modal is disabled, changing the backend URL requires compiling a new APK through EAS with the updated `EXPO_PUBLIC_API_URL`.

---

## Demonstration and Visuals

Authentic screenshots captured from the running mobile client are located in `docs/portfolio/screenshots/`:

| Screenshot Reference | Interface Screen | Description |
|---|---|---|
| `rota-01-schedule-calendar.png` | Schedule Calendar | Shift list, quick presets, and status badges in Light Mode |
| `rota-01b-schedule-offline-dark.png` | Schedule (Dark Mode) | Offline banner, cached shifts, and Dark Mode theme |
| `rota-02-activity-feed.png` | Activity Feed | Keyset-paginated audit trail and system events |
| `rota-03-shift-swaps.png` | Team Shift Swaps | Peer-to-peer swap cards with Accept and Reject actions |
| `rota-03b-team-members.png` | Team Roster | Member list with role labels (Owner, Supervisor, Staff) |
| `rota-04-billing-subscription.png` | Subscription Billing | Tier selection, seat counters, server quotes, and ledger entries |
| `rota-04b-settings-preferences.png` | Settings Preferences | Device sync, timezone selection, and quiet hours configuration |
| `rota-04c-settings-account.png` | Account Settings | User account details and active organization switcher |

A full demonstration video walkthrough is available at `docs/Rota app demo video.mp4` (Duration: 2 minutes, 53 seconds), showing scheduling, activity feeds, Paystack billing, dark mode, and offline transitions.

---

## Deployment Environments and Operational Modes

Rota supports three distinct deployment modes:

### 1. Local Development
- Configuration: Backend API runs on `http://localhost:3000` (or `http://0.0.0.0:3000`) backed by local Docker containers running `postgres:16-alpine` (databases: `rota`, `rota_shard_1`, `rota_shard_2`) and `redis:7-alpine`.
- Access Scope: Accessible only on the host machine or from mobile devices connected to the same local Wi-Fi or mobile hotspot network using the host private IP address.
- Limitation: Cannot be reached over public cellular networks or external Wi-Fi connections.

### 2. Temporary HTTPS Tunnelling (Demonstration and Review Mode)
- Configuration: The backend runs on the local development machine, while a secure tunneling client (such as Cloudflare Tunnel or localtunnel) exposes port 3000 to a public HTTPS endpoint (for example, `https://example-subdomain.trycloudflare.com`).
- Cost and Requirements: Zero cost (N0), no credit or debit card required, and no paid cloud account needed.
- Access Scope: Allows reviewers and physical mobile devices on cellular data to interact with the live API securely from anywhere in the world.
- Distinction and Limitations: Tunnelling is an ephemeral evaluation bridge, not permanent cloud infrastructure. The local development computer and Docker containers must remain powered on and connected to the internet during testing.

### 3. Independent Cloud Deployment (Production Mode)
- Configuration: Containerized API and background worker deployed to a cloud platform (such as Railway, AWS ECS, or a Linux VPS) backed by managed PostgreSQL and Redis services.
- Cost and Requirements: Requires cloud infrastructure, a payment method for managed databases and compute, and continuous uptime monitoring.
- Readiness: All production container definitions (`Dockerfile`), database deployment scripts (`npm run db:deploy`), and health probes are fully verified and documented in [DEPLOYMENT.md](DEPLOYMENT.md).


---

## Additional Technical Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): Detailed system design, data flow, and component breakdown.
- [SECURITY.md](SECURITY.md): Threat modeling, password hashing, token lifecycle, and Row-Level Security policies.
- [SHARDING.md](SHARDING.md): Two-shard database architecture, hash routing, large-team indexing, and cross-shard query handling.
- [STATE.md](STATE.md): Implementation milestone log and verified component statuses.
- [LEARNING-LOG.md](LEARNING-LOG.md): Architectural decisions, lessons learned, and trade-off analyses.
- [DEPLOYMENT.md](DEPLOYMENT.md): Container build instructions, environment variable specifications, and migration sequences.
- [load-tests/RESULTS.md](load-tests/RESULTS.md): Detailed 200-virtual-user load test results and benchmark methodology.
