import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, ScrollView, Text, TextInput, View } from 'react-native';

import { CategoryTimeseriesChart } from '../components/CategoryTimeseriesChart';
import { apiFetch } from '../api/http';
import { useSession } from '../state/SessionContext';

export function DashboardScreen({ navigation }: any) {
  const { session, setSession } = useSession();
  const [email, setEmail] = useState('dev@example.com');
  const [series, setSeries] = useState<Record<string, { day: string; amountCents: number }[]>>(
    {}
  );
  const [selectedCategory, setSelectedCategory] = useState<string>('other');

  const demoPoints = useMemo(
    () => [
      { day: '2026-03-25', amountCents: 1200 },
      { day: '2026-03-26', amountCents: 5600 },
      { day: '2026-03-27', amountCents: 2900 },
      { day: '2026-03-28', amountCents: 8600 },
      { day: '2026-03-29', amountCents: 6400 },
      { day: '2026-03-30', amountCents: 9100 },
      { day: '2026-03-31', amountCents: 7800 }
    ],
    []
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!session) return;
      const now = new Date();
      const to = now.toISOString().slice(0, 10);
      const fromDate = new Date(now.valueOf() - 6 * 24 * 60 * 60 * 1000);
      const from = fromDate.toISOString().slice(0, 10);

      try {
        const res = await apiFetch<{
          from: string;
          to: string;
          series: Record<string, { day: string; amountCents: number }[]>;
        }>(
          `/categories/timeseries?userId=${encodeURIComponent(
            session.user.id
          )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          { session }
        );
        if (cancelled) return;
        setSeries(res.series ?? {});

        const keys = Object.keys(res.series ?? {});
        if (keys.length > 0 && !keys.includes(selectedCategory)) {
          setSelectedCategory(keys[0]);
        }
      } catch {
        // keep UI usable even before DB exists
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const categoryKeys = Object.keys(series);
  const chartPoints = session
    ? series[selectedCategory] ?? []
    : demoPoints;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 20, fontWeight: '700' }}>Dashboard</Text>
        <Text style={{ color: '#6b7280' }}>
          {session ? `Signed in as ${session.user.email}` : 'Not signed in'}
        </Text>
        {!session ? (
          <View style={{ gap: 8 }}>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              style={{
                borderWidth: 1,
                borderColor: '#e5e7eb',
                borderRadius: 12,
                padding: 12
              }}
              placeholder="email"
            />
            <Button
              title="Dev login"
              onPress={async () => {
                try {
                  const res = await apiFetch<{
                    token: string;
                    user: { id: string; email: string };
                  }>('/session/dev-login', {
                    method: 'POST',
                    body: JSON.stringify({ email })
                  });
                  setSession({ token: res.token, user: res.user });
                } catch (e: any) {
                  Alert.alert('Login failed', e?.message ?? 'Unknown error');
                }
              }}
            />
          </View>
        ) : (
          <Button title="Sign out" onPress={() => setSession(null)} />
        )}
        <Text style={{ color: '#6b7280' }}>
          Category trend {session ? '(from budget-api)' : '(demo placeholder)'}
        </Text>
        {session && categoryKeys.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {categoryKeys.slice(0, 8).map((k) => (
              <Button
                key={k}
                title={k === selectedCategory ? `• ${k}` : k}
                onPress={() => setSelectedCategory(k)}
              />
            ))}
          </View>
        ) : null}
        <CategoryTimeseriesChart points={chartPoints} />
      </View>

      <View style={{ gap: 12 }}>
        <Button
          title="View transactions"
          onPress={() => navigation.navigate('Transactions')}
        />
        <Button
          title="View alerts"
          onPress={() => navigation.navigate('Alerts')}
        />
      </View>
    </ScrollView>
  );
}

