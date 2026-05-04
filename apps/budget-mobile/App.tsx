import React, { useMemo, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AlertsScreen } from './src/screens/AlertsScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { TransactionsScreen } from './src/screens/TransactionsScreen';
import { SessionProvider } from './src/state/SessionContext';

export type AppScreen = 'Dashboard' | 'Transactions' | 'Alerts';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('Dashboard');

  const body = useMemo(() => {
    if (screen === 'Transactions') {
      return <TransactionsScreen onBack={() => setScreen('Dashboard')} />;
    }
    if (screen === 'Alerts') {
      return <AlertsScreen onBack={() => setScreen('Dashboard')} />;
    }
    return (
      <DashboardScreen
        onNavigateTransactions={() => setScreen('Transactions')}
        onNavigateAlerts={() => setScreen('Alerts')}
      />
    );
  }, [screen]);

  return (
    <SafeAreaProvider>
      <SessionProvider>{body}</SessionProvider>
    </SafeAreaProvider>
  );
}
