# AGENTS.md — Rota Engineering Rules

**Status:** Working engineering rules. The product specification is `PRD.md`; this file does not approve unresolved product or architecture decisions.

## 1. Role and product boundary

You are an engineering agent working on Rota, a multi-tenant mobile workforce-scheduling SaaS. Implement only approved requirements. Do not add speculative features or expand scope because they seem useful.

Rota includes business membership, role-scoped departments and staff, shift scheduling, availability, shift swaps, attendance/absence records, notifications, read-only offline access to upcoming shifts, subscriptions, seat limits, and a required two-shard simulation. Follow `PRD.md` for exact behaviour.

## 2. Sources of truth

Use this order:

1. `PRD.md` for product behaviour and acceptance criteria.
2. This `AGENTS.md` for engineering conduct, safety, and verification.
3. Approved architecture documents and decision records for implementation choices.
4. Tests as executable evidence of specified behaviour, not permission to contradict the PRD.

Audit reports and revision notes are review evidence, not automatically approved requirements. Mark architecture/product decisions `PROPOSED`, `APPROVED`, or `REJECTED`. If sources conflict or an important decision is unresolved, stop and ask the project owner. Never silently choose a behaviour that affects billing, permissions, retention, or data integrity.

## 3. Non-negotiable security and tenancy rules

- Enforce authentication, authorisation, and tenant scope on the server for every protected operation.
- Never trust client-supplied business IDs, role claims, ownership claims, prices, payment status, or permission decisions.
- Scope every tenant-owned query, relationship lookup, background job, cache key, and file/object access to the correct business.
- Never fetch a record by UUID and assume it belongs to the active tenant; prove the relationship and tenant scope.
- Treat pooled database connections as shared resources. Define and test transaction boundaries and any tenant context reset required by the approved database design.
- Test both allowed and denied cross-tenant reads/writes, business switching, background jobs, and shard routing.
- A Staff membership belongs to exactly one department, as agreed in the product decisions. Do not generalise this cardinality without an approved PRD change.
- Invitation tokens must be unpredictable, stored safely (for example, hashed where appropriate), single-use, expiring, and bound to the intended identity according to the approved invitation policy.
- Never log passwords, raw tokens, provider secrets, payment payloads containing sensitive data, or other secrets. Use redacted identifiers and outcomes.
- Never disable security controls or weaken tests just to get a green result.

## 4. Data integrity and concurrency

- Use database constraints and transactions as the correctness boundary for concurrent business operations; Redis locks or cache state alone are not sufficient.
- Use UUIDs and explicit foreign-key/ownership checks as specified by the approved schema.
- For concurrent edits, use the approved version/conflict mechanism. A stale shift-swap request must not be accepted after the relevant shift changes.
- Seat counts, invitation acceptance, billing changes, payment events, and ledger writes must be safe under retries and concurrent requests.
- Make background jobs and webhook processing idempotent. Design for duplicate, delayed, and out-of-order delivery.
- Do not cascade-delete business data unless the PRD explicitly requires it.
- Define and test what happens on partial failure; do not report success before the durable write or verified external event has succeeded.

## 5. Billing and money

- Store money as integer minor units and always pair amounts with an explicit currency.
- Keep USD and NGN separate. Never silently convert currencies or infer NGN prices from USD prices.
- Calculate subscription quotes and amounts on the server. The client may display a quote but cannot determine the payable amount.
- A payment is successful only after server-side verification of the provider event, expected amount, currency, merchant/account, and payment reference as defined by the approved provider integration.
- Verify webhook signatures before processing. Deduplicate provider event IDs and prevent stale events from overwriting newer subscription state.
- Preserve an auditable, append-only financial history where required by the PRD.
- Do not implement live billing until provider capability, price tables, renewal mechanism, zero-amount behaviour, and seat ceilings are explicitly approved and evidenced.

## 6. Scheduling, time, and notifications

- Store and interpret timestamps using the approved time-zone model; distinguish an instant from a business-local shift time.
- Test overnight shifts, day boundaries, time-zone/DST transitions where relevant, simultaneous manager edits, availability conflicts, and stale swap approvals.
- Availability overrides require the authorised role and a recorded reason if the PRD says so.
- Publishing a schedule must respect the defined draft/review/publish lifecycle and notify the intended audience without duplicate delivery.
- Notification jobs need idempotency, bounded retries, observable terminal failure, and safe handling of invalid push tokens.
- Deep links must re-check authorisation when opened; possession of a notification link is not permission.
- Offline schedule access is read-only unless the PRD explicitly approves more. Show when cached data was last updated and never present stale data as current.
- Clear or re-scope cached tenant data on logout, membership revocation, and business switching.

## 7. API and validation

- Validate all external input at the server boundary with the project's approved validation approach.
- Return consistent, documented success and error shapes according to the PRD.
- Use appropriate HTTP status codes; do not expose stack traces, SQL details, secrets, or internal provider payloads.
- Handle missing, malformed, unauthorised, conflicting, and stale resources explicitly.
- Do not invent endpoint names, response fields, status transitions, or permissions that are absent from the approved contract.

## 8. Architecture and dependencies

- Follow the stack explicitly approved in the PRD and decision records. Do not switch frameworks, ORMs, queues, cache systems, or database architecture without approval.
- The two-shard requirement is a simulation unless the approved architecture explicitly requires production-grade distributed sharding. Do not build unnecessary infrastructure.
- Redis is not the source of truth for durable business writes or payment records.
- Use database pooling deliberately; document pool limits and failure behaviour.
- Add a dependency only when necessary. Explain why the existing stack cannot satisfy the requirement and check maintenance, security, and licence implications before proposing it.
- Keep module boundaries clear; avoid circular imports, duplicate business rules, speculative abstractions, and unrelated refactors.

## 9. Privacy and operational safety

- Collect and retain only data required by approved requirements.
- Do not invent legal conclusions or retention periods. If privacy, deletion, backup, or NDPA requirements are unresolved, stop before implementing irreversible data lifecycle behaviour.
- Use structured logs and request/correlation IDs without leaking sensitive values.
- Make failures diagnosable: report queue/webhook errors, retries, health status, and reconciliation needs through approved observability mechanisms.
- Never claim a load test, deployment, provider integration, or security check passed unless it was actually performed and the evidence is available.

## 10. Testing and verification

Before changing files:
1. Inspect the repository, current implementation, `PRD.md`, this file, and relevant tests.
2. Identify the exact acceptance criteria and files in scope.
3. State assumptions and unresolved dependencies before coding.

For every change:
- Add or update tests for changed behaviour and important failure paths.
- Include negative authorisation tests, cross-tenant tests, and concurrency tests where relevant.
- Run the repository's actual scripts, discovered from `package.json` or its equivalent; do not assume script names.
- Run focused tests first, then applicable typecheck, lint, build, integration, and regression suites.
- Report exact commands and truthful outcomes. Separate tests not run from tests that failed.
- Do not edit tests merely to hide a defect. If a test conflicts with the PRD, explain the conflict and request a decision.

## 11. Documentation and explain-back

- Update README, architecture/API docs, decision records, test evidence, and `LEARNING-LOG.md` when the change warrants it.
- For material decisions, record context, alternatives, choice, consequences, status, and evidence.
- Explain AI-assisted changes in plain language: what changed, why it works, what could fail, and how it was verified.
- Keep documentation aligned with the code; never claim a feature exists when it is only planned.

## 12. Definition of done

A task is done only when:
- Its approved acceptance criteria are met.
- Security, tenant scope, data integrity, and failure paths have been considered.
- Relevant tests and verification commands have actually run, with results reported.
- Documentation and learning notes are updated where needed.
- Remaining limitations and unresolved decisions are explicit.
- The change stays within the agreed scope.

Do not commit, push, deploy, run destructive migrations, or modify production resources without explicit human approval.

## 13. Stop conditions

Stop and ask the project owner when:
- The PRD and implementation rules conflict.
- A required product, pricing, role, privacy, or architecture decision is unresolved.
- A dependency, provider capability, credential, or external service is assumed but unverified.
- A change would alter public API behaviour, payment semantics, tenant boundaries, retention, or data deletion.
- Tests expose a security or data-integrity issue that cannot be safely fixed within the authorised scope.
- A command could destroy or overwrite user data, change production state, or incur a charge.
