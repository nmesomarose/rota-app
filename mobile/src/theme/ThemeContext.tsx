import React, { createContext, useContext, useMemo, useEffect, useState } from 'react';
import { useColorScheme, Appearance, StyleSheet } from 'react-native';
import {
  lightColors,
  darkColors,
  shadows,
  darkShadows,
  typography,
  spacing,
  radii,
  type ColorTokens,
} from './tokens.ts';

export interface ThemeContextValue {
  isDark: boolean;
  colorScheme: 'light' | 'dark';
  colors: ColorTokens;
  shadows: typeof shadows;
  typography: typeof typography;
  spacing: typeof spacing;
  radii: typeof radii;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [activeScheme, setActiveScheme] = useState<'light' | 'dark'>(
    systemScheme === 'dark' ? 'dark' : 'light'
  );

  // Synchronize when React Native useColorScheme updates
  useEffect(() => {
    setActiveScheme(systemScheme === 'dark' ? 'dark' : 'light');
  }, [systemScheme]);

  // Direct Appearance listener to ensure immediate live switching across iOS and Android
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setActiveScheme(colorScheme === 'dark' ? 'dark' : 'light');
    });
    return () => sub.remove();
  }, []);

  const isDark = activeScheme === 'dark';
  const activeColors = isDark ? darkColors : lightColors;
  const activeShadows = isDark ? darkShadows : shadows;

  const value = useMemo<ThemeContextValue>(
    () => ({
      isDark,
      colorScheme: activeScheme,
      colors: activeColors,
      shadows: activeShadows,
      typography,
      spacing,
      radii,
    }),
    [isDark, activeScheme, activeColors, activeShadows]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Accesses active theme tokens and color scheme.
 * Gracefully falls back to current Appearance if called outside ThemeProvider.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    const isDark = Appearance.getColorScheme() === 'dark';
    return {
      isDark,
      colorScheme: isDark ? 'dark' : 'light',
      colors: isDark ? darkColors : lightColors,
      shadows: isDark ? darkShadows : shadows,
      typography,
      spacing,
      radii,
    };
  }
  return context;
}

/**
 * Helper hook to create and memoize styles dynamically based on the current theme tokens.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  styleFactory: (colors: ColorTokens, isDark: boolean) => T
): T {
  const { colors, isDark } = useTheme();
  return useMemo(() => styleFactory(colors, isDark), [styleFactory, colors, isDark]);
}
