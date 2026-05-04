import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Props = {
  title: string;
  onBack?: () => void;
  headerNote?: React.ReactNode;
  children: React.ReactNode;
};

export function StackScreenLayout({ title, onBack, headerNote, children }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 6,
            paddingBottom: 10,
            paddingLeft: 16 + insets.left,
            paddingRight: 16 + insets.right
          }
        ]}
      >
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={{ top: 10, bottom: 10, left: 4, right: 24 }}
            style={({ pressed }) => [styles.backWrap, pressed && styles.backPressed]}
          >
            <Text style={styles.backLabel}>Back</Text>
          </Pressable>
        ) : null}
        <Text style={styles.title}>{title}</Text>
        {headerNote ? <View style={styles.noteWrap}>{headerNote}</View> : null}
      </View>
      <View
        style={[
          styles.body,
          {
            paddingLeft: 16 + insets.left,
            paddingRight: 16 + insets.right,
            paddingBottom: 12 + insets.bottom
          }
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { gap: 6 },
  backWrap: { alignSelf: 'flex-start', paddingVertical: 2 },
  backPressed: { opacity: 0.55 },
  backLabel: { fontSize: 17, fontWeight: '400', color: '#007AFF' },
  title: { fontSize: 22, fontWeight: '700' },
  noteWrap: { marginTop: 2 },
  body: { flex: 1, gap: 12, paddingTop: 4 }
});
