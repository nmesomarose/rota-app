# Rule: Source of Truth, Precedence, and Scope Control

## Behavior Enforced
This rule enforces strict adherence to authoritative project documents, defines precedence when requirements overlap, forbids speculative feature expansion, and prohibits fabricating resolutions for open gates or unverified external dependencies.

## 1. Document Precedence Hierarchy
Engineering agents must resolve requirements strictly in the following order:
1. **`PRD.md` (v0.3)**: Authoritative specification for product behavior, acceptance criteria, data models, and amendments. Where earlier clauses (v0.1/v0.2) conflict with Section 19, Section 19 is authoritative.
2. **`AGENTS.md`**: Project-wide engineering conduct, safety protocols, and verification rules, except where it conflicts with `PRD.md`.
3. **Approved Decision Records (`DR-xx`)**: Documented and approved architecture/implementation decisions (`ARCHITECTURE.md`).
4. **Automated Tests**: Executable verification of specified behavior. Tests provide evidence of conformance; they never grant permission to contradict or weaken PRD requirements.

If `PRD.md` and `AGENTS.md` or any other source conflict, **stop and report the exact conflict**. Never silently choose an arbitrary resolution.

## 2. Unresolved Gates and Open Questions
The following gates and questions are explicitly open and must be treated as unresolved blockers for their dependent milestones:
- **Gate G-01 / DR-01**: Payment provider capabilities, supported charge currencies, webhook formats, and recurring charge models for USD and NGN are **UNVERIFIED**. Real provider integration is blocked until DR-01 is approved; simulated provider workflows must be used during development.
- **Gate FX-01**: Live USD/NGN exchange-rate provider, polling frequency, freshness threshold, and outage behaviors are **UNVERIFIED**. Hardcoded or guessed live rates are forbidden; deterministic, labelled test fixtures must be used in tests.
- **Gate G-02**: Google OAuth credentials and platform configuration. If unavailable, fall back to email/password authentication only.
- **Gate G-03 / OQ-025**: Written privacy policy, NDPA compliance review, data retention periods, and deletion timelines.
- **OQ-012**: Maximum total seat ceilings on Team and Business tiers.
- **OQ-023**: Staff write capabilities during subscription-restricted mode (read-only schedule access and settings sync are approved; other actions remain restricted).
- **DR-02 through DR-06**: Specific choices for HTTP framework, background job queue, sharding router abstractions, session tokens, and client state management.

Never assume a gate is resolved, never invent credentials, and never hardcode unverified provider behaviors.

## 3. Scope Boundaries and Anti-Creep Discipline
- **In Scope (V1)**: Multi-business identity, multi-branch organisation, branch-scoped departments and staff, shift scheduling, availability and reasoned overrides, shift versioning and same-branch swaps, simplified attendance/absence logging, role-scoped activity feed, push/in-app notifications, read-only offline shift viewing, server-authoritative billing quotes with proration, and two-shard logical simulation.
- **Deferred [P]**: Magic link authentication, self clock-in, geofencing, biometrics, payroll export, leave management, cross-department swaps, cross-branch swaps, offline shift/swap mutations, web administrative portal, tablet layouts, and personal-data export (`PRIV-008`).
- **Excluded**: Labour-law compliance engines, automated biometric verification, and live currency trading.

Do not write code, schemas, or migrations for deferred or excluded items unless an explicit, approved PRD amendment is provided.

## 4. Stop Conditions
Agents must halt and seek human instruction when:
1. A task requires behavior defined by an unclosed gate (e.g. attempting live billing without DR-01).
2. A contradiction between PRD.md and AGENTS.md or code is discovered.
3. A proposed change would alter public API contracts, billing semantics, tenant boundaries, or data retention without an approved decision record.
4. A test failure exposes a security flaw, tenant leak, or financial ledger corruption.
5. An action risks data loss or executes destructive migrations.
