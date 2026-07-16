import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { tokens } from '@sindustries/design-tokens/tokens';

import { formatUpdateShortId, getCurrentUpdateInfo } from '../updateInfo';

const budget = tokens.budget;
const b = budget.color;
const bs = budget.space;

export function UpdateBanner() {
  const updateInfo = getCurrentUpdateInfo();
  const shortId = formatUpdateShortId(updateInfo.updateId);
  const runtime = updateInfo.runtimeVersion ?? 'runtime unknown';
  const channel = updateInfo.channel ?? 'no channel';

  return (
    <View accessibilityRole="summary" accessibilityLabel="Build and update identifier" style={styles.banner}>
      <Text style={styles.label}>Build</Text>
      <Text style={styles.value} numberOfLines={1}>
        {shortId} · {runtime} · {channel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: bs[2],
    paddingHorizontal: bs[3],
    paddingVertical: bs[2],
    backgroundColor: b.surface.inset,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: b.border.default
  },
  label: {
    color: b.text.muted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase'
  },
  value: {
    flex: 1,
    color: b.text.secondary,
    fontSize: 12,
    fontWeight: '700'
  }
});
