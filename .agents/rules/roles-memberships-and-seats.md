# Rule: Roles, Memberships, Invitations, and Seat Accounting

## Behavior Enforced
This rule enforces role-based access control, multiple Owner safeguards, the distinction between termination and suspension, single-department branch cardinality, secure dual-channel invitations, and database-transactional seat admission across the entire business.

## 1. Role Hierarchy and Permissions Matrix
The system recognizes four roles: **Owner**, **General Manager (GM)**, **Department Supervisor**, and **Staff** (`PRD 4.1`, `4.5`).
- **Owner Appointment and Removal (`D-02`, `D-16`, `BR-015`)**:
  - Only an active Owner can appoint another Owner.
  - An Owner may remove or demote another Owner, but the business must always retain at least one active Owner (`AC-RBAC-02`).
  - The last active Owner cannot be removed, demoted, deactivated, or deleted.
- **Rostering Privileges (`D-17`, `AC-RBAC-01`)**:
  - Owners, GMs, and Supervisors may be assigned to shifts as workers in departments within their authorised scope.
  - When rostered, they are subject to the same scheduling, availability, conflict, and override rules as Staff.
- **Supervision Cardinality (`D-18`, `C-06`, `AC-DM-05`)**:
  - A Supervisor may oversee multiple departments within their authorised branch scope.
  - `department_supervisors` rows must reference a membership whose role is explicitly `Supervisor`.
- **Staff Cardinality (`D-05`, `D-33`, `C-05`, `AC-DM-01`)**:
  - A Staff membership belongs to exactly one department within exactly one branch.
  - Database constraints must forbid null department IDs for Staff and forbid Staff membership in multiple departments.

## 2. Membership Termination vs. Temporary Suspension (`D-27`, `Section 19.4`)
- **Membership Termination (Deactivation)**:
  - Permanent end of employment in the specific business (`AC-MEM-01`).
  - Access is revoked immediately on the next authenticated request (`FR-RBAC-006`).
  - Sessions for that business are invalidated.
  - Historical records (past shifts, attendance, audit trails, ledger) are retained.
  - The worker is removed from future unpublished shifts, flagged on published shifts for manager attention, and any pending shift swaps involving them are cancelled (`BR-012`).
  - Identities and memberships in other businesses remain untouched.
- **Temporary Suspension**:
  - Authorized actor: Owner or GM; or Supervisor for Staff within their assigned department/branch scope only.
  - A manager cannot suspend an Owner.
  - Requires: explicit reason, actor ID, timestamp, optional expiry date, an audit log event, and a formal restoration action (`AC-MEM-02`).
  - Blocks access to this business immediately without deleting history or affecting memberships in other businesses.

## 3. Invitations Lifecycle (`D-03`, `D-26`, `Section 19.6`, `FR-AUTH-007`)
- **Authority Matrix (`AC-INV-06`)**:
  - **Owner**: May invite any role (Owner, GM, Supervisor, Staff) into any branch/department.
  - **GM**: May invite Supervisor or Staff into any branch/department within the GM's scope.
  - **Supervisor**: May invite Staff only, strictly into departments assigned to that Supervisor.
  - **Staff**: Cannot invite anyone (attempts return HTTP 403 and write an audit event).
- **Dual Delivery Format (`D-26`, `Section 19.6`, `AC-INV-01`)**:
  - Supports both an HTTPS app link (Universal Link / Android App Link) and an associated short invitation code.
  - Link and code represent the **same underlying invitation record** and share identical single-use lifecycle, expiration (default 72 hours), and verification checks.
  - An invitation code is not a public or reusable join code. Code entry must validate the invitee's verified email.
- **Security & Token Hygiene (`C-10`, `AC-INV-02`, `AC-INV-04`)**:
  - Plaintext tokens/codes are never stored in the database or written to logs; only salted hashes are persisted.
  - Invitee email must be verified before acceptance can complete (`FR-AUTH-012`, `SEC-019`).
  - If the inviter is removed, deactivated, or demoted, all pending invitations created by them are immediately revoked (`BR-023`, `AC-INV-08`).
  - Invalid, expired, used, or revoked invitations return a uniform HTTP response: code `INVITATION_INVALID` (HTTP 410 or 400).

## 4. Business-Wide Seat Limits and Atomic Admission
- **Business-Wide Seat Scope (`D-20`, `Section 19.3`, `AC-BR-06`)**:
  - Staff seat limits apply across the entire business, not per branch or department.
  - Seat usage = count of **active** memberships in the business (`BILL-017`).
  - Each active member counts as 1 seat regardless of role, number of supervised departments, or branch assignment (`BR-016`).
  - Deactivated or suspended members do not consume seats.
  - Pending invitations **do not** reserve or consume seats.
- **Database-Enforced Transactional Admission (`BILL-009`, `BR-007`, `C-12`, `AC-SEAT-01`)**:
  - Acceptance of an invitation or reactivation of a member must execute in an isolated database transaction:
    1. Lock the business's `subscriptions` row (`FOR UPDATE`).
    2. Count current active memberships in the tenant plane.
    3. Evaluate current usage against the **admission limit**.
    4. If limit reached: Roll back transaction, leave invitation pending/unconsumed, emit notification to all Owners, and return HTTP 409 `SEAT_LIMIT_REACHED` (`AC-INV-09`).
    5. If under limit: Insert/reactivate membership and commit atomically.
  - **Redis must never be used as the admission gatekeeper.**
- **Admission Limit Calculation (`BILL-021`, `BR-018`, `AC-SEAT-03`)**:
  - `admission_limit = min(current_entitled_seats, scheduled_reduced_seats)`.
  - If a seat reduction or plan downgrade is scheduled for renewal, acceptance beyond the scheduled limit is blocked immediately.
