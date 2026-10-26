import React, { useEffect } from 'react';
import { registerRootComponent } from 'expo';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
  getStateFromPath,
  type LinkingOptions,
} from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator.tsx';
import type { RootStackParamList } from './src/navigation/types.ts';
import { getApiBaseUrl } from './src/services/api-config.ts';
import { queryClient } from './src/services/query-client.ts';
import { lightColors, darkColors } from './src/theme/tokens.ts';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext.tsx';
import {
  rootNavigationRef,
  dispatchPendingNotificationNavigation,
  setupNotificationListeners,
} from './src/services/notifications.ts';

const RotaLightTheme = {
  ...DefaultTheme,
  dark: false,
  colors: {
    ...DefaultTheme.colors,
    primary: lightColors.primaryTeal,
    background: lightColors.background,
    card: lightColors.surface,
    text: lightColors.textPrimary,
    border: lightColors.border,
    notification: lightColors.primaryTeal,
  },
};

const RotaDarkTheme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    primary: darkColors.primaryTeal,
    background: darkColors.background,
    card: darkColors.surface,
    text: darkColors.textPrimary,
    border: darkColors.border,
    notification: darkColors.primaryTeal,
  },
};

const prefixes = ['rota://'];
const apiBase = getApiBaseUrl();
if (apiBase) {
  prefixes.push(apiBase);
}

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes,
  getStateFromPath(path, options) {
    if (path.includes('reset-password')) {
      const queryIdx = path.indexOf('?');
      let token: string | undefined = undefined;
      if (queryIdx !== -1) {
        const queryParams = new URLSearchParams(path.substring(queryIdx));
        token = queryParams.get('token') || undefined;
      }
      return {
        routes: [
          {
            name: 'ResetPassword',
            params: { token },
          },
        ],
      };
    }

    if (path.includes('invite') || path.includes('invitations')) {
      const queryIdx = path.indexOf('?');
      let token: string | undefined = undefined;
      if (queryIdx !== -1) {
        const queryParams = new URLSearchParams(path.substring(queryIdx));
        token = queryParams.get('token') || undefined;
      }
      if (!token) {
        const cleanPath = (queryIdx !== -1 ? path.substring(0, queryIdx) : path).replace(/^\/+|\/+$/g, '');
        const segments = cleanPath.split('/');
        const inviteIdx = segments.findIndex(
          (s) => s === 'invite' || s === 'invites' || s === 'invitations'
        );
        if (inviteIdx !== -1 && segments.length > inviteIdx + 1) {
          token = segments[inviteIdx + 1];
        }
      }
      return {
        routes: [
          {
            name: 'AcceptInvitation',
            params: { token },
          },
        ],
      };
    }

    return getStateFromPath(path, options);
  },
  config: {
    screens: {
      Auth: 'auth',
      ForgotPassword: 'forgot-password',
      ResetPassword: 'reset-password',
      BusinessSelect: 'business-select',
      Billing: 'billing',
      AcceptInvitation: 'invite/:token',
    },
  },
};

function AppNavigation() {
  const { isDark } = useTheme();

  useEffect(() => {
    // Listen for foreground notifications and tap interactions
    const cleanupListeners = setupNotificationListeners();
    return () => {
      cleanupListeners();
    };
  }, []);

  return (
    <NavigationContainer
      ref={rootNavigationRef}
      theme={isDark ? RotaDarkTheme : RotaLightTheme}
      linking={linking}
      onReady={dispatchPendingNotificationNavigation}
    >
      <RootNavigator />
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppNavigation />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

registerRootComponent(App);
