import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { IconButton } from '@sindustries/ui/native';
import { tokens } from '@sindustries/design-tokens/tokens';

import { apiFetch } from '../api/http';
import { useSession } from '../state/SessionContext';

type AlertItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
};

const budget = tokens.budget;
const b = budget.color;
const bs = budget.space;

export function AlertsScreen() {
  const { session } = useSession();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ alerts: AlertItem[] }>(
        `/alerts?userId=${encodeURIComponent(session.user.id)}`,
        { session }
      );
      setAlerts(res.alerts);
    } catch {
      // swallow; empty list is fine
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  function confirmDelete(alertId: string) {
    Alert.alert(
      'Remove alert',
      'This notification will be permanently removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiFetch(`/alerts/${alertId}`, { method: 'DELETE', session });
              setAlerts((prev) => prev.filter((a) => a.id !== alertId));
            } catch (e: any) {
              Alert.alert('Could not remove', e?.message ?? 'Unknown error');
            }
          }
        }
      ]
    );
  }

  if (!session) {
    return (
      <View style={styles.container}>
        <Text style={styles.emptyText}>Sign in on the Accounts tab to view alerts.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {alerts.length === 0 && !loading ? (
        <Text style={styles.emptyText}>No alerts yet. Budget threshold alerts will appear here.</Text>
      ) : null}
      <FlatList
        data={alerts}
        keyExtractor={(a) => a.id}
        style={{ flex: 1 }}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        renderItem={({ item }) => (
          <View style={styles.alertCard}>
            <View style={styles.alertBody}>
              <Text style={styles.alertTitle}>{item.title}</Text>
              <Text style={styles.alertText}>{item.body}</Text>
              <Text style={styles.alertDate}>
                {new Date(item.createdAt).toLocaleDateString('en-NZ', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric'
                })}
              </Text>
            </View>
            <IconButton
              action="delete"
              label="Remove alert"
              destructive
              onPress={() => confirmDelete(item.id)}
            />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: bs[4],
    paddingTop: bs[3],
    paddingBottom: bs[3],
    gap: bs[3]
  },
  emptyText: {
    color: b.text.muted,
    fontSize: 14
  },
  alertCard: {
    borderWidth: 1,
    borderColor: b.border.default,
    borderRadius: 12,
    padding: bs[3],
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: b.surface.row,
    gap: bs[2]
  },
  alertBody: {
    flex: 1,
    gap: 4
  },
  alertTitle: {
    fontWeight: '700',
    color: b.text.primary,
    fontSize: 14
  },
  alertText: {
    color: b.text.secondary,
    fontSize: 13
  },
  alertDate: {
    color: b.text.muted,
    fontSize: 11
  }
});
