# Rota: Security Architecture & Threat Model

## 1. Security Overview
Security and multi-tenant isolation are foundational requirements for Rota (`AGENTS.md` Section 3, `PRD 11`). The platform adopts a zero-trust architecture toward client inputs:
- Authentication, authorization, and tenant scope are validated exclusively on the server for every protected operation.
- Client-supplied tenant IDs, role claims, prices, or payment statuses are never trusted.
- Database mechanisms (RLS, composite foreign keys, transaction-scoped variables) enforce isolation independently of application logic.

---

## 2. Threat Model Matrix (`PRD 11.3`, `SEC-006`)

The following threat matrix analyzes 14 candidate threats and documents their architectural and cryptographic mitigations:

| # | Threat Description | Attack Vector / Impact | Architectural Mitigation | Verifying Criteria |
|---|---|---|---|---|
| **1** | **Cross-Business Data Access** | Malicious tenant manipulates UUIDs (IDOR) or connection pool leaks tenant context across requests. | `SEC-010`: Transaction-scoped `SET LOCAL app.current_business_id`.<br>`SEC-011`, `C-03`: Forced RLS on all tenant tables.<br>`SEC-012`: Composite foreign keys.<br>`SEC-015`: Resources outside active tenant return 404. | `AC-001`<br>`AC-TEN-01`<br>`AC-TEN-02`<br>`AC-TEN-04` |
| **2** | **Privilege Escalation** | Supervisor or Staff crafts API calls to invite an Owner or escalate their own role. | `FR-RBAC-005`, `FR-ORG-002`: Server strictly evaluates inviter role matrix.<br>`D-02`: Only an Owner can appoint an Owner.<br>`BR-023`: Demotion immediately revokes pending invites.<br>`FR-RBAC-004`: Denials audit logged. | `AC-RBAC-01`<br>`AC-RBAC-02`<br>`AC-INV-06` |
| **3** | **Refresh-Token Theft / Replay** | Attacker intercepts a refresh token and attempts session hijack. | `FR-AUTH-004`, `SEC-020`: Refresh tokens belong to cryptographic families. Use of a consumed token outside the 10s grace window terminates the entire family immediately and raises a security alert. | `AC-AUTH-01`<br>`AC-003` |
| **4** | **Invitation Link Hijack / Reuse** | Attacker intercepts or brute-forces an invitation link or code. | `FR-AUTH-007`, `C-10`: Tokens stored only as salted hashes.<br>`D-26`: Single-use, expiring (72h).<br>`SEC-019`: Must be accepted by a verified email matching the invitation record. | `AC-INV-01`<br>`AC-INV-02`<br>`AC-INV-04` |
| **5** | **Webhook Forgery / Replay** | Malicious actor posts forged payment confirmation webhooks to grant free subscriptions. | `SEC-007`: HMAC signature verified over the raw byte body before JSON parsing.<br>`C-09`, `BILL-007`: Unique constraint on `(provider, provider_event_id)` drops duplicates.<br>`BILL-006`: Server verifies status with provider API. | `AC-WH-01`<br>`AC-WH-02`<br>`AC-WH-03` |
| **6** | **Account Takeover via Identity Linking** | Attacker creates a Google account with victim's email and attempts to link. | `FR-AUTH-011`, `SEC-019`: Linking requires verified email from Google **and** verified local email.<br>Linking to an existing password account requires re-entering current password. | `AC-AUTH-04` |
| **7** | **Brute-Force & Credential Stuffing** | Automated brute-force attacks against login and password reset endpoints. | `SEC-004`, `PRD 11.2`: Redis rate limiting enforced per account and per IP (e.g. 5 login failures per 15 min).<br>`SEC-008`: Argon2id password hashing prevents offline hash cracking. | `AC-AUTH-06`<br>`AC-AUTH-11` |
| **8** | **Quote Tampering & Amount Manipulation** | Client attempts to alter payable amounts or swap currencies in billing requests. | `BILL-013`, `BILL-014`: All quotes calculated on server. Quotes bind currency, amount, version, expiry, and line items. Stale quotes rejected.<br>`D-23`: NGN amounts derived server-side. | `AC-BILL-01`<br>`AC-BILL-02`<br>`AC-BILL-05` |
| **9** | **Seat-Limit Race Condition** | 20 parallel invitation acceptances attempt to bypass the 5-seat plan limit. | `BILL-009`, `BR-007`: Database transaction locks the `subscriptions` row (`FOR UPDATE`), counts active members, and blocks excess before insertion.<br>Redis is never the gatekeeper. | `AC-SEAT-01`<br>`AC-012` |
| **10** | **Push-Token Leakage across Shared Devices** | Former worker receives notifications intended for another user on a shared phone. | `FR-NOT-012`: Push tokens are unique and unregistered upon logout; new login reassigns token to the active user.<br>`FR-NOT-011`: Unregistered device receipts immediately delete tokens. | `AC-NOT-04`<br>`AC-NOT-05` |
| **11** | **Cross-Tenant Cache Contamination** | Cache entry from Business A is served to a user in Business B. | `SEC-014`: All Redis keys must include the `tenant:<business_id>:` prefix.<br>Branch keys include `branch:<branch_id>:`. Helper functions strictly enforce prefixing. | `AC-TEN-05` |
| **12** | **Stale Data Left on Shared Mobile Device** | User logs out or switches business, but offline shifts from prior business remain visible. | `FR-OFF-004`, `AC-OFF-01`: Client completely purges local storage, TanStack query cache, and offline SQLite/MMKV stores upon logout, context switch, or session revocation. | `AC-OFF-01`<br>`AC-BR-05` |
| **13** | **Financial Ledger Tampering** | Rogue actor or bug attempts to edit or delete historical ledger rows. | `C-08`, `BR-010`: Database blocking triggers prevent all `UPDATE` and `DELETE` actions on `ledger_entries`. Corrections must be new reversal rows (`BILL-028`). | `AC-013`<br>`AC-LED-02` |
| **14** | **Denial of Service via Redis Outage** | Redis goes down, causing authentication, seat admission, or billing failures. | `NFR-REL-002`: Rate limiters fail closed safely.<br>Session checks fall back to authoritative DB.<br>Seat limits are unaffected (DB row lock).<br>Webhooks accumulate safely in Postgres inbox. | `AC-AUTH-06`<br>`AC-WH-04` |

---

## 3. Mobile Configuration & Secret Hygiene (`SEC-005`, `AC-OPS-08`)

1. **Zero Secrets in Client Bundle**:
   - The React Native mobile bundle must contain zero API secrets, database credentials, or private encryption keys.
   - Any variable exposed to the client must use the `EXPO_PUBLIC_` prefix and be strictly public configuration (e.g. `EXPO_PUBLIC_API_URL`).
2. **Credential Storage on Device**:
   - Access and refresh tokens are stored exclusively in hardware-backed storage via `expo-secure-store` (`FR-AUTH-009`).
   - Automated CI static analysis checks assert that `AsyncStorage` is never imported for credential handling (`AC-AUTH-07`).

---

## 4. Privacy, Deletion, and Compliance (`PRIV-001` to `008`, Gate `G-03`)

1. **Account Deletion Flow (`AC-PRIV-01`, `AC-PRIV-02`)**:
   - Users can request deletion via mobile app.
   - Sole active Owners are blocked from deletion until another Owner is appointed (`PRIV-003`).
   - Upon deletion, user sessions and push tokens are revoked, memberships terminated, and personal identifiers in activity logs pseudonymized (replaced with "Former Member").
   - Financial ledger entries are retained unchanged for legal accounting compliance (`PRIV-005`).
2. **Nigeria Data Protection Act (NDPA) Review**:
   - A formal `PRIVACY-RETENTION.md` policy must be reviewed prior to production launch (Gate `G-03`).
