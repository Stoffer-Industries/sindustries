import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, FlatList, Text, View } from 'react-native';
import { apiFetch } from '../api/http';
import { useSession } from '../state/SessionContext';

type Txn = {
  id: string;
  merchant: string;
  amountCents: number;
  category: string;
};

const categories = [
  'groceries',
  'dining',
  'transport',
  'shopping',
  'utilities',
  'entertainment',
  'health',
  'travel',
  'subscriptions',
  'fees',
  'transfers',
  'other'
];

export function TransactionsScreen() {
  const { session } = useSession();
  const [data, setData] = useState<Txn[]>(useMemo(() => [], []));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!session) return;
      setLoading(true);
      try {
        const res = await apiFetch<{ transactions: Txn[] }>(
          `/transactions?userId=${encodeURIComponent(session.user.id)}`,
          { session }
        );
        if (!cancelled) setData(res.transactions);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [session]);

  function recategorize(txnId: string) {
    Alert.alert(
      'Change category',
      'Pick a new category',
      categories.map((c) => ({
        text: c,
        onPress: async () => {
          if (!session) return;
          const prev = data.find((t) => t.id === txnId);
          setData((p) => p.map((t) => (t.id === txnId ? { ...t, category: c } : t)));
          try {
            await apiFetch(`/transactions/${encodeURIComponent(txnId)}/category`, {
              method: 'PATCH',
              body: JSON.stringify({ category: c }),
              session
            });
          } catch (e: any) {
            // rollback on error
            if (prev) {
              setData((p) =>
                p.map((t) => (t.id === txnId ? { ...t, category: prev.category } : t))
              );
            }
            Alert.alert('Update failed', e?.message ?? 'Unknown error');
          }
        }
      }))
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>Transactions</Text>
      <Text style={{ color: '#6b7280' }}>
        {session ? (loading ? 'Loading…' : 'Backed by budget-api') : 'Please dev-login first.'}
      </Text>

      <FlatList
        data={data}
        keyExtractor={(t) => t.id}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        renderItem={({ item }) => (
          <View
            style={{
              borderWidth: 1,
              borderColor: '#e5e7eb',
              borderRadius: 12,
              padding: 12,
              gap: 8
            }}
          >
            <Text style={{ fontWeight: '700' }}>{item.merchant}</Text>
            <Text>${(item.amountCents / 100).toFixed(2)}</Text>
            <Text style={{ color: '#6b7280' }}>Category: {item.category}</Text>
            <Button
              title="Change category"
              onPress={() => recategorize(item.id)}
            />
          </View>
        )}
      />
    </View>
  );
}

