# Rule: Scheduling Consistency, Shift Swaps, Attendance, and Offline Behavior

## Behavior Enforced
This rule enforces time-zone integrity for shifts and staffing requirements, strict draft/review/publish lifecycles, optimistic and stale-resistant swap workflows, bounded attendance tracking, and read-only offline schedule caching.

## 1. Shift Data Model and Time-Zone Discipline
- **Shift Entity Model (`FR-SCH-007`, `FR-SCH-010`, `C-07`)**:
  - Every shift belongs to exactly one `department_id` and `branch_id` in the tenant plane.
  - Staff assignees must belong to the shift's department (`AC-DM-02`).
  - Stored timestamps: `starts_at` and `ends_at` must be stored as UTC instants (`TIMESTAMPTZ`).
  - Business time zone: Stored as an IANA time zone identifier (e.g. `Africa/Lagos`) on the business record. Mobile display and operational day boundaries use the business time zone (`BR-013`).
  - Overnight shifts crossing local midnight are valid and must be explicitly tested.
- **Staffing Requirements (`FR-SCH-009`)**:
  - Staffing requirements are stored as local wall-clock times (e.g. `08:00 - 16:00`) tied to the business time zone and recurring weekdays.
  - Generating shifts from recurring requirements must preserve local wall-clock hours across Daylight Saving Time (DST) transitions.
- **Shift Lifecycle (`FR-SCH-005`, `AC-SCH-02`)**:
  - Stages: `draft` -> `review` -> `published` -> `cancelled`.
  - Staff see only published shifts in their schedule views.
  - Publishing, editing, or cancelling a published shift triggers notification jobs to affected workers only (`FR-SCH-006`, `FR-SCH-008`, `BR-002`).

## 2. Conflict Detection and Reasoned Overrides
- **Detected Conflicts (`FR-SCH-004`, `BR-001`, `AC-SCH-01`)**:
  - Overlapping shifts for the same worker.
  - Headcount shortages against published staffing requirements.
  - Shift assignments conflicting with submitted staff availability.
- **Reasoned Overrides (`FR-AVL-003`, `BR-005`, `AC-RBAC-03`)**:
  - Availability conflicts warn managers but do not hard-block assignment creation.
  - Overriding an availability or overlap conflict requires an authorised manager role (Owner, GM, or assigned Supervisor).
  - The API must reject any override attempt that lacks a non-empty `override_reason`.
  - The server records `override_reason`, `override_by` (membership ID), and `override_at` (timestamp) directly on `shift_assignments`.

## 3. Shift Swaps Lifecycle and Concurrency (`FR-SWP-001` to `007`)
- **Same-Department & Same-Branch Eligibility (`FR-SWP-006`, `AC-SCH-05`)**:
  - A shift swap is permitted only between active members of the same business and the same home department/branch (`D-05`).
  - Cross-department and cross-branch swaps are strictly forbidden in V1.
  - The counterpart must have no overlapping shift and no unoverridden availability conflict.
- **Three-Stage Workflow (`BR-004`)**:
  1. **Request**: Requester initiates swap specifying their shift, counterpart worker, and counterpart shift. The server records the `version` of both shifts at request time.
  2. **Acceptance**: Counterpart accepts. The server re-verifies that both shifts still match their recorded versions.
  3. **Manager Approval**: An authorised manager approves. The server again verifies shift versions and atomic swap completion.
- **Stale Swap Invalidation (`FR-SWP-004`, `FR-SWP-007`, `BR-003`, `AC-007`)**:
  - Shifts have a monotonic `version` integer incremented on every edit.
  - If either shift is edited, rescheduled, reassigned, or cancelled while a swap request is pending, acceptance or approval must fail with HTTP 409 `STALE_SWAP`.
  - Stale swaps cannot be resurrected; a new swap request is required.

## 4. Attendance and Absence Scope Control
- **In-Scope Boundary (`FR-ATT-001`, `FR-ATT-002`, `AC-SCH-07`)**:
  - Authorised managers (Supervisor, GM, Owner) record `present`, `late`, or `absent` against an assignment on a published shift.
  - Recording an absence automatically enqueues a high-priority notification to relevant managers.
- **Strictly Excluded Features (`FR-ATT-003`)**:
  - Self clock-in, geofencing, QR codes, biometrics, leave management, and automated payroll calculations are excluded from V1.
  - Agents must not implement endpoints, schemas, or hooks for these excluded features.

## 5. Offline Schedule Viewing (`FR-OFF-001` to `005`, `D-28`)
- **Read-Only Invariant (`FR-OFF-003`, `AC-OFF-02`)**:
  - Mobile offline access is strictly read-only in V1.
  - Shift creation, edits, cancellations, availability submissions, and swap requests cannot be queued or replayed offline.
- **Cache Scoping and Invalidation (`FR-OFF-004`, `AC-OFF-01`)**:
  - Caches up to 14 days of the user's published shifts (`OQ-013`).
  - The UI must display a clear "Last updated <timestamp>" indicator.
  - Cache storage is keyed by `user_id`, `business_id`, and `branch_id`.
  - On logout, business context switch, branch switch, detected session revocation, or account deletion, the local client offline cache must be completely wiped.
