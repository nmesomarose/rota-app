# Rota: Multi-Tenant Team Scheduling SaaS

Rota is a multi-tenant mobile workforce scheduling SaaS application designed for shift-based businesses. It provides role-scoped scheduling, branch-scoped departments, and tenant-isolated operations.

The system enforces multi-tenant boundary isolation using:
1. **Control Plane (`rota_control`)**: Stores un-sharded global identities, user credentials, active sessions, and webhook event inboxes.
2. **Two Logical Shards (`rota_shard_1` and `rota_shard_2`)**: Stores business-owned operational data (branches, departments, shifts, subscriptions, ledger). Tenant routing is deterministic, calculated via `SHA-256(business_id) % 2`.
3. **Database-Level Isolation**: PostgreSQL Row-Level Security (`FORCE ROW LEVEL SECURITY`) with non-superuser role `rota_app` (`NOSUPERUSER NOBYPASSRLS`) and composite foreign keys.

---

## 1. Directory Structure

```
Rota App/
├── src/                          # Express 5 backend source
│   ├── config/                   # Zod environment variable validation
│   ├── db/                       # Kysely & pg connection pools for control and shards
│   ├── routes/                   # Route handlers (health check endpoint)
│   ├── sharding/                 # Deterministic shard router (SHA-256 % 2)
│   ├── app.ts                    # Express application factory and middleware
│   └── index.ts                  # Server entry point
├── tests/                        # Automated test suites (Node.js test runner)
│   ├── sharding/                 # Shard router stability & distribution tests (10 passing)
│   ├── config.test.ts            # Environment variable validation tests (4 passing)
│   └── health.test.ts            # Live health check & 404 tests (2 passing)
├── scripts/                      # Database scripts and migration runner
│   ├── init-db.sql               # Schema and role initialization SQL
│   ├── verify-db.sql             # Schema and privilege verification SQL
│   └── migrate.ts                # node-pg-migrate runner across schemas
├── migrations/                   # Declarative SQL migrations
│   ├── control/                  # Control-plane migrations (rota_control)
│   └── tenant/                   # Tenant-plane migrations (applied to rota_shard_1 & 2)
├── mobile/                       # React Native / Expo mobile application
│   ├── src/
│   │   ├── navigation/           # React Navigation RootNavigator & Bottom Tabs
│   │   └── screens/              # Scaffold screens: Schedule, Feed, Team, Settings, Login
│   ├── App.tsx                   # Mobile entry point
│   ├── app.json                  # Expo SDK 58 configuration
│   ├── package.json              # Mobile dependencies and build scripts
│   └── tsconfig.json             # Mobile TypeScript configuration
├── docs/                         # Documentation and decision records
│   └── decisions/                # Decision records DR-01 through DR-08 (PROPOSED)
├── PRD.md                        # Authoritative product requirements document (v0.3)
├── ARCHITECTURE.md               # System architecture and technical design
├── SECURITY.md                   # Security model, threat matrix, and hygiene rules
├── SHARDING.md                   # Two-logical-shard simulation architecture
├── STATE.md                      # Milestone and workstream progress tracker
├── LEARNING-LOG.md               # Plain-language technical notes and trade-off rationale
├── package.json                  # Backend dependencies, typecheck, and test scripts
└── README.md                     # This file
```

---

## 2. Prerequisites & Environment

- **Node.js**: `v24.21.0` LTS (or `v20.x+`)
- **Package Manager**: `npm` `11.19.0` (Use `npm.cmd` on Windows PowerShell if execution policies restrict `.ps1` files)
- **Database**: PostgreSQL 16 (Local instance or Docker container on port `5432`)
- **Mobile Framework**: Expo SDK 58 (`~58.0.13`) with React Native 0.88

---

## 3. Setup and Installation

### 3.1 Backend Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Install backend dependencies:
   ```bash
   npm install
   ```

### 3.2 Database Initialization & Migrations

1. Ensure the PostgreSQL 16 container is running:
   ```bash
   docker compose up -d
   ```
2. Initialize schemas and the application role:
   ```bash
   # Run init-db.sql against the PostgreSQL instance
   psql -U postgres -d rota -f scripts/init-db.sql
   ```
3. Run declarative schema migrations across control plane and both logical shards:
   ```bash
   npm run db:migrate
   ```

---

## 4. Verification Commands

The following commands have been executed and verified in this environment:

### 4.1 Run Backend Tests
Runs all unit and integration test suites using Node's built-in test runner:
```bash
npm test
```
*Expected Result*: 16 passing tests across 7 test suites (10 shard routing, 4 config validation, 2 health check).

### 4.2 Run Shard Router Tests
Runs the deterministic shard router tests verifying stability (`AC-SH-01`) and distribution balance (`AC-SH-02`):
```bash
npm run test:sharding
```

### 4.3 Typecheck Backend
Runs the TypeScript compiler in no-emit mode:
```bash
npm run typecheck
```
*Expected Result*: Clean exit with 0 errors.

### 4.4 Start Backend Server & Verify Health Endpoint
Start the development server:
```bash
npm run dev
```
In another terminal, test the `/health` endpoint:
```bash
curl http://localhost:3000/health
```
*Expected Response (HTTP 200)*:
```json
{
  "status": "ok",
  "timestamp": "2026-10-16T19:05:16.817Z",
  "uptimeSeconds": 1,
  "environment": "development",
  "version": "0.1.0",
  "checks": {
    "server": "healthy",
    "database": "connected"
  }
}
```

---

## 5. Security & Isolation Notes

> [!IMPORTANT]
> A scaffold that boots and passes health checks **does NOT prove tenant isolation**.
> Formal cross-tenant penetration tests, composite foreign-key verification, and PostgreSQL Row-Level Security (RLS) enforcement belong to the upcoming **Milestone M1 Security Verification** milestone.
