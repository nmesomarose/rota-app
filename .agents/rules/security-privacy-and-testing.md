# Rule: Security, Privacy, Defensive Architecture, and Testing Standards

## Behavior Enforced
This rule enforces server-side authentication and session defense, zero secret exposure, strict Zod input validation, fail-closed rate limiting, privacy and NDPA deletion protocols, and mandatory negative, cross-tenant, and concurrency testing.

## 1. Authentication and Session Security
- **Token Lifecycles (`FR-AUTH-003`, `FR-AUTH-004`, `SEC-020`)**:
  - Access tokens are short-lived (15 minutes).
  - Refresh tokens belong to a cryptographic family per session. Tokens rotate on every refresh.
  - Concurrent refresh attempts within the server grace window (10 seconds) receive the same successor token.
  - Refresh token reuse outside the grace window immediately revokes the **entire family**, terminates the session, and emits a high-priority security audit event (`AC-AUTH-01`).
- **Session Authorisation Checks (`FR-AUTH-005`, `FR-AUTH-013`, `FR-RBAC-006`)**:
  - Every authenticated tenant request must verify active session and membership status in the database.
  - Logout, logout-all, password reset, and account deletion revoke existing sessions immediately (`AC-AUTH-02`).
  - Role demotion, branch transfer, suspension, or deactivation applies on the very next request.
- **Client Credential Storage (`FR-AUTH-009`, `AC-AUTH-07`)**:
  - Auth tokens must be stored exclusively in `expo-secure-store`.
  - Storing auth tokens in `AsyncStorage` is strictly prohibited. Static analysis checks must verify this in CI.

## 2. Input Validation and Standard API Shapes (`SEC-003`, `PRD 10`)
- **Strict Boundary Validation**:
  - Every external request body, query parameter, and path variable must be validated using **Zod schemas**.
  - Any validation failure must return HTTP 400 with error code `VALIDATION_ERROR` and detailed field errors (`AC-OPS-09`).
- **Standardized Error Envelope**:
  - All errors must match the canonical schema:
    ```json
    {
      "error": {
        "code": "STRING_ERROR_CODE",
        "message": "Human-readable description",
        "requestId": "uuid",
        "details": {}
      }
    }
    ```
  - Internal database errors, stack traces, SQL syntax, and provider payloads must never be exposed to clients.

## 3. Secret Hygiene and Observability Redaction (`SEC-005`, `AC-OPS-08`)
- **Zero Secrets in Mobile Bundle**:
  - Only non-sensitive public configuration may use the `EXPO_PUBLIC_` prefix (e.g. API base URL). Every public variable must be documented and justified.
- **Log and Event Redaction (`FR-OPS-002`, `AC-OPS-02`)**:
  - Never log passwords, raw tokens, webhook signature secrets, payment card details, or sensitive personal data.
  - Request IDs must be injected into every incoming HTTP request and attached to all downstream structured log lines (`FR-OPS-001`, `AC-OPS-01`).

## 4. Rate Limiting and Resilience (`SEC-004`, `11.2`, `NFR-REL-002`)
- **Dual-Key Rate Limits**:
  - Enforced per IP and per account on sensitive endpoints: login, password reset, invitation creation, invitation acceptance, and billing quote/confirmation (`PRD 11.2`).
- **Fail-Closed on Redis Outage (`NFR-REL-002`, `AC-AUTH-06`)**:
  - If Redis is unavailable, rate limiters for auth, invitations, and payments must **fail closed** by returning HTTP 503 `DEPENDENCY_UNAVAILABLE` with a retry hint.
  - Caches must bypass to the database; seat admission remains unaffected as it relies on database row locks (`BILL-009`).

## 5. Privacy, Account Deletion, and Data Retention (`PRIV-001` to `005`, Gate `G-03`)
- **Deletion Workflow (`AC-PRIV-01`, `AC-PRIV-02`)**:
  - Users can initiate account deletion within the mobile app.
  - If a user is the sole active Owner of a business, deletion is blocked until another Owner is appointed or the business is formally dissolved (`PRIV-003`).
  - Upon deletion: active sessions and push tokens are deleted, business memberships are terminated, and personal identifiers in activity logs are pseudonymized (e.g. replaced with "Former Member").
  - Financial ledger entries are retained unchanged for legal compliance (`PRIV-005`).
- **Gate Compliance**:
  - Specific retention periods and NDPA compliance remain gated by `G-03`. Do not implement irreversible data destruction policies without an approved `PRIVACY-RETENTION.md`.

## 6. Mandatory Testing and Verification Protocols
Before any task or milestone is declared complete, the following tests and evidence must be executed and documented:
1. **Cross-Tenant & Cross-Branch Tests (`AC-001`, `AC-TEN-01`, `AC-BR-04`)**:
   - Automated table-driven tests verifying that a token from Business A accessing Business B resources returns HTTP 404 and changes zero state.
   - Verifying that a Supervisor in Branch 1 cannot access Branch 2 resources.
2. **Database RLS Catalog Test (`AC-TEN-02`)**:
   - Automated assertion that every table with `business_id` has RLS enabled and forced.
3. **Pool Interleaving Test (`AC-TEN-04`)**:
   - 500 concurrent requests across multiple businesses over a constrained connection pool verifying zero cross-tenant contamination.
4. **Concurrency Race Tests (`AC-SEAT-01`)**:
   - 20 parallel invitation acceptances against 1 remaining seat; exactly 1 must succeed and 19 must fail with HTTP 409 `SEAT_LIMIT_REACHED`.
5. **Proration Vector Tests (`AC-009`)**:
   - All unit test vectors `PR-01` through `PR-16` must pass without deviation.
6. **Performance & Scale Evidence (`NFR-PERF-001` to `003`, `AC-015`, `AC-ACT-05`, `AC-OPS-04`)**:
   - 200 concurrent virtual users load test scripts and results documented before and after caching (`AC-015`).
   - Query performance evidence: `EXPLAIN ANALYZE` execution plans documented for each activity feed audience type across at least 10,000 seeded events (`AC-ACT-05`, `AC-014`).
   - Connection pool sizing documentation and exhaustion test demonstrating queuing rather than failure (`AC-OPS-04`).
