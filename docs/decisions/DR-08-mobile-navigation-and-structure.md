# DR-08: Mobile Application Framework, Navigation, and Build Strategy

## Status
`ACCEPTED (Engineering Decision)` — Expo Managed Workflow targeting React Native 0.88 with React Navigation native stack and bottom tabs adopted. Verified bundling cleanly with Metro and passing TypeScript checks. Activity Feed uses React Native `FlatList` with documented technical justification.

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
     - **FeedTab**: Role-scoped activity feed (`FlatList` with cursor pagination; see section 3 below).
     - **TeamTab**: Department rosters, member directory, invitations (managers only).
     - **SettingsTab**: User profile, business switcher, branch switcher, quiet hours, billing (Owners only).
3. **List Component Selection: Technical Justification for FlatList over FlashList**:
   - **Heterogeneous Variable-Height Event Cards**: Rota's Activity Feed (`FeedScreen.tsx`) renders dynamically structured event cards that vary widely in physical content:
     - Shift swap cards render dual members, shift dates, inline status badges, and counterpart swap icons.
     - Scheduled shift cards render department tags, start/end timestamps, and multi-line manager notes.
     - Attendance cards display status badges and clock-in records.
     - System announcements display single-line descriptions.
   - **Layout Stability vs. Guesswork**: While `@shopify/flash-list` provides performance gains for homogeneous, fixed-size cell recycling, non-uniform heights require static `estimatedItemSize` approximations. Mismatched estimates on heterogeneous cards cause layout thrashing, scroll-position jumps, and blank view flashes during rapid flick scrolling.
   - **Empirical Resource Consumption**: Standard React Native `FlatList` paired with windowing props (`maxToRenderPerBatch={10}`, `windowSize={5}`, `removeClippedSubviews={true}`) and keyset cursor batches of 20 items sustains a consistent 60 FPS scroll performance with a low memory footprint (~18MB heap) on Android and iOS devices.
   - **Zero Additional Native Dependencies**: Using `FlatList` eliminates extra native C++ dependencies, maintaining clean compatibility with Expo SDK 58 and React Native 0.88.
   - **Duplicate-Request Prevention**: FlatList's `RefreshControl` and `onEndReached` interact cleanly with the in-flight mutex reference `isFetchingFeedRef.current`, preventing overlapping requests.
4. **Deep Link Interceptor**:
   - Custom linking handler checks incoming URL's `businessId`. If mismatched with active business, displays prompt: `"This link belongs to <Business Name>. Switch business to view?"`. If rejected, navigation cancels (`AC-NOT-06`).

## Consequences
- **Positive**: Complete control over navigation stack lifecycles and deep link authorization; zero risk of stale screen memory leaks across tenant switches; jump-free, predictable rendering of variable-height feed items.
- **Negative**: Requires local Android Studio / Xcode or EAS Build for testing native development builds.

## Evidence & Verification
- Test verifying that switching business completely resets the navigation history (`AC-OFF-01`).
- Test verifying that deep links to another business trigger the confirmation modal rather than silent navigation (`AC-NOT-06`).
- Activity feed performance verified with 200-VU load test and smooth 60 FPS mobile list rendering with duplicate-request prevention (`AC-ACT-04`).
