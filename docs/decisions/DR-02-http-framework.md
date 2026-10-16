# DR-02: Backend HTTP Framework Selection

## Status
`ACCEPTED (Engineering Decision)` — Implemented in scaffold (`src/app.ts`, `src/routes/health.ts`) and verified passing automated checks.

## Context
`PRD.md` Section 12.6 lists **Express** or **Hono** as candidate HTTP frameworks running on Node.js.
Key requirements influencing the choice:
1. **Raw Body Access (`BILL-007`, `SEC-007`)**: Webhook HMAC signature verification must evaluate the exact, byte-for-byte raw body before any JSON parsing.
2. **Context Propagation (`SEC-010`, `FR-OPS-001`)**: Request IDs and active tenant context (`app.current_business_id`) must propagate through request lifecycles.
3. **Connection Pooling & Multi-Shard Dispatch**: Framework must integrate cleanly with connection pool wrappers for two simulated shards and transaction-scoped settings.
4. **Graduation Project Timeline**: Minimal framework learning curve, zero esoteric packaging bugs, and extensive middleware ecosystem.

## Alternatives Considered

### 1. Hono (with `@hono/node-server`)
- *Pros*: Extremely lightweight, built-in standard web fetch APIs, fast router, excellent TypeScript integration.
- *Cons*: Native Node.js stream and connection lifecycle abstraction is relatively young; less battle-tested documentation for complex transaction-scoped connection pooling with PostgreSQL; raw body extraction in Node adapter requires careful stream handling.

### 2. Fastify
- *Pros*: High throughput, built-in schema validation.
- *Cons*: Encapsulation model (`fastify-plugin`) adds conceptual overhead when managing dynamic connection pools and scoped context; hooking raw body parsers can conflict with standard JSON routes.

### 3. Express 5 / Express 4 with TypeScript (Recommended)
- *Pros*: The de facto standard Node.js framework; battle-tested middleware ecosystem (`helmet`, `cors`, `rate-limiter-flexible`). Native support for `express.raw({ type: 'application/json' })` on webhook routes and standard `express.json()` on others. Seamless integration with Node's native `AsyncLocalStorage` for request IDs and database transaction context.
- *Cons*: Slightly older design than Hono; slightly higher memory footprint per connection.

## Decision & Rationale
Adopt **Express with TypeScript**:
1. Route handlers can easily mount `express.raw({ type: 'application/json' })` for `/v1/webhooks/*` ensuring byte-accurate HMAC signature checks (`AC-WH-01`).
2. Global middleware chain can reliably attach `requestId` (UUIDv4) and bind Node's `AsyncLocalStorage` to correlate logs (`FR-OPS-001`).
3. Standard error middleware provides the exact canonical `{ "error": { "code", "message", "requestId", "details" } }` envelope.
4. Established patterns for database transaction lifecycle management with `pg` pools.

## Consequences
- **Positive**: Rapid development pace, zero risk of framework-level edge cases during webhook HMAC parsing or connection pooling, straightforward deployment.
- **Negative**: Manual async route error catching or adoption of Express 5 native promise error handling.

## Evidence & Verification
- Unit test verifying raw-body HMAC signature validation on simulated webhook events (`AC-WH-01`).
- Verification that request IDs appear in all response headers and structured log lines (`AC-OPS-01`).
