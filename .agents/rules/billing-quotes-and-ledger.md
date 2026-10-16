# Rule: Billing, Exchange Rates, Quotes, Payment Simulation, and Ledger Safety

## Behavior Enforced
This rule enforces server-authoritative billing calculations, strict immutable financial ledgers, safe handling of USD base prices and dynamic NGN quotes, clear separation between payment simulation and verified real payments, and resilient renewal failure state machines.

## 1. Monetary Representation and Base Price Schedules
- **Integer Minor Units (`C-13`, `PRD 0.3`)**:
  - All money must be stored as integers in the currency's minor units (USD cents, NGN kobo).
  - Floating point money storage or arithmetic is strictly forbidden.
- **Authoritative Base Price Schedule (`D-23`, `PRD 19.5`)**:
  - Starter: $20.00 / month (2000 cents), up to 5 seats, extra seats not allowed.
  - Team: $50.00 / month (5000 cents), up to 15 seats, $3.00 / month (300 cents) per additional seat.
  - Business: $120.00 / month (12000 cents), up to 40 seats, $2.00 / month (200 cents) per additional seat.
  - Cost formula: `cost(plan, q) = base(plan) + extra_rate(plan) * max(0, q - included(plan))`.
  - USD list prices are the single base schedule. **Do not invent a fixed NGN price list.**

## 2. Dynamic Exchange Rates and NGN Quotes (`D-23`, `AC-FX-01` to `06`)
- **Server-Side Conversion at Quote Time**:
  - NGN amounts are calculated on the server when a quote is requested, using a configured exchange-rate source.
  - The client may show an indicative estimate with an explicit "Estimate" label, timestamp, and staleness warning, but the client **never calculates or dictates payable amounts**.
  - Quotes must bind: USD base amount, FX rate, rate source ID, retrieval timestamp, rounding version, NGN minor units, subscription version, and expiry.
- **Unavailable or Stale FX Rates (`AC-FX-03`, Gate `FX-01`)**:
  - If the configured FX source is unreachable, invalid, or exceeds freshness thresholds, the backend must fail closed and return HTTP 503 / 409 with a retry hint.
  - Guessed, hardcoded, or unverified live exchange rates are forbidden.
  - In automated test suites, tests must use deterministic, explicitly labelled test fixtures (`AC-FX-06`).
- **Quote Immutability (`AC-FX-04`)**:
  - Subsequent FX rate fluctuations must never alter a confirmed quote, an open payment intent, or a committed ledger entry.

## 3. Server-Generated Quotes and Payment Intents
- **Quote Lifecycle (`BILL-013`, `BILL-014`, `AC-BILL-01`, `AC-BILL-02`)**:
  - Quotes are generated on the server only upon request by an active Owner (`BR-006`, `AC-BILL-03`).
  - Quote expires at `min(created_at + 15 minutes, next_local_midnight)`.
  - Confirmation requires an idempotency key (`BILL-008`). The server re-evaluates version and recalculates amount. Stale or expired quotes return HTTP 409 `QUOTE_STALE` or `QUOTE_EXPIRED`.
- **Payment Intents (`BILL-022`, `AC-BILL-07`)**:
  - Exactly one open payment intent is allowed per business at a time. A second confirmation attempt while one is open returns HTTP 409 `PAYMENT_PENDING`.
  - **Confirmation grants nothing (`BILL-014`, `AC-BILL-04`).** Entitlements are applied solely upon processing verified payment confirmation.

## 4. Payment Simulation vs. Real Verified Payments
- **Simulation Rule (`D-25`, `AC-BILL-01`)**:
  - The project must build a fully functional, visibly labelled simulated payment provider first.
  - Simulated payment success must be labelled `SIMULATED` and must never be treated as real money received.
  - Real provider integration is blocked until Gate `G-01` / `DR-01` is formally resolved.
- **Real Payment Verification (`BILL-006`, `BILL-007`, `SEC-007`)**:
  - Real payments require verified server-side evidence:
    1. Verify HMAC webhook signature over the **raw unparsed body**.
    2. Store event in control-plane `payment_events` with unique constraint `(provider, provider_event_id)` (`C-09`).
    3. Re-verify transaction status with the provider's verify endpoint if supported (`BILL-006`).
    4. Match status, amount minor units, currency, and provider reference against the open `payment_intent`. Mismatches are rejected, alerted, and grant zero entitlement.
    5. Apply subscription entitlement and write append-only ledger entries within a single database transaction.

## 5. Proration and Scheduled Changes (`BILL-001`, `004`, `016`, `D-11`, `D-22`)
- **Proration Formula**:
  - `amount = floor( Δmonthly * remaining_days / period_days )`.
  - `period_days` and `remaining_days` are calculated using calendar days in the **business's configured IANA time zone** (`PR-14`).
  - Prorated amounts round down to the nearest integer minor unit (`BILL-004`).
  - All test vectors `PR-01` through `PR-16` must pass.
- **Scheduled Reductions and Downgrades (`BILL-018`, `019`, `020`, `AC-BILL-02`)**:
  - Seat reductions and plan downgrades take effect at the next renewal; no immediate credit or refund is granted.
  - A downgrade is rejected immediately (`DOWNGRADE_EXCEEDS_LIMIT`) if current usage exceeds target plan capacity (`PR-12`).
  - A seat reduction is rejected immediately (`SEAT_REDUCTION_EXCEEDS_USAGE`) if the new quantity is less than current usage (`PR-13`).
  - An immediate upgrade cancels any scheduled downgrade (`BILL-020`, `PR-10b`).
  - Staff members must never be silently deactivated to fit scheduled limits.

## 6. Immutable Financial Ledger (`C-08`, `BILL-010`, `BILL-028`, `AC-013`)
- **Append-Only Invariant**:
  - The `ledger_entries` table must have database triggers blocking all `UPDATE` and `DELETE` queries.
  - Each entry has a monotonic sequence number scoped to the business.
  - Reversals and adjustments are recorded as new rows with opposing values; original records are immutable.
  - Ledger replay across all events must reproduce exact current subscription state (`BILL-025`, `AC-LED-01`).

## 7. Failed Renewal State Machine (`D-13`, `D-21`, `BILL-011`, `BILL-030`)
- **State Progression (`AC-FR-01` to `06`)**:
  - **Day 0 (`past_due`)**: Renewal charge fails. Full access continues. Urgent notice sent to all Owners bypassing quiet hours (`FR-NOT-008`). Persistent in-app banner displayed.
  - **Days 1, 3, 5**: Retried with incremented attempt logging.
  - **Day 7 (`restricted`)**: Without verified payment, system enters restricted mode.
- **Restricted Mode Boundaries (`AC-FR-05`)**:
  - **Blocked**: Shift creation, edits, deletion, publishing; assignments; swap approvals; attendance recording; invitations; quotes for upgrades or seats.
  - **Allowed**: Staff read-only schedule viewing; notifications and inbox; user settings; Owner payment of outstanding balance.
