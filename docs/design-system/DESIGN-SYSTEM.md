# Rota Design System (Code-First)

## 1. Overview & Philosophy
The Rota Design System establishes a coherent, accessible, and professional visual language tailored for workforce scheduling software used by small, medium, and multi-branch enterprises (retail, healthcare, hospitality, logistics).

It prioritizes:
- **Calm authority & clarity**: Distraction-free interface with high-contrast typography and subtle borders.
- **Role-based predictability**: Clear visual hierarchy for owners, general managers, supervisors, and shift workers.
- **Accessibility & ergonomic touch targets**: Minimum 44px touch targets on interactive controls and standard WCAG AA contrast.
- **Cross-platform consistency**: Native safe areas and platform-specific elevation/shadows on iOS and Android.

> [!NOTE]
> This design system is implemented directly in code within `mobile/src/theme/`. No external Figma files are used or assumed.

---

## 2. Color Palette & Semantic Tokens

Located in [`mobile/src/theme/tokens.ts`](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/mobile/src/theme/tokens.ts):

| Token Name | Hex Code | Role & Usage |
|---|---|---|
| `primaryNavy` | `#17324D` | Dominant corporate tone, headers, primary brand badges, and navigation anchors. |
| `primaryTeal` | `#0F766E` | Key action color, active tab icons, primary buttons, and confirmed states. |
| `lightTeal` | `#CCFBF1` | Soft tint for selected cards, active pill badges, and quote highlights. |
| `tealDark` | `#115E59` | High-contrast text on light teal badges and interactive accents. |
| `white` | `#FFFFFF` | Background for cards, input containers, modals, and navigation bars. |
| `background` | `#F3F6F9` | Neutral screen background providing depth behind white cards. |
| `textPrimary` | `#172B3A` | High-contrast body text, headings, and prominent shift details. |
| `textSecondary` | `#64748B` | Secondary details, metadata timestamps, and placeholder labels. |
| `textMuted` | `#94A3B8` | Subtle captions, deactivated hints, and disabled labels. |
| `border` | `#D8E1EA` | Standard hairline border on cards, inputs, and tab dividers. |
| `borderSubtle` | `#E2E8F0` | Subtle internal section dividers and secondary borders. |

### Semantic Status Tokens

| Semantic State | Base Color | Background Tint | Border | Usage |
|---|---|---|---|---|
| **Success** | `#15803D` | `#DCFCE7` | `#BBF7D0` | Published shifts, approved swaps, online status, verified payments. |
| **Warning** | `#B45309` | `#FEF3C7` | `#FDE68A` | Offline working banner, pending peer swaps, scheduled changes. |
| **Error** | `#B91C1C` | `#FEE2E8` | `#FECACA` | Validation errors, rejected requests, session revocation notices. |
| **Info / Security** | `#17324D` | `#E0F2FE` | `#BAE6FD` | Security events, audit trail tags, department shifts. |

---

## 3. Typography Hierarchy

| Style | Size | Weight | Line Height | Usage |
|---|:---:|:---:|:---:|---|
| **Display** | 30px | 800 (Extra Bold) | 1.2 | App title on authentication screens. |
| **H1 / Heading** | 24px | 700 (Bold) | 1.2 | Screen titles (Schedule, Team, Billing). |
| **H2 / Subheading**| 20px | 700 (Bold) | 1.3 | Card headers, modal titles, section groupings. |
| **Body Large** | 17px | 600 (Semi Bold) | 1.4 | Business selection items, prominent cards. |
| **Body / Input** | 15px | 400 / 500 | 1.4 | Standard text, form inputs, list items. |
| **Caption** | 13px | 500 (Medium) | 1.4 | Metadata, timestamps, role subtitles. |
| **Micro / Badge** | 11px | 700 (Bold) | 1.2 | Pill badges, online indicators, counter text. |

---

## 4. Spacing, Radii & Elevation Scale

- **Spacing Scale:** `xs` (4px), `sm` (8px), `md` (12px), `lg` (16px), `xl` (20px), `xxl` (24px), `xxxl` (32px).
- **Border Radii:** `xs` (4px), `sm` (6px), `md` (10px), `lg` (14px), `xl` (18px), `full` (9999px).
- **Elevation / Shadows:**
  - `subtle`: Standard navigation headers and shallow dividers (`elevation: 1`).
  - `card`: Surface cards and shift blocks (`elevation: 2`).
  - `elevated`: Floating action bars and drawer drawers (`elevation: 4`).
  - `modal`: Center popups, action dialogs, and diagnostic drawers (`elevation: 8`).

---

## 5. Reusable Component Catalog

Located in [`mobile/src/theme/components.tsx`](file:///c:/Users/HomePC/Desktop/Graduation%20Project/Mobile-Apps/Rota%20App/mobile/src/theme/components.tsx):

1. **`Button`**:
   - Variants: `primary` (Teal), `navy` (Navy), `secondary` (Light Teal), `outline` (Subtle border), `ghost`, `danger`.
   - Sizes: `sm` (36px), `md` (46px - default ergonomic touch target), `lg` (52px).
   - Built-in loading spinners and disabled state styling.
2. **`Card`**:
   - Surface card with standard `#D8E1EA` border and elevation shadows.
   - Variants: `default`, `subtle`, `elevated`, and `selected`.
3. **`Badge`**:
   - Pill badge for roles, shift statuses, and visibility categories (`teal`, `navy`, `success`, `warning`, `error`, `neutral`).
4. **`InputField`**:
   - Form inputs with clear label, focus highlight (`#0F766E`), helper hint, and inline error text.
5. **`OfflineBanner`**:
   - Unobtrusive warning banner displayed when offline with immediate "Retry" button.
6. **`EmptyState`**:
   - Friendly vector illustration, title, descriptive hint, and optional action button.
