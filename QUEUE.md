# Rota Background Queue & Worker Architecture

This document describes the durable background processing system for the Rota backend, satisfying **PRD 8.6 (BILL-007)**, **SEC-018**, and **AC-TEN-08**.

---

## 1. Overview & Architecture

The Rota background queue is an atomic, Redis-backed job system designed for high durability, zero external dependencies beyond `ioredis`, and complete tenant isolation.

### Core Architecture Components:

```
[ HTTP Requests / Events ]
         |
         v
 [ enqueueJob(...) ]  --> Saves job hash (rota:job:<id>)
         |
         +--> If delayMs > 0: ZADD rota:queue:delayed <timestamp> <id>
         |
         +--> Immediate:       LPUSH rota:queue:ready <id>
                                       |
                                       v
                          [ Reliable Atomic Claim ]
                   RPOPLPUSH rota:queue:ready rota:queue:processing
                   Sets claimedBy=<workerId>, claimedAt=<now>
                                       |
                                       v
                              [ JobWorker Engine ]
                                       |
         +-----------------------------+-----------------------------+
         |                                                           |
 [ Tenant Job (job.businessId) ]                             [ Control Plane Job ]
         |                                                           |
 Re-establishes tenant context                               Checks Whitelist
 withTenantContext(businessId)                               (SEC-018, AC-TEN-08)
         |                                                           |
         +-----------------------------+-----------------------------+
                                       |
                           Executes Job Handler
                                       |
                    +------------------+------------------+
                    |                                     |
               [ Success ]                            [ Failure ]
                    |                                     |
           Removes from processing              attempts < maxAttempts?
           LREM rota:queue:processing           /                     \
           status = 'completed'              [YES]                    [NO]
                                               |                        |
                                      Exponential Backoff       Dead Letter Queue (DLQ)
                                      LREM processing           LREM processing
                                      ZADD rota:queue:delayed   LPUSH rota:queue:dead_letter
                                                                HSET rota:dlq:jobs

         [ Crash & Abandonment Recovery Scheduler (Background Loop) ]
                                       |
                    LRANGE rota:queue:processing (now - claimedAt > visibilityTimeout)
                                       |
                    +------------------+------------------+
                    |                                     |
             attempts < maxAttempts?              attempts >= maxAttempts?
                    |                                     |
             Re-enqueue to ready                 Move to Dead Letter Queue
             LPUSH rota:queue:ready              LPUSH rota:queue:dead_letter
```

---

## 2. Queue Configuration & Environment Variables

The following environment variables configure the queue and worker runtime (in `.env` and `src/config/env.ts`):

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `REDIS_URL` | string (URL) | `redis://localhost:6379` | Shared Redis connection string. Required in production. |
| `QUEUE_MAX_ATTEMPTS` | number | `3` | Maximum attempts before moving an unrecoverable job to the Dead Letter Queue. |
| `QUEUE_BACKOFF_MS` | number | `1000` | Base exponential backoff delay in milliseconds. |
| `QUEUE_VISIBILITY_TIMEOUT_MS` | number | `30000` | Time in ms before an unacknowledged job in `rota:queue:processing` is considered abandoned and recovered. |
| `SWEEPER_INTERVAL_MS` | number | `60000` | Interval in ms between automatic sweeps for unfulfilled payment events (`payment_events` in `'received'` state). |
| `ASYNC_WEBHOOK_PROCESSING` | boolean string | `'false'` | When set to `'true'`, payment webhooks immediately acknowledge with HTTP 200 `{ status: 'queued' }` and delegate fulfillment to the worker. |
| `TRUST_PROXY` | string | `'false'` | Proxy trust configuration for rate limiting and IP evaluation. |

---

## 3. Redis Requirements & Local Durability Configuration

- **Engine:** Redis 7.0+ (Docker image: `redis:7-alpine`).
- **Data Persistence:**
  - Configured with Append-Only File (AOF) persistence (`--appendonly yes --appendfsync everysec`).
  - Mounted to a persistent Docker named volume (`rota_redisdata:/data`).
  - Ensures queued jobs, processing state, and dead-letter records survive container restarts and crashes.
- **Connection Architecture:** Reuses the centralized singleton client in `src/services/redis-client.ts`. No secondary connection pools or separate dependencies.

### Local Redis Startup:
```bash
docker compose up -d rota-redis
```

### Safe Recovery & Restart Procedure:
1. If Redis restarts, AOF automatically reconstructs all in-memory keys from `/data/appendonlydir`.
2. Any job that was in `rota:queue:processing` when a worker crashed will be automatically detected by `recoverStaleJobs` upon worker startup and returned to `rota:queue:ready`.
3. In the event of catastrophic data loss, `payment_events` in PostgreSQL preserves all ingested webhooks, which can be re-enqueued by the sweeper (`sweeper.payment_inbox`).

---

## 4. Starting the Background Worker

### Local Development / Background Process
Run the standalone worker using npm:
```bash
npm run worker
```
Or directly with Node:
```bash
node --experimental-strip-types src/worker.ts
```

### Production Deployment
In production, run one or more dedicated worker processes alongside the API web tier:
```bash
NODE_ENV=production REDIS_URL=redis://your-cluster:6379 npm run worker
```

### Graceful Shutdown
The worker intercepts `SIGINT` and `SIGTERM`. When received, it:
1. Halts polling for new ready jobs (`isRunning = false`).
2. Stops delayed promotion, stale recovery, and sweeper interval timers.
3. Waits for active in-flight jobs to complete (up to a configurable timeout, default 5s).
4. Cleans up Redis and database connection pools before exiting with code 0.

---

## 5. Reliable Claiming & Crash Recovery

### Two-Phase Claim Pattern:
1. **Atomic Claim:** Workers claim jobs using `claimNextJob(workerId)`. Under the hood, an atomic Lua script runs `RPOPLPUSH rota:queue:ready rota:queue:processing` and writes `claimedBy=<workerId>`, `claimedAt=<now>`, and `status='processing'` on the job hash.
2. **Crash Protection:** If the worker abruptly dies (e.g. `SIGKILL`, OOM, host shutdown) while processing, the job remains safe in `rota:queue:processing`.
3. **Visibility Timeout:** A background loop runs `recoverStaleJobs(visibilityTimeoutMs)` (default 30s). Any job whose claim age exceeds the visibility timeout is atomically reclaimed:
   - If `attempts + 1 < maxAttempts`, it is re-queued to `rota:queue:ready` for another worker to process.
   - If `attempts + 1 >= maxAttempts`, it is moved directly to `rota:queue:dead_letter`.
4. **Concurrency Guard:** While a job is actively claimed, other workers cannot claim it, preventing duplicate concurrent execution.

---

## 6. Payment Inbox Sweeper & Overlap Prevention

To satisfy **BILL-007 Step 3**:
- When payment webhooks arrive, they are immediately persisted to PostgreSQL `payment_events` under a unique constraint with `status = 'received'`.
- The worker periodically schedules `sweeper.payment_inbox` every `SWEEPER_INTERVAL_MS` (default 60s).
- **Distributed Mutex:** To prevent duplicate or overlapping sweeps across multiple worker instances, `triggerPaymentInboxSweep()` acquires a Redis distributed lock (`SET rota:lock:payment_sweeper <workerId> NX PX <lockTtl>`). Only the lock winner executes or enqueues the sweep.
- Any unfulfilled payment event older than the threshold is automatically enqueued as a `payment.webhook` job.

---

## 7. Health & Queue Monitoring

The health check endpoint (`GET /health`) monitors both database and queue infrastructure:

### Example Response:
```json
{
  "status": "ok",
  "timestamp": "2026-10-20T22:00:00.000Z",
  "uptimeSeconds": 3600,
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

- If Redis is unreachable or disconnected, the endpoint returns HTTP 503 with `"status": "degraded"` and `"checks": { "redis": "disconnected" }`.
- Queue metrics report aggregate numeric depths only (`ready`, `processing`, `delayed`, `deadLetter`). No payload, secrets, or tenant data are exposed.

---

## 8. Dead-Letter Queue (DLQ) & Debugging

When a job reaches `attempts >= maxAttempts`:
1. The job is marked with status `'dead_letter'`.
2. Full error context is captured and stored:
   - `error.message`: Error description
   - `error.code`: Error status code (e.g., `ECONNRESET`, `404`, `503`, `ERR_VISIBILITY_TIMEOUT`)
   - `error.stack`: Complete stack trace
   - `error.failedAt`: ISO timestamp of final failure
3. The job ID is pushed to `rota:queue:dead_letter` and its JSON payload is saved to `rota:dlq:jobs`.

### Inspecting and Replaying Dead-Letter Jobs
Using programmatic queue helpers:
```ts
import { getDeadLetterJobs, retryDeadLetterJob } from './src/queue/job-queue.ts';

// 1. Inspect failed jobs
const deadJobs = await getDeadLetterJobs(50);
console.log(deadJobs);

// 2. Re-queue a specific job after fixing underlying dependency
await retryDeadLetterJob('job_1792527769938_0a4eb2dbee36');
```

---

## 9. Tenant Isolation & Security Guarantees (SEC-018, AC-TEN-08)

To strictly enforce multi-tenant isolation (**SEC-018** and **AC-TEN-08**):
- **Tenant Jobs:** Any job carrying a `businessId` re-establishes tenant context before accessing tenant data using `withTenantContext(job.businessId, ...)`. This sets PostgreSQL session variable `app.current_business_id`, enforcing Row-Level Security (RLS) on all tenant tables.
- **Control Plane Whitelist:** Any job without a `businessId` **MUST** be present in `CONTROL_PLANE_JOB_WHITELIST`.
- **Fail-Closed Security:** If an unwhitelisted job is enqueued without a `businessId`, the worker rejects it immediately with:
  `AC-TEN-08: Background job '<name>' missing required tenant context (businessId)`
  and routes it directly to the Dead Letter Queue.

---

## 10. Remaining At-Least-Once Delivery Limitations

While the hardened architecture prevents data loss across crashes and Redis restarts:
1. **At-Least-Once Processing:** Because network partitions or worker crashes can occur after a handler performs side-effects but before `completeJob` acknowledges in Redis, handlers are invoked with at-least-once semantics.
   - Handlers must be idempotent.
   - In Rota, this is enforced by:
     - `payment.webhook`: `payment_intents FOR UPDATE` status checks and `payment_events` unique constraints.
     - `push.notification`: `notification_deliveries.status` verification.
     - `email.*`: Redis `SETNX` idempotency keys.
2. **Third-Party External Side Effects:** If an external API (e.g. Expo push gateway or SMTP provider) successfully receives a request but the connection drops before the HTTP response is parsed, retrying the job will re-contact the external API unless that external service supports idempotency keys.
3. **Clock Skew:** Stale claim recovery relies on Redis server time for Lua evaluations. Ensure system clocks are synchronized across cluster hosts via NTP.

---

## 11. Notification Preferences & Quiet Hours Processing

Per **PRD 6.9 (FR-NOT-006..014)**, **BR-011**, **AC-NOT-01**, **AC-NOT-02**, **AC-NOT-08**, and **AC-016**:

### 1. In-App Inbox Persistence
- In-app items (`inbox_items` in tenant database) are **always** inserted immediately upon event creation (`BR-011`, `FR-NOT-009`).
- Mandatory categories (`billing` and `security`) are flagged with `mandatory: true` and cannot be disabled in the in-app inbox.

### 2. Category Preferences Enforcement (`AC-NOT-08`)
- Recipient preferences stored in `rota_control.user_settings.notification_categories` (`shifts`, `swaps`, `approvals`, `attendance`, `billing`, `security`) are enforced before push dispatch.
- Disabled non-mandatory categories produce no push notifications (`notification_deliveries.status = 'skipped_category_disabled'`).
- Urgent notifications bypass quiet hours, but do **not** override a user's explicit opt-out of a non-mandatory category.

### 3. Quiet Hours & Timezone Deferrals (`FR-NOT-007`, `AC-016`)
- When `quiet_hours_enabled` is `true` for a recipient:
  - Local time is evaluated in the recipient's stored IANA `time_zone` (with safe fallback to `UTC`).
  - Overnight windows crossing midnight (e.g. `22:00` to `07:00`) and same-day windows are evaluated accurately across daylight saving time (DST) boundaries.
  - Non-urgent push notifications are deferred by calculating `delayMs` until the end of quiet hours in that timezone.
  - The push job is enqueued in Redis sorted set `rota:queue:delayed` with `{ delayMs, businessId }`.
  - Delivery record is saved with `status = 'deferred_quiet_hours'`.
  - Matured jobs are atomically promoted from `rota:queue:delayed` to `rota:queue:ready` via Lua script in the worker loop.

### 4. Urgency Rules (`FR-NOT-008`, `AC-NOT-01`, `AC-FR-02`)
- The following notifications are marked urgent and **bypass quiet hours** (`delayMs = 0`, dispatched immediately):
  - **Shift Changes:** Where the affected shift's start (old or new, whichever is earlier and still upcoming) is within 12 hours of the change.
  - **Failed Renewals:** Subscription renewal payment failure notices to business Owners (`BILL-011`).

### 5. Delivery-Time Re-evaluation (`FR-NOT-013`, `AC-NOT-07`)
- When a deferred push job executes in `handlePushNotification`:
  - Recipient's latest settings are re-evaluated. If the user disabled the category while the job was waiting, push dispatch is skipped (`status = 'skipped_category_disabled'`).
  - The underlying shift or event is verified. If the shift was deleted or cancelled in a conflicting manner, push dispatch is skipped (`status = 'skipped_superseded'`).
  - Delivery status is idempotently updated to `delivered_expo`, ensuring retries cannot duplicate pushes or generate redundant inbox items.

