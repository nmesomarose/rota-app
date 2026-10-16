# DR-03: Background Job Queue, Webhook Inbox, and Outbox Sweeper

## Status
`ACCEPTED (Engineering Decision)` — Dual-layer inbox/sweeper architecture adopted; Milestone M1 focuses on DB foundation, while BullMQ/Redis worker dispatcher is phased into M2/M3 per D-29.

## Context
Rota relies heavily on asynchronous background processing for:
1. Push and in-app notification fan-out (`FR-NOT-003`, `FR-NOT-010`).
2. Webhook event ingestion and payment reconciliation (`BILL-007`).
3. Membership directory synchronization between tenant plane and control plane (`PRD 9.1`, `AC-TEN-07`).
4. Subscription renewal retries and quiet-hour notification deferrals (`FR-NOT-007`, `BILL-011`).

Per `NFR-REL-002`, **a Redis outage must never lose a financial event or notification delivery**. Redis is a transient queue and cache backing, not the durable source of truth.

## Alternatives Considered

### 1. Pure Redis Queue (BullMQ standalone)
- *Pros*: Fast, lightweight, rich scheduling features (delays, retries, concurrency limits).
- *Cons*: If Redis crashes before a job is persisted or during an un-flushed AOF window, events are permanently lost. Violates `NFR-REL-002` and `BILL-007`.

### 2. Pure PostgreSQL Queue (e.g. `pg-boss` or custom `SKIP LOCKED` table)
- *Pros*: Fully ACID durable in Postgres; transactional enqueue alongside business mutations.
- *Cons*: Higher database write amplification and polling overhead; lacks built-in delayed job scheduling and high-throughput notification fan-out capabilities.

### 3. Dual-Layer Queue: Postgres Transactional Inboxes + BullMQ + Periodic Sweeper (Recommended)
- *Pros*:
  - **Durability**: Webhook events are inserted into `payment_events` (`BILL-007`) and notification events into `notification_deliveries` (`FR-NOT-010`) in the database *before* enqueueing.
  - **High Throughput**: BullMQ handles fast asynchronous worker execution, bounded retries, and delay timers (quiet hours).
  - **Outage Resilience**: A periodic database sweeper job queries for unprocessed rows older than a threshold (e.g. 2 minutes) and re-enqueues them into BullMQ. If Redis goes down, events accumulate safely in PostgreSQL and are processed once Redis recovers (`AC-WH-04`).
- *Cons*: Slightly higher architectural complexity.

## Decision & Rationale
Adopt the **Dual-Layer Architecture**:
1. **Queue Runtime**: BullMQ over Redis for notification dispatch, webhook processing, and deferred delivery.
2. **Persistence Boundary**:
   - Webhooks: Persisted first in `payment_events` (`UNIQUE (provider, provider_event_id)`).
   - Notifications: Persisted first in `notification_deliveries` (`UNIQUE dedupe_key`).
   - Directory Sync: Outbox table in tenant shard with reconciliation sweeper.
3. **Resilience Sweeper**: A background task (node-cron / interval) checks for unprocessed inbox entries with `processed_at IS NULL` and enqueues missing jobs.
4. **Phasing & Simplicity Guardrail (`D-29`)**:
   - In Milestone M1, background queues and Redis are NOT required; M1 is strictly focused on tenant context, schema, and isolation proofs.
   - The PostgreSQL transactional tables are the durable, authoritative source of truth. BullMQ is strictly an ephemeral dispatcher. In development and test environments, jobs can be processed directly via database sweeper intervals without requiring a persistent Redis cluster.

## Consequences
- **Positive**: Strict zero-event-loss guarantee under Redis failures; complete idempotency across retries; observable job status directly in the database.
- **Negative**: Requires maintaining sweeper queries and indexes on `(status, received_at)` in the control plane.

## Evidence & Verification
- Redis outage simulation test: Stop Redis, ingest signed webhook, verify HTTP 200 and database persistence. Start Redis, verify sweeper processes event exactly once (`AC-WH-04`).
- Idempotent delivery test: Simulate worker failure during notification fan-out; verify zero duplicate push deliveries (`AC-NOT-03`).
