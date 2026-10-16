---
name: verify-task-completion
description: >-
  Use this skill before declaring any task, feature, refactor, or milestone complete
  to verify PRD acceptance criteria, tenant isolation, test suite execution,
  secret hygiene, documentation updates, and plain-language explain-back.
---

# Skill: Verify Task Completion

This workflow guides the end-of-task verification process, ensuring that all implementation changes are safe, thoroughly tested, strictly within scope, and properly documented before declaring completion.

## When to Use
- Concluding any feature implementation or bug fix.
- Completing a development milestone or sub-milestone.
- Before submitting work for human review or requesting approval to proceed.

## Steps to Follow

### 1. Scope and Gate Verification
- Review modified and created files against the task scope and `PRD.md`.
- Confirm that no deferred or excluded features were accidentally introduced.
- Verify that unresolved gates (`G-01` real provider billing, `FX-01` live exchange rates, `G-02` Google OAuth, `G-03` NDPA policy) remain unassumed.

### 2. Execute Automated Verification Commands
- Discover project test, lint, and typecheck scripts from `package.json` or project configuration.
- Execute focused tests for the changed components first.
- Execute the full test suite, including:
  - Unit tests.
  - Cross-tenant isolation harness (`AC-TEN-01`).
  - Cross-branch permission checks (`AC-BR-04`).
  - Proration vector tests (`AC-009`).
  - Database RLS catalog tests (`AC-TEN-02`).
- Execute linting and static type checking (`npm run lint`, `npm run typecheck` or equivalents).
- Record exact commands and their truthful terminal outputs.

### 3. Secret Hygiene and Bundle Inspection
- Inspect modified files and recent logs to ensure no passwords, plain tokens, provider secrets, or customer PII are logged.
- If frontend files were modified, verify that no secret keys are exposed and that all `EXPO_PUBLIC_` variables are documented and strictly non-sensitive (`SEC-005`, `AC-OPS-08`).

### 4. Database and Tenant Integrity Check
- If schema migrations were touched:
  - Confirm all tenant-plane tables have `business_id NOT NULL` and `FORCE ROW LEVEL SECURITY`.
  - Confirm composite primary and foreign keys include `business_id`.
  - Confirm `ledger_entries` has append-only triggers blocking updates and deletions.

### 5. Update Living Documentation
- Update `STATE.md` with completed acceptance criteria, active milestone status, and next steps.
- Update `LEARNING-LOG.md` if any technical patterns, gotchas, or architectural lessons were discovered.
- If architecture or decision boundaries were touched, update `ARCHITECTURE.md` or the corresponding Decision Record (`DR-xx`).

### 6. Formulate Plain-Language Explain-Back
- Prepare an explain-back statement addressing:
  1. **What Changed**: Specific files, endpoints, schemas, and configurations created or modified.
  2. **Why It Works**: Direct mapping between the code changes and PRD requirements/business rules.
  3. **What Could Fail**: Edge cases, race conditions, external outages, or partial failure modes considered and mitigated.
  4. **How It Was Verified**: Exact automated test suites executed with concrete pass/fail outcomes.

## Verification
1. Compare git status and diff against the original task prompt.
2. Confirm that all tests ran and passed. Do not declare completion if any test failed or was commented out.
3. Confirm that no application code was generated if the prompt restricted the scope to rules/skills.

## Required Output
- Complete verification checklist report.
- Summary of executed commands and actual test output.
- Documentation updates summary (`STATE.md`, `LEARNING-LOG.md`).
- Structured plain-language explain-back.
