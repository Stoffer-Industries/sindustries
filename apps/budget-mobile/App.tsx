import React, { useRef } from 'react';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ClerkProvider } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';

import { AppEdgeSwipeBack } from './src/components/AppEdgeSwipeBack';
import { UpdateBanner } from './src/components/UpdateBanner';
import { AlertsScreen } from './src/screens/AlertsScreen';
import { CategoryTransactionsScreen } from './src/screens/CategoryTransactionsScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TokenSpecimenScreen } from './src/screens/TokenSpecimenScreen';
import { TransactionsScreen } from './src/screens/TransactionsScreen';
import { SessionProvider } from './src/state/SessionContext';
import type { RootStackParamList } from './src/navigation/types';
import { CLERK_PUBLISHABLE_KEY } from './src/config';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const navigationRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  if (!CLERK_PUBLISHABLE_KEY) throw new Error('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is required');

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <NavigationContainer
            ref={navigationRef}
            linking={{
              enabled: false,
              prefixes: [],
              config: {
                screens: {
                  Dashboard: '',
                  Transactions: 'transactions',
                  CategoryTransactions: 'transactions/:category',
                  Alerts: 'alerts',
                  Settings: 'settings',
                  TokenSpecimen: 'tokens'
                }
              }
            }}
          >
            <UpdateBanner />
            <Stack.Navigator
              initialRouteName="Dashboard"
              screenOptions={{
                gestureEnabled: true,
                gestureResponseDistance: { start: 80 }
              }}
            >
              <Stack.Screen
                name="Dashboard"
                component={DashboardScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="Transactions"
                component={TransactionsScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="CategoryTransactions"
                component={CategoryTransactionsScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="Alerts"
                component={AlertsScreen}
                options={{
                  title: 'Alerts',
                  headerBackTitle: 'Back',
                  headerBackButtonDisplayMode: 'generic'
                }}
              />
              <Stack.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="TokenSpecimen"
                component={TokenSpecimenScreen}
                options={{ headerShown: false }}
              />
            </Stack.Navigator>
            <AppEdgeSwipeBack navigationRef={navigationRef} />
          </NavigationContainer>
        </SessionProvider>
      </SafeAreaProvider>
      </GestureHandlerRootView>
    </ClerkProvider>
  );
}
