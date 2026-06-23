import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheet,
  BudgetHeader,
  BudgetScreen,
  CategoryOptionRow,
  CategorySummaryRow,
  IconButton,
  MetricPanel,
  PillTabBar,
  StackedCategoryBars,
  TransactionRow
} from '@sindustries/ui/native';
import { tokens } from '@sindustries/design-tokens/tokens';

import { apiFetch } from '../api/http';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../state/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Transactions'>;

type Txn = {
  id: string;
  merchant: string | null;
  description: string | null;
  amountCents: number;
  category: string;
  pending?: boolean;
};

const budget = tokens.budget;
const b = budget.color;
const bs = budget.space;

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

const demoTransactions: Txn[] = [
  { id: 'demo-1', merchant: 'Countdown', description: null, amountCents: -8420, category: 'groceries' },
  { id: 'demo-2', merchant: 'Netflix', description: null, amountCents: -2499, category: 'subscriptions' },
  { id: 'demo-3', merchant: 'Auckland Transport', description: null, amountCents: -1180, category: 'transport' },
  { id: 'demo-4', merchant: 'Payroll', description: null, amountCents: 328000, category: 'transfers' },
  { id: 'demo-5', merchant: 'Best Ugly Bagels', description: null, amountCents: -2750, category: 'dining' }
];

export function TransactionsScreen({ navigation }: Props) {
  const { session } = useSession();
  const [data, setData] = useState<Txn[]>(demoTransactions);
  const [loading, setLoading] = useState(false);
  const [detailTxn, setDetailTxn] = useState<Txn | null>(null);
  const [editingTxn, setEditingTxn] = useState<Txn | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!session) {
        setData(demoTransactions);
        return;
      }
      setLoading(true);
      try {
        const res = await apiFetch<{ transactions?: Txn[] }>(
          `/transactions?userId=${encodeURIComponent(session.user.id)}`,
          { session }
        );
        const list = res?.transactions;
        if (!cancelled) setData(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setData([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const categoryRows = useMemo(() => buildCategoryRows(data), [data]);
  const totalSpend = data
    .filter((txn) => txn.amountCents < 0)
    .reduce((sum, txn) => sum + Math.abs(txn.amountCents), 0);

  async function updateCategory(txn: Txn, category: string) {
    setEditingTxn(null);
    const previous = txn.category;
    setData((current) => current.map((item) => (item.id === txn.id ? { ...item, category } : item)));
    if (!session) return;

    try {
      await apiFetch(`/transactions/${encodeURIComponent(txn.id)}/category`, {
        method: 'PATCH',
        body: JSON.stringify({ category }),
        session
      });
    } catch (e: any) {
      setData((current) => current.map((item) => (item.id === txn.id ? { ...item, category: previous } : item)));
      Alert.alert('Update failed', e?.message ?? 'Unknown error');
    }
  }

  return (
    <BudgetScreen
      footer={
        <PillTabBar
          activeKey="spend"
          items={[
            { key: 'accounts', label: 'Accounts' },
            { key: 'spend', label: 'Spend' },
            { key: 'alerts', label: 'Alerts' }
          ]}
          onChange={(key) => {
            if (key === 'accounts') navigation.navigate('Dashboard');
            if (key === 'alerts') navigation.navigate('Alerts');
          }}
        />
      }
    >
      <BudgetHeader
        title="Spending"
        subtitle={session ? (loading ? 'Refreshing transactions' : 'Backed by budget-api') : 'Demo spending breakdown'}
        left={<IconButton action="back" label="Back to accounts" onPress={() => navigation.navigate('Dashboard')} />}
      />

      <MetricPanel title={formatCents(totalSpend)} subtitle="Spent this period">
        <StackedCategoryBars
          bars={[
            {
              label: 'W1',
              segments: categoryRows.slice(0, 4).map((row) => ({
                key: row.category,
                value: row.amountCents,
                color: row.color
              }))
            },
            {
              label: 'W2',
              segments: categoryRows.slice(1, 5).map((row) => ({
                key: row.category,
                value: Math.round(row.amountCents * 0.72),
                color: row.color
              }))
            },
            {
              label: 'W3',
              segments: categoryRows.slice(0, 5).map((row) => ({
                key: row.category,
                value: Math.round(row.amountCents * 0.9),
                color: row.color
              }))
            },
            {
              label: 'W4',
              segments: categoryRows.slice(0, 5).map((row) => ({
                key: row.category,
                value: row.amountCents,
                color: row.color
              }))
            }
          ]}
        />
      </MetricPanel>

      <MetricPanel title="Categories" subtitle="Tap a category to review transactions">
        {categoryRows.map((row) => (
          <CategorySummaryRow
            key={row.category}
            color={row.color}
            label={titleCase(row.category)}
            metadata={`${row.count} transaction${row.count !== 1 ? 's' : ''}`}
            amount={formatCents(row.amountCents)}
            progress={totalSpend === 0 ? 0 : row.amountCents / totalSpend}
            onPress={() => navigation.navigate('CategoryTransactions', { category: row.category })}
          />
        ))}
      </MetricPanel>

      <MetricPanel title="Recent transactions">
        <View style={styles.transactionList}>
          {data.length === 0 ? (
            <Text style={styles.emptyText}>{session ? 'No transactions yet.' : 'Please dev-login from Accounts to load live data.'}</Text>
          ) : (
            data.slice(0, 8).map((txn) => {
              const title = txn.merchant?.trim() || txn.description?.trim() || 'Unknown transaction';
              return (
                <TransactionRow
                  key={txn.id}
                  initial={title.charAt(0).toUpperCase()}
                  title={title}
                  metadata={`${titleCase(txn.category)}${txn.pending ? ' · Pending' : ''}`}
                  amount={formatCents(txn.amountCents)}
                  income={txn.amountCents > 0}
                  color={colorForCategory(txn.category)}
                  onPress={() => setDetailTxn(txn)}
                />
              );
            })
          )}
        </View>
      </MetricPanel>

      {/* Transaction detail sheet */}
      <BottomSheet
        visible={detailTxn !== null && editingTxn === null}
        title={detailTxn ? (detailTxn.merchant || detailTxn.description || 'Transaction') : undefined}
        subtitle={detailTxn ? formatCents(detailTxn.amountCents) : undefined}
        detailRows={detailTxn ? buildDetailRows(detailTxn) : []}
        onDismiss={() => setDetailTxn(null)}
      >
        {detailTxn ? (
          <Pressable
            accessibilityRole="button"
            style={styles.changeCategoryButton}
            onPress={() => {
              setEditingTxn(detailTxn);
              setDetailTxn(null);
            }}
          >
            <Text style={styles.changeCategoryText}>Change category</Text>
          </Pressable>
        ) : null}
      </BottomSheet>

      {/* Recategorization sheet */}
      <BottomSheet
        visible={editingTxn !== null}
        title={editingTxn ? (editingTxn.merchant || editingTxn.description || 'Transaction') : undefined}
        subtitle="Choose a category"
        onDismiss={() => setEditingTxn(null)}
      >
        {editingTxn
          ? categories.map((category) => (
              <CategoryOptionRow
                key={category}
                color={colorForCategory(category)}
                label={titleCase(category)}
                selected={editingTxn.category === category}
                onPress={() => updateCategory(editingTxn, category)}
              />
            ))
          : null}
      </BottomSheet>
    </BudgetScreen>
  );
}

function buildDetailRows(txn: Txn): { label: string; value: string }[] {
  return [
    { label: 'Category', value: titleCase(txn.category) },
    { label: 'Status', value: txn.pending ? 'Pending' : 'Cleared' }
  ];
}

function buildCategoryRows(transactions: Txn[]) {
  const spend = transactions.filter((txn) => txn.amountCents < 0);
  const grouped = new Map<string, { amountCents: number; count: number }>();
  for (const txn of spend) {
    const current = grouped.get(txn.category) ?? { amountCents: 0, count: 0 };
    current.amountCents += Math.abs(txn.amountCents);
    current.count += 1;
    grouped.set(txn.category, current);
  }

  return [...grouped.entries()]
    .map(([category, value]) => ({
      category,
      color: colorForCategory(category),
      ...value
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

function colorForCategory(category: string) {
  const categoryColors = b.category as Record<string, string>;
  return categoryColors[category] ?? b.category.other;
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatCents(cents: number) {
  const amount = Math.abs(cents) / 100;
  const formatted = new Intl.NumberFormat('en-NZ', {
    style: 'currency',
    currency: 'NZD'
  }).format(amount);
  if (cents < 0) return `-${formatted}`;
  return formatted;
}

const styles = StyleSheet.create({
  transactionList: {
    gap: bs[3]
  },
  emptyText: {
    color: b.text.muted,
    fontSize: 14
  },
  changeCategoryButton: {
    minHeight: tokens.platform.mobile.hitTarget.min,
    borderRadius: budget.radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: b.surface.control
  },
  changeCategoryText: {
    color: b.text.inverse,
    fontWeight: '800',
    fontSize: 15
  }
});
