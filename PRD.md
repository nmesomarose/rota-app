Rota: Product Requirements Document
Field	Value
Version	0.3 (consolidated product decisions; authoritative requirements and amendments included below)
Date	2026-10-16
Status	DRAFT. Not approved for implementation
Supersedes	Version 0.1, archived unchanged as PRD-v0.1.md
Inputs	PRD v0.2 baseline; v0.2 audit and revision report; product-owner decisions D-01 to D-34 consolidated in this document
Product	Rota, multi-tenant team scheduling SaaS (Expo mobile app, Node.js backend)
Workspace	C:\Users\HomePC\Desktop\Graduation Project\Mobile-Apps


0. How to read this document
0.1 Status tags
Tag	Meaning
A (AGREED)	Decided by the product owner. D-nn points to the decision in section 0.5
P (PROPOSED)	Recommended here, awaiting approval
T (TBD)	Unresolved. Listed in section 17 with a gate or question ID. Not invented


A row may carry two tags (for example A (D-06) / P (values)): the rule is agreed, the quoted values are proposals.
0.2 ID scheme
FR-<AREA>-NNN functional, NFR-<AREA>-NNN non-functional, BR-NNN business rule, SEC-NNN security, BILL-NNN billing, PRIV-NNN privacy, AC-NNN and AC-<AREA>-NN acceptance, OQ-NNN open question, RISK-NNN risk, D-nn decision, G-nn decision gate, PR-nn proration test vector, C-nn data constraint, DR-nn decision record to be written.
IDs are never reused or renumbered. When v0.2 changes a v0.1 requirement it keeps the ID and the row says "(v0.2)". A requirement that no longer applies is marked WITHDRAWN and kept.
0.3 Money convention
Every stored amount is an integer in the minor unit of an explicit currency (USD cents, NGN kobo). USD is the base plan-price schedule. For NGN display and quotes only, the backend may calculate a naira equivalent using a configured exchange-rate source. Each quote is bound to its rate, source, retrieval time, amount, currency and expiry. A confirmed quote and historical ledger entry never change when the rate changes. No conversion is performed on existing payments, ledger entries or active subscription balances. See authoritative v0.3 amendments in section 19.
0.4 Change history
Version	Date	Summary
0.1	2026-10-15	Pass 1 draft
0.2	2026-10-15	Prior baseline; preserved in the v0.2 archive
0.3	2026-10-16	Consolidates decisions D-16 to D-34; adds branches, branch-scoped departments and access, business-wide seat limits, controlled USD-to-NGN exchange-rate quotes, invitations, membership termination and suspension. Section 19 is authoritative where older v0.2 clauses conflict.


v0.2 changes in detail
- Identity and tenancy: multi-business identity with explicit business switching (D-01); multiple Owners (D-02); single department per Staff membership, enforced in the database (D-05); control plane and tenant plane separated; row-level security, composite foreign keys, transaction-scoped tenant context and tenant-scoped cache keys made requirements.
- Auth: token and session model, concurrent-refresh handling and revocation rules (D-06); Google sign-in with verified-identity linking (D-07); hashed single-use invitation tokens delivered by HTTPS app links.
- Billing: USD and NGN as separate currencies (D-08); seat usage and admission rules (D-09); server-calculated, bound quotes (D-10, D-12); seat removals and downgrades at renewal with no immediate credit (D-11); failed-renewal state machine (D-13); durable idempotent webhook processing; provider and currency verification kept as gate G-01 and not verified in this revision.
- Notifications: urgent definition, mandatory categories with in-app fallback, idempotent delivery, receipts, offline cache clearing (D-14).
- Privacy: documented deletion and financial-retention policy required (D-15).
- Milestones: reordered. Tenant-aware data access and shard routing now come first (M1); a decisions-and-verification milestone (M0) precedes any feature.
- IDs whose meaning changed (kept): FR-AUTH-002, -003, -004, -005, -006, -007; FR-ORG-002; FR-RBAC-003; FR-SCH-007; FR-SWP-006; FR-NOT-008; BR-006, -007, -008, -011, -013, -014; BILL-004, -006, -007, -008, -009, -010, -011; SEC-001, -009.
- Superseded v0.1 text: the staff-in-several-departments rule (BR-014), the "one primary department" assumption, and the audit's three examples that used an immediate seat-removal credit (replaced by PR-08 and PR-09 under D-11).
- Acceptance criteria: AC-001 to AC-017 retained (AC-001, -004, -009, -010, -012 extended, none weakened); area-prefixed criteria added in section 14.
0.5 Decision register
ID	Decision (product owner)	Applied in
D-01	Multi-business identity. Users explicitly switch business; every request is scoped to the selected business	4.2, 4.4, FR-AUTH-010, FR-ORG-005, SEC-010
D-02	Multiple Owners. Only an Owner can appoint an Owner	4.2, 4.4, FR-ORG-006, FR-RBAC-005
D-03	Invitations: Owner any role; GM Supervisor or Staff; Supervisor Staff in assigned department only; Staff none	4.3, FR-ORG-002, FR-RBAC-005
D-04	Activity feed visibility follows role and scope; security events not visible to all staff	4.5, FR-ACT-005 to -007
D-05	A Staff member belongs to one department per business; enforced by database constraints and backend authorisation	4.2, FR-ORG-007, BR-014, section 9
D-06	Short-lived access tokens, refresh sessions, tested revocation, safe rotation	FR-AUTH-003 to -005, -013
D-07	Email/password and Google sign-in (subject to credentials). Linking requires verified identity	FR-AUTH-002, -011, -012, G-02
D-08	Superseded by D-23 (v0.3): USD base prices; NGN equivalents calculated only for display/quotes from a configured rate source; confirmed amounts and historical records remain immutable. Provider capability must be verified before live billing.	8.1, 8.7, BILL-012, BILL-023, G-01, section 19
D-09	Each active business membership counts once toward seats. Pending invitations are not billable until accepted; concurrent acceptance cannot bypass limits	8.2, BILL-009, BILL-017, BR-016
D-10	Paid additions need Owner confirmation of a server-calculated quote; entitlement only after server-verified payment	8.3, BILL-013 to -015, BR-022
D-11	Seat removals at next renewal, no immediate credit. Downgrades at period end, rejected if usage exceeds target limit. Upgrading cancels a scheduled downgrade	8.5, BILL-018 to -020, BR-008, BR-017
D-12	Proration uses actual period length and the business time zone; quotes bound to currency, subscription state, expiry and amount; stale quotes rejected; audit examples preserved and tested	8.4, 8.9, BILL-004, BILL-014, BILL-016
D-13	Failed renewal: 7-day grace, retries on days 1, 3, 5, Owner notified, then restriction; payment restores access	8.8, BILL-011, BILL-030
D-14	Urgent: shift changes within 12 hours and failed-renewal notices to Owners. Mandatory security and billing notices cannot be fully disabled; in-app fallback	12.2, FR-NOT-008, -009, -014
D-15	Account deletion follows a documented privacy and financial-retention policy	11.5, PRIV-001 to -008


1. Problem statement and product vision
Problem. Shift-based businesses (for example a supermarket with Checkout, Stock/Inventory, Customer Service, Security and Cleaning departments) run schedules in spreadsheets and chat groups. Shifts change without notice, availability is unknown, swaps are informal, and managers cannot see coverage gaps.
Vision. Rota lets any business organise departments, staff, shifts, availability, swaps and notifications from a phone, with each business fully isolated from every other, including for people who work at more than one business.
V1 success outcomes (measurable in section 14)
1. A manager can build, review and publish a week's schedule and staff are notified.
2. Staff can see upcoming shifts offline and request swaps.
3. Owners can subscribe, change seats and plans with server-authoritative billing.
4. No user can read or change another business's data.
5. A person who belongs to two businesses can switch between them without any data from one appearing in the other.
2. Target users and personas
Persona	Role	Goals	Pain today
Ada, Owner	Owner	Control cost, confirm charges, share ownership with a partner	Surprise bills, no oversight
Emeka, General Manager	GM	Cover every department, resolve conflicts fast	Phone calls to fix gaps
Ngozi, Department Supervisor (Checkout)	Supervisor	Fill shifts for her department only, invite her own staff	Staff unavailable without notice
Tunde, Cashier	Staff	Know his shifts, swap when needed, stay informed	Finds out about changes late; patchy data connection
Chioma, Staff at two businesses	Staff in two businesses	See each employer's shifts separately and never mixed	Two chat groups, missed clashes


3. Glossary
Term	Definition
Business / Tenant	One independent organisation. Tenant = Business [A]
business_id	Tenant-isolation, row-level security and shard-routing key [A]
Identity (user)	One global person record. May hold memberships in several businesses
Membership	A user's role and status in one business. At most one membership per user per business [P]
Active business	The business a session is currently scoped to
Home department	The single department a Staff membership belongs to
Session	A refresh-token family tied to one device login
Control plane	Unsharded data: identities, sessions, devices, push tokens, membership directory, payment-event inbox
Tenant plane	Data keyed by business_id, stored on one of two simulated shards
Seat usage	Number of active memberships in a business
Entitlement	What the business has paid for: plan and seat quantity
Quote	A server-calculated, expiring, single-use price for a change, bound to currency, subscription state and amount
Payment intent	A server record of an attempted payment, tied to a quote and a provider reference
Billing currency	The currency (USD or NGN) a subscription is priced and charged in
Draft / Review / Published	Schedule stages [A]
Ledger	Immutable financial record


4. Roles, permissions and tenant boundaries
4.1 Roles [A]
Owner, General Manager (GM), Department Supervisor, Staff. The GM oversees the business; departments may have their own supervisors.
4.2 Identity and membership model
Rule	Status
One global identity may hold memberships in several businesses; each membership has its own role, status and (for Staff) department (FR-ORG-005)	A (D-01)
At most one membership per user per business, so one role per business	A (D-01)
A business may have several Owners. Only an Owner can appoint another Owner (FR-ORG-006)	A (D-02)
A business always keeps at least one active Owner; the final active Owner cannot be removed, demoted, deactivated or deleted	A (D-16)
A Staff membership belongs to exactly one department in exactly one branch of its business (FR-ORG-007)	A (D-05)
Owners have access to all branches in their business. GM access is limited to the branches/departments explicitly granted by the permission model; neither role requires a Staff home department	A (D-34)
A Supervisor is assigned to one or more departments within authorised branch/business scope (department_supervisors)	A (D-18, D-34)
Owner, GM and Supervisor memberships can be rostered on shifts subject to normal availability, conflict and scope rules	A (D-17)
An Owner may remove or demote another Owner only if at least one active Owner remains	A (D-16)


4.3 Invitation permissions [A] (D-03)
Inviter	May invite	Department rule
Owner	Owner, General Manager, Supervisor, Staff	Staff require a department. Supervisors require at least one department assignment
General Manager	Supervisor, Staff	Any department of the business
Department Supervisor	Staff only	Only into a department the inviter is assigned to
Staff	Nobody	n/a


- The server enforces this from the inviter's membership at request time, never from the client. The role, branch and department are stored on the invitation.
- Acceptance MUST re-check that the invitation is unrevoked, unexpired, bound to the verified invited email, and still within the inviter’s current role and branch/department scope. Pending invitations are revoked if the inviter loses the required permission or the invitation is cancelled. The email link and invitation code refer to the same single-use invitation record.
- Pending invitations do not count as seats (BR-016). A full plan blocks acceptance, not creation (FR-AUTH-007, BR-007). The authoritative seat check and membership creation happen atomically at acceptance; an invitation code never bypasses verified-email binding or seat/permission checks.
4.4 Business context [A] (D-01)
- After login the user receives the list of their active memberships. If exactly one exists, it is selected [P]; otherwise the user must choose.
- Switching business is an explicit action (FR-AUTH-010). The server issues a new access token scoped to the chosen business; the session itself continues.
- Tenant context for every request comes from the token's business claim, never from the request body, path or headers supplied by the client. A path or body that names a different business is rejected.
- Membership role and status are read from the database on every tenant request, so demotion or deactivation takes effect on the next request (FR-RBAC-006).
- A push-notification link into another business never switches silently: the app asks first (FR-NOT-005).
- On a business switch, branch switch, logout, or detected revocation, the app clears or re-scopes every affected business/branch cache: query cache, offline shifts, badge counts and deep-link state (FR-OFF-004, D-28, D-31). Branch context is not authorisation; every request is checked server-side.
4.5 Permissions matrix
Action	Owner	GM	Supervisor	Staff
Edit business settings	Yes	Limited [T]	No	No
Create or rename departments [A]	Yes	Yes	No	No
Appoint an Owner [A] (D-02)	Yes	No	No	No
Invite	Per 4.3	Per 4.3	Per 4.3	No
Assign or change a department supervisor	Yes	Yes	No	No
Change a member's role	Yes, any role	Staff and Supervisor only [P]	No	No
Transfer Staff to another department	Yes	Yes	No	No
Deactivate or remove a member	Yes, subject to last-Owner protection (D-16)	Staff and Supervisor [P]	Staff in own authorised department/branch scope [P]	No
Create or edit shifts	Yes	Yes	Own department(s)	No
Delete shifts	Yes	Yes	Own department(s)	No [A]
Publish schedule	Yes	Yes	Own department(s) [P]	No
Override availability conflict, with reason [A]	Yes	Yes	Own department(s) [P]	No
Submit availability	n/a	n/a	Yes	Yes
Request or accept swap	n/a	n/a	Yes	Yes
Approve swap [A]	Yes	Yes	Own department(s) [P]	No
Record attendance or absence	Yes	Yes	Own department(s) [P]	No
View billing; request or confirm quotes; change plan or seats; pay	Yes (any Owner)	No	No	No
View own schedule	Yes	Yes	Yes	Yes
Activity feed	Scope per 4.6	Scope per 4.6	Scope per 4.6	Scope per 4.6


When the subscription is restricted (section 8.8) manager writes, new invitations and plan changes are blocked for every role except that an Owner can still pay the outstanding balance.
4.6 Activity-feed visibility [A] (D-04)
Events carry a department, an actor, a subject and a visibility class. Visibility is resolved on the server; the client never filters.
Event class	Owner	GM	Supervisor	Staff
Schedule published, shift changed or cancelled	Yes	Yes	Own department(s)	Only if the shift concerns them
Swap requested, accepted, rejected, approved	Yes	Yes	Own department(s)	Participants only
Availability override	Yes	Yes	Own department(s)	Subject only [P]
Attendance and absence	Yes	Yes	Own department(s)	Subject only
Member invited, joined, deactivated, transferred	Yes	Yes	Own department(s) Staff	No
Billing events	Yes	No	No	No
Security events (new device sign-in, session revoked, role change, ownership change)	Yes	No	No	Own events only


4.7 Tenant boundaries
- [A] Every business's data is isolated. Every backend query and mutation runs inside a tenant context for exactly one business_id (SEC-010 to SEC-018).
- [A] Permissions are enforced on the backend, not only in the UI.
- [A] Automated cross-tenant read and write tests are required (AC-001, AC-TEN-01 to AC-TEN-06).
5. Core user journeys
ID	Journey	Actors
J-01	Owner registers, creates a business, creates departments	Owner
J-02	Supervisor invites Staff into their department; invitee opens the HTTPS link, verifies email, joins the right business	Supervisor, Staff
J-03	Staff submits availability and preferences	Staff
J-04	Manager builds a draft schedule, sees conflicts, overrides with a reason, moves to review, publishes	Supervisor, GM
J-05	Staff views upcoming shifts online and offline	Staff
J-06	Staff requests swap; same-department colleague accepts; manager approves	Staff, Supervisor
J-07	Shift edited after a swap request; stale request rejected	System
J-08	Owner requests a quote for added seats or an upgrade, reviews the charge, confirms, pays via provider checkout; entitlement arrives after the verified webhook	Owner, System
J-09	Owner schedules a downgrade or seat reduction for the next renewal; an upgrade later cancels the scheduled downgrade	Owner
J-10	Renewal fails; Owners notified; retries on days 1, 3, 5; grace ends on day 7; restricted mode; payment restores access	Owner, System
J-11	User changes settings on one device; syncs to another	Any
J-12	Manager records absence; relevant managers notified	Supervisor
J-13	A user in two businesses switches business; the previous business's data disappears from the app	Staff
J-14	Invitation accepted while seats are full; invitation stays pending; Owners are told; Owner buys seats; invitee accepts again	Staff, Owner
J-15	An Owner appoints another Owner	Owner
J-16	A user requests account deletion; sole Owners must transfer ownership first	Any


6. Functional requirements
6.1 Authentication and sessions (AUTH)
ID	Requirement	Status
FR-AUTH-001	Register and log in with email and password	A
FR-AUTH-002	(v0.2) Google sign-in is supported, subject to gate G-02 (OAuth credentials and platform configuration available). If G-02 is not met by M2, V1 ships with email/password only and Google sign-in moves to deferred scope with no other requirement changing. Magic link is not in V1. The server validates the Google ID token (issuer, audience, expiry, email_verified)	A (D-07) / P (fallback, magic link deferral)
FR-AUTH-003	(v0.2) Access tokens are short-lived. Proposed lifetime 15 minutes; refresh session 30 days idle and 90 days absolute	A (D-06) / P (values, OQ-009)
FR-AUTH-004	(v0.2) Refresh tokens rotate within a per-session family. A reused token outside the grace window revokes the whole family and ends the session. Concurrent refresh is handled by a single-flight client and a server grace window (proposed 10 seconds) that returns the same successor token	A (D-06) / P (window)
FR-AUTH-005	(v0.2) Logout (this device) and logout from all devices. Revocation applies to refresh tokens and access tokens: session status is checked on every authenticated request (database is authoritative, Redis may cache)	A (D-06)
FR-AUTH-006	(v0.2) Password reset uses single-use, expiring tokens (proposed 30 minutes) stored as hashes. Responses are identical for known and unknown emails. A successful reset revokes all sessions	A / P (expiry)
FR-AUTH-007	(v0.2) Invitation links are HTTPS app links (Android App Links, iOS Universal Links), not custom URL schemes. The token is stored only as a hash, single-use, expiring (proposed 72 hours) and bound to the invited email. Acceptance requires a verified email, re-checks the seat admission limit transactionally (BILL-009) and, on success, creates the membership in the invited business only	A / P (expiry)
FR-AUTH-008	Account and session management screen: list devices and sessions, revoke one or all	P
FR-AUTH-009	Tokens are stored with expo-secure-store, never AsyncStorage	A
FR-AUTH-010	Business context: after login list the user's active memberships; an explicit switch action issues a new access token scoped to the chosen business	A (D-01)
FR-AUTH-011	Account linking requires verified identity: a Google identity links only if Google reports the email as verified and the local email is verified. Linking to an existing password account also requires current-password re-authentication	A (D-07) / P (re-authentication step)
FR-AUTH-012	Email verification with a single-use, hashed, expiring token. Unverified accounts cannot accept invitations, link identities or use billing	P
FR-AUTH-013	Session revocation triggers: logout, logout-all, password reset, account deletion. Removing or deactivating a membership blocks that business for the user's sessions on the next request. A role change takes effect on the next request (FR-RBAC-006)	A (D-06)


6.2 Access control (RBAC)
ID	Requirement	Status
FR-RBAC-001	Permissions are enforced on every API route server-side	A
FR-RBAC-002	Staff cannot delete shifts by calling the API directly	A
FR-RBAC-003	(v0.2) A Supervisor's authority is limited to their assigned departments, including invitations (section 4.3)	A (D-03) / P (other actions)
FR-RBAC-004	Denied privileged actions and privilege changes (role change, ownership change, override) are written to the audit log with actor, outcome and request ID	P
FR-RBAC-005	The role ceiling is enforced on invitation and role assignment per sections 4.3 and 4.5. Only an Owner can appoint an Owner	A (D-02, D-03)
FR-RBAC-006	Membership role and status are read from the database inside every tenant request; token claims are never trusted for role	P


6.3 Business, branches, departments, staff (ORG)
Authoritative v0.3 organisation model (D-31 to D-34): A business may have any number of branches in V1; there is no plan-specific branch cap. Each department belongs to exactly one branch, and each branch belongs to exactly one business. Staff have one department/branch assignment per business; a transfer updates that existing membership and must not create a second seat. Owners may access all branches; GM and Supervisor access is limited to explicitly authorised scope. Branch context is never treated as proof of permission.
ID	Requirement	Status
FR-ORG-001	Owner or GM creates branches and branch-owned departments; each branch may have its own department and staffing arrangement	A (D-32, D-33)
FR-ORG-002	(v0.2) Invitation permissions follow section 4.3	A (D-03)
FR-ORG-003	Deactivate or remove a worker; effect on shifts and swaps defined in BR-012	P
FR-ORG-004	Assign and change department supervisors	P
FR-ORG-005	Multi-business identity: one global identity, one membership per business	A (D-01)
FR-ORG-006	Multiple Owners are allowed. Only an Owner can appoint another Owner. A business always has at least one active Owner (BR-015)	A (D-02) / P (last-Owner rule)
FR-ORG-007	A Staff membership belongs to exactly one department in exactly one branch per business, enforced by database constraints and backend authorisation. An authorised Owner or GM can transfer the existing membership between departments/branches with an audit event and defined shift/swap handling	A (D-05, D-33)


6.4 Scheduling (SCH)
ID	Requirement	Status
FR-SCH-001	Shift calendar by day and week per department	A
FR-SCH-002	Manual shift assignment	A
FR-SCH-003	Shifts defined by staffing requirements	A
FR-SCH-004	Conflict detection: overlapping shifts, shortage against requirement, availability conflict	A
FR-SCH-005	Draft, review and publish stages	A
FR-SCH-006	Publishing notifies affected staff	A
FR-SCH-007	(v0.2) A shift stores a UTC start and end plus the business IANA time zone; overnight shifts supported; display uses the business time zone	P
FR-SCH-008	Cancelling or editing a published shift notifies affected staff	P
FR-SCH-009	Staffing requirements are stored as local wall-clock times with the business IANA time zone and generate shifts from them, so a daylight-saving change in a business's region does not move local times. Gap and overlap hours are documented	P
FR-SCH-010	A shift belongs to one department. Staff can only be assigned to shifts of their home department	A (derived from D-05)


6.5 Availability (AVL)
ID	Requirement	Status
FR-AVL-001	Staff submit availability and preferences	A
FR-AVL-002	Managers see availability conflicts	A
FR-AVL-003	An authorised manager overrides a conflict with a recorded reason; the reason, actor and time are stored	A


6.6 Shift swaps (SWP)
ID	Requirement	Status
FR-SWP-001	Staff request a swap	A
FR-SWP-002	An eligible colleague must accept	A
FR-SWP-003	A manager approves after acceptance	A
FR-SWP-004	If either shift changes after the request, reject the stale request and require a new one	A
FR-SWP-005	Swap request UI uses optimistic update with rollback	A
FR-SWP-006	(v0.2) An eligible colleague is an active member of the same business and the same home department (D-05), with no overlapping shift and no unresolved availability conflict unless a manager overrides at approval. Cross-department swaps are not supported in V1	P
FR-SWP-007	Each swap request stores the version of both shifts at request time; acceptance and approval re-check the versions	P


6.7 Attendance and absence (ATT)
Scope conflict flagged in v0.1 and kept: attendance is desired but its V1 boundary is a proposal.
ID	Requirement	Status
FR-ATT-001	Supervisor or manager records present, late or absent against a published shift	P
FR-ATT-002	Absence triggers a notification to the relevant manager	P
FR-ATT-003	Excluded from V1: self clock-in, geofencing, biometrics, payroll, leave management	P


6.8 Activity feed (ACT)
ID	Requirement	Status
FR-ACT-001	Cursor-paginated feed using timestamp plus ID	A
FR-ACT-002	Infinite scroll with FlashList or FlatList, pull-to-refresh	A
FR-ACT-003	Loading, empty, error and end-of-list states; duplicate-request prevention	A
FR-ACT-004	At least 10,000 seeded records for volume testing	A
FR-ACT-005	Feed visibility follows role and scope per section 4.6 and is resolved on the server	A (D-04)
FR-ACT-006	Audience-filtered queries keep cursor pagination free of duplicates and gaps, and each audience type has a documented EXPLAIN ANALYZE	P
FR-ACT-007	Security events are visible only to the affected user and Owners, not to all staff	A (D-04) / P (audience)


6.9 Notifications (NOT)
ID	Requirement	Status
FR-NOT-001	Push for shift changes, swaps, approvals, attendance and billing	A
FR-NOT-002	Push tokens registered per user and device	A
FR-NOT-003	Sent through background jobs	A
FR-NOT-004	Invalid push tokens removed (mechanism in FR-NOT-011)	A
FR-NOT-005	Taps deep-link to the relevant screen. A link into a business other than the active one asks the user to switch and never switches silently; a link to a resource the user cannot access shows a not-found screen	A
FR-NOT-006	Users enable or disable notification categories, except as limited by FR-NOT-009	A
FR-NOT-007	Quiet hours use the user's server-stored time zone; non-urgent push is deferred	A
FR-NOT-008	(v0.2) Urgent means: a shift change where the affected shift's start (old or new, whichever is earlier and still in the future) is within 12 hours of the change, and failed-renewal notices to Owners. Urgent push bypasses quiet hours	A (D-14)
FR-NOT-009	Security and billing notices are mandatory: the user may turn off their push but cannot disable them completely; an in-app inbox item and banner are always created	A (D-14)
FR-NOT-010	Delivery is idempotent: one delivery record per event, recipient, device and channel, protected by a unique key; one job per recipient	A
FR-NOT-011	Invalid-token cleanup uses push receipts: a receipt reporting an unregistered device deletes the token	A
FR-NOT-012	A push token is unique. It is unregistered on logout and reassigned to the current user on registration	P
FR-NOT-013	A deferred notification is re-evaluated when delivered and skipped if superseded or stale	P
FR-NOT-014	In-app inbox holding every notification, mandatory ones flagged	A (D-14)


6.10 Settings (SET)
ID	Requirement	Status
FR-SET-001	Settings: quiet hours, time zone, notification categories, language, theme	A
FR-SET-002	Settings sync across devices	A
FR-SET-003	Conflicts resolved with server timestamps; limitations documented	A
FR-SET-004	Optimistic updates with rollback	A
FR-SET-005	Server timestamps are kept per field, so changes to different fields on two devices both survive; an older replayed edit loses to a newer server value	P (OQ-014)


6.11 Offline (OFF)
ID	Requirement	Status
FR-OFF-001	Upcoming shifts cached for offline viewing	A
FR-OFF-002	Visible "last updated" time on cached data	A
FR-OFF-003	Offline is read-only in V1 (no offline edits or swap requests)	P
FR-OFF-004	The offline cache is keyed by user and business and is cleared on logout, on business switch, when session revocation is detected, and on account deletion	A
FR-OFF-005	On reconnect the app refreshes and replaces cached data; if refresh fails the stale indicator stays	P


6.12 Subscriptions (SUB)
Requirements are in section 8 (BILL-001 onward).
6.13 Operations (OPS)
ID	Requirement	Status
FR-OPS-001	Request IDs on every request and response, structured logs, job-attempt logging (in place from M1)	A
FR-OPS-002	Error tracking with personal-data scrubbing. Proposal: Sentry free tier for backend and app	P
FR-OPS-003	Deployment and load-test documentation	A
FR-OPS-004	Load-test scripts are delivered with the report. Proposal: k6	A / P (tool)


7. Business rules and edge cases
ID	Rule	Status
BR-001	A shift cannot overlap another shift for the same worker unless an authorised override with reason is recorded	P
BR-002	Publishing notifies only staff whose assignments changed	P
BR-003	A swap request references both shift versions; any change to either shift invalidates it	A (intent) / P (mechanism)
BR-004	Swap approval requires acceptance first	A
BR-005	Availability conflicts never block creation; they warn and require a reasoned override	A
BR-006	(v0.2) Only an Owner (any Owner) confirms quotes and charges. GM, Supervisor and Staff cannot	A (D-10)
BR-007	(v0.2) The seat admission limit is enforced inside a database transaction that locks the subscription row, counts active memberships and then inserts. Redis is never the source of truth	A
BR-008	(v0.2) Downgrades apply at the end of the current billing period and are rejected if current seat usage exceeds the target plan's limit. Upgrading cancels a scheduled downgrade	A (D-11)
BR-009	The mobile app can never mark a payment successful	A
BR-010	Ledger rows are never edited or deleted; corrections are new rows	A
BR-011	(v0.2) Quiet hours defer non-urgent push only. Urgent push bypasses them. In-app items are always created	A (D-14)
BR-012	A deactivated worker is removed from future unpublished shifts; published shifts are flagged for manager action; pending swaps involving the worker are cancelled	P
BR-013	(v0.2) Shift times are stored as UTC instants plus the business time zone. For billing, "day" means the business-configured time zone (BILL-016)	P (shifts) / A (billing, D-12)
BR-014	(v0.2) A Staff membership belongs to exactly one department per business. The v0.1 rule that staff could belong to several departments is superseded	A (D-05)
BR-015	A business always has at least one active Owner. The last Owner cannot be removed, demoted, deactivated or delete their account until another Owner exists	P
BR-016	Each active membership counts once toward seat usage regardless of role or number of supervised departments. Pending invitations do not count until accepted	A (D-09)
BR-017	Seat removals take effect at the next renewal with no immediate credit or refund	A (D-11)
BR-018	A scheduled seat reduction or plan downgrade immediately lowers the admission limit to the lower of the current and scheduled limits, so usage can never exceed the scheduled limit	P
BR-019	A quote is single-use, expires, and is bound to currency, subscription version, effective local date and amount. A stale or expired quote is rejected	A (D-10, D-12)
BR-020	A subscription has one explicit billing currency (USD or NGN); quotes, payments and ledger rows carry that currency. USD is the base price schedule; a server-calculated USD-to-NGN quote is permitted under Section 19.5. Existing payments, balances and ledger entries are never converted. Currency changes require request/manual review (D-24).	A (D-23, D-24); supersedes v0.2 wording
BR-021	Failed-renewal handling follows section 8.8	A (D-13)
BR-022	A paid entitlement is granted only after the server has verified the payment (BILL-015)	A (D-10)
BR-023	Invitations created by a member who is removed, deactivated or demoted are revoked	P
BR-024	A change to the business time zone takes effect for billing at the start of the next period	P


Edge cases to specify and test: overnight shifts crossing midnight; business time-zone change; shift edited while a swap is pending; worker removed or transferred while a swap is pending; two managers editing one shift; two Owners confirming the same quote; invitation accepted when seats are full; two invitations accepted at once at the limit; scheduled downgrade then seat added; change made just after local midnight.
8. Subscriptions, seats and proration
8.1 Plans and currencies
USD price list [A] (prices are monthly, in USD cents):
Plan	Price (USD cents)	Included seats	Additional seats
Starter	2000	up to 5	not allowed
Team	5000	up to 15	300 per additional seat per month
Business	12000	up to 40	200 per additional seat per month


Current rule (D-23): USD is the sole base price schedule. NGN equivalents are calculated server-side from a configured, verified exchange-rate source when a quote is requested. Do not create a fixed NGN price list or issue a chargeable quote without a valid, fresh configured rate. The source and rounding/freshness rules remain an explicit gate.
- BILL-012 Every quote, payment intent, ledger row and subscription state carries an explicit currency. USD is the base price schedule; NGN quotes may be calculated server-side under Section 19.5. Never convert historical payments, ledger rows or an existing subscription balance. See D-23 and D-24; this supersedes the v0.2 no-conversion wording.
- Whether a payment provider supports USD, NGN or both for this account is not verified (G-01, section 8.7).
- Monthly cost function [A]: cost(plan, q) = base(plan) + extra_rate(plan) × max(0, q − included(plan)), where q is the purchased seat quantity (Starter: always 5). Cost uses the purchased quantity, never current usage.
- [T] Maximum total seats on Team and Business (OQ-012). Starter is capped at 5.
8.2 Seats: usage, entitlement and admission
- BILL-017 (D-09) Seat usage = number of active memberships in the business. Every role counts, once, whatever the number of supervised departments (BR-016). Deactivated or removed memberships do not count. Pending invitations do not count until accepted.
- BILL-009 (v0.2) Seat limits are enforced transactionally in the database (BR-007). Creating or reactivating a membership, including accepting an invitation, runs in one transaction that (1) locks the business's subscription row, (2) counts active memberships, (3) compares with the admission limit, (4) inserts the membership. Redis is never used as the check.
- BILL-021 [P] Admission limit = the lower of the current entitled limit and any scheduled lower limit (scheduled seat reduction or downgrade target, BR-018). Usage therefore never exceeds what the next renewal will allow.
- Blocked acceptance (limit reached): the response is a conflict (SEAT_LIMIT_REACHED), the invitation stays pending and unconsumed, all Owners receive an in-app and push notice, and the invitee can accept again after an Owner buys seats (J-14) [P].
- Seat reductions: see 8.5.
8.3 Quotes, confirmation and entitlement (D-10, D-12)
- BILL-013 The server calculates a quote for an upgrade, an added-seat purchase, or both together. A quote contains: quote ID, currency, amount, line items (plan delta, seat delta, remaining days, period days), effective local date, subscription version, and expiry. The quote expires at the earlier of 15 minutes [P] and the next local midnight of the business (so the effective date cannot change before payment). Only an Owner can request one (BR-006).
- BILL-014 Confirmation names a quote ID and carries an idempotency key. The server re-checks that the quote is open, unexpired, in the subscription's currency, that the subscription version is unchanged, and that recalculating gives the same amount. Otherwise it returns QUOTE_STALE or QUOTE_EXPIRED. A quote can be confirmed once. If two Owners confirm the same quote, one succeeds.
- Confirmation creates a payment intent (state awaiting_payment) and returns the provider checkout reference. Confirmation grants nothing.
- BILL-015 (BR-022) The paid entitlement (new plan, added seats) is granted only after the server has processed a verified payment event for that payment intent (8.6). Neither the mobile app nor the confirmation call can mark a payment successful (BR-009).
- BILL-022 [P] A business has at most one open payment intent at a time. A second quote confirmation while one is open returns PAYMENT_PENDING. An intent that is not paid within its window expires and releases the quote.
- BILL-024 [T] Provider minimum charge amounts and zero-amount quotes (OQ-019): a prorated amount can be very small (PR-06 is 6 USD cents). The PRD does not decide whether such amounts are rounded up to a provider minimum, carried to the next renewal, or granted with a zero-amount ledger row. The decision depends on G-01.
8.4 Proration (server-calculated) [A]
- BILL-001 Proration is calculated by the server, not by the provider.
- BILL-002 Upgrades and added seats show the charge and require Owner confirmation before completion.
- BILL-004 (v0.2) Prorated charges are rounded down to the minor unit. Credits do not exist mid-period (D-11), so no credit rounding applies. Reversals and corrections post the exact original amounts as new ledger rows (BILL-028).
- BILL-016 (D-12) The period length is the actual number of days of the billing period, and "day" means the calendar day in the business's configured time zone.
  - Period dates are local dates in the business time zone. period_days = period_end_date − period_start_date (end exclusive).
  - remaining_days = period_end_date − effective_local_date. The change day counts as the new plan, so a change on the first day gives period_days and a change on the last day gives 1.
  - [P] The first period starts on the local date of the first verified payment. Each period ends on the same day-of-month next month; if that day does not exist, the last day of that month is used, and the original anchor day is kept for later periods (PR-15).
- Formula (charges only): amount = floor( Δmonthly × remaining_days / period_days ), with Δmonthly = cost(new plan, new q) − cost(old plan, old q) and integer arithmetic. If Δmonthly ≤ 0 there is no charge now.
- Renewal charges cost(plan, q) for the new period after scheduled changes are applied. There is no proration at renewal.
- BILL-029 [P] A change to the business time zone applies to billing from the next period start (BR-024).
8.5 Scheduled changes (D-11)
- BILL-003 Downgrades take effect at the end of the current billing period (AGREED).
- BILL-019 A downgrade request is rejected (DOWNGRADE_EXCEEDS_LIMIT) if current seat usage exceeds the target plan's limit. Starter's limit is 5; Team and Business limits depend on OQ-012.
- BILL-020 An upgrade cancels a scheduled downgrade. A scheduled seat reduction survives an upgrade and is re-validated against the new plan [P].
- BILL-018 A seat reduction takes effect at the next renewal with no immediate credit (BR-017). It is rejected (SEAT_REDUCTION_EXCEEDS_USAGE) if it would take the purchased quantity below current usage. The owner may also cancel a scheduled change.
- While a change is scheduled, the admission limit applies immediately (BILL-021).
8.6 Payment flow and webhooks [A]
- BILL-005 Provider checkout in test mode.
- BILL-006 (v0.2) Only a verified server-side webhook event, confirmed against the payment intent, can confirm payment success. Where the provider offers a transaction-verify call, the server also calls it before granting entitlement [P].
- BILL-007 (v0.2) Webhook handling is durable and idempotent:
  1. Verify the signature over the raw request body before parsing. A bad signature is rejected and nothing is processed.
  2. Persist the event in the control-plane inbox (payment_events) under a unique (provider, provider_event_id) constraint, then respond with success. A duplicate ID is acknowledged and ignored.
  3. Enqueue a background job. A sweeper re-enqueues inbox rows still unprocessed after a delay, so a Redis outage never loses an event.
  4. The job matches the event to a payment intent by provider reference, then checks status, amount, currency and reference. A mismatch marks the event rejected_mismatch, raises an alert and grants nothing.
  5. In one tenant-plane transaction it locks the subscription, applies the entitlement, writes ledger rows and marks the event processed, once, whatever the number of retries.
  6. An event for an unknown reference is retried with back-off, then flagged for manual review [P]. Out-of-order events cannot move an intent out of a terminal state.
- BILL-008 (v0.2) Idempotency keys cover both legs: app to server (stored with the request hash; the same key with a different body returns 422) and server to provider (the provider's idempotency mechanism where it exists). Keys expire after 24 hours [P].
- BILL-010 (v0.2) Immutable financial ledger; subscription state is reconstructable from ledger rows and events (BILL-025).
- BILL-025 Replaying all ledger rows and events for a business reproduces its plan, seat quantity, period and status exactly.
- BILL-028 Corrections and refunds are new reversal rows with the exact original amounts. Rows are never updated or deleted (BR-010, C-08).
8.7 Provider and currency verification gate (G-01) [A that it is required; result T]
Status: NOT VERIFIED. Nothing in this PRD asserts what any provider supports. The product owner decides on provider and currency scope after the checks below, recorded in decision record DR-01, by the end of M0, and in any case before any billing implementation (M8) [P].
Check, per provider and per currency (USD, NGN)	Paystack	Flutterwave
Account can charge in USD	UNVERIFIED	UNVERIFIED
Account can charge in NGN	UNVERIFIED	UNVERIFIED
Test mode available for each currency	UNVERIFIED	UNVERIFIED
One-off charge through hosted checkout	UNVERIFIED	UNVERIFIED
Stored authorisation or token for later server-initiated charges	UNVERIFIED	UNVERIFIED
Webhook signature scheme and raw-body requirement	UNVERIFIED	UNVERIFIED
Transaction-verify endpoint	UNVERIFIED	UNVERIFIED
Minimum chargeable amount per currency	UNVERIFIED	UNVERIFIED
Idempotency support	UNVERIFIED	UNVERIFIED
Settlement currency and fees	UNVERIFIED	UNVERIFIED
Credentials and test access currently available to the owner	UNVERIFIED	UNVERIFIED


Flutterwave test mode was used in an earlier project; current access must be confirmed, not assumed. Stripe is not considered unless Nigerian-business availability is verified.
Options if no single provider supports both currencies: (a) one provider per currency, (b) launch with one currency and defer the other, (c) evaluate another provider. This is OQ-004 and OQ-003.
Also decided here: the renewal mechanism (BILL-026, OQ-021) and local webhook testing (tunnel or provider test events).
8.8 Failed renewal (D-13) [A]
Requirements: BILL-011 (failed-renewal handling), BILL-030 (restricted mode), BILL-026 (renewal mechanism, T).
State	Entered when	Behaviour
active	Payment verified	Full access
past_due (day 0)	A renewal payment fails at the renewal time t0	Full access. All Owners get an urgent notice. Retries run on days 1, 3 and 5 after t0; each attempt and result is logged with its attempt number
restricted	Day 7 after t0 without a verified payment	See below
back to active	A verified successful payment at any point	Restriction lifted; ledger rows written; Owners notified


- Retry mechanism depends on G-01: a server-initiated charge if the provider supports stored authorisation, otherwise a fresh payment link sent to Owners (BILL-026, OQ-021).
- Notices to Owners at t0, after each failed retry, on day 6 and at restriction are urgent and bypass quiet hours (FR-NOT-008) [P for the schedule]. An in-app banner persists (FR-NOT-009).
- Restricted mode blocks: shift create, edit, delete and publish; assignments; swap approval; attendance recording; department and membership changes; creating or accepting invitations; quotes for upgrades or seats.
- Restricted mode allows: staff read-only access to published schedules and their own shifts; notifications and the in-app inbox; settings; an Owner paying the outstanding balance.
- [T] Whether Staff can still submit availability or swap requests in restricted mode (OQ-023).
- The billing period keeps its anchor: a recovered payment covers the renewal that failed [P].
8.9 Worked examples and unit-test vectors (PR-nn)
Assumptions: USD cents. Period of 30 days unless stated. d is the day number of the change (day 1 is the period start date); remaining_days = period_days − d + 1. Amounts are floor(Δmonthly × remaining_days / period_days). NGN vectors follow the same arithmetic once the NGN price list exists (G-04).
ID	Scenario	Arithmetic	Result
PR-01	Starter→Team, 5 seats, day 1 (v0.1 example)	(5000 − 2000) × 30/30	3000
PR-02	Same change on the last day, day 30	3000 × 1/30	100
PR-03	Team with 20 seats→Business, day 11 (v0.1 example)	old 5000 + 300×5 = 6500; (12000 − 6500) × 20/30 = 3666.67	3666
PR-04	Team with 18 seats→Business, day 11	old 5000 + 300×3 = 5900; 6100 × 20/30 = 4066.67	4066
PR-05	Business with 40 seats, add 2 seats, day 11	2×200 = 400; 400 × 20/30 = 266.67	266
PR-06	Business with 40 seats, add 1 seat on the last day, day 30	200 × 1/30 = 6.67	6
PR-07	Two plan changes in one period: Starter→Team day 5, then Team→Business day 20, 5 seats	3000 × 26/30 = 2600; 7000 × 11/30 = 2566.67	2600, then 2566. Paid 2000 + 2600 + 2566 = 7166 against the exact cost 7166.67
PR-08	Add then remove seats: Business 40 seats; +2 seats day 11; Owner schedules −1 seat day 21	day 11: 266 (as PR-05). Day 21: nothing now (D-11). Renewal: 12000 + 200×1 for 41 seats	266; then 0 now; renewal 12200 (not 12400)
PR-09	Three events in one period: Team 15 seats; +4 seats day 3; −2 seats day 12 scheduled; upgrade to Business day 25	day 3: 1200 × 28/30 = 1120. Day 12: 0 now. Day 25: old Team with 19 seats 5000 + 1200 = 6200; new Business 12000; 5800 × 6/30 = 1160	1120; 0; 1160. Charges in period 5000 + 1120 + 1160 = 7280. The scheduled reduction to 17 remains for renewal
PR-10a	Scheduled downgrade later cancelled: Business with 25 seats schedules Team on day 12 and the Owner cancels on day 22	Team at 25 seats would cost 8000; Business costs 12000	0 now. Ledger gets a scheduled and a cancelled row; next renewal 12000
PR-10b	Upgrade cancels a scheduled downgrade: Team with 4 members schedules Starter on day 12; on day 18 Owner upgrades to Business	(12000 − 5000) × 13/30 = 3033.33	3033. The scheduled downgrade is cancelled
PR-11	Period length matters: Team, 15 seats, add 1 seat on day 8	28 days: 300 × 21/28 = 225. 30 days: 300 × 23/30 = 230. 31 days: 300 × 24/31 = 232.26	225, 230 and 232
PR-12	Downgrade rejected: Business with 6 active memberships requests Starter	usage 6 > limit 5	Rejected, DOWNGRADE_EXCEEDS_LIMIT
PR-13	Seat reduction rejected: Team with 20 active memberships and 22 purchased seats requests 19	19 < usage 20	Rejected, SEAT_REDUCTION_EXCEEDS_USAGE
PR-14	Business time zone: Africa/Lagos (UTC+1), period 2026-04-01 to 2026-05-01, Starter→Team at 2026-04-01T23:30Z	Local date 2026-04-02, day 2, remaining 29: 3000 × 29/30. Using the UTC date would give 3000	2900
PR-15	Period anchor on the 31st: first period starts 2027-01-31	Periods end 2027-02-28 (28 days), 2027-03-31 (31 days), 2027-04-30 (30 days)	28, 31 and 30 days
PR-16	Currency mismatch: a quote in NGN confirmed against a USD subscription	no conversion exists	Rejected, CURRENCY_MISMATCH


The three audit examples that used an immediate seat-removal credit (credit 66, net 200, and the three-event total 7020) are superseded by PR-08 and PR-09 under D-11. Every other audit example is preserved above (audit scenarios 1, 2, 3, 4, 7, 9, 10, 11, 12 as PR-01, PR-02, PR-04, PR-05, PR-07, PR-10a, PR-06, PR-11, PR-12).
Unit tests required [A]: a test per vector PR-01 to PR-16 (more than the eight required in v0.1: upgrade, downgrade, seat add, seat remove, first-day, last-day, multiple changes in one period, scheduled downgrade then cancelled).
8.10 Billing requirement index
ID	Requirement	Status
BILL-001	Proration is calculated by the server	A
BILL-002	Upgrades and added seats show the charge and need Owner confirmation	A
BILL-003	Downgrades apply at period end	A
BILL-004	(v0.2) Prorated charges round down; no mid-period credits	A (D-12)
BILL-005	Provider checkout in test mode	A
BILL-006	(v0.2) Only a verified server-side webhook confirmed against the payment intent confirms payment	A
BILL-007	(v0.2) Durable, idempotent webhook processing with signature, amount, currency, reference and status checks	A
BILL-008	(v0.2) Idempotency keys on both payment legs	A
BILL-009	(v0.2) Seat limits enforced transactionally in the database	A
BILL-010	(v0.2) Immutable ledger; state reconstructable	A
BILL-011	(v0.2) Failed renewal: 7-day grace, retries on days 1, 3, 5, Owner notices, then restriction	A (D-13)
BILL-012	Explicit currency on all monetary records; USD base pricing and controlled NGN quote conversion under Section 19.5; no historical-record conversion	A (D-23, D-24); supersedes v0.2 wording
BILL-013	Server-calculated quote with defined contents and expiry	A (D-10) / P (15 minutes)
BILL-014	Confirmation of a bound, single-use quote; stale quotes rejected	A (D-10, D-12)
BILL-015	Entitlement only after verified payment	A (D-10)
BILL-016	Actual period length and business time zone; anchor rule	A (D-12) / P (anchor)
BILL-017	Seat usage counts active memberships once; pending invitations excluded	A (D-09)
BILL-018	Seat reductions at renewal, no immediate credit	A (D-11)
BILL-019	Downgrade rejected if usage exceeds target limit	A (D-11)
BILL-020	Upgrade cancels a scheduled downgrade	A (D-11)
BILL-021	Admission limit is the lower of current and scheduled limits	P
BILL-022	One open payment intent per business	P
BILL-023	Provider and currency capability verification before provider commitment (G-01)	A (D-08)
BILL-024	Minimum charge and zero-amount handling	T
BILL-025	Ledger replay reproduces subscription state	A
BILL-026	Renewal mechanism: server-initiated charge or customer-initiated payment link	T
BILL-027	Configured FX source and quote policy for NGN equivalents	T (FX-01); blocks chargeable NGN quotes until configured and verified
BILL-028	Corrections are new reversal rows	A
BILL-029	Time-zone change applies from the next period	P
BILL-030	Restricted mode behaviour after grace	A (D-13)


9. Data entities and relationships
9.1 Planes
Control plane (unsharded database or schema): data that is looked up before the business is known.
Tenant plane (two simulated shards, routed by hash of business_id): everything owned by a business. All tenant-plane access goes through one shard-routing abstraction (SEC-013).
A membership directory in the control plane (user, business, role, status) is a copy used only to list a user's businesses at login. The tenant-plane membership is authoritative; the copy is kept in step by a transactional outbox and a reconciliation job, because no distributed transaction spans the two [P]. A crash between the two writes is repaired by reconciliation (AC-TEN-07).
9.2 Control-plane entities
Entity	Key fields (illustrative)	Notes
users	id, email (normalised), email_verified_at, password_hash (null for Google-only), status	Global identity
auth_identities	id, user_id, provider, provider_subject, linked_at	UNIQUE (provider, provider_subject); linking per FR-AUTH-011
auth_tokens	id, user_id, purpose (email_verify, password_reset), token_hash, expires_at, used_at	Hashed, single-use
devices	id, user_id, platform, last_seen_at	
sessions	id, user_id, device_id, active_business_id, created_at, revoked_at, revoked_reason	Checked on every request
refresh_tokens	id, session_id, family_id, token_hash, parent_id, issued_at, expires_at, used_at, replaced_by	UNIQUE token_hash
push_tokens	id, user_id, device_id, token, invalidated_at	UNIQUE token
user_settings	user_id, time_zone, quiet_hours, language, theme, plus an updated_at per field	Per-field sync (FR-SET-005)
notification_preferences	user_id, category, push_enabled, updated_at	Mandatory categories cannot be fully disabled
membership_directory	user_id, business_id, role, status	Copy of tenant-plane membership
payment_events	id, provider, provider_event_id, signature_valid, raw_payload, business_id (null until matched), status, attempts, received_at, processed_at	UNIQUE (provider, provider_event_id); durable inbox
idempotency_keys	key, user_id, operation, request_hash, response, expires_at	Same key, different body returns 422
deletion_requests	id, user_id, status, requested_at, completed_at	PRIV-001


9.3 Tenant-plane entities (every row has business_id)
Required v0.3 addition: branches(id, business_id, name, status, created_at, updated_at) and departments(id, business_id, branch_id, name, status, created_at, updated_at). A department’s composite foreign key must bind its branch to the same business. Branch-scoped tenant entities (including shifts, staffing requirements, membership assignments, invitations and relevant audit/activity records) must carry or derive a validated branch_id; do not trust client-supplied branch IDs. Apply RLS and composite tenant keys consistently. Exact columns may be refined in approved schema decision records, but the business/branch ownership rules may not be weakened.
Entity	Key fields (illustrative)	Notes
businesses	id, name, time_zone (IANA)	Tenant root
memberships	business_id, id, user_id, role, status, branch_id, department_id	UNIQUE (business_id, user_id); Staff requires one department and its branch; other roles may have no home department but their branch access is represented by explicit grants
departments	business_id, id, name	UNIQUE (business_id, name)
department_supervisors	business_id, branch_id, department_id, membership_id	Membership role must be Supervisor; assignment must be within authorised business/branch scope (C-06, D-18, D-34)
invitations	business_id, id, email (normalised), role, department_id, invited_by_membership_id, token_hash, status, expires_at, accepted_at	Token carries a non-secret routing prefix so the shard can be found; only the hash is stored
shifts	business_id, id, branch_id, department_id, starts_at, ends_at, time_zone, status, version	Status draft, review, published, cancelled
staffing_requirements	business_id, id, branch_id, department_id, role_label, headcount, local_start, local_end, weekdays, time_zone	Local wall-clock (FR-SCH-009)
shift_assignments	business_id, shift_id, membership_id, override_reason, override_by, override_at	Assignee's department equals the shift's (C-07)
availability_entries	business_id, membership_id, window, preference	
swap_requests	business_id, id, requester_membership_id, requester_shift_id, requester_shift_version, counterpart_membership_id, counterpart_shift_id, counterpart_shift_version, status	Stale detection by versions
attendance_records	business_id, shift_assignment ref, state, recorded_by	
activity_events	business_id, id, created_at, type, department_id, actor_membership_id, subject_membership_id, visibility_class, payload	No personal data beyond IDs in payload; index (business_id, created_at, id) plus audience indexes
subscriptions	business_id (one row), plan, billing_currency, seat_quantity, period_start_date, period_end_date, anchor_day, status, scheduled_plan, scheduled_seat_quantity, version	Version bumps on every change
billing_quotes	business_id, id, currency, amount_minor, subscription_version, effective_local_date, expires_at, status, created_by	Single-use
payment_intents	business_id, id, quote_id, provider, provider_reference, amount_minor, currency, status	One open per business
ledger_entries	business_id, id, seq, type, amount_minor, currency, quote_id, payment_intent_id, provider_event_id, created_at	Append-only (C-08)
audit_log	business_id, id, actor_membership_id, action, outcome, request_id, created_at	FR-RBAC-004
notification_deliveries	business_id, id, event_id, recipient_user_id, device_id, channel, dedupe_key, status, ticket_id, attempts	UNIQUE dedupe_key
inbox_items	business_id, id, recipient_membership_id, category, mandatory, read_at, created_at	In-app fallback (FR-NOT-014)


A full ERD is a required deliverable (ARCHITECTURE.md).
9.4 Constraints (requirements, not migrations)
ID	Constraint	Status
C-01	Every tenant-plane table has business_id NOT NULL	A
C-02	Every tenant-plane table is unique on (business_id, id) and every relationship is a composite foreign key that includes business_id, so a row cannot reference another business's parent	A
C-03	Row-level security is enabled and forced on every tenant-plane table with a policy on business_id; the application database role is neither the table owner nor able to bypass RLS; migrations run under a separate role	A
C-04	memberships is unique on (business_id, user_id)	P
C-05	Single department (D-05): department_id is required when role is Staff and null otherwise; a composite foreign key ties it to the same business; no table can attach a Staff membership to a second department	A (D-05)
C-06	A department_supervisors row must reference a membership whose role is Supervisor (constraint trigger or equivalent, with a test)	P
C-07	A Staff assignee's department must equal the shift's department	A (derived from D-05)
C-08	ledger_entries is append-only: no update or delete privilege, a blocking trigger, a monotonic per-business sequence	A
C-09	payment_events is unique on (provider, provider_event_id)	A
C-10	Unique dedupe_key on deliveries, unique push token, unique refresh token_hash, unique invitation token_hash	A
C-11	One subscriptions row per business with a version number incremented on every state change	A
C-12	Seat admission and last-Owner protection cannot be declarative; they run in a transaction holding a row lock (subscription row, business row)	A
C-13	Money columns are integer minor-unit amounts plus explicit USD/NGN currency. Each quote/payment/ledger entry records the currency actually used; immutable historical entries retain their original currency. NGN quotes require a valid configured FX source and Owner confirmation.	A (D-23, D-24)


10. API capabilities and error conventions
Capabilities (by area): auth (register, verify email, login, Google sign-in, refresh, logout, logout-all, password reset, link identity), sessions and devices, business context (list memberships, switch business), businesses and departments, memberships and invitations (create, revoke, accept), shifts and requirements, assignments, availability, swaps, attendance, activity feed, inbox, notification preferences and push tokens, settings, subscription (view, quote, confirm quote, schedule downgrade, schedule seat reduction, cancel scheduled change), payment webhook (control plane), account deletion, health.
Conventions [P]
- Versioned base path /v1. Tenant routes derive the business from the access token (FR-AUTH-010). Control-plane routes (memberships list, invitation acceptance, sessions, settings, deletion) do not need an active business.
- Request bodies are validated with Zod [A]; invalid input returns 400 with field errors.
- Error envelope: { "error": { "code", "message", "requestId", "details?" } }. Every response carries a request ID.
- Resources outside the caller's business return 404, never 403, so existence is not revealed (SEC-015).
- Cursor pagination: ?limit=&cursor= returning nextCursor, an opaque encoding of timestamp plus ID. Maximum limit 50.
HTTP	Code	Used for
400	VALIDATION_ERROR	Invalid body or query
401	UNAUTHENTICATED, SESSION_REVOKED	Missing, expired or revoked credentials
403	FORBIDDEN, SUBSCRIPTION_RESTRICTED	Role or scope denial; restricted mode
404	NOT_FOUND	Missing resource or another business's resource
409	SEAT_LIMIT_REACHED, QUOTE_STALE, QUOTE_EXPIRED, PAYMENT_PENDING, CURRENCY_MISMATCH, DOWNGRADE_EXCEEDS_LIMIT, SEAT_REDUCTION_EXCEEDS_USAGE, STALE_SWAP, BUSINESS_CONTEXT_REQUIRED	Conflicts with current state
410 or 400	INVITATION_INVALID	One uniform response for unknown, used, expired, revoked or wrong-email invitations
422	IDEMPOTENCY_KEY_REUSED	Same key with a different body
429	RATE_LIMITED	Limit exceeded; includes a retry hint
500 / 503	INTERNAL, DEPENDENCY_UNAVAILABLE	Server fault; a dependency such as Redis is down (NFR-REL-002)


Full API contracts are a required deliverable.
11. Security and privacy
11.1 Requirements
ID	Requirement	Status
SEC-001	(v0.2) Every backend query and mutation runs inside a tenant context; tenant isolation is tested for reads and writes (AC-001, AC-TEN-01 to AC-TEN-07)	A
SEC-002	Server-side permission enforcement; Staff direct-API shift deletion test	A
SEC-003	Zod validation on request bodies	A
SEC-004	Redis rate limiting for login, password reset, invitations and payment endpoints; thresholds in 11.2	A / P (thresholds)
SEC-005	No secret keys in the mobile bundle; every EXPO_PUBLIC_ variable is documented and justified	A
SEC-006	SECURITY.md with at least eight threats and mitigations (11.3 lists the candidates)	A
SEC-007	Webhook signature verification over the raw body	A
SEC-008	Passwords hashed with a modern, tunable algorithm (Argon2id proposed)	P
SEC-009	(v0.2) Privacy and retention follow section 11.5	A (D-15)
SEC-010	Tenant context: the business comes from the access token's business claim; the server opens a transaction and sets the tenant with a transaction-scoped setting (SET LOCAL), never a session-level setting; a repository layer refuses tenant queries without context; route handlers have no raw pool access	A
SEC-011	Row-level security enabled and forced on all tenant tables (C-03); a catalogue test asserts it for every table with business_id	A
SEC-012	Composite foreign keys including business_id for all tenant relationships (C-02)	A
SEC-013	One shard-routing function maps business_id to a shard; tenant-plane connections come only from it; cross-shard operations are limited to control-plane lookups and explicit admin jobs	A
SEC-014	Cache keys are scoped by tenant (business_id prefix; user-level caches also include the user); a helper enforces the prefix; invalidation is per business	A
SEC-015	Resources outside the caller's business return 404	A
SEC-016	Cross-tenant tests are generated from the route list and cover reads, writes and guessed IDs, plus database-level, cache-level and pool-interleave tests	A
SEC-017	Control-plane endpoints authorise by user (a user touches only their own sessions, devices and settings)	A
SEC-018	Background jobs carry business_id and re-establish tenant context before touching tenant data; only listed control-plane jobs may run without it	A
SEC-019	Account linking and invitation acceptance require a verified email (FR-AUTH-011, FR-AUTH-012)	A (D-07)
SEC-020	Refresh-token reuse outside the grace window revokes the whole session family and raises a security event	A (D-06)


11.2 Proposed rate-limit thresholds [P]
Limits are per account and per IP, because staff on one mobile carrier can share an address.
Endpoint	Proposed limit
Login	10 per minute per IP; 5 failures per 15 minutes per account
Password reset	3 per hour per email; 10 per hour per IP
Invitation creation	30 per hour per membership
Invitation acceptance	10 per hour per IP
Payment endpoints (quote, confirm)	10 per minute per user


11.3 Threat candidates for SECURITY.md (at least eight required)
#	Threat	Mitigation requirements
1	Cross-business data access (IDOR, bad token scope, pool leakage)	SEC-010 to SEC-016, FR-AUTH-010
2	Privilege escalation through invitation or role change	FR-RBAC-005, FR-ORG-002, BR-023
3	Refresh-token theft or replay	FR-AUTH-004, SEC-020
4	Invitation link hijack or reuse	FR-AUTH-007
5	Webhook forgery or replay	BILL-006, BILL-007, SEC-007
6	Account takeover through linking or unverified email	FR-AUTH-011, FR-AUTH-012
7	Credential stuffing and brute force	SEC-004, SEC-008
8	Quote tampering or replay, amount manipulation	BILL-013, BILL-014, BR-019
9	Seat-limit race	BILL-009, BR-007
10	Push-token leakage across users on a shared device	FR-NOT-012
11	Cross-tenant cache exposure	SEC-014
12	Data left on a shared device	FR-OFF-004
13	Ledger tampering	BR-010, C-08
14	Denial of service through a Redis outage	NFR-REL-002


11.4 Mobile configuration
EXPO_PUBLIC_ variables are visible to anyone with the app. Each must be listed with its purpose; only non-secret values (API base URL, public client IDs) are allowed (SEC-005). Push notifications, Google sign-in and HTTPS app links require an Expo development build; Expo Go is not assumed to support them (M0).
11.5 Privacy, deletion and financial retention (D-15)
ID	Requirement	Status
PRIV-001	A user can request account deletion in the app. The request is recorded and acknowledged	A
PRIV-002	A written privacy and retention policy (PRIVACY-RETENTION.md) exists and is reviewed before launch (gate G-03). It states what is deleted, what is retained, for how long and why	A (D-15)
PRIV-003	A sole Owner cannot delete the account until another Owner exists or the business is closed (BR-015)	P
PRIV-004	On deletion: sessions and push tokens are removed, memberships are ended, personal fields are removed or pseudonymised (for example "former member") in activity events and other business records	P
PRIV-005	Financial ledger rows are retained for the retention period; they refer to the business and payment references and hold no more personal data than the policy requires	P
PRIV-006	Retention periods, deletion deadlines and the legal basis	T (G-03, OQ-025)
PRIV-007	Compliance with the Nigeria Data Protection Act (NDPA) is assessed against the policy. This PRD is not legal advice; legal review is a gate	T
PRIV-008	Personal-data export on request	T


12. Offline, notifications and settings behaviour
12.1 Offline
- Cache the next 14 days of the user's own shifts [P] (OQ-013), keyed by user and business.
- Show "Last updated <time>". Refresh and replace on reconnect. The cache is read-only.
- Clear the cache on logout, business switch, detected revocation and account deletion (FR-OFF-004).
12.2 Notifications
- Categories: shift changes, swaps, approvals, attendance, billing, security. Billing and security are mandatory.
- Channels: push and the in-app inbox. Mandatory categories always create an inbox item and a banner, even if the user switched off their push (FR-NOT-009).
- Urgent (D-14): a shift change within 12 hours of the affected shift's start, and failed-renewal notices to Owners. Urgent push bypasses quiet hours; it does not override a user's opt-out of a non-mandatory category [P].
- Notification text uses the user's language setting and falls back to English [P].
- Quiet hours use the user's server-stored time zone. Deferred notifications are queued for the end of quiet hours and re-evaluated at delivery (FR-NOT-013).
- Delivery: one job per recipient; a unique dedupe key per event, recipient, device and channel; retries cannot duplicate (FR-NOT-010). A receipt-check job removes unregistered tokens (FR-NOT-011).
- Deep links ask before switching business and show not-found for inaccessible resources (FR-NOT-005).
12.3 Settings
- The server holds the source of truth with per-field timestamps (FR-SET-005). Last write wins per field. An older edit replayed after reconnect loses to a newer server value. Settings edits need connectivity and use optimistic update with rollback.
12.4 Client state
Zustand for client-only state; TanStack Query for server state [P]. Rationale: small API, little boilerplate, and a single query cache that can be cleared on business switch.
12.5 Development build [A]
An Expo development build is required before push, Google sign-in or HTTPS app-link features. Setup is documented in M0.
12.6 Technology decisions (proposals; each needs a decision record)
Area	Choice	Status
Mobile	React Native with Expo; development build for native features	A
Backend runtime	Node.js	A
HTTP framework	Express or Hono. Criteria: raw-body access for webhook signatures, middleware ecosystem, familiarity. Decision in DR-02	T
Database	PostgreSQL (control plane plus two simulated tenant shards)	A
Redis	Caching, rate limiting, queue backing. Seat admission does not use Redis (BILL-009). Distributed locks only where justified in a decision record	A
Job queue	A Redis-backed queue such as BullMQ, with database-persisted inboxes so Redis loss cannot lose events (DR-03)	P
Validation	Zod	A
Server state	TanStack Query	A
Client state	Zustand (12.4)	P
Token storage	expo-secure-store	A


13. Non-functional requirements
ID	Requirement	Status
NFR-PERF-001	Activity feed supported by an index; EXPLAIN ANALYZE before and after documented for each audience type	A
NFR-PERF-002	Load test: 200 concurrent virtual users on the activity feed; results before and after caching	A
NFR-PERF-003	Connection pooling configured; pool size justified and tested at exhaustion	A
NFR-PERF-004	Redis caches for team rosters and shift calendars, with tenant-scoped keys, invalidated on shift changes	A
NFR-SCALE-001	Read/write routing and read-your-own-writes behaviour documented and tested	A
NFR-SCALE-002	Two simulated PostgreSQL shards routed by hash of business_id; SHARDING.md documents the shard key, large-business limitation, harder queries (including login membership lookup, which uses the control plane)	A
NFR-REL-001	Background-job retries with attempt logging	A
NFR-REL-002	Behaviour when Redis is unavailable follows the table below	P
NFR-OBS-001	Request IDs, structured logs, job-attempt logging and error tracking, built into the foundation (M1)	A / P
NFR-COST-001	Prefer free or low-cost services where core security is not compromised	A


Redis failure behaviour (NFR-REL-002) [P]
Function	Behaviour when Redis is unavailable
Rate limiting	Fail closed for login, password reset, invitations and payments: return DEPENDENCY_UNAVAILABLE with a retry hint. A conservative in-process limiter is the documented fallback
Session revocation check	Fall back to the database, which is authoritative
Seat admission	Unaffected. It uses a database lock (BILL-009)
Caches	Read through to the database with load shedding
Queues	Webhook events and notification deliveries are already persisted (payment_events, notification_deliveries); a sweeper re-enqueues them when Redis returns


14. Acceptance criteria
Version note: Criteria inherited from v0.2 remain applicable only where they do not conflict with Section 19. In particular, currency-conversion and branchless-model criteria superseded by Section 19 are not current acceptance criteria; the additional criteria in Section 19.7 are authoritative for those areas.
AC-001 to AC-017 are carried over from v0.1; AC-001, AC-004, AC-009, AC-010 and AC-012 are extended, none is weakened. Criteria marked "(after Gxx)" become testable when the named gate is closed.
14.1 Carried over from v0.1
ID	Criterion	Verifies
AC-001	A user in business A receives no data from business B on any endpoint, and cannot change B's data (automated)	SEC-001, SEC-016
AC-002	A Staff token calling shift delete returns 403 and the shift remains	FR-RBAC-002, SEC-002
AC-003	Reusing a rotated refresh token outside the grace window is rejected	FR-AUTH-004
AC-004	After logout-all, existing refresh tokens fail and existing access tokens are rejected on the next request	FR-AUTH-005
AC-005	A used or expired reset token is rejected	FR-AUTH-006
AC-006	Publishing a schedule creates notification jobs for affected staff only	FR-SCH-006, BR-002
AC-007	A swap request is rejected as stale after either shift changes	FR-SWP-004, BR-003
AC-008	Offline app shows cached shifts and a last-updated time	FR-OFF-001, FR-OFF-002
AC-009	Proration unit tests for PR-01 to PR-16 pass (at least eight) with the documented expected values	BILL-001, BILL-004, BILL-016
AC-010	A webhook with a bad signature is rejected; a duplicate event ID is ignored; an amount, currency or reference mismatch grants nothing	BILL-006, BILL-007
AC-011	Payment success cannot be set from the mobile client	BR-009
AC-012	Adding a worker beyond the admission limit is refused, including under concurrency	BILL-009, BR-007
AC-013	Ledger rows cannot be updated or deleted	BR-010, C-08
AC-014	The feed pages by cursor with no duplicates or gaps across 10,000 records	FR-ACT-001, FR-ACT-004
AC-015	The load-test report shows 200 virtual users before and after caching	NFR-PERF-002
AC-016	Quiet hours defer non-urgent pushes using the stored time zone	FR-NOT-007, BR-011
AC-017	Settings changed on device 1 appear on device 2	FR-SET-002


14.2 Tenant isolation and data model
ID	Criterion	Verifies
AC-TEN-01	Generated from the route list: for every route, a business-A token with a business-B resource ID returns 404 and changes nothing (reads and writes)	SEC-015, SEC-016
AC-TEN-02	As the application role with tenant A set, direct SQL cannot read, update or delete business-B rows on any tenant table; a catalogue test asserts RLS is enabled and forced on every table with business_id; the role is not the owner and cannot bypass RLS	SEC-011, C-03
AC-TEN-03	Inserting a child row that references another business's parent fails for every tenant relationship	SEC-012, C-01, C-02
AC-TEN-04	500 interleaved requests from two businesses over a 5-connection pool return zero cross-tenant rows; the tenant setting is empty after every transaction	SEC-010
AC-TEN-05	Every cache key carries the business prefix (test or lint); a request for A never receives a value cached for B; invalidating A leaves B untouched	SEC-014
AC-TEN-06	A token for A cannot reach B even if the user belongs to B; switching issues a new token; a deactivated membership fails on the next request; a demotion applies on the next request	FR-AUTH-010, FR-RBAC-006, SEC-017
AC-TEN-07	After a simulated crash between the tenant membership write and the directory copy, reconciliation repairs it and the business appears at login	FR-ORG-005
AC-TEN-08	A background job without tenant context fails unless it is a listed control-plane job	SEC-018
AC-DM-01	The database rejects a Staff membership with no department, a department of another business, and a second membership for the same user in the same business	FR-ORG-007, C-04, C-05
AC-DM-02	The API rejects assigning Staff to a shift of another department	FR-SCH-010, C-07
AC-DM-03	Transferring Staff removes them from the old department's future unpublished shifts, flags published ones and cancels pending swaps	BR-012, FR-ORG-003
AC-DM-04	A user who is Staff in department X of business A and department Y of business B sees only the matching context in each	FR-ORG-005, BR-014
AC-DM-05	A department-supervisor row for a non-Supervisor membership is rejected	C-06, FR-ORG-004
AC-DM-06	Money columns reject any currency other than USD or NGN, and a ledger row whose currency differs from its subscription's	C-13, C-11


14.3 Authorisation
ID	Criterion	Verifies
AC-RBAC-01	A table-driven test over every role and action in section 4.5 returns the stated allow or deny	FR-RBAC-001, FR-RBAC-003, FR-ORG-001, FR-ORG-004
AC-RBAC-02	A GM, Supervisor or Staff appointing an Owner gets 403; an Owner succeeds; removing, demoting or deleting the last Owner is rejected	FR-ORG-006, FR-RBAC-005, BR-015
AC-RBAC-03	An availability override without a reason is rejected; with a reason it stores reason, actor and time	FR-AVL-003, BR-005
AC-RBAC-04	Denied privileged actions and role changes write audit-log entries carrying the request ID	FR-RBAC-004


14.4 Authentication, sessions, invitations
ID	Criterion	Verifies
AC-AUTH-01	Two concurrent refreshes with one token inside the grace window both succeed with the same successor; reuse after the window revokes the family and raises a security event	FR-AUTH-004, SEC-020
AC-AUTH-02	Logout, logout-all, password reset and account deletion each make existing access and refresh tokens fail on the next request	FR-AUTH-005, FR-AUTH-013
AC-AUTH-03	Reset tokens are single-use, expire, are stored hashed, give the same response for unknown emails and revoke all sessions	FR-AUTH-006
AC-AUTH-04	A Google identity with an unverified email cannot link; linking to a password account needs re-authentication; an unverified account cannot accept an invitation	FR-AUTH-011, FR-AUTH-012, SEC-019
AC-AUTH-05 (after G-02)	A Google ID token with the wrong audience or issuer, or expired, is rejected	FR-AUTH-002
AC-AUTH-06	The 6th failed login in 15 minutes for one account returns 429 with a retry hint; the thresholds in 11.2 hold for reset, invitations and payments; with Redis stopped these fail closed	SEC-004, NFR-REL-002
AC-AUTH-07	A static check finds no auth token read or written through AsyncStorage	FR-AUTH-009
AC-AUTH-08	The session list shows devices; revoking one ends only that session	FR-AUTH-008
AC-AUTH-09	A user with one active membership is scoped automatically; a user with several gets BUSINESS_CONTEXT_REQUIRED until they choose	FR-AUTH-010
AC-AUTH-10	Email/password registration and login work; an access token stops working at its configured lifetime	FR-AUTH-001, FR-AUTH-003
AC-AUTH-11	Stored password hashes use the configured algorithm; no password or token appears in logs	SEC-008
AC-AUTH-12	A user cannot read or revoke another user's sessions, devices or settings	SEC-017
AC-INV-01	A valid invitation creates a membership in the invited business only, with the invited role and department	FR-AUTH-007
AC-INV-02	Used, expired (72 hours), revoked and unknown tokens return the same INVITATION_INVALID response	FR-AUTH-007
AC-INV-03	A token presented by a different email is rejected	FR-AUTH-007
AC-INV-04	Only the token hash is stored; the plain token appears nowhere in the database or logs	FR-AUTH-007, C-10
AC-INV-05	The link opens the app through a verified HTTPS app link; a fallback page appears when the app is absent; a custom scheme is not accepted	FR-AUTH-007
AC-INV-06	Owner may invite any role; GM only Supervisor and Staff; Supervisor only Staff in an assigned department; Staff nobody. Every violation returns 403 and is audit-logged	FR-ORG-002, FR-RBAC-005
AC-INV-07	An existing user accepting an invitation to a second business gains a membership with no duplicate identity	FR-ORG-005
AC-INV-08	Invitations created by a member who is later removed, deactivated or demoted fail	BR-023
AC-INV-09	Acceptance with no seat free returns SEAT_LIMIT_REACHED, leaves the invitation pending and notifies Owners	BILL-009, BR-016


14.5 Seats
ID	Criterion	Verifies
AC-SEAT-01	20 parallel acceptances at 4 of 5 seats: exactly one succeeds and usage never exceeds 5	BILL-009, BR-007
AC-SEAT-02	Pending invitations do not count; a Supervisor of two departments counts once; deactivated members do not count	BILL-017, BR-016
AC-SEAT-03	After a seat reduction or downgrade is scheduled, acceptance beyond the scheduled limit is rejected immediately	BILL-021, BR-018
AC-SEAT-04	A reduction below usage (PR-13) and a downgrade above the target limit (PR-12) are rejected	BILL-018, BILL-019
AC-SEAT-05	An upgrade cancels a scheduled downgrade (PR-10b)	BILL-020, BR-008
AC-SEAT-06	A seat removal gives no credit and the renewal uses the reduced quantity (PR-08)	BILL-018, BR-017


14.6 Billing, webhooks, ledger
ID	Criterion	Verifies
AC-BILL-01	A quote holds the required fields, equals the formula, and expires at the earlier of 15 minutes and the business's next local midnight	BILL-013
AC-BILL-02	A stale, expired or used quote is rejected; two Owners confirming one quote gives one success	BILL-014, BR-019
AC-BILL-03	Only Owners can request or confirm quotes; GM, Supervisor and Staff get 403	BR-006, BILL-002
AC-BILL-04	Confirmation alone grants nothing; the entitlement appears only after the verified event is processed	BILL-015, BR-022
AC-BILL-05	NGN quote amounts are calculated server-side from the USD base price using a valid configured rate; client-supplied rates are ignored/rejected; explicit currency and historical ledger immutability are preserved	BILL-012, BR-020, D-23
AC-BILL-06	The same idempotency key and body gives one intent, one charge and the same response; a different body gives 422; the provider-leg key is used	BILL-008
AC-BILL-07	A second confirmation while a payment intent is open returns PAYMENT_PENDING	BILL-022
AC-BILL-08	PR-14 and PR-15 pass; a time-zone change applies from the next period	BILL-016, BILL-029, BR-024
AC-BILL-09	Decision record DR-01 exists with the section 8.7 table completed from provider documentation and test-mode runs before M8 starts	BILL-023
AC-BILL-10 (after OQ-019)	Minimum-charge and zero-amount behaviour matches the recorded decision	BILL-024
AC-BILL-11	A test-mode checkout for an upgrade completes end to end and grants the entitlement only after the webhook	BILL-005, BILL-001
AC-BILL-12	A scheduled downgrade leaves the entitlement unchanged until renewal, then applies	BILL-003
AC-BILL-13 (after FX-01)	A chargeable NGN quote is issued only when the configured rate source is valid and fresh; the quote records the source, rate, timestamp, rounding version, amount and expiry	BILL-027, D-23
AC-WH-01	A bad signature is rejected and nothing is processed	BILL-007, SEC-007
AC-WH-02	A duplicate event ID is acknowledged and produces one ledger effect	BILL-007, C-09
AC-WH-03	A status, amount, currency or reference mismatch is marked rejected_mismatch, raises an alert and grants nothing	BILL-007
AC-WH-04	With Redis stopped, a signed event is stored and later processed exactly once by the sweeper	BILL-007, NFR-REL-002
AC-WH-05	An event for an unknown reference is retried then flagged; an out-of-order event cannot move an intent out of a terminal state	BILL-007
AC-WH-06	A replayed valid event does not grant entitlement for a different payment intent	BILL-006
AC-WH-07	Where a provider verify call exists, a disagreement blocks the entitlement	BILL-006
AC-LED-01	Replaying ledger rows and events reproduces plan, seats, period and status exactly	BILL-010, BILL-025
AC-LED-02	Corrections are reversal rows with the exact original amounts; originals are unchanged	BILL-028
AC-FR-01	A failed-renewal webhook sets past_due and writes the event and ledger rows	BILL-011, BR-021
AC-FR-02	Owners get an urgent notice within 5 minutes regardless of quiet hours, and an in-app banner persists	BILL-011, FR-NOT-008, FR-NOT-009
AC-FR-03	Retries run on days 1, 3 and 5 after the first failure; each attempt is logged with its number	BILL-011
AC-FR-04	From day 0 to day 6 all features work	BILL-011
AC-FR-05	On day 7 without payment, manager writes, creating or accepting invitations, and plan or seat quotes return SUBSCRIPTION_RESTRICTED; Staff can still read published schedules; an Owner can pay	BILL-030
AC-FR-06	A verified payment in past_due or restricted restores active and lifts the restriction	BILL-011, BILL-030
AC-FR-07	A ledger replay reproduces the past-due, restricted and recovered states	BILL-025
AC-FR-08 (after G-01)	The renewal mechanism recorded in DR-01 is implemented and tested	BILL-026


14.7 Notifications, settings, feed, offline
ID	Criterion	Verifies
AC-NOT-01	A shift change within 12 hours of the affected start (old or new) is delivered during quiet hours; one 13 hours away is deferred	FR-NOT-008, BR-011
AC-NOT-02	A user can switch off push for security and billing but the inbox item and banner remain; disabling them completely is rejected	FR-NOT-009, FR-NOT-014
AC-NOT-03	Stopping the worker mid fan-out and retrying gives exactly one notification per device	FR-NOT-010, C-10
AC-NOT-04	A receipt reporting an unregistered device deletes the token	FR-NOT-011, FR-NOT-004
AC-NOT-05	After A logs out and B logs in on one device only B receives pushes; the token stays unique	FR-NOT-012
AC-NOT-06	A link into another business prompts to switch and never switches silently; an inaccessible resource shows not-found	FR-NOT-005
AC-NOT-07	A deferred notification superseded by a later change is skipped at delivery	FR-NOT-013
AC-NOT-08	A disabled non-mandatory category produces no push	FR-NOT-006, FR-NOT-001
AC-NOT-09	Push tokens are registered per user and device and sending runs in background jobs	FR-NOT-002, FR-NOT-003
AC-SET-01	Changes to different fields on two devices both survive; an older replayed edit loses	FR-SET-001, FR-SET-003, FR-SET-005
AC-SET-02	A failed swap request or settings save returns the interface to its previous state with an error	FR-SWP-005, FR-SET-004
AC-ACT-01	A Staff feed contains only events they act in, are the subject of, or that their scope allows; others' attendance and absence do not appear	FR-ACT-005
AC-ACT-02	Security events are visible only to the affected user and Owners	FR-ACT-007
AC-ACT-03	Cursor pagination has no duplicates or gaps for each audience type across 10,000 seeded events	FR-ACT-006
AC-ACT-04	The feed shows loading, empty, error and end states, prevents duplicate requests during fast scrolling, and supports pull-to-refresh	FR-ACT-002, FR-ACT-003
AC-ACT-05	EXPLAIN ANALYZE before and after is recorded for each audience type	NFR-PERF-001
AC-OFF-01	After logout, business switch or detected revocation, the offline cache and query cache are empty	FR-OFF-004
AC-OFF-02	Offline, cached shifts are read-only with a last-updated time; reconnect refreshes them	FR-OFF-003, FR-OFF-005


14.8 Scheduling, swaps, attendance
ID	Criterion	Verifies
AC-SCH-01	Overlap, shortage and availability conflicts are detected and shown	FR-SCH-004, BR-001
AC-SCH-02	Draft, review and publish transitions work; staff see only published shifts; calendar and manual and requirement-based assignment work	FR-SCH-001, FR-SCH-002, FR-SCH-003, FR-SCH-005
AC-SCH-03	An overnight shift is stored in UTC and shown in business time; a recurring 08:00 requirement yields 08:00 local on both sides of a clock change	FR-SCH-007, FR-SCH-009, BR-013
AC-SCH-04	Editing or cancelling a published shift notifies affected staff	FR-SCH-008
AC-SCH-05	A same-department colleague can accept; a cross-department or overlapping colleague cannot; approval needs acceptance	FR-SWP-001, FR-SWP-002, FR-SWP-003, FR-SWP-006, FR-SWP-007, BR-004
AC-SCH-06	Staff submit availability; managers see conflicts	FR-AVL-001, FR-AVL-002
AC-SCH-07	Present, late and absent are recorded; absence notifies the manager; excluded attendance features are absent	FR-ATT-001, FR-ATT-002, FR-ATT-003
AC-ORG-01	Owner and GM can create departments; Supervisor and Staff cannot	FR-ORG-001


14.9 Sharding, performance, operations, privacy
ID	Criterion	Verifies
AC-SH-01	The same business_id maps to the same shard across 1,000 calls and restarts	SEC-013, NFR-SCALE-002
AC-SH-02	Of 1,000 generated IDs each shard receives at least 40 percent; the distribution is reported	NFR-SCALE-002
AC-SH-03	Every row of a business exists only on its shard; a direct read on the other shard returns nothing	NFR-SCALE-002
AC-SH-04	Cross-shard operations (login membership lookup via the control plane, global listings) are listed in SHARDING.md with their cost	NFR-SCALE-002
AC-SH-05	A skewed business with 10,000 activity rows shows the shard imbalance in the report	NFR-SCALE-002
AC-SH-06	Migrations apply to both shards and report any drift	NFR-SCALE-002
AC-OPS-01	Every response has a request ID that appears in the matching structured log line; job attempts are logged with their number	FR-OPS-001, NFR-OBS-001, NFR-REL-001
AC-OPS-02	Error tracking redacts personal data in a test event	FR-OPS-002
AC-OPS-03	Load-test scripts and a written report exist, with before and after caching	FR-OPS-003, FR-OPS-004
AC-OPS-04	The pool-size calculation is documented and an exhaustion test shows queuing, not failure	NFR-PERF-003
AC-OPS-05	Editing a shift invalidates the cached roster and calendar before the next read	NFR-PERF-004
AC-OPS-06	A user's write is visible on their next read even if replicas lag	NFR-SCALE-001
AC-OPS-07	SECURITY.md lists at least eight threats, each mapped to mitigations	SEC-006
AC-OPS-08	Every EXPO_PUBLIC_ variable is documented and a scan finds no secret in the bundle	SEC-005
AC-OPS-09	Every route returns 400 VALIDATION_ERROR for an invalid body (generated)	SEC-003
AC-OPS-10	The development-build setup is documented and push, HTTPS app links and Google sign-in run in it	FR-NOT-002, FR-AUTH-007
AC-PRIV-01	A deletion request is recorded; a sole Owner is blocked until another Owner exists	PRIV-001, PRIV-003
AC-PRIV-02	After deletion, sessions and push tokens are gone, memberships ended, personal fields pseudonymised in activity events, and ledger totals unchanged	PRIV-004, PRIV-005, SEC-009
AC-PRIV-03	PRIVACY-RETENTION.md exists and is reviewed before launch (G-03)	PRIV-002, PRIV-006, PRIV-007


15. Risks, dependencies and external services
ID	Risk	Level	Mitigation
RISK-001	Tenant isolation defect	High	RLS, composite keys, tenant context, generated tests (SEC-010 to SEC-016)
RISK-002	Billing and proration errors	High	Server-side formula, bound quotes, ledger, PR vectors
RISK-003	Provider cannot support custom proration	High	Gate G-01 in M0 (BILL-023)
RISK-004	Attendance scope creep	Medium	Narrow V1 scope (FR-ATT-003)
RISK-005	Sharding simulation complexity	Medium	Router built first (M1); limits documented in SHARDING.md
RISK-006	Payment provider access not configured	Medium	Do not assume access; confirm credentials in G-01
RISK-007	Neither provider supports both USD and NGN	High	Options in 8.7; owner decision in DR-01
RISK-008	Control plane and tenant plane drift apart (membership directory)	Medium	Outbox, reconciliation job, AC-TEN-07
RISK-009	RLS misconfiguration or bypass by the application role	High	C-03, catalogue test AC-TEN-02
RISK-010	Very small prorated amounts below provider minimums	Medium	OQ-019, decided in DR-01
RISK-011	Google credentials unavailable	Medium	Gate G-02; fallback in FR-AUTH-002
RISK-012	Retention and deletion rules conflict with legal duties	Medium	Gate G-03; policy reviewed before launch


External services: payment provider (Paystack and Flutterwave shortlisted, unverified), Expo push service, email delivery for verification, reset and invitations, Google sign-in (if G-02 is met), error tracking (Sentry proposed), managed or local PostgreSQL and Redis.
Dependencies: Expo development build for push, Google sign-in and HTTPS app links; domain and hosting for app-link verification files. Branch-specific entities and constraints in Section 19.2 extend the earlier baseline data model and must be included in the implementation schema.---
16. Scope
V1 in scope: sections 6 to 13 as tagged, including simplified attendance (FR-ATT-001, FR-ATT-002), multi-business identity, USD base pricing and controlled NGN quotes under Section 19.5. Live billing and chargeable NGN quotes remain gated by verified provider/FX configuration.
Deferred [P]: magic link, self clock-in, payroll export, leave management, staff in several departments, cross-department swaps, offline edits, web admin portal, tablet layouts, conversion of existing payments, ledger entries or subscription balances (controlled quote conversion is defined in Section 19.5), personal-data export (PRIV-008).
Excluded [P]: geofencing, biometrics, labour-law compliance engine.
17. Open questions, decision gates and assumptions
17.1 Open questions
ID	Question	Status	Needed by
OQ-001	Can one identity belong to several businesses?	RESOLVED (D-01)	n/a
OQ-002	More than one Owner per business?	RESOLVED (D-02)	n/a
OQ-003	Currency and minor unit	RESOLVED by D-23/D-24: USD base price schedule, explicit USD/NGN amounts, server-calculated NGN quotes, immutable historical records. FX source and provider feasibility remain gated by FX-01/G-01.	Before chargeable NGN/live billing
OQ-004	Provider choice and billing mechanism for custom proration	OPEN, gate G-01	End of M0; before M8
OQ-005	Credit and refund rounding; period and day-boundary rules	RESOLVED (D-11, D-12): no mid-period credits; actual period length; business time zone	n/a
OQ-006	Do pending invitations reserve a seat?	RESOLVED (D-09): no	n/a
OQ-007	Grace period, retries, meaning of "restricted"	RESOLVED (D-13). Retry mechanism open (OQ-021); Staff writes in restricted mode open (OQ-023)	n/a
OQ-008	Google sign-in or magic link	RESOLVED (D-07): Google, subject to G-02; magic link deferred	n/a
OQ-009	Access-token lifetime, refresh lifetimes, refresh grace window	PROPOSED: 15 min, 30 days idle, 90 days absolute, 10 s. Needs confirmation	Before M2
OQ-010	Definition of urgent notifications	RESOLVED (D-14)	n/a
OQ-011	Invitation boundaries per role	RESOLVED (D-03)	n/a
OQ-012	Maximum total seats on Team and Business	OPEN	Before M8 (affects BILL-019)
OQ-013	Offline cache window	PROPOSED: 14 days	Before M7
OQ-014	Settings conflict granularity	PROPOSED: per field	Before M5
OQ-015	NDPA obligations and retention periods	OPEN, gate G-03 (D-15 requires a documented policy)	Before launch
OQ-016	Can Owner, GM and Supervisor memberships be rostered on shifts?	RESOLVED by D-17: yes, subject to normal availability, conflict and authorised scope rules.	n/a
OQ-017	Can a Supervisor supervise more than one department?	RESOLVED by D-18: yes, through explicit authorised assignments. Department supervisor cardinality must not be used to bypass scope checks.	n/a
OQ-018	Can an Owner remove or demote another Owner?	RESOLVED by D-16: yes, if at least one active Owner remains; only an Owner may do so.	n/a
OQ-019	Provider minimum charge amounts; handling of very small or zero prorated amounts	OPEN, depends on G-01	Before M8
OQ-020	FX source, freshness threshold, precision and rounding policy for NGN quotes	OPEN, gate FX-01	Before chargeable NGN quotes
OQ-021	Renewal mechanism: server-initiated charge or payment link to Owners	OPEN, depends on G-01	Before M8
OQ-022	Which roles other than Owners and the affected user see security events?	RESOLVED by D-19: none; security events are visible only to the affected user and business Owners.	n/a
OQ-023	In restricted mode, can Staff still submit availability, swap requests and settings?	OPEN (v0.2 allows settings only)	Before M8
OQ-024	Billing-currency change process	RESOLVED by D-24: request and manual review; current currency remains until approved and new quote/payment setup is confirmed. Provider mechanics remain gated by DR-01.	Before live billing
OQ-025	Retention periods, deletion deadlines and legal basis	OPEN, gate G-03	Before launch


17.2 Decision gates
Gate	What must be true	Owner	Blocks
G-01	Provider and currency capability verified from provider documentation and test-mode runs for USD and NGN (section 8.7); decision recorded in DR-01. Not done in v0.2	Product owner	Any billing implementation (M8)
G-02	Google OAuth credentials and platform configuration available	Product owner	Google sign-in (FR-AUTH-002)
G-03	PRIVACY-RETENTION.md written and legally reviewed	Product owner	Launch (PRIV-002)
FX-01	Exchange-rate source, freshness threshold, precision and rounding rule verified and recorded	Product owner	Chargeable NGN quotes


17.3 Assumptions [P]
A business has one primary time zone; the owner group is the payer; every active membership occupies a seat; notification language follows the user's language setting.
18. Proposed implementation milestones
M	Milestone	Deliverables	Exit checks
M0	Decisions, verification and workspace	Expo development build documented; local Postgres and Redis; docs skeleton (README, STATE, LEARNING-LOG); decision records DR-01 (provider, currency, billing mechanism, renewal, minimum amounts), DR-02 (HTTP framework), DR-03 (job queue, outbox, sweeper), DR-04 (tenancy architecture), DR-05 (token and session design), DR-06 (client state); gates G-01 to G-04 progressed	DR-01 to DR-06 recorded; no billing code before DR-01 (AC-BILL-09)
M1	Tenant-aware foundation	Control and tenant planes; shard router; tenant context with transaction-scoped setting; repository layer; RLS and composite-key conventions; generated cross-tenant test harness; request IDs, structured logging, error tracking; core schema for users, businesses, departments, memberships	AC-001, AC-TEN-01 to AC-TEN-05, AC-TEN-08, AC-DM-01, AC-DM-06, AC-SH-01 to AC-SH-03, AC-OPS-01, AC-OPS-02, AC-OPS-09
M2	Authentication and sessions	Email/password; email verification; tokens; refresh rotation and revocation; password reset; Google sign-in if G-02; business switching; sessions screen; Redis rate limiting with the failure behaviour	AC-AUTH-01 to AC-AUTH-12, AC-003, AC-004, AC-005, AC-TEN-06
M3	Business structure, invitations, seats	Departments, supervisors, memberships, role matrix; invitation flow (hashed tokens, HTTPS app links); last-Owner rule; single-department constraints; transactional seat admission against a seeded subscription; audit log; directory outbox and reconciliation	AC-INV-01 to AC-INV-09, AC-RBAC-01 to AC-RBAC-04, AC-ORG-01, AC-DM-02 to AC-DM-05, AC-SEAT-01, AC-SEAT-02, AC-TEN-07, AC-002, AC-012
M4	Scheduling and caching	Shifts, requirements, conflicts, draft/review/publish, availability, time zones and daylight saving; tenant-scoped roster and calendar caches	AC-SCH-01 to AC-SCH-04, AC-SCH-06, AC-OPS-05
M5	Notifications and settings	Queue, delivery records, inbox, quiet hours, urgent rule, receipts, push tokens, deep links, mandatory categories, settings sync	AC-NOT-01 to AC-NOT-09, AC-SET-01, AC-006, AC-016, AC-017, AC-OPS-10
M6	Swaps, attendance, activity feed	Swaps, attendance, feed events and visibility, pagination, UI states, 10,000 seeded events	AC-SCH-05, AC-SCH-07, AC-SET-02, AC-ACT-01, AC-ACT-02, AC-ACT-04, AC-007, AC-014
M7	Offline	Read-only cache, last-updated time, clearing rules	AC-OFF-01, AC-OFF-02, AC-008
M8	Subscriptions and billing	Simulated provider, server-calculated quotes, deterministic labelled FX fixtures for tests, webhook/event verification contract, ledger, proration, scheduled changes, failed renewal and restricted mode. Live provider/chargeable NGN remain gated.	AC-BILL-01 to AC-BILL-13, AC-WH-01 to AC-WH-07, AC-LED-01, AC-LED-02, AC-FR-01 to AC-FR-08, AC-SEAT-03 to AC-SEAT-06
M9	Performance and scale evidence	Pooling, read/write routing, load tests before and after caching, EXPLAIN ANALYZE, sharding report	AC-015, AC-ACT-03, AC-ACT-05, AC-SH-04 to AC-SH-06, AC-OPS-03, AC-OPS-04, AC-OPS-06
M10	Security, privacy, deployment	SECURITY.md, deletion flow and privacy policy implementation, deployment documentation, final documents	AC-PRIV-01 to AC-PRIV-03, AC-OPS-07, AC-OPS-08


Security and isolation tests are part of every milestone's exit, not only M10.
Required documents: README.md, PRD.md, ARCHITECTURE.md, STATE.md, SECURITY.md, SHARDING.md, LEARNING-LOG.md, PRIVACY-RETENTION.md, architecture diagram, ERD, API contracts, decision records (DR-01 onward), test, deployment and load-test documentation, load-test scripts and report.
19. Traceability (requirement to test or evidence)
Generated from the "Verifies" column of section 14. Requirements marked T are unresolved; they list the criterion that becomes testable once decided. "Evidence" lists the non-test proof where no acceptance criterion applies.
Requirement	Status	Acceptance criteria	Evidence
FR-AUTH-001	A	AC-AUTH-10	
FR-AUTH-002	A (D-07) / P (fallback, magic link deferral)	AC-AUTH-05	
FR-AUTH-003	A (D-06) / P (values, OQ-009)	AC-AUTH-10	
FR-AUTH-004	A (D-06) / P (window)	AC-003, AC-AUTH-01	
FR-AUTH-005	A (D-06)	AC-004, AC-AUTH-02	
FR-AUTH-006	A / P (expiry)	AC-005, AC-AUTH-03	
FR-AUTH-007	A / P (expiry)	AC-INV-01, AC-INV-02, AC-INV-03, AC-INV-04, AC-INV-05, AC-OPS-10	
FR-AUTH-008	P	AC-AUTH-08	
FR-AUTH-009	A	AC-AUTH-07	
FR-AUTH-010	A (D-01)	AC-AUTH-09, AC-TEN-06	
FR-AUTH-011	A (D-07) / P (re-authentication step)	AC-AUTH-04	
FR-AUTH-012	P	AC-AUTH-04	
FR-AUTH-013	A (D-06)	AC-AUTH-02	
FR-RBAC-001	A	AC-RBAC-01	
FR-RBAC-002	A	AC-002	
FR-RBAC-003	A (D-03) / P (other actions)	AC-RBAC-01	
FR-RBAC-004	P	AC-RBAC-04	
FR-RBAC-005	A (D-02, D-03)	AC-INV-06, AC-RBAC-02	
FR-RBAC-006	P	AC-TEN-06	
FR-ORG-001	A	AC-ORG-01, AC-RBAC-01	
FR-ORG-002	A (D-03)	AC-INV-06	
FR-ORG-003	P	AC-DM-03	
FR-ORG-004	P	AC-DM-05, AC-RBAC-01	
FR-ORG-005	A (D-01)	AC-DM-04, AC-INV-07, AC-TEN-07	
FR-ORG-006	A (D-02) / P (last-Owner rule)	AC-RBAC-02	
FR-ORG-007	A (D-05)	AC-DM-01	
FR-SCH-001	A	AC-SCH-02	
FR-SCH-002	A	AC-SCH-02	
FR-SCH-003	A	AC-SCH-02	
FR-SCH-004	A	AC-SCH-01	
FR-SCH-005	A	AC-SCH-02	
FR-SCH-006	A	AC-006	
FR-SCH-007	P	AC-SCH-03	
FR-SCH-008	P	AC-SCH-04	
FR-SCH-009	P	AC-SCH-03	
FR-SCH-010	A (derived from D-05)	AC-DM-02	
FR-AVL-001	A	AC-SCH-06	
FR-AVL-002	A	AC-SCH-06	
FR-AVL-003	A	AC-RBAC-03	
FR-SWP-001	A	AC-SCH-05	
FR-SWP-002	A	AC-SCH-05	
FR-SWP-003	A	AC-SCH-05	
FR-SWP-004	A	AC-007	
FR-SWP-005	A	AC-SET-02	
FR-SWP-006	P	AC-SCH-05	
FR-SWP-007	P	AC-SCH-05	
FR-ATT-001	P	AC-SCH-07	
FR-ATT-002	P	AC-SCH-07	
FR-ATT-003	P	AC-SCH-07	
FR-ACT-001	A	AC-014	
FR-ACT-002	A	AC-ACT-04	
FR-ACT-003	A	AC-ACT-04	
FR-ACT-004	A	AC-014	
FR-ACT-005	A (D-04)	AC-ACT-01	
FR-ACT-006	P	AC-ACT-03	
FR-ACT-007	A (D-04) / P (audience)	AC-ACT-02	
FR-NOT-001	A	AC-NOT-08	
FR-NOT-002	A	AC-NOT-09, AC-OPS-10	
FR-NOT-003	A	AC-NOT-09	
FR-NOT-004	A	AC-NOT-04	
FR-NOT-005	A	AC-NOT-06	
FR-NOT-006	A	AC-NOT-08	
FR-NOT-007	A	AC-016	
FR-NOT-008	A (D-14)	AC-FR-02, AC-NOT-01	
FR-NOT-009	A (D-14)	AC-FR-02, AC-NOT-02	
FR-NOT-010	A	AC-NOT-03	
FR-NOT-011	A	AC-NOT-04	
FR-NOT-012	P	AC-NOT-05	
FR-NOT-013	P	AC-NOT-07	
FR-NOT-014	A (D-14)	AC-NOT-02	
FR-SET-001	A	AC-SET-01	
FR-SET-002	A	AC-017	
FR-SET-003	A	AC-SET-01	
FR-SET-004	A	AC-SET-02	
FR-SET-005	P (OQ-014)	AC-SET-01	
FR-OFF-001	A	AC-008	
FR-OFF-002	A	AC-008	
FR-OFF-003	P	AC-OFF-02	
FR-OFF-004	A	AC-OFF-01	
FR-OFF-005	P	AC-OFF-02	
FR-OPS-001	A	AC-OPS-01	
FR-OPS-002	P	AC-OPS-02	
FR-OPS-003	A	AC-OPS-03	README.md, deployment and load-test documents
FR-OPS-004	A / P (tool)	AC-OPS-03	
BR-001	P	AC-SCH-01	
BR-002	P	AC-006	
BR-003	A (intent) / P (mechanism)	AC-007	
BR-004	A	AC-SCH-05	
BR-005	A	AC-RBAC-03	
BR-006	A (D-10)	AC-BILL-03	
BR-007	A	AC-012, AC-SEAT-01	
BR-008	A (D-11)	AC-SEAT-05	
BR-009	A	AC-011	
BR-010	A	AC-013	
BR-011	A (D-14)	AC-016, AC-NOT-01	
BR-012	P	AC-DM-03	
BR-013	P (shifts) / A (billing, D-12)	AC-SCH-03	
BR-014	A (D-05)	AC-DM-04	
BR-015	P	AC-RBAC-02	
BR-016	A (D-09)	AC-INV-09, AC-SEAT-02	
BR-017	A (D-11)	AC-SEAT-06	
BR-018	P	AC-SEAT-03	
BR-019	A (D-10, D-12)	AC-BILL-02	
BR-020	A (D-08) / P (new subscription)	AC-BILL-05	
BR-021	A (D-13)	AC-FR-01	
BR-022	A (D-10)	AC-BILL-04	
BR-023	P	AC-INV-08	
BR-024	P	AC-BILL-08	
BILL-001	A	AC-009, AC-BILL-11	
BILL-002	A	AC-BILL-03	
BILL-003	A	AC-BILL-12	
BILL-004	A (D-12)	AC-009	
BILL-005	A	AC-BILL-11	
BILL-006	A	AC-010, AC-WH-06, AC-WH-07	
BILL-007	A	AC-010, AC-WH-01, AC-WH-02, AC-WH-03, AC-WH-04, AC-WH-05	
BILL-008	A	AC-BILL-06	
BILL-009	A	AC-012, AC-INV-09, AC-SEAT-01	
BILL-010	A	AC-LED-01	
BILL-011	A (D-13)	AC-FR-01, AC-FR-02, AC-FR-03, AC-FR-04, AC-FR-06	
BILL-012	A (D-08)	AC-BILL-05	
BILL-013	A (D-10) / P (15 minutes)	AC-BILL-01	
BILL-014	A (D-10, D-12)	AC-BILL-02	
BILL-015	A (D-10)	AC-BILL-04	
BILL-016	A (D-12) / P (anchor)	AC-009, AC-BILL-08	
BILL-017	A (D-09)	AC-SEAT-02	
BILL-018	A (D-11)	AC-SEAT-04, AC-SEAT-06	
BILL-019	A (D-11)	AC-SEAT-04	
BILL-020	A (D-11)	AC-SEAT-05	
BILL-021	P	AC-SEAT-03	
BILL-022	P	AC-BILL-07	
BILL-023	A (D-08)	AC-BILL-09	
BILL-024	T	AC-BILL-10	
BILL-025	A	AC-FR-07, AC-LED-01	
BILL-026	T	AC-FR-08	
BILL-027	T	AC-BILL-13	
BILL-028	A	AC-LED-02	
BILL-029	P	AC-BILL-08	
BILL-030	A (D-13)	AC-FR-05, AC-FR-06	
SEC-001	A	AC-001	
SEC-002	A	AC-002	
SEC-003	A	AC-OPS-09	
SEC-004	A / P (thresholds)	AC-AUTH-06	
SEC-005	A	AC-OPS-08	
SEC-006	A	AC-OPS-07	
SEC-007	A	AC-WH-01	
SEC-008	P	AC-AUTH-11	
SEC-009	A (D-15)	AC-PRIV-02	
SEC-010	A	AC-TEN-04	
SEC-011	A	AC-TEN-02	
SEC-012	A	AC-TEN-03	
SEC-013	A	AC-SH-01	
SEC-014	A	AC-TEN-05	
SEC-015	A	AC-TEN-01	
SEC-016	A	AC-001, AC-TEN-01	
SEC-017	A	AC-AUTH-12, AC-TEN-06	
SEC-018	A	AC-TEN-08	
SEC-019	A (D-07)	AC-AUTH-04	
SEC-020	A (D-06)	AC-AUTH-01	
PRIV-001	A	AC-PRIV-01	
PRIV-002	A (D-15)	AC-PRIV-03	
PRIV-003	P	AC-PRIV-01	
PRIV-004	P	AC-PRIV-02	
PRIV-005	P	AC-PRIV-02	
PRIV-006	T (G-03, OQ-025)	AC-PRIV-03	
PRIV-007	T	AC-PRIV-03	
PRIV-008	T	none yet	Deferred (section 16); testable once OQ-025 is decided
NFR-PERF-001	A	AC-ACT-05	
NFR-PERF-002	A	AC-015	
NFR-PERF-003	A	AC-OPS-04	
NFR-PERF-004	A	AC-OPS-05	
NFR-SCALE-001	A	AC-OPS-06	
NFR-SCALE-002	A	AC-SH-01, AC-SH-02, AC-SH-03, AC-SH-04, AC-SH-05, AC-SH-06	
NFR-REL-001	A	AC-OPS-01	
NFR-REL-002	P	AC-AUTH-06, AC-WH-04	
NFR-OBS-001	A / P	AC-OPS-01	
NFR-COST-001	A	none yet	Service and cost list in ARCHITECTURE.md


Appendix A. Audit resolution map
Finding	Resolution in v0.2	Result
BL-01	4.2, 4.4, 9.1, FR-AUTH-010, FR-ORG-005, AC-TEN-06, AC-TEN-07	Resolved (D-01)
BL-02	Section 18: M0 and M1 first; billing spike in M0	Resolved
HI-01	SEC-010 to SEC-012, C-01 to C-03, AC-TEN-02 to AC-TEN-04	Resolved
HI-02	4.3, FR-RBAC-005, AC-INV-06	Resolved (D-03)
HI-03	4.6, FR-ACT-005 to FR-ACT-007, AC-ACT-01, AC-ACT-02	Resolved (D-04); wider security-event audience open (OQ-022)
HI-04	FR-AUTH-004, AC-AUTH-01	Resolved; window value proposed
HI-05	FR-AUTH-005, FR-AUTH-013, FR-RBAC-006, AC-AUTH-02	Resolved; token lifetimes proposed (OQ-009)
HI-06	FR-AUTH-007, invitations entity, AC-INV-01 to AC-INV-09	Resolved; expiry proposed
HI-07	FR-AUTH-011, FR-AUTH-012, SEC-019, AC-AUTH-04	Resolved (D-07)
HI-08	8.2 blocked-acceptance flow, J-14, AC-INV-09	Resolved (D-09); Owner-notification flow proposed
HI-09	BILL-009, BR-007, AC-SEAT-01	Resolved
HI-10	BILL-016, BILL-004, BILL-018, PR-14, PR-15	Resolved (D-11, D-12); anchor rule proposed
HI-11	G-01, DR-01 in M0, 8.7, BILL-023	Resolved as a gate. Provider support NOT verified
HI-12	BILL-007 steps, AC-WH-01 to AC-WH-07	Resolved
HI-13	8.8, BILL-011, BILL-030, AC-FR-01 to AC-FR-08	Resolved (D-13); mechanism and Staff writes open (OQ-021, OQ-023)
HI-14	FR-NOT-008, BR-011, AC-NOT-01	Resolved (D-14)
HI-15	FR-NOT-010, FR-NOT-011, notification_deliveries, AC-NOT-03, AC-NOT-04	Resolved
HI-16	Section 14 (rate limits AC-AUTH-06, idempotency AC-BILL-06, token cleanup AC-NOT-04 and the rest)	Resolved
ME-01	Section 9 (sessions, auth_tokens, audit_log, billing_quotes, payment_intents, notification_deliveries)	Resolved
ME-02	D-05, BR-014, C-05, FR-SWP-006	Resolved
ME-03	C-08, BILL-025, AC-LED-01	Resolved
ME-04	BILL-008, idempotency_keys, AC-BILL-06	Resolved
ME-05	8.1 cost function, BILL-013, BILL-014	Resolved
ME-06	FR-NOT-009	Resolved (D-14)
ME-07	FR-NOT-012, AC-NOT-05	Resolved
ME-08	FR-SET-005, AC-SET-01	Resolved as proposal (OQ-014)
ME-09	FR-NOT-005, AC-NOT-06	Resolved
ME-10	FR-OFF-004, AC-OFF-01	Resolved
ME-11	SEC-014 to SEC-016, AC-TEN-01, AC-TEN-05	Resolved
ME-12	FR-AUTH-006, 11.2, AC-AUTH-03, AC-AUTH-06, NFR-REL-002	Resolved; thresholds proposed
ME-13	11.5, PRIV-001 to PRIV-008, G-03	Partly: policy required (D-15); periods open (OQ-025)
ME-14	FR-SCH-009, AC-SCH-03	Resolved (proposal)
ME-15	12.6, DR-02 to DR-06	Resolved as proposals; framework choice open (DR-02)
ME-16	FR-OPS-001 and NFR-OBS-001 in M1	Resolved
LO-01	FR-OPS-002 (Sentry proposal)	Resolved
LO-02	FR-OPS-004, AC-OPS-03	Resolved
LO-03	Tags applied throughout	Resolved
LO-04	BR-013, FR-SCH-007 (display in business time zone; quiet hours use the user's zone)	Resolved
LO-05	FR-AUTH-003 values	Resolved as proposal
LO-06	12.2 notification language and fallback	Resolved (proposal)
LO-07	C-13, BR-020	Resolved
LO-08	Section 19 generated from section 14	Resolved


Appendix B. Decision to requirement and test map
Generated from the (D-nn) references in the requirement tables.
Decision	Requirements citing it	Acceptance criteria
D-01	FR-AUTH-010, FR-ORG-005	AC-AUTH-09, AC-DM-04, AC-INV-07, AC-TEN-06, AC-TEN-07
D-02	FR-RBAC-005, FR-ORG-006	AC-INV-06, AC-RBAC-02
D-03	FR-RBAC-003, FR-RBAC-005, FR-ORG-002	AC-INV-06, AC-RBAC-01, AC-RBAC-02
D-04	FR-ACT-005, FR-ACT-007	AC-ACT-01, AC-ACT-02
D-05	FR-ORG-007, FR-SCH-010, FR-SWP-006, BR-014	AC-DM-01, AC-DM-02, AC-DM-04, AC-SCH-05
D-06	FR-AUTH-003, FR-AUTH-004, FR-AUTH-005, FR-AUTH-013, SEC-020	AC-003, AC-004, AC-AUTH-01, AC-AUTH-02, AC-AUTH-10
D-07	FR-AUTH-002, FR-AUTH-011, SEC-019	AC-AUTH-04, AC-AUTH-05
D-08	BR-020, BILL-012, BILL-023	AC-BILL-05, AC-BILL-09
D-09	BR-016, BILL-017	AC-INV-09, AC-SEAT-02
D-10	BR-006, BR-019, BR-022, BILL-013, BILL-014, BILL-015	AC-BILL-01, AC-BILL-02, AC-BILL-03, AC-BILL-04
D-11	BR-008, BR-017, BILL-018, BILL-019, BILL-020	AC-SEAT-04, AC-SEAT-05, AC-SEAT-06
D-12	BR-013, BR-019, BILL-004, BILL-014, BILL-016	AC-009, AC-BILL-02, AC-BILL-08, AC-SCH-03
D-13	BR-021, BILL-011, BILL-030	AC-FR-01, AC-FR-02, AC-FR-03, AC-FR-04, AC-FR-05, AC-FR-06
D-14	FR-NOT-008, FR-NOT-009, FR-NOT-014, BR-011	AC-016, AC-FR-02, AC-NOT-01, AC-NOT-02
D-15	SEC-009, PRIV-002	AC-PRIV-02, AC-PRIV-03


19. Authoritative v0.3 amendments and consolidated decisions
Authority rule: This section is part of this single PRD and supersedes any conflicting v0.2 wording elsewhere in the document. Requirements and IDs from v0.2 remain useful unless explicitly superseded here. Implementers must follow this section for branches, role permissions, invitations, membership lifecycle, billing currency conversion and renewal behaviour. The PRD remains DRAFT — not approved for implementation until the gates in section 19.8 are closed or explicitly scoped out by the product owner.
19.1 Consolidated product decisions
ID	Decision	Status / implementation consequence
D-16	An Owner may remove or demote another Owner, but a business must always retain at least one active Owner.	Agreed. The final active Owner cannot be removed, demoted, deactivated or deleted until another Owner exists. Record ownership changes in the audit log.
D-17	Owners, General Managers and Supervisors may be assigned to shifts.	Agreed. They remain subject to the same availability, conflict, branch-scope and scheduling rules as other assignees; privileges do not imply automatic assignment.
D-18	A Supervisor may oversee multiple departments within their authorised branch/business scope.	Agreed. Each assignment is explicit and checked server-side.
D-19	Security events are visible only to the affected user and business Owners.	Agreed. Other activity-feed events retain the existing role/scope visibility rules.
D-20	Staff-seat limits apply across the entire business, not per branch.	Agreed. Each active membership counts once per business; moving a worker between branches/departments does not create a second seat.
D-21	Failed renewal receives a seven-day grace period.	Agreed. Notify Owners; retry on days 1, 3 and 5 where the payment mechanism supports retries. At grace expiry, restrict the defined management actions, preserve published-schedule reads and data, and restore normal access only after verified payment.
D-22	Downgrades and seat reductions take effect at the next renewal; immediate upgrades/additional seats may be prorated.	Agreed. No immediate credit for scheduled removals/downgrades. Upgrades/additional seats require an Owner-confirmed server quote. A downgrade that would leave usage over the target limit is scheduled only with a clear remediation rule: preserve current staff/history, block new invitations and seat increases, and require reduction to the target limit before the lower entitlement takes effect.
D-23	USD is the base price schedule; NGN equivalents are calculated using a configured exchange-rate source.	Agreed. USD list price remains authoritative. NGN amount is calculated server-side at quote time, and each quote records source, rate, timestamp, rounding rule, amount, currency and expiry. Never silently change a confirmed quote or historical ledger row. Supersedes D-08's “no conversion” wording.
D-24	Billing-currency change requires a request and manual review.	Agreed. Current subscription currency remains unchanged until the change is approved and a new quote/payment setup is confirmed. Never rewrite old payment or ledger currency. Exact provider transition mechanics remain gated by DR-01.
D-25	Build a clearly labelled simulated payment provider first; attempt real integration only if capability, account eligibility and time are verified.	Agreed. Simulation never represents real money received. Use deterministic, explicitly labelled test FX rates in automated tests. Real payment success requires verified server-side provider evidence.
D-26	Support email invitations and an associated invitation code.	Agreed. Link and code represent the same invitation and share one single-use lifecycle, expiry, intended-email binding, revocation, permission checks and transactional seat checks. A code is not a public/reusable join code and cannot bypass email verification.
D-27	Employment termination and temporary access suspension are different actions.	Agreed. Ending employment deactivates that business membership and revokes access immediately while preserving required history. Temporary suspension restricts access without deleting the identity or other business memberships; require an authorised actor, reason, audit event and restoration path.
D-28	Offline upcoming schedules are read-only and show last-updated time.	Agreed. No offline mutations are queued for silent replay in V1. Clear or re-scope branch/business caches on context changes and logout.
D-29	Build a working core product before optional/advanced infrastructure.	Agreed. This does not waive tenant isolation, two-shard simulation, required backend proof, security tests or the specified performance evidence.
D-30	Simulate two logical tenant-data shards with deterministic business-ID routing.	Agreed. Test consistent routing and cross-tenant isolation. Document that logical simulation is not two physical production databases.
D-31	One global identity can switch between businesses; within a business, authorised users can switch branch context.	Agreed. Business context and branch context are distinct and server-authorised on every protected request.
D-32	Businesses may have multiple branches; no plan-specific branch cap in V1.	Agreed. Do not implement proposed Starter/Team/Business branch limits.
D-33	Each branch has its own departments and staffing arrangement; each Staff membership belongs to exactly one department in exactly one branch.	Agreed. Same-named departments at different branches are distinct records. Staff transfers update the existing membership and do not create a second seat.
D-34	Manager and Supervisor access is limited to their authorised branch/department scope.	Agreed. Owners may access all branches. The server—not hidden UI controls—enforces scope for every read, write, job, notification and cache operation.


19.2 Branch and department model
Add Branch to the tenant-plane data model. Minimum fields: id, business_id, name, active/deactivated state, created_at, and updated_at. A branch belongs to exactly one business; enforce composite tenant foreign keys and RLS consistently with other tenant records.
A Department belongs to exactly one branch. A business can create any number of branches in V1; each branch can have any number of departments and its own staffing distribution. Branches need not have the same departments or staffing levels. Department names are not globally unique across branches. If uniqueness is required, enforce it only within the same branch.
A Staff membership is assigned to exactly one department and therefore one branch within a business. Owner, GM and Supervisor memberships may be rostered as workers but their operational access still follows their role and assigned scope. Supervisors may be assigned to multiple departments; a GM may manage only the branches/departments explicitly granted by the permission model. Owners may oversee every branch of their business.
Branch switching is a navigation/context change inside the selected business, not a new login and not proof of authorisation. Every branch-scoped API request must validate the authenticated membership, business, branch and department scope. Reject foreign-business branch IDs without revealing the foreign resource. Cache keys for branch-specific data include both business_id and branch_id; switching branch clears or re-scopes stale branch data and refreshes permissions/data. Offline cache remains read-only and must not leak one branch's data into another.
Required branch behaviours and tests:
- Branch A and Branch B may have different department counts and staffing levels.
- A staff membership cannot belong to departments in two branches simultaneously in the same business.
- A Supervisor cannot access another branch or department by changing an ID, request body, deep link or client state.
- Owners can switch across authorised branches; GM/Supervisor branch choices are restricted to their grants.
- Branch creation does not multiply staff-seat allowance.
- Moving a worker between branches/departments updates the existing membership; handle unpublished shifts, published shifts, availability and pending swaps explicitly and audit the transfer.
- Cross-business branch IDs are rejected without resource disclosure.
19.3 Staff limits and invitation admission
Seat usage is business-wide across every branch and department. Each active membership counts once regardless of role, branch, or number of supervised departments. Pending invitations do not count as active seats until acceptance. A transfer between branches does not create a new seat.
When an invitation is created, Rota may issue it only if current policy allows the invitation workflow; the decisive seat check happens transactionally at acceptance/activation. If the business is at its admission limit, return a stable SEAT_LIMIT_REACHED conflict, leave the invitation unconsumed, notify Owners, and show the authorised Owner the upgrade/add-seat path. A concurrent acceptance race must be serialized/locked in the database; Redis is not the source of truth. Any billable increase requires a server-generated quote and explicit Owner confirmation before charge/entitlement. No supervisor or manager can approve an Owner-only charge.
19.4 Membership termination, suspension and permissions
Membership deactivation/termination: an authorised actor ends the person's membership in this business. Revoke access to the business on the next protected request at the latest; invalidate/deny business-scoped sessions and tokens as required by the existing session model. Preserve necessary schedules, attendance, audit and billing records. Do not delete the global identity or memberships in other businesses. Remove the person from future unpublished shifts, flag published shifts for manager action, and cancel pending swaps involving them, consistent with BR-012.
Temporary suspension: an authorised Owner or GM may suspend a Staff membership; a Supervisor may do so only for Staff within the Supervisor's assigned department/branch scope. This is a proposed implementation permission boundary to apply unless the final role matrix reveals a contradiction; do not allow a manager to suspend an Owner. Require a reason, actor, timestamp, optional expiry, audit event, and an explicit authorised restoration action. Suspension must immediately block the affected person's business data access; it does not delete history or affect other business memberships. If a temporary restriction is initiated for investigation, the actor must choose suspension rather than employment termination.
Role/ownership changes: only an Owner can appoint another Owner or remove/demote an Owner. The last active Owner is protected. Record changes as security events visible only to the affected user and business Owners. Permission checks are server-side and evaluated against current database membership/scope, not stale client state or role claims alone.
19.5 Currency, exchange rate, quotes and renewals
Base price schedule
Plan	Monthly USD price	Included active seats	Additional seat price/month
Starter	$20.00	5	Not allowed
Team	$50.00	15	$3.00 per additional seat
Business	$120.00	40	$2.00 per additional seat


USD is the base price schedule. Do not invent a separate fixed NGN price list. The NGN equivalent is calculated from a configured USD/NGN rate source when a quote is requested. All stored monetary amounts remain integer minor units with explicit currency (USD cents or NGN kobo). The rate source is a runtime dependency and must be chosen/verified in DR-01; this PRD does not claim a live provider has been configured.
Exchange-rate quote lifecycle
1. The app may show an indicative NGN estimate with a visible “estimate” label, the rate timestamp and a stale/unavailable state. It must not imply that an estimate is a confirmed charge.
2. When the Owner selects NGN and requests a purchase/upgrade/additional-seat quote, the backend retrieves a rate from the configured source. Record source identifier, rate value, retrieved-at timestamp, source date/time if provided, calculation version and rounding rule.
3. Calculate the NGN amount server-side from the USD base amount and the retrieved rate. Use a documented deterministic rounding rule to integer kobo. The client never calculates the payable amount and never supplies an authoritative rate.
4. Bind the quote to the exact amount, currency, base USD amount, rate/source/time, subscription version, relevant seat count, effective date, line items, idempotency context and expiry. Require the Owner to confirm the displayed amount.
5. If the rate source is unavailable, invalid, or older than the configured freshness threshold, do not issue a chargeable NGN quote from a guessed/stale rate. Return a clear retry/unavailable response. A test fixture may be used only in tests and must be labelled simulated.
6. Once confirmed, a quote's amount and rate do not change. If it expires or the subscription/seat state changes, reject it as expired/stale and generate a new quote requiring new Owner confirmation. A payment intent and ledger entry retain the exact currency and amount used.
7. USD payments use the USD base amount; no exchange rate is required to charge in USD. Do not silently convert an existing USD subscription, payment or ledger entry to NGN.
Renewal behaviour — important unresolved product gate
The Owner wants NGN equivalents to reflect the current exchange rate. That means the NGN renewal amount can change when the rate changes. Rota must not silently charge a different amount at renewal without informing the Owner and obtaining the confirmation required by the selected payment mechanism. The recommended V1 behaviour is application-managed renewal: before the renewal date, generate a new quote using the then-current rate, notify the Owner of the exact amount and expiry, and require Owner confirmation/payment. If the Owner does not confirm by the due date, follow the documented grace/retry/restricted-mode policy; do not silently charge a stale or changed amount.
This recommended renewal model is not yet approved as a provider-feasibility fact. Record the chosen model in DR-01 after checking provider capabilities, minimum charge, test-mode behaviour, webhook verification, recurring/merchant-initiated transaction rules and account eligibility. If the chosen real provider cannot support the desired confirmation flow, use an Owner-initiated payment link or keep the simulated provider; do not weaken the no-silent-charge rule to fit the provider.
Proration and changes
- Upgrades and additional seats that take effect immediately may be prorated using the existing actual-period-length and business-time-zone rules. The server calculates the quote, binds it to a rate if NGN is selected, and the Owner confirms the final amount.
- Seat removals and plan downgrades are scheduled for the next renewal and generate no immediate credit/refund. Historical ledger entries are immutable.
- If a scheduled downgrade would reduce entitlement below current usage, preserve current staff/history, block additional invitations and seat increases, and require the Owner to reduce active memberships before the lower entitlement begins. Do not silently deactivate staff.
- A currency-change request requires manual review. The existing subscription continues in its current currency until approval and a new quote/payment setup are confirmed. Do not assume the provider can mutate currency on an existing subscription.
- Payment success is accepted only from a verified server-side payment event/verification result. A simulated provider must be visibly labelled and cannot be represented as real money received. Webhook processing remains signature-verified, amount/currency/reference-matched, idempotent and durable.
19.6 Invitation modes
The product supports an email invitation link and an associated invitation code for the same invitation record. Both methods enforce: high-entropy token/code handling; stored token hashes where applicable; expiry; single use; invited-email binding and verification; revocation on inviter permission loss or invitation cancellation; inviter role and branch/department scope; business-wide seat limit at acceptance; rate limits; and an audit event. A code must not be a permanent, shareable, public join code. Code entry must not bypass the email/identity binding. The invitation acceptance transaction performs the authoritative seat check and membership creation atomically.
19.7 Acceptance criteria added for v0.3
The following criteria supplement, and do not weaken, the criteria in section 14. They must be implemented as automated tests where feasible and mapped to milestone exit checks.
ID	Acceptance criterion
AC-BR-01	A business can create multiple branches; each branch can have a different number of departments and staff.
AC-BR-02	Departments in separate branches are distinct records even when their names match; a department belongs to exactly one branch and business.
AC-BR-03	A Staff membership is assigned to one department/branch per business; branch transfer does not create a second membership or seat.
AC-BR-04	A Supervisor cannot read or mutate a branch/department outside their explicit scope, including by guessed IDs, direct API calls, background jobs or stale deep links.
AC-BR-05	Switching branches refreshes authorised data and clears/re-scopes branch-specific caches; no previous branch's private data is shown after switching or offline.
AC-BR-06	Active membership seat count is business-wide across branches and counts each membership once. Concurrent invitation acceptances cannot exceed the admission limit.
AC-BR-07	A business has no subscription-tier branch cap in V1.
AC-RBAC-01	Owner, GM and Supervisor memberships can be rostered when assigned, and their own scheduling follows availability/conflict/override rules.
AC-RBAC-02	Removing/demoting an Owner is denied if it would leave zero active Owners; only an Owner can perform Owner appointment/removal/demotion.
AC-RBAC-03	Security events are visible only to the affected user and business Owners.
AC-MEM-01	Membership termination revokes access to that business but preserves required historical records and does not delete other business memberships.
AC-MEM-02	Temporary suspension requires an authorised actor and reason, blocks affected business access, is audited, and can be explicitly reversed by an authorised actor.
AC-INV-01	Email link and invitation code use the same invitation record and all expiry, single-use, verified-email, permission, revocation and seat-limit checks. Reusing an accepted/expired/revoked invitation fails.
AC-FX-01	An NGN quote records USD base amount, rate, source, retrieval timestamp, calculation/rounding version, NGN amount and expiry; amount is calculated on the server.
AC-FX-02	Client-supplied rates or amounts cannot change a server quote; quote confirmation revalidates expiry, subscription version and exact amount.
AC-FX-03	A stale/unavailable/invalid rate source cannot produce a chargeable NGN quote; the user sees a retry/unavailable state.
AC-FX-04	Rate changes never mutate a confirmed quote, payment intent or historical ledger row.
AC-FX-05	NGN renewal does not silently charge a changed amount; renewal flow follows the provider model recorded in DR-01 and requires Owner confirmation of the quote.
AC-FX-06	Automated tests use deterministic labelled FX fixtures; no test fixture is presented as a live rate.
AC-BILL-01	Simulated payment success is labelled as simulated and cannot be described as real money received; live payment success requires verified provider evidence.
AC-BILL-02	Downgrade/seat removal creates no immediate credit and takes effect at renewal; staff are not silently deactivated to meet the future limit.


19.8 Open gates that must remain visible (do not invent answers)
Gate / question	Still required	What it blocks
G-01 / DR-01	Verify actual payment provider, merchant-country eligibility, supported charge/presentment/settlement currencies, initial payment, renewal mechanics, minimum/zero charge handling, webhook verification, retry/refund behaviour and test-mode proof. Also decide Owner-confirmed NGN renewal mechanism.	Real-provider billing. Simulation may proceed with fixtures.
FX-01	Select a configured exchange-rate source, refresh/freshness threshold, outage behaviour, precision and rounding rule; record evidence and implementation decision.	Chargeable NGN quotes. Indicative estimate may be shown only if clearly labelled and fresh.
G-02	Confirm Google OAuth credentials and platform configuration; keep email/password as fallback if unavailable.	Google sign-in only.
G-03	Define data retention, deletion deadlines, backups, audit/financial retention and legal basis; obtain suitable privacy/legal review.	Production launch/deletion-policy completion.
OQ-012	Confirm maximum total seats/additional-seat ceilings for Team and Business if no approved ceiling exists elsewhere.	Enforcing any ceiling beyond current included/additional-seat pricing rules.
OQ-023	Define exact actions available to Staff during subscription-restricted mode. Preserve published-schedule reads and do not silently expand permissions.	Final restricted-mode implementation.
DR-02 to DR-06	Record HTTP framework, queue/outbox/sweeper, tenancy/control-plane architecture, token/session design and client-state choices as required by M0.	Corresponding implementation decisions.


19.9 Updated milestone sequencing
1. M0 — Decisions and feasibility: workspace, Expo development build, local Postgres/Redis, documentation skeleton; record DR-01 to DR-06; verify provider/FX capabilities; keep unverified items explicitly gated.
2. M1 — Tenant/shard proof before feature work: prove control-plane/tenant-plane boundary, two logical shards, tenant context, RLS/composite keys, pool reuse safety, tenant- and branch-scoped cache keys, request logging and adversarial cross-tenant tests.
3. M2 — Identity and organisation foundation: auth/session/revocation, business switching, branch switching, role matrix, branches, branch-owned departments, invitations, memberships, Owner protection, temporary suspension and transactional seat accounting.
4. M3 — Scheduling core: staffing requirements, availability, conflicts and reasoned overrides, draft/review/publish, rostered manager roles, branch-scoped schedules, shift versioning and stale swap invalidation.
5. M4 — Mobile/offline and notifications: read-only upcoming schedule cache, visible last-updated time, branch/business cache clearing, durable jobs, push/in-app notifications, deep links and retries.
6. M5 — Swaps, attendance and activity: same-branch swap policy as specified by the core PRD, attendance history, scoped feed and 10,000-event pagination tests.
7. M6 — Simulated billing: server quotes, deterministic FX fixtures, owner confirmation, proration, immutable ledger, payment-intent state machine, idempotency, renewal/grace/restricted-mode tests. No live-provider claim.
8. M7 — Live billing decision/integration (conditional): only after G-01/FX-01 evidence and owner-approved DR-01; otherwise document the simulator boundary and leave live integration out of scope.
9. M8 — Performance, resilience and release evidence: 200-VU tests before/after caching, EXPLAIN ANALYZE, pool exhaustion/failure drills, sharding limitations, privacy/security docs, deployment, demo and learning log.
Security/isolation tests are required at every milestone, not only at the end. A milestone cannot be declared complete merely because code compiles; its acceptance criteria and evidence must pass.
19.10 Change-control note
This v0.3 PRD is the single source of product requirements. Sections 4, 6, 8, 9, 14, 17 and 18 have been updated to reflect the agreed v0.3 branch, permission, invitation, membership-lifecycle and currency decisions; Section 19 provides the consolidated decision register and acceptance criteria. Historical audit/traceability rows may retain older wording only where they are explicitly marked superseded; they are not independent requirements. If an implementation detail appears inconsistent, follow the latest explicit D-16–D-34 decision and the matching current requirement/acceptance criterion, and record any remaining ambiguity as a decision gate rather than inventing behaviour. This document does not claim that a live FX source, payment provider, OAuth credentials or privacy/legal review has been completed. Those remain explicit external-feasibility gates; they do not contradict the product rules. Status remains DRAFT pending product-owner approval and closure or explicit scoping-out of those gates.