# DR-08: Mobile Application Framework, Navigation, and Build Strategy

## Status
`ACCEPTED (Engineering Decision)` — Expo Managed Workflow targeting React Native 0.88 with React Navigation native stack and bottom tabs adopted. Verified bundling cleanly with Metro and passing TypeScript checks.

## Context
The Rota mobile client is a cross-platform React Native app built using the **Expo** ecosystem (`PRD 12.6`).
Key mobile architectural constraints:
1. **Development Build (`PRD 12.5`, `AC-OPS-10`)**: Standard Expo Go cannot support native Google Sign-in (`FR-AUTH-002`), HTTPS Universal/App Links (`FR-AUTH-007`), or raw push notification receipts (`FR-NOT-011`). An **Expo Development Build** (`expo-dev-client`) is required from the outset.
2. **Context Switching & Navigation Reset (`FR-AUTH-010`, `FR-OFF-004`)**: When switching business or branch, the navigation stack must be capable of programmatic, deterministic reset to prevent back-navigation into stale tenant screens.
3. **Deep Linking Interception (`FR-NOT-005`, `AC-NOT-06`)**: Notification links into a business other than the active one must prompt the user before switching, never switching silently.

## Alternatives Considered

### 1. Expo Router (File-Based Routing)
- *Pros*: Modern, file-system-based routing convention.
- *Cons*: Tightly coupled to URL paths; programmatic navigation reset across dynamic multi-tenant boundaries is less predictable; complex middleware required to intercept deep links targeting non-active businesses before the target route mounts.

### 2. React Navigation (Native Stack + Bottom Tabs) (Recommended)
- *Pros*:
  - **Imperative Stack Control**: Supports `navigation.reset(...)` to completely discard previous tenant screen histories upon business switch or logout.
  - **Deep Link Interceptor**: Easy to define custom `linking` configuration with a pre-navigation authentication and tenant-matching middleware. If a notification deep link targets `Business_B` while user is in `Business_A`, the app intercepts and shows a confirmation modal (`FR-NOT-005`).
  - **Mature Ecosystem**: Maximum stability, extensive documentation, and zero experimental routing bugs for a graduation project timeline.
- *Cons*: Requires declaring navigation containers and screen stacks manually rather than relying on folder structure.

## Decision & Rationale
Adopt **Expo Development Build + React Navigation**:
1. **Build Tooling**:
   - Expo SDK 58 (verified current stable release, targeting React Native 0.88) Managed Workflow configured with `expo-dev-client`.
   - Build scripts: `npx expo run:android` and `npx expo run:ios`.
   - Native modules: `expo-secure-store`, `expo-notifications`, `expo-application`.
2. **Navigation Architecture**:
   - `RootNavigator`: Switch between `AuthStack` (Login, Register, Password Reset, Accept Invite) and `AppStack`.
   - `AppStack`: Bottom Tab Navigator:
     - **ScheduleTab**: Calendar, shifts, availability, shift swaps.
     - **FeedTab**: Role-scoped activity feed (`FlashList`).
     - **TeamTab**: Department rosters, member directory, invitations (managers only).
     - **SettingsTab**: User profile, business switcher, branch switcher, quiet hours, billing (Owners only).
3. **Deep Link Interceptor**:
   - Custom linking handler checks incoming URL's `businessId`. If mismatched with active business, displays prompt: `"This link belongs to <Business Name>. Switch business to view?"`. If rejected, navigation cancels (`AC-NOT-06`).

## Consequences
- **Positive**: Complete control over navigation stack lifecycles and deep link authorization; zero risk of stale screen memory leaks across tenant switches.
- **Negative**: Requires local Android Studio / Xcode or EAS Build for testing native development builds.

## Evidence & Verification
- Test verifying that switching business completely resets the navigation history (`AC-OFF-01`).
- Test verifying that deep links to another business trigger the confirmation modal rather than silent navigation (`AC-NOT-06`).
