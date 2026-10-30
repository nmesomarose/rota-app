import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { RootStackParamList, MainTabParamList } from './types.ts';
import { LoginScreen } from '../screens/LoginScreen.tsx';
import { ForgotPasswordScreen } from '../screens/ForgotPasswordScreen.tsx';
import { ResetPasswordScreen } from '../screens/ResetPasswordScreen.tsx';
import { BusinessSelectScreen } from '../screens/BusinessSelectScreen.tsx';
import { ScheduleScreen } from '../screens/ScheduleScreen.tsx';
import { FeedScreen } from '../screens/FeedScreen.tsx';
import { TeamScreen } from '../screens/TeamScreen.tsx';
import { SettingsScreen } from '../screens/SettingsScreen.tsx';
import { BillingScreen } from '../screens/BillingScreen.tsx';
import { AcceptInvitationScreen } from '../screens/AcceptInvitationScreen.tsx';
import { HamburgerDrawer } from './HamburgerDrawer.tsx';
import { clearSession, getAccessToken, getActiveBusiness } from '../services/storage.ts';
import { clearAllOfflineCache } from '../services/offline-cache.ts';
import { api } from '../services/api.ts';
import { connectivityManager, type ConnectivityState } from '../services/connectivity.ts';
import {
  registerForPushNotificationsAsync,
  resetPushRegistrationState,
} from '../services/notifications.ts';
import { colors, typography, spacing, radii, shadows, useTheme } from '../theme/index.ts';
import { OfflineBanner } from '../theme/components.tsx';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

export function MainTabs({ navigation }: { navigation: any }) {
  const { colors, shadows, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [menuVisible, setMenuVisible] = useState(false);
  const [connectivity, setConnectivity] = useState<ConnectivityState>(connectivityManager.getState());

  // Calculate dynamic bottom safe area padding for Android (gesture & 3-button) and iOS
  const tabBottomPadding = insets.bottom > 0 ? insets.bottom : (Platform.OS === 'ios' ? 20 : 10);
  const tabHeight = 60 + tabBottomPadding;

  useEffect(() => {
    // Listen to real-time connectivity changes (AppState, API success/failure, network events)
    const unsub = connectivityManager.addListener((state) => {
      setConnectivity(state);
    });

    // Verify backend reachability on mount
    connectivityManager.checkBackendHealth();

    // Register Expo push token for active session (FR-NOT-002, AC-NOT-09)
    registerForPushNotificationsAsync().catch(() => {});

    return () => {
      unsub();
    };
  }, []);

  const handleQuickSignOut = async () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out of Rota?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.auth.logout();
            } catch {
              // offline fallback
            } finally {
              resetPushRegistrationState();
              await clearSession();
              await clearAllOfflineCache();
              navigation.reset({
                index: 0,
                routes: [{ name: 'Auth' }],
              });
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.tabContainer, { backgroundColor: colors.background }]}>
      <OfflineBanner
        visible={!connectivity.isOnline}
        isChecking={connectivity.isChecking}
        onRetry={() => connectivityManager.retry()}
        message="Working offline. Shift schedule and activity feed remain cached."
        style={{
          paddingTop: Math.max(insets.top, Platform.OS === 'android' ? 24 : 0) + 6,
        }}
      />

      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerStyle: {
            backgroundColor: colors.surface,
            borderBottomColor: colors.border,
            borderBottomWidth: 1,
            ...shadows.subtle,
          },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: {
            fontWeight: typography.weights.bold,
            fontSize: typography.sizes.lg,
            color: colors.textPrimary,
          },
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: tabHeight,
            paddingBottom: tabBottomPadding,
            paddingTop: 8,
          },
          tabBarActiveTintColor: colors.primaryTeal,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarLabelStyle: {
            fontSize: typography.sizes.xs,
            fontWeight: typography.weights.semiBold,
          },
          // Custom unmistakable function icons
          tabBarIcon: ({ focused, color, size }) => {
            let iconName: keyof typeof Ionicons.glyphMap = 'calendar';
            if (route.name === 'Schedule') {
              iconName = focused ? 'calendar' : 'calendar-outline';
            } else if (route.name === 'Feed') {
              iconName = focused ? 'chatbubbles' : 'chatbubbles-outline';
            } else if (route.name === 'Team') {
              iconName = focused ? 'people' : 'people-outline';
            } else if (route.name === 'Settings') {
              iconName = focused ? 'settings' : 'settings-outline';
            }
            return <Ionicons name={iconName} size={size || 24} color={color} />;
          },
          // Top navigation bar header with Hamburger on left
          headerLeft: () => (
            <TouchableOpacity
              style={styles.headerLeftButton}
              onPress={() => setMenuVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="Open navigation menu"
              activeOpacity={0.7}
            >
              <Ionicons name="menu" size={26} color={colors.textPrimary} />
            </TouchableOpacity>
          ),
          // Top navigation bar header with Online status & Sign Out on right
          headerRight: () => (
            <View style={styles.headerRightContainer}>
              <TouchableOpacity
                onPress={() => connectivityManager.retry()}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Check backend connection"
                style={[
                  styles.onlineBadge,
                  connectivity.isOnline
                    ? { backgroundColor: colors.lightTeal, borderColor: isDark ? colors.primaryTeal : '#99F6E4' }
                    : { backgroundColor: colors.warningLight, borderColor: colors.warningBorder },
                ]}
              >
                {connectivity.isChecking ? (
                  <ActivityIndicator
                    size="small"
                    color={connectivity.isOnline ? colors.tealDark : colors.warningText}
                    style={{ marginRight: 4 }}
                  />
                ) : (
                  <View
                    style={[
                      styles.onlineDot,
                      { backgroundColor: connectivity.isOnline ? colors.success : colors.warning },
                    ]}
                  />
                )}
                <Text
                  style={[
                    styles.onlineText,
                    { color: connectivity.isOnline ? colors.tealDark : colors.warningText },
                  ]}
                >
                  {connectivity.isChecking ? 'Checking...' : connectivity.isOnline ? 'Online' : 'Offline'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.signOutButton}
                onPress={handleQuickSignOut}
                accessibilityRole="button"
                accessibilityLabel="Sign out of Rota"
                activeOpacity={0.7}
              >
                <Ionicons name="log-out-outline" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ),
        })}
      >
        <Tab.Screen
          name="Schedule"
          component={ScheduleScreen}
          options={{ title: 'Schedule' }}
        />
        <Tab.Screen
          name="Feed"
          component={FeedScreen}
          options={{ title: 'Inbox' }}
        />
        <Tab.Screen
          name="Team"
          component={TeamScreen}
          options={{ title: 'Team' }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Settings' }}
        />
      </Tab.Navigator>

      {/* Hamburger Navigation Drawer Modal */}
      <HamburgerDrawer
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        navigation={navigation}
      />
    </View>
  );
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class RootErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[RootErrorBoundary] Caught unhandled component error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={errorBoundaryStyles.container}>
          <View style={errorBoundaryStyles.card}>
            <Ionicons name="alert-circle-outline" size={54} color="#EF4444" />
            <Text style={errorBoundaryStyles.title}>Unable to Load Screen</Text>
            <Text style={errorBoundaryStyles.subtitle}>
              An unexpected runtime error occurred while rendering this view.
            </Text>
            {this.state.error?.message ? (
              <View style={errorBoundaryStyles.errorBox}>
                <Text style={errorBoundaryStyles.errorText} numberOfLines={3}>
                  {this.state.error.message}
                </Text>
              </View>
            ) : null}
            <TouchableOpacity
              style={errorBoundaryStyles.button}
              onPress={this.handleReset}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Reload application"
            >
              <Text style={errorBoundaryStyles.buttonText}>Reload Application</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

export function RootNavigator() {
  const { colors } = useTheme();
  const [initialRoute, setInitialRoute] = useState<keyof RootStackParamList | null>(null);

  useEffect(() => {
    restoreSession();
  }, []);

  const restoreSession = async () => {
    try {
      // Bounded timeout guard: if SecureStore is slow or stalls on Android Keystore,
      // fallback to Auth without deleting credentials or hanging indefinitely
      const targetRoute = await Promise.race([
        (async (): Promise<keyof RootStackParamList> => {
          const [token, activeBiz] = await Promise.all([
            getAccessToken(),
            getActiveBusiness(),
          ]);
          if (!token) return 'Auth';
          if (activeBiz && activeBiz.id) {
            return 'Main';
          }
          return 'BusinessSelect';
        })(),
        new Promise<keyof RootStackParamList>((resolve) =>
          setTimeout(() => resolve('Auth'), 2500)
        ),
      ]);
      setInitialRoute(targetRoute);
    } catch {
      setInitialRoute('Auth');
    }
  };

  if (!initialRoute) {
    return (
      <View style={[styles.splashContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primaryTeal} />
        <Text style={[styles.splashText, { color: colors.textSecondary }]}>Restoring session...</Text>
      </View>
    );
  }

  return (
    <RootErrorBoundary>
      <Stack.Navigator initialRouteName={initialRoute} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Auth" component={LoginScreen} />
        <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
        <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
        <Stack.Screen name="BusinessSelect" component={BusinessSelectScreen} />
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="AcceptInvitation" component={AcceptInvitationScreen} />
        <Stack.Screen
          name="Billing"
          component={BillingScreen}
          options={{
            headerShown: true,
            title: 'Subscription & Billing',
            headerStyle: {
              backgroundColor: colors.surface,
            },
            headerTintColor: colors.textPrimary,
            headerTitleStyle: {
              fontWeight: typography.weights.bold,
              color: colors.textPrimary,
            },
          }}
        />
      </Stack.Navigator>
    </RootErrorBoundary>
  );
}

const styles = StyleSheet.create({
  tabContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerLeftButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerRightContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.lg,
    gap: spacing.md,
  },
  onlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: 1,
  },
  onlineBadgeActive: {
    backgroundColor: colors.lightTeal,
    borderColor: '#99F6E4',
  },
  onlineBadgeOffline: {
    backgroundColor: colors.warningLight,
    borderColor: colors.warningBorder,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  onlineDotActive: {
    backgroundColor: colors.success,
  },
  onlineDotOffline: {
    backgroundColor: colors.warning,
  },
  onlineText: {
    fontSize: typography.sizes.xs,
    fontWeight: typography.weights.bold,
  },
  onlineTextActive: {
    color: colors.tealDark,
  },
  onlineTextOffline: {
    color: colors.warningText,
  },
  signOutButton: {
    padding: spacing.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  splashText: {
    marginTop: spacing.md,
    fontSize: typography.sizes.md,
    color: colors.textSecondary,
    fontWeight: typography.weights.medium,
  },
});

const errorBoundaryStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    maxWidth: 380,
    width: '100%',
    borderWidth: 1,
    borderColor: '#334155',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#F8FAFC',
    marginTop: 14,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 8,
    padding: 10,
    width: '100%',
    marginBottom: 20,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  button: {
    backgroundColor: '#0D9488',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
  },
});
