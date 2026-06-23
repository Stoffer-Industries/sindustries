import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  AccountCardRow,
  BalanceAreaChart,
  BudgetHeader,
  BudgetScreen,
  IconButton,
  InlineAlertEditor,
  MetricPanel,
  NativeConfirmDialogAdapter,
  PeriodSelector,
  PillTabBar
} from '@sindustries/ui/native';
import { tokens } from '@sindustries/design-tokens/tokens';

import { apiFetch } from '../api/http';
import type { RootStackParamList } from '../navigation/types';
import { useSession, type Session } from '../state/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Dashboard'>;

type BalanceAccount = {
  id: string;
  displayName: string;
  currentBalanceCents: number | null;
  availableBalanceCents: number | null;
  balanceCurrency: string | null;
  balanceUpdatedAt: string | null;
};

type BalancePoint = {
  capturedAt: string;
  currentBalanceCents: number;
};

type AlertConfig = {
  id: string;
  cardId: string;
  condition: 'more-than' | 'less-than';
  thresholdCents: number;
  pushEnabled: boolean;
  emailEnabled: boolean;
};

type AlertEditorState = {
  condition: 'more-than' | 'less-than';
  amount: string;
  pushEnabled: boolean;
  emailEnabled: boolean;
};

const budget = tokens.budget;
const b = budget.color;
const bs = budget.space;
const accountColors = [b.account.blue, b.account.purple, b.account.orange, b.account.green];

const demoAccounts: BalanceAccount[] = [
  {
    id: 'demo-savings',
    displayName: 'Savings',
    currentBalanceCents: 1284400,
    availableBalanceCents: 1284400,
    balanceCurrency: 'NZD',
    balanceUpdatedAt: new Date().toISOString()
  },
  {
    id: 'demo-travel',
    displayName: 'Travel Mastercard',
    currentBalanceCents: -84275,
    availableBalanceCents: -84275,
    balanceCurrency: 'NZD',
    balanceUpdatedAt: new Date().toISOString()
  },
  {
    id: 'demo-emergency',
    displayName: 'Emergency Fund',
    currentBalanceCents: 650000,
    availableBalanceCents: 650000,
    balanceCurrency: 'NZD',
    balanceUpdatedAt: new Date().toISOString()
  }
];

const demoBalancePoints = [10250, 10680, 10420, 11190, 11740, 11610, 12440].map((value) => ({
  value
}));

export function DashboardScreen({ navigation }: Props) {
  const { session, setSession } = useSession();
  const [email, setEmail] = useState('dev@example.com');
  const [balanceAccounts, setBalanceAccounts] = useState<BalanceAccount[]>([]);
  const [balancePoints, setBalancePoints] = useState<{ value: number }[]>(demoBalancePoints);
  const [syncVersion, setSyncVersion] = useState(0);
  const [akahuStatus, setAkahuStatus] = useState<string>('');
  const [period, setPeriod] = useState('1M');

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [alertConfigs, setAlertConfigs] = useState<Record<string, AlertConfig | null>>({});
  const [editorState, setEditorState] = useState<AlertEditorState>({
    condition: 'less-than',
    amount: '',
    pushEnabled: true,
    emailEnabled: false
  });
  const [savingAlert, setSavingAlert] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function validateSession() {
      if (!session) return;

      try {
        await apiFetch('/me', { session });
      } catch {
        if (!cancelled) {
          setSession(null);
          setAkahuStatus('Session expired after DB reset. Sign in again.');
        }
      }
    }

    validateSession();
    return () => {
      cancelled = true;
    };
  }, [session, setSession]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!session) return;
      const now = new Date();
      const to = now.toISOString();
      const from = new Date(now.valueOf() - 30 * 24 * 60 * 60 * 1000).toISOString();

      try {
        const res = await apiFetch<{
          accounts?: BalanceAccount[];
          totalSeries?: BalancePoint[];
        }>(
          `/cards/balance-history?userId=${encodeURIComponent(
            session.user.id
          )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          { session }
        );
        if (cancelled) return;
        setBalanceAccounts(res.accounts ?? []);
        setBalancePoints(
          (res.totalSeries ?? []).map((point) => ({
            value: point.currentBalanceCents / 100
          }))
        );
      } catch {
        if (!cancelled) {
          setBalanceAccounts([]);
          setBalancePoints(demoBalancePoints);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [session, syncVersion]);

  useEffect(() => {
    if (!session) return;
    const activeSession = session;
    let alive = true;

    async function maybeHandleUrl(url: string) {
      try {
        const u = new URL(url);
        const code = u.searchParams.get('code');
        if (!code) return;

        setAkahuStatus('Exchanging Akahu code...');
        await apiFetch('/akahu/exchange', {
          method: 'POST',
          body: JSON.stringify({ userId: activeSession.user.id, code }),
          session: activeSession
        });

        setAkahuStatus('Syncing transactions...');
        const now = Date.now();
        const startMs = now - 30 * 24 * 60 * 60 * 1000;
        await apiFetch('/akahu/sync', {
          method: 'POST',
          body: JSON.stringify({ userId: activeSession.user.id, startMs, endMs: now }),
          session: activeSession
        });

        if (alive) {
          setAkahuStatus('Akahu linked and synced');
          setSyncVersion((value) => value + 1);
        }
      } catch (e: any) {
        if (alive) setAkahuStatus('');
        Alert.alert('Akahu link failed', e?.message ?? 'Unknown error');
      }
    }

    Linking.getInitialURL()
      .then((url) => {
        if (url) return maybeHandleUrl(url);
      })
      .catch(() => {});

    const sub = Linking.addEventListener('url', (evt) => {
      void maybeHandleUrl(evt.url);
    });

    return () => {
      alive = false;
      sub.remove();
    };
  }, [session]);

  const loadAlertConfig = useCallback(
    async (cardId: string) => {
      if (!session || cardId.startsWith('demo-')) return;
      try {
        const res = await apiFetch<{ config: AlertConfig | null }>(
          `/cards/${encodeURIComponent(cardId)}/alert-config`,
          { session }
        );
        setAlertConfigs((prev) => ({ ...prev, [cardId]: res.config }));
        if (res.config) {
          setEditorState({
            condition: res.config.condition,
            amount: (res.config.thresholdCents / 100).toFixed(2),
            pushEnabled: res.config.pushEnabled,
            emailEnabled: res.config.emailEnabled
          });
        } else {
          setEditorState({ condition: 'less-than', amount: '', pushEnabled: true, emailEnabled: false });
        }
      } catch {
        setEditorState({ condition: 'less-than', amount: '', pushEnabled: true, emailEnabled: false });
      }
    },
    [session]
  );

  function handleCardPress(cardId: string) {
    if (selectedCardId === cardId) {
      setSelectedCardId(null);
      return;
    }
    setSelectedCardId(cardId);
    loadAlertConfig(cardId);
  }

  async function handleSaveAlert() {
    if (!session || !selectedCardId) return;
    const thresholdCents = Math.round(parseFloat(editorState.amount.replace(/[^0-9.]/g, '')) * 100);
    if (!thresholdCents || thresholdCents <= 0) {
      Alert.alert('Invalid amount', 'Enter a threshold amount greater than $0.');
      return;
    }
    setSavingAlert(true);
    try {
      const res = await apiFetch<{ config: AlertConfig }>(
        `/cards/${encodeURIComponent(selectedCardId)}/alert-config`,
        {
          method: 'POST',
          body: JSON.stringify({
            condition: editorState.condition,
            thresholdCents,
            pushEnabled: editorState.pushEnabled,
            emailEnabled: editorState.emailEnabled
          }),
          session
        }
      );
      setAlertConfigs((prev) => ({ ...prev, [selectedCardId]: res.config }));
      setSelectedCardId(null);
    } catch (e: any) {
      Alert.alert('Could not save alert', e?.message ?? 'Unknown error');
    } finally {
      setSavingAlert(false);
    }
  }

  function handleDeleteAlert() {
    if (!session || !selectedCardId) return;
    const dialog = NativeConfirmDialogAdapter({
      title: 'Remove balance alert',
      message: 'This will permanently remove the balance alert for this account.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        try {
          await apiFetch(`/cards/${encodeURIComponent(selectedCardId)}/alert-config`, {
            method: 'DELETE',
            session
          });
          setAlertConfigs((prev) => ({ ...prev, [selectedCardId]: null }));
          setSelectedCardId(null);
        } catch (e: any) {
          Alert.alert('Could not remove alert', e?.message ?? 'Unknown error');
        }
      }
    });
    dialog.confirm();
  }

  const accounts = session && balanceAccounts.length > 0 ? balanceAccounts : demoAccounts;
  const totalBalanceCents = accounts.reduce((sum, account) => {
    const value = account.currentBalanceCents ?? account.availableBalanceCents;
    return value === null ? sum : sum + value;
  }, 0);

  const subtitle = session ? `Signed in as ${session.user.email}` : 'Demo balances until Akahu is linked';
  const selectedAccount = selectedCardId ? accounts.find((a) => a.id === selectedCardId) : null;
  const selectedConfig = selectedCardId ? alertConfigs[selectedCardId] : null;
  const isDemo = selectedCardId?.startsWith('demo-') ?? false;

  return (
    <BudgetScreen
      footer={
        <PillTabBar
          activeKey="accounts"
          items={[
            { key: 'accounts', label: 'Accounts' },
            { key: 'spend', label: 'Spend' },
            { key: 'alerts', label: 'Alerts' }
          ]}
          onChange={(key) => {
            if (key === 'spend') navigation.navigate('Transactions');
            if (key === 'alerts') navigation.navigate('Alerts');
          }}
        />
      }
    >
      <BudgetHeader
        title="Accounts"
        subtitle={subtitle}
        right={<IconButton action="more" label="Account actions" />}
      />

      <MetricPanel
        title={formatCents(totalBalanceCents)}
        subtitle={session ? 'Latest total balance' : 'Demo total balance'}
      >
        <PeriodSelector value={period} onChange={setPeriod} />
        <BalanceAreaChart points={balancePoints.length > 0 ? balancePoints : demoBalancePoints} />
      </MetricPanel>

      <View style={styles.list}>
        {accounts.map((account, index) => {
          const balance = account.currentBalanceCents ?? account.availableBalanceCents;
          const hasAlert = !!alertConfigs[account.id];
          const isSelected = selectedCardId === account.id;
          return (
            <View key={account.id}>
              <AccountCardRow
                initial={initialFor(account.displayName)}
                name={account.displayName}
                subtitle={
                  hasAlert
                    ? `Alert set · ${account.balanceUpdatedAt ? `Updated ${formatDate(account.balanceUpdatedAt)}` : 'No balance update yet'}`
                    : account.balanceUpdatedAt
                    ? `Updated ${formatDate(account.balanceUpdatedAt)}`
                    : 'No balance update yet'
                }
                balance={balance === null ? 'No balance' : formatCents(balance)}
                color={accountColors[index % accountColors.length]}
                onPress={() => handleCardPress(account.id)}
              />
              {isSelected && selectedAccount ? (
                <View style={styles.inlineEditor}>
                  {isDemo ? (
                    <Text style={styles.demoNote}>
                      Sign in with a real account to save balance alerts.
                    </Text>
                  ) : (
                    <>
                      <InlineAlertEditor
                        condition={editorState.condition}
                        amount={editorState.amount}
                        pushEnabled={editorState.pushEnabled}
                        emailEnabled={editorState.emailEnabled}
                        onConditionChange={(c) => setEditorState((s) => ({ ...s, condition: c }))}
                        onAmountChange={(a) => setEditorState((s) => ({ ...s, amount: a }))}
                        onPushChange={(v) => setEditorState((s) => ({ ...s, pushEnabled: v }))}
                        onEmailChange={(v) => setEditorState((s) => ({ ...s, emailEnabled: v }))}
                        onSave={savingAlert ? undefined : handleSaveAlert}
                        onCancel={() => setSelectedCardId(null)}
                      />
                      {selectedConfig ? (
                        <Pressable onPress={handleDeleteAlert} style={styles.deleteLink}>
                          <Text style={styles.deleteLinkText}>Remove balance alert</Text>
                        </Pressable>
                      ) : null}
                    </>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      <MetricPanel title={session ? 'Akahu' : 'Dev sign in'} subtitle={akahuStatus || undefined}>
        {!session ? (
          <View style={styles.loginForm}>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="email"
              placeholderTextColor={b.text.disabled}
              style={styles.input}
            />
            <ActionButton
              label="Dev login"
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
          <View style={styles.actions}>
            <ActionButton label="Link Akahu" onPress={() => linkAkahu(session.user.id, session, setAkahuStatus)} />
            <ActionButton
              label="Sync now"
              onPress={async () => {
                try {
                  setAkahuStatus('Refreshing Akahu and syncing transactions...');
                  const now = Date.now();
                  const startMs = now - 90 * 24 * 60 * 60 * 1000;
                  await apiFetch('/akahu/sync', {
                    method: 'POST',
                    body: JSON.stringify({ userId: session.user.id, startMs, endMs: now, force: true }),
                    session
                  });
                  setAkahuStatus('Sync complete');
                  setSyncVersion((value) => value + 1);
                } catch (e: any) {
                  setAkahuStatus('');
                  Alert.alert('Sync failed', e?.message ?? 'Unknown error');
                }
              }}
            />
            <ActionButton label="Sign out" variant="secondary" onPress={() => setSession(null)} />
          </View>
        )}
      </MetricPanel>
    </BudgetScreen>
  );
}

function ActionButton({
  label,
  variant = 'primary',
  onPress
}: {
  label: string;
  variant?: 'primary' | 'secondary';
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        variant === 'secondary' && styles.secondaryButton,
        pressed && styles.pressed
      ]}
    >
      <Text style={[styles.actionText, variant === 'secondary' && styles.secondaryText]}>{label}</Text>
    </Pressable>
  );
}

async function linkAkahu(userId: string, session: Session, setAkahuStatus: (status: string) => void) {
  try {
    setAkahuStatus('Opening Akahu...');
    const res = await apiFetch<{ authorizeUrl: string }>(
      `/akahu/authorize-url?userId=${encodeURIComponent(userId)}`,
      { session }
    );
    await Linking.openURL(res.authorizeUrl);
  } catch (e: any) {
    setAkahuStatus('');
    Alert.alert('Could not open Akahu', e?.message ?? 'Unknown error');
  }
}

function initialFor(name: string) {
  return name.trim().charAt(0).toUpperCase() || '$';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short' }).format(new Date(value));
}

function formatCents(cents: number) {
  return new Intl.NumberFormat('en-NZ', {
    style: 'currency',
    currency: 'NZD'
  }).format(cents / 100);
}

const styles = StyleSheet.create({
  list: {
    gap: bs[3]
  },
  loginForm: {
    gap: bs[3]
  },
  actions: {
    gap: bs[3]
  },
  inlineEditor: {
    marginTop: bs[2],
    gap: bs[2]
  },
  demoNote: {
    color: b.text.muted,
    fontSize: 13,
    paddingHorizontal: bs[2]
  },
  deleteLink: {
    alignItems: 'center',
    paddingVertical: bs[2]
  },
  deleteLinkText: {
    color: b.status.iosDanger,
    fontSize: 14,
    fontWeight: '600'
  },
  input: {
    minHeight: 50,
    borderRadius: budget.radius.cardSm,
    paddingHorizontal: bs[4],
    color: b.text.primary,
    backgroundColor: b.surface.inset,
    borderWidth: 1,
    borderColor: b.border.default,
    fontSize: 16,
    fontWeight: '600'
  },
  actionButton: {
    minHeight: tokens.platform.mobile.hitTarget.min,
    borderRadius: budget.radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: b.surface.control
  },
  secondaryButton: {
    backgroundColor: b.surface.strong
  },
  actionText: {
    color: b.text.inverse,
    fontWeight: '800'
  },
  secondaryText: {
    color: b.text.primary
  },
  pressed: {
    opacity: 0.82
  }
});
