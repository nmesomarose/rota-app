# DR-05: Authentication, Session Lifecycle, and Token Revocation Design

## Status
`ACCEPTED (Engineering Decision)` — Dual-layer token architecture and database session model adopted. Gate G-02 (Google OAuth credentials) preserved as pending provider verification; baseline proceeds with email/password authentication.

## Context
Rota requires multi-business identity (`D-01`), short-lived access tokens, refresh token family rotation, immediate session revocation upon security events, and secure credential storage (`PRD 6.1`, `11.1`).

Key constraints:
1. **Token Lifetimes (`FR-AUTH-003`, `OQ-009`)**: Proposed 15 minutes for access tokens; refresh session 30 days idle, 90 days absolute.
2. **Family Rotation & Grace Window (`FR-AUTH-004`, `SEC-020`)**: Reuse outside the grace window (proposed 10 seconds) revokes the whole family.
3. **Session Verification on Every Request (`FR-AUTH-005`, `FR-AUTH-013`)**: The database is the authoritative source of session revocation and membership status. Demotions, suspensions, or deactivations must take effect on the next request (`FR-RBAC-006`).
4. **Mobile Storage (`FR-AUTH-009`)**: Auth tokens must use `expo-secure-store`, never `AsyncStorage`.
5. **Google Sign-in Gate (`G-02`)**: OAuth credentials remain unverified; email/password is the primary baseline.

## Alternatives Considered

### 1. Stateless Pure JWT Tokens with Long Expiry
- *Pros*: Fast, no database lookup on API requests.
- *Cons*: Cannot immediately revoke access on logout-all, role change, deactivation, or token theft without distributed blacklists. Violates `FR-AUTH-005` and `FR-RBAC-006`.

### 2. Opaque Bearer Tokens Looked Up in Redis
- *Pros*: Immediate revocation; simple revocation checks.
- *Cons*: If Redis crashes, all sessions fail. Violates `NFR-REL-002` (database must remain authoritative for session checks).

### 3. Dual-Layer Token Architecture: Short-Lived Access Token + Authoritative DB Session Check (Recommended)
- *Pros*:
  - Access token contains user ID and active `business_id` (15-minute lifetime).
  - Middleware checks `sessions` and `memberships` tables in the database (or a short-lived Redis cache with immediate DB fallthrough) to verify session validity and caller role on every tenant request (`FR-RBAC-006`).
  - Refresh tokens are stored strictly as SHA-256 hashes in control-plane `refresh_tokens`.
  - Refresh rotation issues a new token and records parent linkage.
  - Concurrent refreshes within 10 seconds receive the existing valid successor token, preventing race-condition logout bugs on mobile networks.
  - Reuse of an already-consumed refresh token outside the grace window triggers immediate revocation of all tokens in that family (`SEC-020`).
- *Cons*: Requires an extra lightweight query per authenticated request (mitigated by index on `(session_id, user_id)`).

## Decision & Rationale
Adopt the **Dual-Layer Token Architecture**:
1. **Access Tokens**: Short-lived (15 minutes), signed with asymmetric (RS256) or HMAC (HS256) keys.
2. **Refresh Sessions**:
   - `sessions` row tracks device ID, user ID, active business, and revocation status.
   - `refresh_tokens` row stores `token_hash`, `family_id`, `expires_at`, and `used_at`.
   - Single-flight refresh on mobile client (`TanStack Query` / custom fetch interceptor) coupled with 10-second server grace window.
3. **Password Security (`SEC-008`)**:
   - Passwords hashed with **Argon2id** (memory cost 64MB, 3 iterations, 4 parallelism).
4. **Token Storage (`FR-AUTH-009`)**:
   - Stored on device via `expo-secure-store`. Static analysis linting in CI forbids importing `AsyncStorage` for auth keys (`AC-AUTH-07`).
5. **Gate G-02 Strategy**:
   - V1 baseline is email/password with single-use hashed verification tokens (`FR-AUTH-012`).
   - If Google OAuth credentials are confirmed by M2, Google Sign-in will be enabled with email-verified identity linking (`FR-AUTH-011`); otherwise, deferred without blocking launch.

## Consequences
- **Positive**: Immediate enforcement of role demotions, suspensions, and logouts; mobile single-flight token rotation prevents network race conditions; robust secret hygiene.
- **Negative**: Requires careful indexing on the `sessions` table in the control plane.

## Evidence & Verification
- Unit test for concurrent refresh within 10-second window returning same successor token (`AC-AUTH-01`).
- Unit test verifying token reuse outside grace window revokes the whole family (`AC-AUTH-01`).
- Immediate rejection test after logout-all (`AC-AUTH-02`).
- Static analysis test verifying zero auth token storage in `AsyncStorage` (`AC-AUTH-07`).
