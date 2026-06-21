import React, { type ReactNode, useMemo } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native';
import Svg, { Defs, LinearGradient, Line, Path, Rect, Stop } from 'react-native-svg';
import { colors, fonts, radius, space, tokens } from '@sindustries/design-tokens/tokens';

const budget = tokens.budget;
const b = budget.color;
const bs = budget.space;
const br = budget.radius;
const hitTarget = tokens.platform.mobile.hitTarget.min;

type IconAction = 'back' | 'more' | 'delete' | 'add' | 'chart';
type TabItem = { key: string; label: string };
type DetailRow = { label: string; value: string };
type ChartPoint = { label?: string; value: number };
type CategoryBarSegment = { key: string; value: number; color: string };
type CategoryBar = { label: string; segments: CategoryBarSegment[] };

export interface BudgetScreenProps {
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}

export function BudgetScreen({ children, footer, scroll = true, style, contentStyle }: BudgetScreenProps) {
  const content = <View style={[styles.screenContent, contentStyle]}>{children}</View>;

  return (
    <SafeAreaView style={[styles.screen, style]}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.screenScrollContent}>{content}</ScrollView>
      ) : (
        content
      )}
      {footer ? <View style={styles.screenFooter}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export interface BudgetHeaderProps {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
}

export function BudgetHeader({ title, subtitle, left, right }: BudgetHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>{left}</View>
      <View style={styles.headerCenter}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  );
}

export interface IconButtonProps {
  action: IconAction;
  label?: string;
  selected?: boolean;
  destructive?: boolean;
  onPress?: (event: GestureResponderEvent) => void;
  disabled?: boolean;
}

const actionLabels: Record<IconAction, string> = {
  back: '‹',
  more: '...',
  delete: '×',
  add: '+',
  chart: '⌁'
};

export function IconButton({ action, label, selected, destructive, onPress, disabled }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? action}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        selected && styles.iconButtonSelected,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled
      ]}
    >
      <Text style={[styles.iconButtonText, destructive && styles.destructiveText]}>
        {actionLabels[action]}
      </Text>
    </Pressable>
  );
}

export interface PillTabBarProps {
  items: TabItem[];
  activeKey: string;
  onChange?: (key: string) => void;
}

export function PillTabBar({ items, activeKey, onChange }: PillTabBarProps) {
  return (
    <View style={styles.tabBar}>
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange?.(item.key)}
            style={({ pressed }) => [
              styles.tabSegment,
              active && styles.tabSegmentActive,
              pressed && styles.pressed
            ]}
          >
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface AccountCardRowProps {
  initial: string;
  name: string;
  subtitle: string;
  balance: string;
  color?: string;
  onPress?: () => void;
}

export function AccountCardRow({
  initial,
  name,
  subtitle,
  balance,
  color = b.account.blue,
  onPress
}: AccountCardRowProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <InitialTile label={initial} color={color} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{name}</Text>
        <Text style={styles.rowMeta}>{subtitle}</Text>
      </View>
      <Text style={styles.balanceText}>{balance}</Text>
    </Pressable>
  );
}

export interface TransactionRowProps {
  initial: string;
  title: string;
  metadata: string;
  amount: string;
  income?: boolean;
  color?: string;
  onPress?: () => void;
}

export function TransactionRow({
  initial,
  title,
  metadata,
  amount,
  income,
  color = b.account.ink,
  onPress
}: TransactionRowProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <InitialTile label={initial} color={color} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowMeta}>{metadata}</Text>
      </View>
      <Text style={[styles.amountText, income ? styles.incomeText : styles.expenseText]}>{amount}</Text>
    </Pressable>
  );
}

export interface MetricPanelProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function MetricPanel({ title, subtitle, children, style }: MetricPanelProps) {
  return (
    <View style={[styles.metricPanel, style]}>
      {title || subtitle ? (
        <View style={styles.panelHeader}>
          {title ? <Text style={styles.panelTitle}>{title}</Text> : null}
          {subtitle ? <Text style={styles.panelSubtitle}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export interface PeriodSelectorProps {
  periods?: string[];
  value: string;
  onChange?: (period: string) => void;
}

export function PeriodSelector({ periods = ['1W', '1M', '3M', '1Y', 'ALL'], value, onChange }: PeriodSelectorProps) {
  return (
    <View style={styles.periodSelector}>
      {periods.map((period) => {
        const active = period === value;
        return (
          <Pressable
            key={period}
            onPress={() => onChange?.(period)}
            style={({ pressed }) => [
              styles.periodSegment,
              active && styles.periodSegmentActive,
              pressed && styles.pressed
            ]}
          >
            <Text style={[styles.periodText, active && styles.periodTextActive]}>{period}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface BalanceAreaChartProps {
  points: ChartPoint[];
  height?: number;
  threshold?: number;
  thresholdLabel?: string;
}

export function BalanceAreaChart({ points, height = 160, threshold, thresholdLabel }: BalanceAreaChartProps) {
  const path = useMemo(() => buildAreaPath(points, 320, height), [points, height]);
  const thresholdY = threshold === undefined ? null : yForValue(threshold, points, height);

  return (
    <View style={[styles.chartFrame, { height }]}>
      <Svg width="100%" height={height} viewBox={`0 0 320 ${height}`}>
        <Defs>
          <LinearGradient id="budgetIncomeFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={b.chart.incomeFill} />
            <Stop offset="1" stopColor={b.chart.incomeFillTransparent} />
          </LinearGradient>
        </Defs>
        <Path d={path.area} fill="url(#budgetIncomeFill)" />
        <Path d={path.line} stroke={b.chart.incomeLine} strokeWidth={3} fill="none" />
        {thresholdY !== null ? (
          <Line x1={12} x2={308} y1={thresholdY} y2={thresholdY} stroke={b.status.danger} strokeWidth={1.5} strokeDasharray="6 6" />
        ) : null}
      </Svg>
      {thresholdLabel ? <Text style={styles.thresholdLabel}>{thresholdLabel}</Text> : null}
    </View>
  );
}

export interface StackedCategoryBarsProps {
  bars: CategoryBar[];
  height?: number;
}

export function StackedCategoryBars({ bars, height = 160 }: StackedCategoryBarsProps) {
  const maxTotal = Math.max(1, ...bars.map((bar) => bar.segments.reduce((sum, segment) => sum + segment.value, 0)));
  return (
    <View style={[styles.stackedBars, { height }]}>
      {bars.map((bar) => {
        const total = bar.segments.reduce((sum, segment) => sum + segment.value, 0);
        return (
          <View key={bar.label} style={styles.barColumn}>
            <View style={styles.barTrack}>
              <Svg width="100%" height="100%" viewBox="0 0 32 120">
                {bar.segments.reduce<{ y: number; nodes: ReactNode[] }>(
                  (acc, segment) => {
                    const segmentHeight = (segment.value / maxTotal) * 112;
                    const y = 116 - acc.y - segmentHeight;
                    acc.nodes.push(
                      <Rect key={segment.key} x={7} y={y} width={18} height={Math.max(3, segmentHeight)} rx={br.barSm} fill={segment.color} />
                    );
                    acc.y += segmentHeight;
                    return acc;
                  },
                  { y: 0, nodes: [] }
                ).nodes}
              </Svg>
            </View>
            <Text style={[styles.periodText, total === 0 && styles.disabledText]}>{bar.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export interface CategorySummaryRowProps {
  color: string;
  label: string;
  metadata: string;
  amount: string;
  progress: number;
  onPress?: () => void;
}

export function CategorySummaryRow({ color, label, metadata, amount, progress, onPress }: CategorySummaryRowProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.categoryRow, pressed && styles.pressed]}>
      <View style={[styles.categoryDot, { backgroundColor: color }]} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.rowMeta}>{metadata}</Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, progress)) * 100}%`, backgroundColor: color }]} />
        </View>
      </View>
      <Text style={styles.balanceText}>{amount}</Text>
    </Pressable>
  );
}

export interface InlineAlertEditorProps {
  condition: 'more-than' | 'less-than';
  amount: string;
  pushEnabled: boolean;
  emailEnabled: boolean;
  onConditionChange?: (condition: 'more-than' | 'less-than') => void;
  onAmountChange?: (amount: string) => void;
  onPushChange?: (enabled: boolean) => void;
  onEmailChange?: (enabled: boolean) => void;
  onSave?: () => void;
  onCancel?: () => void;
}

export function InlineAlertEditor({
  condition,
  amount,
  pushEnabled,
  emailEnabled,
  onConditionChange,
  onAmountChange,
  onPushChange,
  onEmailChange,
  onSave,
  onCancel
}: InlineAlertEditorProps) {
  return (
    <MetricPanel title="Balance alert">
      <View style={styles.conditionRow}>
        {[
          ['more-than', 'More than'],
          ['less-than', 'Less than']
        ].map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => onConditionChange?.(key as 'more-than' | 'less-than')}
            style={[styles.conditionButton, condition === key && styles.conditionButtonActive]}
          >
            <Text style={[styles.periodText, condition === key && styles.periodTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={amount}
        onChangeText={onAmountChange}
        keyboardType="decimal-pad"
        placeholder="$0.00"
        placeholderTextColor={b.text.disabled}
        style={styles.amountInput}
      />
      <ToggleRow label="Push" selected={pushEnabled} onChange={onPushChange} />
      <ToggleRow label="Email" selected={emailEnabled} onChange={onEmailChange} />
      <View style={styles.editorActions}>
        <Pressable onPress={onCancel} style={styles.secondaryAction}>
          <Text style={styles.secondaryActionText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={onSave} style={styles.primaryAction}>
          <Text style={styles.primaryActionText}>Save</Text>
        </Pressable>
      </View>
    </MetricPanel>
  );
}

export interface ToggleRowProps {
  label: string;
  detail?: string;
  selected: boolean;
  onChange?: (selected: boolean) => void;
}

export function ToggleRow({ label, detail, selected, onChange }: ToggleRowProps) {
  return (
    <Pressable onPress={() => onChange?.(!selected)} style={styles.toggleRow}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        {detail ? <Text style={styles.rowMeta}>{detail}</Text> : null}
      </View>
      <View style={[styles.toggleControl, selected && styles.toggleControlSelected]}>
        <View style={[styles.toggleKnob, selected && styles.toggleKnobSelected]} />
      </View>
    </Pressable>
  );
}

export interface CategoryOptionRowProps {
  color: string;
  label: string;
  detail?: string;
  selected?: boolean;
  onPress?: () => void;
}

export function CategoryOptionRow({ color, label, detail, selected, onPress }: CategoryOptionRowProps) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.categoryOption, selected && styles.categoryOptionSelected, pressed && styles.pressed]}>
      <View style={[styles.categoryDot, { backgroundColor: color }]} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        {detail ? <Text style={styles.rowMeta}>{detail}</Text> : null}
      </View>
      {selected ? <Text style={styles.checkmark}>✓</Text> : null}
    </Pressable>
  );
}

export interface BottomSheetProps {
  visible: boolean;
  title?: string;
  subtitle?: string;
  detailRows?: DetailRow[];
  children?: ReactNode;
  onDismiss?: () => void;
}

export function BottomSheet({ visible, title, subtitle, detailRows = [], children, onDismiss }: BottomSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable style={styles.sheetScrim} onPress={onDismiss} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
        {detailRows.map((row) => (
          <View key={row.label} style={styles.detailRow}>
            <Text style={styles.detailLabel}>{row.label}</Text>
            <Text style={styles.detailValue}>{row.value}</Text>
          </View>
        ))}
        {children}
      </View>
    </Modal>
  );
}

export interface NativeConfirmDialogAdapterProps {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function NativeConfirmDialogAdapter({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm
}: NativeConfirmDialogAdapterProps) {
  return {
    confirm: () =>
      Alert.alert(title, message, [
        { text: cancelLabel, style: 'cancel' },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm }
      ])
  };
}

function InitialTile({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.initialTile, { backgroundColor: color }]}>
      <Text style={styles.initialTileText}>{label}</Text>
    </View>
  );
}

function buildAreaPath(points: ChartPoint[], width: number, height: number) {
  if (points.length === 0) return { line: '', area: '' };
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = Math.max(1, max - min);
  const step = (width - 24) / Math.max(1, points.length - 1);
  const coords = points.map((point, index) => ({
    x: 12 + index * step,
    y: 12 + (1 - (point.value - min) / span) * (height - 28)
  }));
  const line = coords.map((coord, index) => `${index === 0 ? 'M' : 'L'} ${coord.x} ${coord.y}`).join(' ');
  const last = coords[coords.length - 1];
  const first = coords[0];
  return {
    line,
    area: `${line} L ${last.x} ${height - 8} L ${first.x} ${height - 8} Z`
  };
}

function yForValue(value: number, points: ChartPoint[], height: number) {
  if (points.length === 0) return height / 2;
  const min = Math.min(...points.map((point) => point.value), value);
  const max = Math.max(...points.map((point) => point.value), value);
  const span = Math.max(1, max - min);
  return 12 + (1 - (value - min) / span) * (height - 28);
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: b.surface.app
  },
  screenScrollContent: {
    paddingBottom: tokens.platform.mobile.tabBar.height + bs[6]
  },
  screenContent: {
    gap: bs[4],
    padding: bs[4]
  },
  screenFooter: {
    position: 'absolute',
    left: bs[4],
    right: bs[4],
    bottom: bs[4]
  },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center'
  },
  headerSide: {
    width: 54,
    alignItems: 'flex-start'
  },
  headerRight: {
    alignItems: 'flex-end'
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    gap: bs[1]
  },
  headerTitle: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 21,
    fontWeight: '700'
  },
  headerSubtitle: {
    color: b.text.muted,
    fontFamily: fonts.ui,
    fontSize: 13
  },
  iconButton: {
    width: hitTarget,
    height: hitTarget,
    borderRadius: br.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: b.surface.elevated,
    borderWidth: 1,
    borderColor: b.border.default
  },
  iconButtonSelected: {
    backgroundColor: b.surface.strong,
    borderColor: b.border.selected
  },
  iconButtonText: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 22,
    fontWeight: '700'
  },
  destructiveText: {
    color: b.status.iosDanger
  },
  tabBar: {
    height: tokens.platform.mobile.tabBar.height,
    padding: bs[1],
    borderRadius: br.nav,
    flexDirection: 'row',
    backgroundColor: b.surface.card,
    borderWidth: 1,
    borderColor: b.border.default,
    gap: bs[1]
  },
  tabSegment: {
    flex: 1,
    borderRadius: br.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tabSegmentActive: {
    backgroundColor: b.surface.control
  },
  tabLabel: {
    color: b.text.muted,
    fontFamily: fonts.ui,
    fontSize: 11,
    fontWeight: '700'
  },
  tabLabelActive: {
    color: b.text.inverse
  },
  row: {
    minHeight: 72,
    borderRadius: br.row,
    padding: bs[3],
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: b.surface.row,
    borderWidth: 1,
    borderColor: b.border.default,
    gap: bs[3]
  },
  initialTile: {
    width: 48,
    height: 48,
    borderRadius: br.avatar,
    alignItems: 'center',
    justifyContent: 'center'
  },
  initialTileText: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 18,
    fontWeight: '800'
  },
  rowBody: {
    flex: 1,
    gap: bs[1]
  },
  rowTitle: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 15,
    fontWeight: '700'
  },
  rowMeta: {
    color: b.text.muted,
    fontFamily: fonts.ui,
    fontSize: 12
  },
  balanceText: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 15,
    fontWeight: '700'
  },
  amountText: {
    fontFamily: fonts.ui,
    fontSize: 15,
    fontWeight: '700'
  },
  incomeText: {
    color: b.status.income
  },
  expenseText: {
    color: b.status.danger
  },
  metricPanel: {
    borderRadius: br.panel,
    padding: bs[4],
    backgroundColor: b.surface.card,
    borderWidth: 1,
    borderColor: b.border.default,
    gap: bs[3]
  },
  panelHeader: {
    gap: bs[1]
  },
  panelTitle: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 16,
    fontWeight: '800'
  },
  panelSubtitle: {
    color: b.text.secondary,
    fontFamily: fonts.ui,
    fontSize: 12
  },
  periodSelector: {
    flexDirection: 'row',
    borderRadius: br.chip,
    backgroundColor: b.surface.inset,
    padding: bs[1],
    gap: bs[1]
  },
  periodSegment: {
    flex: 1,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: br.segment
  },
  periodSegmentActive: {
    backgroundColor: b.surface.strong
  },
  periodText: {
    color: b.text.muted,
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: '700'
  },
  periodTextActive: {
    color: b.text.primary
  },
  chartFrame: {
    overflow: 'hidden',
    borderRadius: br.panel
  },
  thresholdLabel: {
    position: 'absolute',
    right: bs[2],
    top: bs[2],
    color: b.status.danger,
    fontFamily: fonts.ui,
    fontSize: 11,
    fontWeight: '700'
  },
  stackedBars: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: bs[2]
  },
  barColumn: {
    flex: 1,
    alignItems: 'center',
    gap: bs[2]
  },
  barTrack: {
    height: '85%',
    width: '100%',
    borderRadius: br.bar,
    backgroundColor: b.surface.inset,
    overflow: 'hidden'
  },
  categoryRow: {
    borderRadius: br.row,
    padding: bs[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: bs[3],
    backgroundColor: b.surface.row,
    borderWidth: 1,
    borderColor: b.border.default
  },
  categoryDot: {
    width: 12,
    height: 12,
    borderRadius: 6
  },
  progressTrack: {
    marginTop: bs[2],
    height: 7,
    borderRadius: br.progress,
    backgroundColor: b.surface.strong,
    overflow: 'hidden'
  },
  progressFill: {
    height: 7,
    borderRadius: br.progress
  },
  conditionRow: {
    flexDirection: 'row',
    gap: bs[2]
  },
  conditionButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: br.chip,
    backgroundColor: b.surface.inset
  },
  conditionButtonActive: {
    backgroundColor: b.surface.strong
  },
  amountInput: {
    minHeight: 50,
    borderRadius: br.cardSm,
    paddingHorizontal: bs[4],
    color: b.text.primary,
    backgroundColor: b.surface.inset,
    borderWidth: 1,
    borderColor: b.border.default,
    fontFamily: fonts.ui,
    fontSize: 20,
    fontWeight: '700'
  },
  editorActions: {
    flexDirection: 'row',
    gap: bs[2]
  },
  primaryAction: {
    flex: 1,
    minHeight: hitTarget,
    borderRadius: br.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.brand
  },
  primaryActionText: {
    color: colors.ink950,
    fontFamily: fonts.ui,
    fontWeight: '800'
  },
  secondaryAction: {
    flex: 1,
    minHeight: hitTarget,
    borderRadius: br.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: b.surface.strong
  },
  secondaryActionText: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontWeight: '800'
  },
  toggleRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: bs[3]
  },
  toggleControl: {
    width: 52,
    height: 30,
    borderRadius: br.chip,
    padding: 3,
    backgroundColor: b.surface.strong
  },
  toggleControlSelected: {
    backgroundColor: b.status.success
  },
  toggleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: b.text.primary
  },
  toggleKnobSelected: {
    transform: [{ translateX: 22 }]
  },
  categoryOption: {
    minHeight: 58,
    borderRadius: br.row,
    padding: bs[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: bs[3],
    backgroundColor: b.surface.row,
    borderWidth: 1,
    borderColor: b.border.default
  },
  categoryOptionSelected: {
    borderColor: b.border.selected,
    backgroundColor: b.surface.strong
  },
  checkmark: {
    color: b.status.success,
    fontFamily: fonts.ui,
    fontSize: 18,
    fontWeight: '800'
  },
  sheetScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: b.overlay.sheet
  },
  sheet: {
    marginTop: 'auto',
    borderTopLeftRadius: br.sheet,
    borderTopRightRadius: br.sheet,
    padding: bs[5],
    paddingBottom: bs[6],
    backgroundColor: b.surface.modal,
    gap: bs[3]
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 42,
    height: 5,
    borderRadius: br.handle,
    backgroundColor: b.border.ios
  },
  sheetTitle: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 20,
    fontWeight: '800'
  },
  detailRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: b.border.subtle
  },
  detailLabel: {
    color: b.text.muted,
    fontFamily: fonts.ui,
    fontSize: 13
  },
  detailValue: {
    color: b.text.primary,
    fontFamily: fonts.ui,
    fontSize: 13,
    fontWeight: '700'
  },
  pressed: {
    opacity: 0.82
  },
  disabled: {
    opacity: 0.5
  },
  disabledText: {
    color: b.text.disabled
  }
});
