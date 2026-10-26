# Rota Zero-Cost Cloud Deployment Guide
## Secure Deployment on Hostless Free + Neon Free + Managed Redis

This guide provides verified, step-by-step instructions for deploying the Rota workforce scheduling backend to the cloud with **zero ongoing costs** and **without requiring a credit card or payment method**.

---

## 1. Verified Architecture & Resource Accounting

```
                     +---------------------------------------+
                     |         Mobile App (Android APK)      |
                     |         React Native / Expo           |
                     +-------------------+-------------------+
                                         | HTTPS (TLS 1.3)
                                         v
+---------------------------------------------------------------------------------+
| Hostless Free Tier (Account-wide pool: 0.5 vCPU / 1 GB RAM / 512 MB Disk)       |
|                                                                                 |
|  +---------------------------------------------------------------------------+  |
|  | Single Container Runtime: `src/combined.ts`                               |  |
|  | - Express HTTP API (Port 3000)                                            |  |
|  | - Durable Background Queue Worker (Poll: 500ms, Sweeper: 60s)             |  |
|  | - Container Liveness Probe: `GET /health/live` (Memory/uptime only)       |  |
|  | - Deep Readiness Probe: `GET /health` (PostgreSQL + Redis validation)     |  |
|  | - Memory Footprint: ~100–120 MB Node.js RSS                               |  |
|  +---------------------------------------------------------------------------+  |
|                                         |                                       |
|  +-----------------------------------+  | Enforced TLS (`rediss://`)            |
|  | Hostless-Managed Redis 7.x        |<-+ Internal Private Container Network    |
|  | - Memory cap: ~64–80 MB            |                                          |
|  | - Consumes from same 1 GB pool    |                                          |
|  | - Append-Only File (AOF) enabled  |                                          |
|  | - Zero public internet exposure   |                                          |
|  +-----------------------------------+                                          |
+---------------------------------------------------------------------------------+
                                         |
                                         | Direct Port 5432 (`sslmode=require`)
                                         | Runtime Role: `rota_app` (NOBYPASSRLS)
                                         v
+---------------------------------------------------------------------------------+
| Neon Free Tier (Zero Payment Card / 100 Compute Unit-Hours / 1 GB Storage)      |
|                                                                                 |
|  +--------------------+  +-----------------------+  +------------------------+  |
|  |       `rota`       |  |    `rota_shard_1`     |  |     `rota_shard_2`     |  |
|  | Global identities, |  | Tenant rosters, shifts|  | Tenant rosters, shifts |  |
|  | sessions, payment  |  | organization data     |  | organization data      |  |
|  | event inbox        |  | (Deterministic hash=0)|  | (Deterministic hash=1) |  |
|  +--------------------+  +-----------------------+  +------------------------+  |
|                                                                                 |
|  * Automatic scale-to-zero after 5 minutes of client inactivity                 |
|  * Protected against wakeups by lightweight `/health/live` container probe      |
+---------------------------------------------------------------------------------+
```

### Account-Wide Resource Budget
| Component | Free Tier Allowance | Measured/Budgeted Usage | Accounting & Headroom |
| :--- | :--- | :--- | :--- |
| **Combined Node Process** | Shared Hostless pool (1 GB RAM total) | ~100–120 MB RAM | Leaves ~880 MB for Redis and OS buffers |
| **Managed Redis** | Shared Hostless pool (1 GB RAM total) | ~64–80 MB RAM (with AOF) | **Total memory: ~180–200 MB / 1,024 MB pool** (~80% headroom) |
| **Database Compute (Neon)** | 100 CU-hr/month, 1 GB storage | ~15–25 CU-hr/month (with idle sleep) | ~75% compute allowance remaining |
| **Database Connections** | Direct port 5432 (`sslmode=require`) | 30 max connections (10 per pool) | Within Neon connection limits |
| **Network Security** | Automated TLS 1.3 | Public HTTPS + internal `rediss://` TLS | Zero credentials transmitted over plaintext TCP |

> [!IMPORTANT]
> **Hostless Resource Pooling**: Hostless calculates CPU (0.5 vCPU), RAM (1 GB), and storage (512 MB) as an **account-wide aggregate allowance**. Managed Redis does **not** receive a separate unmetered 64 MB allocation; its memory footprint is drawn from the shared 1 GB pool alongside the Node.js application container.

---

## 2. Step 1: Provision Free Accounts (Zero Credit Cards)

### 2.1 Neon PostgreSQL Account
1. Open [https://neon.tech](https://neon.tech).
2. Sign up using GitHub or Google.
3. Confirm creation of your free-tier project. **No payment card or billing information is required.**

### 2.2 Hostless Cloud Account
1. Open [https://hostless.app](https://hostless.app).
2. Sign in with GitHub.
3. Confirm the free account tier (0.5 vCPU, 1 GB RAM, 512 MB disk). **No payment card is required.**

---

## 3. Step 2: Provision Neon Databases

To preserve Rota's architectural conventions, three dedicated databases matching the repository configuration must be provisioned:

### 3.1 Create the Three Databases
In the Neon Console -> **Project Dashboard** -> **Databases**:
1. Rename the default database to `rota` (or click **New Database** -> Name: `rota`).
2. Click **New Database** -> Name: `rota_shard_1` -> Click **Create**.
3. Click **New Database** -> Name: `rota_shard_2` -> Click **Create**.

> [!NOTE]
> Preserving the canonical database names (`rota`, `rota_shard_1`, `rota_shard_2`) is required by `src/config/env.ts` and `scripts/setup-shard-databases.ts`.

### 3.2 Obtain the Direct Connection Strings
In the Neon Console, select **Connection Details**:
- Choose **Direct connection** (Port **5432**), NOT Pooled connection (Port 6543).
  *(Direct connection is mandatory because Rota startup sets session options `-c search_path=...`, which is incompatible with PgBouncer transaction pooling).*
- The connection strings follow the format:
  ```text
  postgresql://neondb_owner:YOUR_PASSWORD@ep-xyz.us-east-2.aws.neon.tech/DATABASE_NAME?sslmode=require
  ```
- Copy the admin connection URLs for your local migration run:
  1. `DATABASE_URL`: `.../rota?sslmode=require`
  2. `SHARD_1_DATABASE_URL`: `.../rota_shard_1?sslmode=require`
  3. `SHARD_2_DATABASE_URL`: `.../rota_shard_2?sslmode=require`

---

## 4. Step 3: Run Database Migrations from Local CLI

Run the migration pipeline from your local terminal against the Neon databases using admin credentials. The migration scripts automatically establish schemas, create the `rota_app` non-superuser role with `NOBYPASSRLS`, configure table default privileges, and run all DDL migrations:

```powershell
# Set temporary migration environment variables in your local shell
$env:DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota?sslmode=require"
$env:APP_DATABASE_URL="postgresql://rota_app:YOUR_APP_PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota?sslmode=require"
$env:SHARD_1_DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota_shard_1?sslmode=require"
$env:SHARD_2_DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota_shard_2?sslmode=require"

# 1. Initialize schemas, create 'rota_app' role, and configure default privileges
npm.cmd run db:init

# 2. Provision shard schemas and permissions on rota_shard_1 and rota_shard_2
npm.cmd run db:setup-shards

# 3. Apply all migrations across control plane and both physical shard databases
npm.cmd run db:migrate

# 4. Verify shard symmetry and RLS enforcement
npm.cmd run db:verify
```

> [!TIP]
> The automated migration script (`scripts/migrate.ts`) invokes `ensureApplicationRolePermissions` after each migration step, guaranteeing that the runtime role (`rota_app`) receives explicit `SELECT, INSERT, UPDATE, DELETE` permissions on newly created tables and sequences without superuser elevation.

---

## 5. Step 4: Configure Production Environment Variables

Set these environment variables in your Hostless App Dashboard under **Settings -> Environment Variables**.

> [!CAUTION]
> - Never commit passwords or secret keys to Git.
> - **Administrative connection strings (`DATABASE_URL`, `SHARD_1_DATABASE_URL`, `SHARD_2_DATABASE_URL`) must NEVER be added to the production web container.** Only non-superuser runtime credentials (`APP_*`) may be set.

| Variable Name | Required | Example / Format | Purpose & Architectural Guidance |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Yes | `production` | Enforces production validation (demands non-dev secrets, requires Redis). |
| `PORT` | Yes | `3000` | Port the unified process listens on. |
| `HOST` | Yes | `0.0.0.0` | Container bind address. |
| `TRUST_PROXY` | Yes | `1` | Configures Express to trust 1 reverse-proxy hop behind Hostless, correctly extracting client IPs. |
| `APP_BASE_URL` | Yes | `https://your-app.hostless.app` | Canonical public HTTPS URL of your deployed backend. |
| `APP_DATABASE_URL` | Yes | `postgresql://rota_app:PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota?sslmode=require` | Non-superuser runtime connection for Control DB (`NOBYPASSRLS`). |
| `APP_SHARD_1_DATABASE_URL` | Yes | `postgresql://rota_app:PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota_shard_1?sslmode=require` | Non-superuser runtime connection for Shard 1 DB. |
| `APP_SHARD_2_DATABASE_URL` | Yes | `postgresql://rota_app:PASSWORD@ep-xyz.us-east-2.aws.neon.tech/rota_shard_2?sslmode=require` | Non-superuser runtime connection for Shard 2 DB. |
| `CONTROL_SCHEMA` | No | `rota_control` | PostgreSQL schema name for control plane data. |
| `SHARD_1_SCHEMA` | No | `rota_shard_1` | Schema name for Shard 1 tenant data. |
| `SHARD_2_SCHEMA` | No | `rota_shard_2` | Schema name for Shard 2 tenant data. |
| `REDIS_URL` | Yes | `rediss://default:PASSWORD@redis-host:6379` | **Must use `rediss://` for TLS connections.** Internal private Redis URL. |
| `JWT_SECRET` | Yes | `[Min 32 characters random]` | HMAC secret for signing access tokens (`openssl rand -hex 32`). |
| `REFRESH_TOKEN_SECRET` | Yes | `[Min 32 characters random]` | HMAC secret for signing refresh tokens (`openssl rand -hex 32`). |
| `PAYSTACK_SECRET_KEY` | Yes | `sk_test_...` | Paystack test secret key for billing simulations. |
| `PAYSTACK_PUBLIC_KEY` | Yes | `pk_test_...` | Paystack test public key. |
| `EMAIL_PROVIDER` | Yes | `simulated` | Uses zero-cost simulated email for invitations and resets (avoids paid domain verification). |
| `PUSH_PROVIDER` | No | `expo` | Expo push notification service (free tier, no card required). |
| `SWEEPER_INTERVAL_MS` | No | `60000` | Payment inbox sweeper interval (60 seconds). |

> [!WARNING]
> **Redis Connection Protocol**: Never label plaintext `redis://` as encrypted. In `ioredis`, TLS encryption is activated **only** when using the `rediss://` scheme (double 's'). If your managed Redis provider uses TLS, configure `REDIS_URL=rediss://...`.

---

## 6. Step 5: Deploy to Hostless

1. In the Hostless Dashboard, click **New Application** and select your GitHub repository.
2. Select the target branch (`main`).
3. Add the **Managed Redis** service to your project (configured with memory cap ~64 MB to share the 1 GB pool safely).
4. Configure Build and Runtime settings:
   - **Build Type**: `Dockerfile` (automatically uses root `Dockerfile`).
   - **Exposed Port**: `3000`.
   - **Healthcheck Path**: `/health/live`.
   - **Healthcheck Interval**: `30s` (timeout: `5s`, start period: `10s`).
5. Set the Environment Variables from Section 5.
6. Click **Deploy**.
7. Hostless will build the container, provision the internal Redis, and assign a public HTTPS domain: `https://your-app.hostless.app`.

---

## 7. Step 6: Verify Deployment & Health Checks

Verify your deployment using `curl` or a web browser:

### 7.1 Verify Container Liveness Probe (Zero Database Wakeup)
```bash
curl -i https://your-app.hostless.app/health/live
```
**Expected Response (`HTTP 200 OK`):**
```json
{
  "status": "ok",
  "timestamp": "2026-10-25T16:00:00.000Z",
  "uptimeSeconds": 142,
  "service": "rota-backend"
}
```

### 7.2 Verify Deep System Readiness Probe (PostgreSQL + Redis + Queues)
```bash
curl -i https://your-app.hostless.app/health
```
**Expected Response (`HTTP 200 OK`):**
```json
{
  "status": "ok",
  "timestamp": "2026-10-25T16:00:05.000Z",
  "uptimeSeconds": 147,
  "environment": "production",
  "version": "0.1.0",
  "checks": {
    "server": "healthy",
    "database": "connected",
    "redis": "connected",
    "queues": {
      "ready": 0,
      "processing": 0,
      "delayed": 0,
      "deadLetter": 0
    }
  }
}
```

---

## 8. Step 7: Update Mobile Application & Rebuild Android APK

### 8.1 Update Mobile Environment
Update `mobile/.env` with your assigned public HTTPS URL:

```env
# mobile/.env
EXPO_PUBLIC_API_URL=https://your-app.hostless.app
```

### 8.2 Rebuild the Android Release APK
Generate the release preview APK:

```bash
cd mobile

# Option A: Cloud EAS Build (free tier)
npx eas-cli build --profile preview --platform android

# Option B: Local Android Gradle Build (if Android SDK is installed locally)
npx expo run:android --variant release
```

---

## 9. Step 8: Post-Deployment Smoke Test Sequence

Verify tenant isolation, deterministic sharding, and queue worker execution in cloud staging:

### 1. Register Business A (Deterministic Shard Allocation)
```bash
curl -X POST https://your-app.hostless.app/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"businessName":"Cloud Clinic Alpha","email":"admin@alpha.com","password":"Password123!","name":"Dr. Alpha"}'
```
*Save the returned `accessToken` and `businessId`.*

### 2. Verify Tenant Context & Sharded Access
```bash
curl -X GET https://your-app.hostless.app/v1/organization/departments \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "X-Business-ID: <BUSINESS_ID>"
```

### 3. Verify Background Worker Execution
Enqueue a notification or event and observe in `/health` that `queues.ready` and `queues.processing` increment and clear cleanly.

---

## 10. Step 9: Rollback & Inactivity Sleep Verification

1. **Hostless One-Click Rollback**: In the Hostless Dashboard -> **Deployments**, select the previous stable deployment and click **Rollback**.
2. **Neon Point-in-Time Recovery**: Neon supports non-destructive branching. If data inconsistency occurs during migration, branch from a prior timestamp in the Neon console.
3. **Scale-to-Zero Verification**: 10 minutes after stopping user activity, inspect the Neon compute metrics graph. The compute status should transition to **Idle** (0 active compute units), proving that the container liveness probe (`/health/live`) does not exhaust Neon's 100 CU-hour monthly allowance.
