---
name: implement-scheduling-and-conflicts
description: >-
  Use this skill when implementing shift scheduling, wall-clock staffing requirements,
  conflict detection and reasoned overrides, shift versioning, shift swap workflows,
  attendance recording, or read-only offline schedule caching.
---

# Skill: Implement Scheduling Changes and Conflict Checks

This workflow guides the implementation of Rota's scheduling core, time-zone conversions, concurrency-safe shift swaps, and conflict management.

## When to Use
- Implementing shift management endpoints, calendars, and assignment algorithms.
- Building conflict detection engines (overlaps, shortage, availability).
- Creating the draft, review, and published schedule lifecycle.
- Implementing the three-stage shift swap protocol.
- Building manager attendance and absence logging.

## Steps to Follow

### 1. Model Shifts and Requirements with Time-Zone Correctness (`FR-SCH-007`, `009`)
- Store all shift boundaries (`starts_at`, `ends_at`) as UTC instants (`TIMESTAMPTZ`).
- Read the business IANA time zone from the tenant record for display and calendar boundaries (`BR-013`).
- For `staffing_requirements`: store start and end as local wall-clock times (e.g. `09:00:00`, `17:00:00`) tied to weekdays. Ensure shift generation from requirements remains invariant across Daylight Saving Time (DST) clock changes (`AC-SCH-03`).

### 2. Implement Conflict Detection Engine (`FR-SCH-004`, `BR-001`, `AC-SCH-01`)
- When creating or modifying shift assignments, evaluate:
  1. **Overlap Conflict**: Does the assigned member have another shift overlapping in time?
  2. **Shortage Conflict**: Does current assignment count fall below the published requirement?
  3. **Availability Conflict**: Does the assignment intersect the worker's submitted unavailable windows (`FR-AVL-001`)?
- Return conflict warnings in draft/review stage payloads.

### 3. Reasoned Availability Overrides (`FR-AVL-003`, `BR-005`, `AC-RBAC-03`)
- Do not hard-block assignment creation when an availability conflict occurs.
- If an override is submitted:
  - Check caller is an authorized manager for the department (Owner, GM, or assigned Supervisor).
  - Enforce non-empty `override_reason` string. Reject empty reasons with HTTP 400.
  - Store `override_reason`, `override_by`, and `override_at` on the assignment.
  - Write an audit event recording actor, subject, reason, and shift details.

### 4. Schedule Lifecycle and Notification Hooks (`FR-SCH-005`, `006`, `008`)
- State machine: `draft` -> `review` -> `published` -> `cancelled`.
- Restrict Staff visibility to `published` shifts only.
- On transition to `published`, or when editing a published shift, enqueue notification jobs exclusively for affected staff members whose assignments changed (`BR-002`, `AC-006`).

### 5. Shift Versioning and Optimistic Locking (`FR-SWP-007`)
- Every shift record must carry a `version INT NOT NULL DEFAULT 1`.
- Increment `version = version + 1` on every edit, rescheduling, reassignment, or cancellation.

### 6. Three-Stage Shift Swap Protocol (`FR-SWP-001` to `007`, `D-05`, `AC-SCH-05`)
- **Stage 1 (Request)**: Staff requests swap with a colleague in the same home department and branch. Record `requester_shift_version` and `counterpart_shift_version`.
- **Stage 2 (Acceptance)**: Counterpart accepts. In a transaction, lock both shifts and assert current versions match recorded versions.
- **Stage 3 (Approval)**: Authorized manager approves. In a transaction, re-assert both versions match.
- **Stale Swap Invalidation (`FR-SWP-004`, `AC-007`)**: If either shift version changed between request and approval, reject with HTTP 409 `STALE_SWAP`. Mark swap request `cancelled_stale`.

### 7. Attendance and Absence Logging (`FR-ATT-001`, `002`)
- Authorised manager submits status (`present`, `late`, `absent`) against a published shift assignment.
- If `absent` is logged, enqueue high-priority notification to relevant department managers.
- Exclude geofencing, clock-in, biometrics, and payroll features (`FR-ATT-003`).

## Verification
1. **Conflict Engine**: Assign overlapping shift; assert overlap conflict detected (`AC-SCH-01`).
2. **Reasoned Override**: Submit override without reason; assert HTTP 400. Submit valid reason; assert stored fields and audit log (`AC-RBAC-03`).
3. **Overnight and DST Transitions**: Create overnight shift across local midnight; verify correct local calendar date and duration. Test recurring 08:00 requirement across DST boundary (`AC-SCH-03`).
4. **Stale Swap Race**: Initiate swap request; edit requester shift; attempt counterpart acceptance; assert HTTP 409 `STALE_SWAP` (`AC-007`).
5. **Staff Deletion Safety**: Verify Staff cannot call shift delete directly (`AC-002`).

## Required Output
- Scheduling entity schemas and migrations.
- Conflict detection and validation logic.
- Shift swap state machine and optimistic versioning.
- Unit and integration tests covering scheduling scenarios, DST, and stale swap rejections.
