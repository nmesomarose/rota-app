# DR-01: Payment Simulation Boundary, Currency Strategy, and Renewal Model

## Status
`ACCEPTED (Engineering Decision)` — Preserves unresolved Gate G-01 (Paystack/Flutterwave merchant capabilities) and Gate FX-01 (Live FX provider selection). Baseline implementation proceeds with visibly labelled simulation per D-25.

## Context
Rota requires server-authoritative billing with USD as the base list price schedule (`PRD 8.1`, `D-23`, `19.5`), server-calculated NGN quotes dynamically derived from a configured FX rate source, and support for proration, scheduled downgrades, and failed-renewal recovery.

Crucially:
- **Gate G-01**: Account capabilities and test-mode access for Paystack and Flutterwave (specifically USD charges, NGN recurring charges, webhook raw-body verification, and idempotency) are **NOT VERIFIED**.
- **Gate FX-01**: Live exchange-rate source, polling frequency, and freshness thresholds are **NOT VERIFIED**.
- **Decision D-25**: The product owner mandated building a visibly labelled simulated payment provider first, before attempting real integrations.

## Alternatives Considered

### 1. Direct Real Provider Integration (Paystack or Flutterwave)
- *Pros*: Tests real payment gateway from day one.
- *Cons*: High risk of blockers due to unverified merchant account capabilities, missing credentials, API downtime, or card testing restrictions in Nigeria/US accounts. Contradicts `D-25` and milestone sequencing.

### 2. Static NGN Price List
- *Pros*: Simple to code, no FX conversion.
- *Cons*: Explicitly rejected and superseded by `D-23`. The owner wants NGN amounts to reflect real-world exchange rates.

### 3. Simulation-First Architecture with Deterministic Test FX Fixtures (Recommended)
- *Pros*: Allows end-to-end development and automated testing of quotes, confirmation, checkout redirects, webhook processing, ledger entries, proration vectors (`PR-01` to `PR-16`), and failed-renewal state machines without external gateway dependencies. Real integration is isolated behind an adapter interface once Gate `G-01` is resolved.
- *Cons*: Requires building a mock provider UI/endpoint.

## Decision & Rationale

1. **Simulation-First Provider (`D-25`)**:
   - Build a `SimulatedPaymentProvider` implementing the provider contract interface (`initiateCheckout`, `verifyTransaction`, `generateWebhookPayload`).
   - Mock checkout screen displays a clear banner: `*** SIMULATED PAYMENT ENVIRONMENT - NO REAL MONEY IS CHARGED ***`.
   - Simulated payments generate mock webhook payloads with valid HMAC signatures for the raw-body verification pipeline.

2. **Currency and Dynamic FX Quote Strategy (`D-23`, `AC-FX-01` to `06`)**:
   - USD is the authoritative base schedule (Starter 2000c, Team 5000c, Business 12000c).
   - In development/testing, FX rates use deterministic labelled test fixtures (`AC-FX-06`).
   - When live FX is configured, the server fetches the rate at quote time, binds source/rate/timestamp/version/expiry, and calculates NGN kobo server-side.
   - If the rate source is unavailable or stale, fail closed with HTTP 503 / 409 retry (`AC-FX-03`). Never guess rates.
   - Confirmed quotes and ledger entries are immutable (`AC-FX-04`).

3. **Renewal Model (`PRD 19.5`)**:
   - Use **Application-Managed Renewal Quotes**: Prior to renewal, the server calculates a renewal quote with the current rate and notifies the Owner.
   - If unpaid at period end, subscription enters `past_due` with 7-day grace and retries on days 1, 3, 5 (`D-13`, `D-21`), entering `restricted` mode on day 7 (`BILL-030`).

## Consequences
- **Positive**: Complete independence from external payment gateways during core development. Proration unit tests (`AC-009`) and webhook idempotency (`AC-010`) can be verified immediately.
- **Negative**: Live credit card processing will require closing Gate `G-01` before production release.

## Evidence & Verification
- Unit test suite verifying `PR-01` through `PR-16`.
- Webhook signature and replay test harness (`AC-WH-01` to `07`).
- Ledger replay state reconstruction test (`AC-LED-01`).
