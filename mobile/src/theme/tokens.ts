/**
 * Rota Design System Tokens
 * Authoritative color palette, typography hierarchy, spacing scale, border radii, and cross-platform elevation tokens.
 * Supports automatic system-controlled Light and Dark modes.
 */

import { Appearance } from 'react-native';

export const lightColors = {
  // Brand Core
  primaryNavy: '#17324D',
  primaryTeal: '#0F766E',
  lightTeal: '#CCFBF1',
  tealDark: '#115E59',
  tealMuted: '#E6FFFA',

  // Neutrals & Surfaces
  white: '#FFFFFF',
  background: '#F3F6F9',
  surface: '#FFFFFF',
  surfaceSubtle: '#F8FAFC',
  surfaceSelected: '#F1F5F9',
  border: '#D8E1EA',
  borderSubtle: '#E2E8F0',
  borderFocus: '#0F766E',

  // Typography
  textPrimary: '#172B3A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  textInverse: '#FFFFFF',
  textTeal: '#0F766E',

  // Semantic Status
  success: '#15803D',
  successLight: '#DCFCE7',
  successBorder: '#BBF7D0',
  successText: '#166534',

  warning: '#B45309',
  warningLight: '#FEF3C7',
  warningBorder: '#FDE68A',
  warningText: '#92400E',

  error: '#B91C1C',
  errorLight: '#FEE2E2',
  errorBorder: '#FECACA',
  errorText: '#991B1B',

  info: '#17324D',
  infoLight: '#E0F2FE',
  infoBorder: '#BAE6FD',
  infoText: '#0369A1',

  // Overlays
  overlay: 'rgba(23, 50, 77, 0.45)',
  backdrop: 'rgba(15, 23, 42, 0.6)',
};

export const darkColors: typeof lightColors = {
  // Brand Core
  primaryNavy: '#38BDF8', // High-contrast sky/navy accent for headings on dark backgrounds
  primaryTeal: '#14B8A6', // Vibrant, accessible teal on dark surfaces (WCAG AA compliant)
  lightTeal: '#134E4A',   // Teal 900 background tint for active badges & cards
  tealDark: '#5EEAD4',    // Teal 300 text for high-contrast badge copy on dark mode
  tealMuted: '#042F2E',

  // Neutrals & Surfaces (Deep navy/slate corporate aesthetic preserving Rota brand identity)
  white: '#1E293B',       // Elevated surface in dark mode
  background: '#0B132B',  // Deep corporate dark blue-slate background
  surface: '#1E293B',     // Slate 800 - cards, modals, navigation headers, drawer
  surfaceSubtle: '#182234',
  surfaceSelected: '#1E3A5F',
  border: '#334155',      // Slate 700 standard borders
  borderSubtle: '#243248',
  borderFocus: '#14B8A6',

  // Typography
  textPrimary: '#F8FAFC',   // Slate 50 - pristine readability
  textSecondary: '#94A3B8', // Slate 400 - secondary metadata
  textMuted: '#64748B',     // Slate 500 - subtle captions
  textInverse: '#0B132B',
  textTeal: '#2DD4BF',

  // Semantic Status (Dark container tints with high-contrast pastel foregrounds)
  success: '#22C55E',
  successLight: '#052E16',
  successBorder: '#14532D',
  successText: '#86EFAC',

  warning: '#F59E0B',
  warningLight: '#451A03',
  warningBorder: '#78350F',
  warningText: '#FDE68A',

  error: '#EF4444',
  errorLight: '#450A0A',
  errorBorder: '#7F1D1D',
  errorText: '#FCA5A5',

  info: '#38BDF8',
  infoLight: '#082F49',
  infoBorder: '#075985',
  infoText: '#BAE6FD',

  // Overlays
  overlay: 'rgba(0, 0, 0, 0.65)',
  backdrop: 'rgba(0, 0, 0, 0.8)',
};

export type ColorTokens = typeof lightColors;

/**
 * Proxy that returns darkColors or lightColors according to React Native Appearance.
 * Ensures transparent backwards compatibility for static imports.
 */
export const colors: ColorTokens = new Proxy(lightColors, {
  get(target, prop: string | symbol) {
    const isDark = Appearance.getColorScheme() === 'dark';
    const active = isDark ? darkColors : lightColors;
    return (active as any)[prop] ?? (target as any)[prop];
  },
});

export const typography = {
  sizes: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 17,
    xl: 20,
    xxl: 24,
    display: 30,
  },
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semiBold: '600' as const,
    bold: '700' as const,
    extraBold: '800' as const,
  },
  lineHeights: {
    tight: 1.2,
    normal: 1.4,
    relaxed: 1.6,
  },
};

export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
};

export const radii = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  full: 9999,
};

export const shadows = {
  subtle: {
    shadowColor: '#17324D',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  card: {
    shadowColor: '#17324D',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  elevated: {
    shadowColor: '#17324D',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  modal: {
    shadowColor: '#17324D',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 8,
  },
};

export const darkShadows = {
  subtle: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 1,
  },
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 2,
  },
  elevated: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 4,
  },
  modal: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
    elevation: 8,
  },
};
