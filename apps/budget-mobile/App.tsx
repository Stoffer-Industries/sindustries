import React, { useRef } from 'react';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppEdgeSwipeBack } from './src/components/AppEdgeSwipeBack';
import { AlertsScreen } from './src/screens/AlertsScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { TransactionsScreen } from './src/screens/TransactionsScreen';
import { SessionProvider } from './src/state/SessionContext';
import type { RootStackParamList } from './src/navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const navigationRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  return (
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
                  Alerts: 'alerts'
                }
              }
            }}
          >
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
                options={{
                  title: 'Transactions',
                  headerBackTitle: 'Back',
                  headerBackButtonDisplayMode: 'generic'
                }}
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
            </Stack.Navigator>
            <AppEdgeSwipeBack navigationRef={navigationRef} />
          </NavigationContainer>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
