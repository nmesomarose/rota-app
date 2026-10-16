---
name: implement-billing-and-ledger
description: >-
  Use this skill when implementing billing quotes, FX exchange-rate calculations,
  payment intent workflows, payment simulation, webhook processing, proration vectors,
  failed-renewal state machines, and immutable financial ledgers.
---

# Skill: Implement Billing Changes with Quote and Ledger Safety

This workflow guides the implementation of Rota's server-authoritative billing engine, dynamic exchange-rate quotes, simulated and verified payment processing, and append-only financial ledgers.

## When to Use
- Implementing subscription tier changes, seat additions, or plan quotes.
- Integrating exchange-rate sources and NGN currency quote conversions.
- Building the simulated payment provider or test-mode checkout flow.
- Implementing durable, idempotent webhook inboxes and event processors.
- Writing financial ledger records, proration formulas, and audit replays.
- Implementing renewal failure, grace periods, and restricted mode.

## Steps to Follow

### 1. USD Base Calculation and Server-Side Quotes (`D-23`, `BILL-013`, `19.5`)
- Authoritative base monthly schedule:
  - Starter: 2000 USD cents (5 seats included, extra seats not permitted).
  - Team: 5000 USD cents (15 seats included, 300 USD cents per extra seat).
  - Business: 12000 USD cents (40 seats included, 200 USD cents per extra seat).
- Evaluate `cost(plan, q) = base(plan) + extra_rate(plan) * max(0, q - included(plan))`.
- When an Owner requests an NGN quote:
  - Query configured FX rate source. In tests, use deterministic, explicitly labelled test fixtures (`AC-FX-06`).
  - If rate source is unavailable or stale, return HTTP 503 / 409 retry (`AC-FX-03`). Never guess or use stale rates.
  - Calculate NGN kobo server-side with documented integer rounding.
  - Create `billing_quotes` row binding: USD base amount, FX rate, source ID, timestamp, rounding rule, calculated minor units, currency, subscription version, and expiry (`min(now + 15m, next_local_midnight)`).

### 2. Quote Confirmation and Payment Intents (`BILL-014`, `022`, `AC-BILL-02`, `07`)
- Require active Owner authentication (`BR-006`). GM, Supervisor, and Staff get HTTP 403.
- Require an idempotency key (`BILL-008`).
- Verify quote is unexpired, open, and subscription version is unchanged.
- Ensure no other payment intent is in `awaiting_payment` status for the business (`BILL-022`).
- Create `payment_intents` row in `awaiting_payment` state.
- **Grant zero entitlement upon confirmation (`BILL-014`, `AC-BILL-04`).** Return provider checkout reference.

### 3. Payment Simulation Implementation (`D-25`, `AC-BILL-01`)
- Build the simulated payment provider first:
  - Provide a mock hosted checkout endpoint.
  - Label all UI outputs and database records with `SIMULATED`.
  - Simulate success, failure, and timeout scenarios.
  - Deliver webhook payloads through the standard webhook ingestion pipeline.

### 4. Durable Webhook Ingestion (`BILL-006`, `007`, `C-09`, `AC-WH-01` to `07`)
- **Step 1: Raw Signature Check**: Verify HMAC signature over raw unparsed body. Reject invalid signatures with HTTP 400 (`AC-WH-01`).
- **Step 2: Inbox Persistence**: Store in control-plane `payment_events` with unique `(provider, provider_event_id)` constraint. Return HTTP 200 immediately. Duplicate events are safely acknowledged and ignored (`AC-WH-02`).
- **Step 3: Background Processor**: Job fetches matching `payment_intents` row. Assert that amount minor units, currency, status, and reference match exactly. Flag mismatches as `rejected_mismatch` and grant nothing (`AC-WH-03`).
- **Step 4: Atomic Entitlement**: In one database transaction:
  1. Lock subscription row (`FOR UPDATE`).
  2. Update subscription plan, seats, and period dates.
  3. Insert monotonic append-only `ledger_entries` record.
  4. Mark payment intent `paid` and payment event `processed`.

### 5. Append-Only Financial Ledger (`C-08`, `BILL-010`, `BILL-028`, `AC-013`)
- Configure database blocking triggers preventing `UPDATE` and `DELETE` on `ledger_entries`.
- Write ledger entry with monotonic per-business sequence number, amount minor units, currency, quote ID, and intent ID.
- Adjustments or refunds must be written as separate reversal rows (`BILL-028`, `AC-LED-02`).

### 6. Proration Engine (`BILL-004`, `BILL-016`, `PR-01` to `PR-16`)
- `amount = floor( Δmonthly * remaining_days / period_days )`.
- `period_days` and `remaining_days` derived from calendar days in the business's configured IANA time zone (`PR-14`).
- Upgrades and added seats take effect immediately upon verified payment.
- Seat reductions and downgrades take effect at the next renewal; no immediate credit or refund (`BILL-018`, `AC-BILL-02`).
- If an immediate upgrade is confirmed while a downgrade is scheduled, cancel the scheduled downgrade (`BILL-020`, `PR-10b`).

### 7. Failed-Renewal Lifecycle (`D-13`, `D-21`, `BILL-011`, `BILL-030`)
- **Day 0**: Transition subscription to `past_due`. Emit urgent push notice to Owners bypassing quiet hours (`FR-NOT-008`). Display persistent in-app banner.
- **Days 1, 3, 5**: Schedule renewal retry jobs, logging attempt numbers.
- **Day 7**: Transition subscription to `restricted`. Block manager scheduling mutations, invitations, and quote creation (`AC-FR-05`). Allow published schedule reads, settings sync, and Owner balance payment.
- **Recovery**: Verified payment at any point restores `active` status and lifts restrictions (`AC-FR-06`).

## Verification
1. **Proration Unit Tests (`AC-009`)**: Run test suite executing all 16 vectors `PR-01` through `PR-16`; assert exact integer results match PRD table.
2. **Webhook Security**: Test invalid signature rejection (`AC-WH-01`), duplicate event idempotency (`AC-WH-02`), and amount/currency mismatch rejection (`AC-WH-03`).
3. **Ledger Immutability**: Attempt direct SQL `UPDATE` and `DELETE` on `ledger_entries`; assert database trigger raises exception (`AC-013`).
4. **Ledger Replay (`AC-LED-01`)**: Replay all historical ledger rows for a test business; assert reproduced plan and seat state matches live subscription record.
5. **Renewal State Machine (`AC-FR-01` to `06`)**: Simulate failed renewal, retries on days 1, 3, 5, entry into restricted mode on day 7, and successful recovery payment.

## Required Output
- Billing and quote services, exchange-rate adapters, and proration logic.
- Simulated payment provider and webhook inbox handlers.
- Immutable ledger schema, trigger migrations, and replay test harness.
- Test execution report demonstrating passing PR-01 to PR-16 vectors and webhook security.
