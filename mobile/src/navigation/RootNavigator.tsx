import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { RootStackParamList, MainTabParamList } from './types.ts';
import { LoginScreen } from '../screens/LoginScreen.tsx';
import { BusinessSelectScreen } from '../screens/BusinessSelectScreen.tsx';
import { ScheduleScreen } from '../screens/ScheduleScreen.tsx';
import { FeedScreen } from '../screens/FeedScreen.tsx';
import { TeamScreen } from '../screens/TeamScreen.tsx';
import { SettingsScreen } from '../screens/SettingsScreen.tsx';
import { BillingScreen } from '../screens/BillingScreen.tsx';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

export function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0F172A' },
        headerTintColor: '#F8FAFC',
        tabBarStyle: { backgroundColor: '#0F172A', borderTopColor: '#1E293B' },
        tabBarActiveTintColor: '#38BDF8',
        tabBarInactiveTintColor: '#64748B',
      }}
    >
      <Tab.Screen name="Schedule" component={ScheduleScreen} options={{ title: 'Schedule' }} />
      <Tab.Screen name="Feed" component={FeedScreen} options={{ title: 'Inbox' }} />
      <Tab.Screen name="Team" component={TeamScreen} options={{ title: 'Team' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Auth" component={LoginScreen} />
      <Stack.Screen name="BusinessSelect" component={BusinessSelectScreen} />
      <Stack.Screen name="Main" component={MainTabs} />
      <Stack.Screen
        name="Billing"
        component={BillingScreen}
        options={{
          headerShown: true,
          title: 'Subscription & Billing',
          headerStyle: { backgroundColor: '#0F172A' },
          headerTintColor: '#F8FAFC',
        }}
      />
    </Stack.Navigator>
  );
}
