# DR-06: Mobile Client State Management and Cache Invalidation

## Status
`ACCEPTED (Engineering Decision)` — TanStack Query v5 (`@tanstack/react-query`) + Zustand / React state architecture adopted. Read-only offline shift viewing with immediate tenant cache clearing on business switch confirmed per FR-OFF-001–004.

## Context
Rota's mobile application (Expo / React Native) requires:
1. Management of user identity, active business context, and active branch context.
2. Server state synchronization (shifts, rosters, departments, availability, activity feed).
3. Read-only offline caching of upcoming shifts (up to 14 days) with visible last-updated time (`FR-OFF-001` to `003`, `D-28`).
4. Instant and thorough cache clearing on logout, business switch, branch switch, or detected session revocation (`FR-OFF-004`, `AC-OFF-01`, `AC-BR-05`).
5. Optimistic updates with automatic rollback on network or server error for responsive touch interactions.

## Alternatives Considered

### 1. Redux Toolkit + RTK Query
- *Pros*: Mature, structured, single store.
- *Cons*: Heavy boilerplate, complex configuration for custom cache clearing per tenant and branch, unnecessary complexity for graduation timelines.

### 2. WatermelonDB / SQLite Offline-First Client Sync
- *Pros*: True offline database on device.
- *Cons*: Extreme complexity with conflict resolution and multi-master replication; explicitly rejected by `FR-OFF-003` and `D-28`, which state that offline access is **strictly read-only** in V1.

### 3. TanStack Query v5 (React Query) + Lightweight Local UI State (Adopted)
- *Pros*:
  - **Separation of Concerns**: TanStack Query handles all server-derived data (fetching, background refetch, stale-while-revalidate, cursor pagination for activity feed, optimistic mutation rollback). React state / Zustand handles lightweight client-only state (active `business_id`, active `branch_id`, theme, UI modal states).
  - **Tenant Cache Isolation**: Standardized query key factory ensures no cross-tenant cache contamination:
    - Activity Feed: `['tenant', businessId, 'feed', { limit, cursor }]`
    - Inbox: `['tenant', businessId, 'inbox', { limit, cursor, unreadOnly }]`
    - Shifts: `['tenant', businessId, 'branch', branchId, 'shifts', { start, end }]`
    - Settings: `['tenant', businessId, 'settings']`
    - Team: `['tenant', businessId, 'branch', branchId, 'team']`
    - Swaps: `['tenant', businessId, 'swaps']`
  - **Instant Cache Clearing**: `queryClient.clear()` and `clearAllTenantQueries()` completely wipe all server data from memory in a single call upon business switch, logout, or session expiry (`FR-OFF-004`).
  - **Offline Persistence**: Shift query results for the next 14 days are cached locally in AsyncStorage for read-only viewing with a stored `dataUpdatedAt` timestamp (`FR-OFF-002`).
  - **Optimistic Updates with Rollback**: Implemented for instant UI responsiveness on settings toggle, inbox read marking, and schedule interactions, reverting to snapshot on error.
- *Cons*: Requires discipline to ensure client mutations always trigger query invalidations and provide rollback snapshots.

## Decision & Rationale
Adopt **TanStack Query v5 + React UI state**:
1. **Server State**: Managed exclusively through TanStack Query (`queryClient` configured in `src/services/query-client.ts`, provided via `<QueryClientProvider>` at the root of `App.tsx`).
2. **Context Switching & Cache Clearing Workflow (`FR-OFF-004`, `AC-OFF-01`)**:
   - Calling business switch, logout, or creating a new business triggers `clearAllTenantQueries()`:
     ```ts
     queryClient.clear(); // purge all active and inactive queries
     clearOfflineShiftStorage();
     ```
   - Switching branches re-scopes branch queries and invalidates branch-specific rosters (`AC-BR-05`).
3. **Offline Viewing (`D-28`, `AC-OFF-02`)**:
   - Shift query results for the next 14 days are cached locally.
   - When offline, cached shifts are rendered with a visible banner: `Offline - Showing schedule cached at <time>`.
   - All mutation actions (create shift, request swap, override) are disabled when offline.
4. **Optimistic Rollback**:
   - Updates update local query data or state immediately, saving the previous state as a rollback snapshot. If the API request fails, the rollback snapshot is restored and an error message is surfaced to the user.

## Consequences
- **Positive**: Clean separation between server and client state; 100% reliable cache wiping on business switch; trivial implementation of read-only offline viewing; seamless optimistic interactions.
- **Negative**: Must prevent unhandled background refetch spam when reconnecting on spotty networks (configured `staleTime: 60_000` and `retry: 1`).

## Evidence & Verification
- Unit test verifying that calling business switch purges the query cache completely (`AC-OFF-01`).
- Verification that offline UI displays cached shifts and last-updated time without allowing mutations (`AC-OFF-02`).
- Unit test verifying TanStack Query key isolation, cache clearing, and optimistic rollback mechanics (`tests/mobile/tanstack-query.test.ts`).
