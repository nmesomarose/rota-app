# Rota Backend Production Deployment Guide

This document describes the operational architecture, container configuration, migration procedures, reproducible startup commands, health check probes, and remaining external blockers for deploying the Rota backend to production.

---

## 1. Operational Architecture

Rota is designed as a cloud-native, horizontally scalable multi-tenant workforce scheduling system:

- **Runtime**: Native Node.js 22 LTS or Node.js 24 using `--experimental-strip-types`. TypeScript files are executed directly without intermediate transpilation artifacts or build drift.
- **Database Architecture**: PostgreSQL 16+ utilizing physical multi-tenant sharding:
  - `rota`: Control plane database housing `rota_control` schema (global identities, sessions, payment event inbox, and directory).
  - `rota_shard_1`: Dedicated PostgreSQL database storing tenant organizations, shifts, rosters, and financial records for Shard 1 with forced Row-Level Security.
  - `rota_shard_2`: Dedicated PostgreSQL database storing symmetrical tenant structures for Shard 2 with forced Row-Level Security.
- **Cache & Queue Store**: Redis 7+ configured with Append-Only File (`appendonly yes`) persistence for:
  - Reliable at-least-once distributed background queue processing (claim renewals, heartbeats, visibility timeout recovery, and dead-letter queues).
  - High-performance distributed sliding-window rate limiting.
  - Multi-tier tenant query caching with strict `tenant:{businessId}:{key}` isolation and write-through invalidation.
- **Separation of Services**:
  - **API Server** (`src/index.ts`): Stateless HTTP server exposing authenticated RESTful endpoints.
  - **Queue Worker** (`src/worker.ts`): Background daemon processing asynchronous notification dispatch, webhook events, and sweeper maintenance.

---

## 2. Reproducible Startup Commands

### 2.1 Database Setup & Migrations (One-Off / CI/CD Pipeline)

Database migrations MUST run prior to deploying new versions of the API or Worker services. Migrations enforce strict privilege separation between administrative DDL setup and application DML runtime.

```bash
# 1. Initialize schemas, users, and grant least-privilege permissions
npm run db:init

# 2. Provision and migrate physical shard databases (rota_shard_1, rota_shard_2)
npm run db:setup-shards

# 3. Execute all migrations across control plane and both physical shard databases
npm run db:migrate

# 4. Or execute complete zero-drift deployment pipeline sequentially
npm run db:deploy

# 5. Verify database integrity and reconciliation
npm run db:verify
npm run db:reconcile
```

### 2.2 API Service (Stateless Web Server)

```bash
# Standard production API start command
npm run start:api
# Or via default start script
npm start
# Direct Node.js command
node --experimental-strip-types src/index.ts
```

### 2.3 Queue Worker Service (Background Daemon)

```bash
# Standard production Worker start command
npm run start:worker
# Direct Node.js command
node --experimental-strip-types src/worker.ts
```

---

## 3. Database Privilege Separation

To satisfy enterprise security guidelines (SEC-001, SEC-002) and prevent SQL injection attacks from gaining superuser capabilities:

| Role Name | Environment Variable | Granted Capabilities | Prohibited Capabilities | Used By |
| :--- | :--- | :--- | :--- | :--- |
| **Admin / Migration Role** | `DATABASE_URL` | DDL execution (`CREATE`, `ALTER`, `DROP`), schema ownership, extension management (`pgcrypto`, `uuid-ossp`) | Used exclusively in CI/CD migration steps; NEVER used by running web servers | `scripts/init-db.ts`, `scripts/migrate.ts` |
| **Application Runtime Role** | `APP_DATABASE_URL` | DML execution (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) on tables; `USAGE, SELECT` on sequences | `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, schema modifications, DDL | `src/index.ts` (API), `src/worker.ts` (Worker) |

The migration runner (`scripts/migrate.ts`) automatically invokes `ensureApplicationRolePermissions(schemaName)` upon completing migrations for each schema (`control`, `shard_1`, `shard_2`). This verifies that the `APP_DATABASE_URL` role has all required DML permissions while strictly forbidding superuser elevation or RLS bypass.

---

## 4. Containerization & Docker Deployment

A multi-stage, hardened production `Dockerfile` is provided in the repository root.

### 4.1 Building the Container Image

```bash
docker build -t rota-backend:latest .
```

### 4.2 Running the API Service

```bash
docker run -d \
  --name rota-api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env.production \
  rota-backend:latest
```

### 4.3 Running the Queue Worker

```bash
docker run -d \
  --name rota-worker \
  --restart unless-stopped \
  --env-file .env.production \
  rota-backend:latest \
  node --experimental-strip-types src/worker.ts
```

---

## 5. Health Check Probes & Monitoring

The application provides a comprehensive `/health` endpoint designed for container orchestrator readiness and liveness probes (e.g., Kubernetes `readinessProbe` and `livenessProbe`, AWS ALB Target Group health checks).

- **Endpoint**: `GET /health`
- **Port**: Configured via `PORT` (default `3000`)
- **Probed Subsystems**:
  1. **HTTP Server**: Process uptime, environment metadata.
  2. **PostgreSQL**: Queries `SELECT 1` concurrently across all connection pools (`controlPool`, `shard1Pool`, `shard2Pool`) with a 2,000ms timeout.
  3. **Redis**: Sends `PING` command and verifies `PONG` response with a 1,500ms timeout; extracts real-time queue depth metrics (`ready`, `processing`, `delayed`, `deadLetter`).
- **HTTP Status Codes**:
  - `200 OK`: All subsystems healthy (`status: "ok"`).
  - `503 Service Unavailable`: Either PostgreSQL or Redis is unreachable (`status: "degraded"`).

### Recommended Orchestrator Probe Configuration (Kubernetes Example)

```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3

livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 20
  timeoutSeconds: 3
  failureThreshold: 3
```

---

## 6. Production Environment Variables Reference

| Variable Name | Required | Default / Format | Description & Guidance |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes | `production` | Enables production security checks (e.g. enforces Redis presence). |
| `PORT` | No | `3000` | HTTP listening port for Express API. |
| `HOST` | No | `0.0.0.0` | Bind address for API server. |
| `TRUST_PROXY` | Yes | `1` | Reverse proxy trust configuration. Set to hop count behind ingress (e.g. `1` for ALB/Cloudflare) or `false` if exposed directly. |
| `APP_BASE_URL` | Yes | `https://api.yourdomain.com` | Canonical public API URL used for payment gateway redirects. |
| `DATABASE_URL` | Yes (Migrations) | `postgresql://admin:***@host:5432/rota` | Superuser/Admin connection for control plane migrations. Must NOT be exposed to web workers. |
| `APP_DATABASE_URL` | Yes (Runtime) | `postgresql://rota_app:***@host:5432/rota` | Non-superuser connection without `BYPASSRLS` for control plane application workloads. |
| `SHARD_1_DATABASE_URL` | Yes (Migrations) | `postgresql://admin:***@host:5432/rota_shard_1` | Admin connection for Shard 1 migrations and table provisioning. |
| `APP_SHARD_1_DATABASE_URL` | Yes (Runtime) | `postgresql://rota_app:***@host:5432/rota_shard_1` | Non-superuser runtime connection for Shard 1 tenant database with forced RLS. |
| `SHARD_2_DATABASE_URL` | Yes (Migrations) | `postgresql://admin:***@host:5432/rota_shard_2` | Admin connection for Shard 2 migrations and table provisioning. |
| `APP_SHARD_2_DATABASE_URL` | Yes (Runtime) | `postgresql://rota_app:***@host:5432/rota_shard_2` | Non-superuser runtime connection for Shard 2 tenant database with forced RLS. |
| `CONTROL_SCHEMA` | No | `rota_control` | PostgreSQL schema name for control plane metadata. |
| `SHARD_1_SCHEMA` | No | `rota_shard_1` | PostgreSQL schema name for tenant shard 1. |
| `SHARD_2_SCHEMA` | No | `rota_shard_2` | PostgreSQL schema name for tenant shard 2. |
| `REDIS_URL` | Yes | `rediss://...` (TLS) | Redis connection string. Mandatory when `NODE_ENV=production`. |
| `JWT_SECRET` | Yes | `[Cryptographic Random]` | HMAC secret for signing authentication tokens (min 32 chars). |
| `REFRESH_TOKEN_SECRET` | Yes | `[Cryptographic Random]` | HMAC secret for signing refresh tokens (min 32 chars). |
| `PAYSTACK_SECRET_KEY` | Yes | `sk_live_...` | Live Paystack secret key for charge authorization and subscription billing. |
| `PAYSTACK_PUBLIC_KEY` | Yes | `pk_live_...` | Live Paystack public key for client-side transaction initiation. |
| `PAYSTACK_CALLBACK_URL` | Yes | `https://api.yourdomain.com/v1/billing/return` | Webhook / checkout return callback URL. |
| `ASYNC_WEBHOOK_PROCESSING` | No | `true` | When `true`, delegates payment webhook processing to Redis worker queues. |
| `QUEUE_MAX_ATTEMPTS` | No | `3` | Maximum attempts before moving job to dead-letter queue. |
| `QUEUE_BACKOFF_MS` | No | `1000` | Initial exponential backoff delay for retried jobs. |
| `QUEUE_VISIBILITY_TIMEOUT_MS`| No | `30000` | Job visibility timeout in milliseconds. |
| `SWEEPER_INTERVAL_MS` | No | `60000` | Periodic interval for stalled job reclamation. |
| `RESEND_API_KEY` | Yes (Prod Email) | `re_...` | Live Resend API key for transactional email delivery (invitations, password resets). Required in production. |
| `EMAIL_FROM` | No | `Rota <onboarding@resend.dev>` | Verified sender address for outbound emails (e.g. `Rota <invitations@yourdomain.com>`). |
| `EMAIL_PROVIDER` | No | `resend` (in prod) | Explicit provider selector (`resend` or `simulated`). Defaults to `simulated` in dev/test, requires real provider in production. |
| `PUSH_PROVIDER` | No | `expo` (in prod) | Push notification provider (`expo` or `simulated`). Defaults to `simulated` in dev/test, `expo` in production. |
| `EXPO_ACCESS_TOKEN` | No | `[Expo Token]` | Optional Expo access token if push security/token authentication is enabled on your Expo project. |

---

## 7. Concrete Remaining Deployment Blockers

The following items are external prerequisites that cannot be executed purely in code and must be fulfilled by the infrastructure and operations team prior to production launch:

1. **Production Infrastructure Provisioning**:
   - Provision a managed PostgreSQL 16+ instance (AWS RDS, GCP Cloud SQL, or Neon/Supabase) with automated backups, point-in-time recovery, and connection pooling enabled (e.g., PgBouncer).
   - Provision a managed Redis 7+ cluster (AWS ElastiCache, Upstash, or Redis Cloud) with AOF persistence enabled and TLS encryption in transit.
2. **Production Secret Generation & Key Vault**:
   - Generate production-grade, cryptographically random strings for `JWT_SECRET` and `REFRESH_TOKEN_SECRET` (e.g. `openssl rand -base64 48`) and store them in an enterprise secret manager (AWS Secrets Manager, HashiCorp Vault, or cloud provider environment secrets).
3. **Paystack Production Merchant Onboarding**:
   - Complete Paystack business verification / KYC to activate live mode.
   - Obtain `sk_live_...` and `pk_live_...` keys and register the production webhook endpoint in the Paystack merchant dashboard (`https://api.yourdomain.com/v1/billing/webhook`).
4. **Custom Domain & SSL/TLS Termination**:
   - Configure DNS records (`api.yourdomain.com`) pointing to the load balancer / reverse proxy.
   - Provision trusted SSL/TLS certificates (AWS Certificate Manager or Let's Encrypt).
5. **Transactional Email & Push Notification Provider Provisioning**:
   - Register a live Resend account, add your sending domain (e.g. `yourdomain.com`), and configure DNS verification records (SPF, DKIM, and DMARC).
   - Obtain a production API key (`re_...`) and configure `RESEND_API_KEY` and `EMAIL_FROM`.
   - Configure Firebase Cloud Messaging (FCM) and Apple Push Notification Service (APNs) keys in Expo Application Services (EAS) for live push dispatch.
6. **Mobile Application Store Distribution**:
   - Apple Developer Program account ($99/yr) enrolled for iOS App Store and TestFlight distribution.
   - Google Play Console developer account ($25 one-time) enrolled for Android APK / AAB distribution.

---

## 8. Mobile Client (Expo / EAS) Production API Configuration

The mobile application (`mobile/`) uses the standard Expo public environment variable `EXPO_PUBLIC_API_URL` to configure the API base URL at build time.

### 8.1 Build vs. Development Behavior

- **Development (`__DEV__ === true`)**:
  - Automatically defaults to the local development server (`http://172.20.10.13:3000`) if `EXPO_PUBLIC_API_URL` is unset.
  - Can be overridden at runtime via `setCustomApiUrl(url)`.
- **Production (`__DEV__ === false`)**:
  - Does **not** fall back to private LAN or localhost IP addresses.
  - If `EXPO_PUBLIC_API_URL` was not supplied during bundle compilation and no runtime URL override was provided, API calls fail immediately with a descriptive `CONFIGURATION_ERROR` (`Production API URL is not configured...`).

### 8.2 Supplying the HTTPS API URL to EAS Builds

When the backend is deployed to a cloud environment with an HTTPS domain (e.g. `https://api.yourdomain.com`), supply the URL to EAS builds using any of the following approaches:

#### Option A: EAS Environment Variables (Recommended for EAS Cloud Builds)

Define the variable in the Expo Application Services dashboard or via the EAS CLI:

```bash
# Set for preview builds
eas env:create --scope project --profile preview --name EXPO_PUBLIC_API_URL --value "https://staging-api.yourdomain.com" --type string

# Set for production builds
eas env:create --scope project --profile production --name EXPO_PUBLIC_API_URL --value "https://api.yourdomain.com" --type string
```

#### Option B: Configure `env` in `mobile/eas.json`

Add the `env` block to the appropriate profile in `mobile/eas.json` once the backend domain is provisioned:

```json
{
  "build": {
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      },
      "env": {
        "EXPO_PUBLIC_API_URL": "https://staging-api.yourdomain.com"
      }
    },
    "production": {
      "autoIncrement": true,
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.yourdomain.com"
      }
    }
  }
}
```

#### Option C: Inline via Environment Variable on CLI

For local EAS builds (`eas build --local`) or CI/CD pipelines:

```bash
cd mobile
EXPO_PUBLIC_API_URL="https://api.yourdomain.com" eas build --profile preview --platform android
```

