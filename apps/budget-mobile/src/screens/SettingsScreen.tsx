import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Updates from 'expo-updates';
import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tokens } from '@sindustries/design-tokens/tokens';

import type { RootStackParamList } from '../navigation/types';
import {
  formatUpdateShortId,
  formatUpdateTimestamp,
  getCurrentUpdateInfo,
  type UpdateInfo
} from '../updateInfo';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const budget = tokens.budget;
const b = budget.color;
const bs = budget.space;

export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>(() => getCurrentUpdateInfo());
  const [checking, setChecking] = useState(false);

  async function handleCheckForUpdates() {
    setChecking(true);
    try {
      const result = await Updates.checkForUpdateAsync();
      setUpdateInfo(getCurrentUpdateInfo());
      Alert.alert(
        'Update check complete',
        result.isAvailable ? 'A compatible update is available and will be fetched by Expo.' : 'No compatible update is available.'
      );
    } catch (error: any) {
      Alert.alert('Could not check for updates', error?.message ?? 'Expo Updates is unavailable in this build.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + bs[4],
          paddingBottom: insets.bottom + bs[6],
          paddingLeft: insets.left + bs[4],
          paddingRight: insets.right + bs[4]
        }
      ]}
    >
      <Pressable accessibilityRole="button" onPress={() => navigation.goBack()} style={styles.backButton}>
        <Text style={styles.backLabel}>Back</Text>
      </Pressable>

      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Settings</Text>
        <Text style={styles.title}>Build & update</Text>
        <Text style={styles.body}>Use this screen to confirm the TestFlight build is receiving OTA updates from main.</Text>
      </View>

      <View style={styles.card}>
        <InfoRow label="Update ID" value={updateInfo.updateId ?? 'dev build / embedded'} />
        <InfoRow label="Short ID" value={formatUpdateShortId(updateInfo.updateId)} />
        <InfoRow label="Runtime version" value={updateInfo.runtimeVersion ?? 'unknown'} />
        <InfoRow label="Channel" value={updateInfo.channel ?? 'not bound'} />
        <InfoRow label="Created at" value={formatUpdateTimestamp(updateInfo.createdAt)} />
        <InfoRow label="Updates enabled" value={updateInfo.isEnabled ? 'yes' : 'no'} />
        <InfoRow label="Launch type" value={updateInfo.isEmbeddedLaunch ? 'embedded' : 'OTA update'} />
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={checking}
        onPress={handleCheckForUpdates}
        style={({ pressed }) => [styles.actionButton, pressed && styles.pressed, checking && styles.disabled]}
      >
        <Text style={styles.actionText}>{checking ? 'Checking…' : 'Check for updates'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: b.surface.app
  },
  content: {
    gap: bs[4]
  },
  backButton: {
    alignSelf: 'flex-start',
    minHeight: 36,
    justifyContent: 'center'
  },
  backLabel: {
    color: b.status.iosInfo,
    fontSize: 17,
    fontWeight: '700'
  },
  hero: {
    gap: bs[2],
    padding: bs[5],
    borderWidth: 1,
    borderColor: b.border.default,
    borderRadius: budget.radius.panel,
    backgroundColor: b.surface.card
  },
  eyebrow: {
    color: b.text.muted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase'
  },
  title: {
    color: b.text.primary,
    fontSize: 30,
    fontWeight: '800'
  },
  body: {
    color: b.text.secondary,
    fontSize: 15,
    lineHeight: 22
  },
  card: {
    gap: bs[3],
    padding: bs[4],
    borderWidth: 1,
    borderColor: b.border.default,
    borderRadius: budget.radius.panel,
    backgroundColor: b.surface.card
  },
  infoRow: {
    gap: bs[1]
  },
  infoLabel: {
    color: b.text.muted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase'
  },
  infoValue: {
    color: b.text.primary,
    fontSize: 15,
    fontWeight: '700'
  },
  actionButton: {
    minHeight: tokens.platform.mobile.hitTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: budget.radius.button,
    backgroundColor: b.surface.control
  },
  actionText: {
    color: b.text.inverse,
    fontSize: 16,
    fontWeight: '800'
  },
  pressed: {
    opacity: 0.82
  },
  disabled: {
    opacity: 0.6
  }
});
