import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors, fonts, radius, space } from '@sindustries/design-tokens/tokens';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TokenSpecimen'>;

const swatches = [
  ['Canvas', colors.bgCanvas],
  ['Surface', colors.bgSurface],
  ['Primary text', colors.textPrimary],
  ['Muted text', colors.textMuted],
  ['Brand', colors.brand],
  ['Success', colors.success],
  ['Danger', colors.danger],
  ['Sage', colors.sage],
  ['Accent pink', colors.accentPink]
] as const;

const labelSwatches = [
  ['Green', colors.labels.green],
  ['Blue', colors.labels.blue],
  ['Orange', colors.labels.orange],
  ['Purple', colors.labels.purple],
  ['Gray', colors.labels.gray]
] as const;

const radiusEntries = Object.entries(radius);
const spaceEntries = Object.entries(space);

export function TokenSpecimenScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + space[4],
          paddingBottom: insets.bottom + space[8],
          paddingLeft: insets.left + space[4],
          paddingRight: insets.right + space[4]
        }
      ]}
    >
      <Pressable onPress={() => navigation.goBack()} style={styles.backButton}>
        <Text style={styles.backLabel}>Back</Text>
      </Pressable>

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Design tokens</Text>
        <Text style={styles.title}>React Native token specimen</Text>
        <Text style={styles.body}>
          This screen imports values from @sindustries/design-tokens/tokens.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Color</Text>
        <View style={styles.swatchGrid}>
          {swatches.map(([label, value]) => (
            <View key={label} style={styles.swatchCard}>
              <View style={[styles.swatch, { backgroundColor: value }]} />
              <Text style={styles.swatchLabel}>{label}</Text>
              <Text style={styles.code}>{value}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Color Labels</Text>
        <View style={styles.swatchGrid}>
          {labelSwatches.map(([label, value]) => (
            <View key={label} style={styles.swatchCard}>
              <View style={[styles.swatch, { backgroundColor: value }]} />
              <Text style={styles.swatchLabel}>{label}</Text>
              <Text style={styles.code}>{value}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Typography</Text>
        <Text style={styles.displayText}>Display face</Text>
        <Text style={styles.uiText}>UI label and controls</Text>
        <Text style={styles.body}>Body copy for longer readable text.</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Space</Text>
        <View style={styles.spaceRow}>
          {spaceEntries.map(([key, value]) => (
            <View key={key} style={styles.spaceItem}>
              <View style={[styles.spaceBar, { width: value }]} />
              <Text style={styles.code}>{key}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Radius</Text>
        <View style={styles.radiusGrid}>
          {radiusEntries.map(([key, value]) => (
            <View key={key} style={[styles.radiusTile, { borderRadius: value }]}>
              <Text style={styles.radiusLabel}>{key}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.componentRow}>
        <View style={styles.miniCard}>
          <Text style={styles.cardTitle}>Budget card</Text>
          <Text style={styles.body}>Shared surface, text, spacing, radius, and chart colors.</Text>
        </View>
        <Pressable style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Primary action</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgCanvas
  },
  content: {
    gap: space[4]
  },
  backButton: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center'
  },
  backLabel: {
    color: colors.info,
    fontFamily: fonts.ui,
    fontSize: 17
  },
  hero: {
    gap: space[2],
    padding: space[5],
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    backgroundColor: colors.bgSurface
  },
  eyebrow: {
    color: colors.brand,
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase'
  },
  title: {
    color: colors.textPrimary,
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 38
  },
  body: {
    color: colors.textSecondary,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 22
  },
  section: {
    gap: space[3],
    padding: space[4],
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    backgroundColor: colors.bgSurface
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: 18,
    fontWeight: '800'
  },
  swatchGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3]
  },
  swatchCard: {
    width: '47%',
    gap: space[2]
  },
  swatch: {
    height: 60,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md
  },
  swatchLabel: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: 13,
    fontWeight: '800'
  },
  code: {
    color: colors.textMuted,
    fontFamily: fonts.ui,
    fontSize: 11
  },
  displayText: {
    color: colors.textPrimary,
    fontFamily: fonts.display,
    fontSize: 30
  },
  uiText: {
    color: colors.brand,
    fontFamily: fonts.ui,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase'
  },
  spaceRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space[3]
  },
  spaceItem: {
    alignItems: 'center',
    gap: space[2]
  },
  spaceBar: {
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.brand
  },
  radiusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[3]
  },
  radiusTile: {
    width: '30%',
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 212, 255, 0.12)'
  },
  radiusLabel: {
    color: colors.info,
    fontFamily: fonts.ui,
    fontWeight: '800'
  },
  componentRow: {
    gap: space[3]
  },
  miniCard: {
    gap: space[2],
    padding: space[4],
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    backgroundColor: colors.bgSurface
  },
  cardTitle: {
    color: colors.textPrimary,
    fontFamily: fonts.ui,
    fontSize: 17,
    fontWeight: '800'
  },
  primaryButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.brand
  },
  primaryButtonText: {
    color: colors.ink950,
    fontFamily: fonts.ui,
    fontSize: 15,
    fontWeight: '800'
  }
});
