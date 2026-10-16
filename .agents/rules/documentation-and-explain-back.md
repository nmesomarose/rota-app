# Rule: Required Documentation, Decision Records, and Explain-Back Expectations

## Behavior Enforced
This rule enforces synchronized project documentation, formal decision record maintenance, transparent plain-language explain-back for AI-assisted modifications, and strict definition-of-done criteria before declaring any engineering task complete.

## 1. Required Living Documentation
The following living documents must be maintained and updated as code evolves:
- **`README.md`**: Project overview, environment setup, local run instructions, and service dependencies.
- **`ARCHITECTURE.md`**: Architectural component design, control plane vs tenant plane layout, data flow, ERD, and external integrations.
- **`SECURITY.md`**: Threat model detailing at least eight threat scenarios mapped directly to their architectural mitigations (`SEC-006`, `PRD 11.3`).
- **`SHARDING.md`**: Two-shard simulation architecture, hash routing function, cross-shard query catalog, and large-tenant limitations (`NFR-SCALE-002`, `AC-SH-04`).
- **`STATE.md`**: Current milestone progress, completed acceptance criteria, active workstreams, and known blockers.
- **`LEARNING-LOG.md`**: Ongoing log of technical discoveries, edge cases encountered, and patterns established.
- **`PRIVACY-RETENTION.md`**: Data retention schedules, pseudonymization rules, and deletion protocols (`PRIV-002`, Gate `G-03`).

Never claim a feature or capability exists in documentation when it is merely planned or partially scaffolded.

## 2. Decision Record Standard (`DR-xx`)
For any material architecture, library, protocol, or design choice, a Decision Record must be created or updated with the following structure:
- **ID & Title**: e.g. `DR-01: Payment Provider & Currency Strategy`.
- **Status**: Must be explicitly marked `PROPOSED`, `APPROVED`, or `REJECTED`.
- **Context**: Problem statement, background constraints, and relevant PRD requirements.
- **Alternatives Considered**: Viable alternatives evaluated with pros and cons.
- **Decision & Rationale**: The chosen option and why it satisfies requirements.
- **Consequences**: Positive effects, trade-offs, operational overhead, and migration impact.
- **Evidence**: Executable proof, benchmark results, or provider documentation references.

## 3. Plain-Language Explain-Back Expectations
When presenting changes or completing a task, the agent must provide an explain-back in clear, accessible language covering four distinct dimensions:
1. **What Changed**: Specific files created or modified, interfaces added, and database schema updates.
2. **Why It Works**: Rationale connecting the implementation directly to PRD requirements and architectural invariants.
3. **What Could Fail**: Edge cases considered, concurrency failure modes, external dependencies, and how partial failures are handled.
4. **How It Was Verified**: Exact automated test suites, linter commands, and verification checks executed, with truthful pass/fail outputs.

## 4. Definition of Done (DoD)
A task or milestone is considered DONE only when:
- All targeted acceptance criteria from `PRD.md` are demonstrably satisfied.
- Multi-tenant isolation and branch-scoped authorization have been verified.
- Concurrency, error handling, and transactional integrity checks have run.
- Real verification commands have been executed (not assumed) and their outputs reported truthfully.
- Relevant documentation (`STATE.md`, `LEARNING-LOG.md`, API contracts) is updated.
- All remaining limitations, open questions, and gated dependencies are explicitly highlighted.
- No application code or configuration is committed or pushed without human approval.
