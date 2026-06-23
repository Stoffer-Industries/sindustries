import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheet,
  BudgetHeader,
  BudgetScreen,
  CategoryOptionRow,
  IconButton,
  MetricPanel,
  TransactionRow
} from '@sindustries/ui/native';
import { tokens } from '@sindustries/design-tokens/tokens';

import { apiFetch } from '../api/http';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../state/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'CategoryTransactions'>;

type Txn = {
  id: string;
  merchant: string | null;
  description: string | null;
  amountCents: number;
  category: string;
  pending?: boolean;
  date?: string;
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
  { id: 'demo-1', merchant: 'Countdown', description: null, amountCents: -8420, category: 'groceries', date: '2026-06-20' },
  { id: 'demo-2', merchant: 'Netflix', description: null, amountCents: -2499, category: 'subscriptions', date: '2026-06-19' },
  { id: 'demo-3', merchant: 'Auckland Transport', description: null, amountCents: -1180, category: 'transport', date: '2026-06-18' },
  { id: 'demo-4', merchant: 'Payroll', description: null, amountCents: 328000, category: 'transfers', date: '2026-06-15' },
  { id: 'demo-5', merchant: 'Best Ugly Bagels', description: null, amountCents: -2750, category: 'dining', date: '2026-06-17' },
  { id: 'demo-6', merchant: 'New World', description: null, amountCents: -11200, category: 'groceries', date: '2026-06-14' },
  { id: 'demo-7', merchant: 'Uber', description: null, amountCents: -1850, category: 'transport', date: '2026-06-13' },
  { id: 'demo-8', merchant: 'Spotify', description: null, amountCents: -1199, category: 'subscriptions', date: '2026-06-12' },
  { id: 'demo-9', merchant: 'Pak\'nSave', description: null, amountCents: -9300, category: 'groceries', date: '2026-06-07' },
  { id: 'demo-10', merchant: 'Mekong', description: null, amountCents: -3400, category: 'dining', date: '2026-06-05' }
];

export function CategoryTransactionsScreen({ navigation, route }: Props) {
  const { category } = route.params;
  const { session } = useSession();
  const [allData, setAllData] = useState<Txn[]>(demoTransactions);
  const [loading, setLoading] = useState(false);
  const [detailTxn, setDetailTxn] = useState<Txn | null>(null);
  const [editingTxn, setEditingTxn] = useState<Txn | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!session) {
        setAllData(demoTransactions);
        return;
      }
      setLoading(true);
      try {
        const res = await apiFetch<{ transactions?: Txn[] }>(
          `/transactions?userId=${encodeURIComponent(session.user.id)}`,
          { session }
        );
        if (!cancelled) setAllData(Array.isArray(res?.transactions) ? res.transactions : []);
      } catch {
        if (!cancelled) setAllData([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const data = useMemo(() => allData.filter((t) => t.category === category), [allData, category]);
  const totalCents = data.reduce((sum, t) => (t.amountCents < 0 ? sum + Math.abs(t.amountCents) : sum), 0);

  async function updateCategory(txn: Txn, newCategory: string) {
    setEditingTxn(null);
    const previous = txn.category;
    setAllData((current) => current.map((item) => (item.id === txn.id ? { ...item, category: newCategory } : item)));
    if (!session) return;
    try {
      await apiFetch(`/transactions/${encodeURIComponent(txn.id)}/category`, {
        method: 'PATCH',
        body: JSON.stringify({ category: newCategory }),
        session
      });
    } catch (e: any) {
      setAllData((current) => current.map((item) => (item.id === txn.id ? { ...item, category: previous } : item)));
      Alert.alert('Update failed', e?.message ?? 'Unknown error');
    }
  }

  const subtitleText = loading
    ? 'Loading transactions...'
    : `${data.length} transaction${data.length !== 1 ? 's' : ''}`;

  return (
    <BudgetScreen>
      <BudgetHeader
        title={titleCase(category)}
        subtitle={subtitleText}
        left={<IconButton action="back" label="Back to spending" onPress={() => navigation.goBack()} />}
      />

      <MetricPanel title={formatCents(totalCents)} subtitle={`Total spent · ${titleCase(category)}`}>
        <View style={styles.categoryBadge}>
          <View style={[styles.categoryDot, { backgroundColor: colorForCategory(category) }]} />
          <Text style={styles.categoryBadgeLabel}>{titleCase(category)}</Text>
        </View>
      </MetricPanel>

      <MetricPanel title="Transactions">
        <View style={styles.list}>
          {data.length === 0 ? (
            <Text style={styles.emptyText}>
              {session ? 'No transactions in this category.' : 'Demo data — tap a transaction to review it.'}
            </Text>
          ) : (
            data.map((txn) => {
              const title = txn.merchant?.trim() || txn.description?.trim() || 'Unknown transaction';
              return (
                <TransactionRow
                  key={txn.id}
                  initial={title.charAt(0).toUpperCase()}
                  title={title}
                  metadata={txn.date ? formatDate(txn.date) : titleCase(category)}
                  amount={formatCents(txn.amountCents)}
                  income={txn.amountCents > 0}
                  color={colorForCategory(category)}
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
          ? categories.map((cat) => (
              <CategoryOptionRow
                key={cat}
                color={colorForCategory(cat)}
                label={titleCase(cat)}
                selected={editingTxn.category === cat}
                onPress={() => updateCategory(editingTxn, cat)}
              />
            ))
          : null}
      </BottomSheet>
    </BudgetScreen>
  );
}

function buildDetailRows(txn: Txn): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'Category', value: titleCase(txn.category) },
    { label: 'Status', value: txn.pending ? 'Pending' : 'Cleared' }
  ];
  if (txn.date) rows.splice(1, 0, { label: 'Date', value: formatDate(txn.date) });
  if (txn.description && txn.merchant) rows.push({ label: 'Reference', value: txn.description });
  return rows;
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
  const formatted = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(amount);
  return cents < 0 ? `-${formatted}` : formatted;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}

const styles = StyleSheet.create({
  list: {
    gap: bs[3]
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: bs[2]
  },
  categoryDot: {
    width: 10,
    height: 10,
    borderRadius: 5
  },
  categoryBadgeLabel: {
    color: b.text.secondary,
    fontSize: 13,
    fontWeight: '600'
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
