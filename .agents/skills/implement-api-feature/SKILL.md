---
name: implement-api-feature
description: >-
  Use this skill when implementing, extending, or refactoring an HTTP endpoint,
  API resource, or controller in the Rota backend to ensure strict Zod validation,
  standard error envelopes, tenant/branch authorization, and audit logging.
---

# Skill: Implement API Feature

This workflow guides the implementation of backend API endpoints adhering to Rota's architectural standards, boundary validation, and security invariants.

## When to Use
- Implementing a new route handler or API capability listed in `PRD.md` Section 10.
- Modifying request/response contracts for existing endpoints.
- Implementing role- or branch-restricted actions.

## Steps to Follow

### 1. Requirements and Scope Verification
- Locate the functional requirement ID (`FR-xxx`), business rule (`BR-xxx`), and acceptance criteria (`AC-xxx`) in `PRD.md`.
- Verify the endpoint is in V1 scope (not deferred or excluded).
- Identify required role privileges in the Permissions Matrix (`PRD 4.5`, `19.1`, `19.4`) and branch scoping rules (`PRD 19.2`).

### 2. Define Validation Schemas with Zod (`SEC-003`)
- Create strict Zod schemas for request body, URL path parameters, and query strings.
- Enforce bounds: string lengths, UUID formats, email normalization, and pagination limits (`limit` capped at 50).
- Reject extraneous or unrecognized fields (`.strict()`).

### 3. Route Handler Implementation
- Extract active `business_id` exclusively from the verified access token (`FR-AUTH-010`).
- If the endpoint is branch-scoped, validate the target `branch_id` against caller's authorized scope (`PRD 19.2`, `D-34`).
- If target resource belongs to another business or an unauthorized branch, return HTTP 404 `NOT_FOUND` (`SEC-015`). Never return 403 when revealing resource existence would leak data.
- Attach `requestId` from the incoming request context to all responses and internal logs (`FR-OPS-001`).

### 4. Role Authorization and Audit Logging
- Verify caller's role against database membership on every request (`FR-RBAC-006`).
- If permission is denied within the authorized branch, return HTTP 403 `FORBIDDEN`.
- For privileged actions (role change, ownership change, availability overrides) or denied privileged attempts, emit an audit log entry with actor ID, action, outcome, and request ID (`FR-RBAC-004`).

### 5. Return Canonical Response Envelopes
- Success responses return resource payloads directly or paginated envelopes:
  ```json
  { "data": [...], "nextCursor": "string | null" }
  ```
- Error responses must follow the canonical envelope:
  ```json
  {
    "error": {
      "code": "ERROR_CODE_STRING",
      "message": "Human readable message",
      "requestId": "uuid",
      "details": {}
    }
  }
  ```

### 6. Contract Documentation
- Update or create the endpoint specification in API contracts documentation.

## Verification
1. **Schema Validation**: Send malformed, missing, and extra fields; verify HTTP 400 `VALIDATION_ERROR` with field details.
2. **Cross-Tenant Check**: Send request with valid token for Business A targeting Business B resource; verify HTTP 404 `NOT_FOUND`.
3. **Cross-Branch Check**: Send request with Supervisor token for Branch 1 targeting Branch 2 resource; verify HTTP 404 `NOT_FOUND`.
4. **Role Boundary Check**: Send request with unauthorized role (e.g. Staff calling shift delete); verify HTTP 403 `FORBIDDEN` and shift remains intact (`AC-002`).

## Required Output
- Route handler, controller, and Zod schema files.
- Automated route tests covering valid, invalid, unauthorized, and cross-tenant inputs.
- Updated API contract documentation.
