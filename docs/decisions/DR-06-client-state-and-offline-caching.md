# DR-06: Mobile Client State Management and Cache Invalidation

## Status
`ACCEPTED (Engineering Decision)` — TanStack Query v5 + Zustand state architecture adopted. Read-only offline shift viewing with immediate cache clearing on business switch confirmed per FR-OFF-001–004.

## Context
Rota's mobile application (Expo / React Native) requires:
1. Management of user identity, active business context, and active branch context.
2. Server state synchronization (shifts, rosters, departments, availability, activity feed).
3. Read-only offline caching of upcoming shifts (up to 14 days) with visible last-updated time (`FR-OFF-001` to `003`, `D-28`).
4. Instant and thorough cache clearing on logout, business switch, branch switch, or detected session revocation (`FR-OFF-004`, `AC-OFF-01`, `AC-BR-05`).

## Alternatives Considered

### 1. Redux Toolkit + RTK Query
- *Pros*: Mature, structured, single store.
- *Cons*: Heavy boilerplate, complex configuration for custom cache clearing per tenant and branch, unnecessary complexity for graduation timelines.

### 2. WatermelonDB / SQLite Offline-First Client Sync
- *Pros*: True offline database on device.
- *Cons*: Extreme complexity with conflict resolution and multi-master replication; explicitly rejected by `FR-OFF-003` and `D-28`, which state that offline access is **strictly read-only** in V1.

### 3. TanStack Query (React Query) + Zustand (Recommended)
- *Pros*:
  - **Separation of Concerns**: TanStack Query handles all server-derived data (fetching, background refetch, stale-while-revalidate, cursor pagination for activity feed). Zustand handles lightweight client-only state (active `business_id`, active `branch_id`, theme, UI modal states).
  - **Instant Cache Clearing**: `queryClient.clear()` completely wipes all server data from memory in a single call upon business switch or logout (`FR-OFF-004`).
  - **Offline Persistence**: React Query's `createAsyncStoragePersister` or custom storage persister using MMKV/SecureStore can persist upcoming shifts for read-only viewing with a stored `dataUpdatedAt` timestamp (`FR-OFF-002`).
  - **Zero Boilerplate**: Easy to learn and rapidly iterate on within the graduation project deadline.
- *Cons*: Requires discipline to ensure client mutations always trigger query invalidations.

## Decision & Rationale
Adopt **TanStack Query v5 + Zustand**:
1. **Server State**: Managed exclusively by TanStack Query. Query keys must follow the scoped pattern:
   - Global: `['user', 'profile']`, `['memberships']`
   - Tenant-scoped: `['tenant', businessId, 'departments']`, `['tenant', businessId, 'settings']`
   - Branch-scoped: `['tenant', businessId, 'branch', branchId, 'shifts']`
2. **Client State**: Zustand store holding:
   - Active `businessId`
   - Active `branchId`
   - Current user profile summary
   - UI states (active modals, snackbars)
3. **Context Switching & Cache Clearing Workflow (`FR-OFF-004`, `AC-OFF-01`)**:
   - Calling `/v1/auth/switch-business` triggers:
     ```ts
     queryClient.clear(); // purge all queries
     zustandStore.getState().setActiveBusiness(newBusinessId);
     clearOfflineShiftStorage();
     ```
   - Switching branches re-scopes branch queries and invalidates branch-specific rosters (`AC-BR-05`).
4. **Offline Viewing (`D-28`, `AC-OFF-02`)**:
   - Shift query results for the next 14 days are cached locally.
   - When offline, TanStack Query serves the cached data and the UI renders a banner: `Offline - Showing schedule cached at <time>`.
   - All mutation actions (create shift, request swap, override) are disabled when offline.

## Consequences
- **Positive**: Clean separation between server and client state; 100% reliable cache wiping on business switch; trivial implementation of read-only offline viewing.
- **Negative**: Must prevent unhandled background refetch spam when reconnecting on spotty networks.

## Evidence & Verification
- Unit test verifying that calling business switch purges the query cache completely (`AC-OFF-01`).
- Verification that offline UI displays cached shifts and last-updated time without allowing mutations (`AC-OFF-02`).
