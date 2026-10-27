import { Pressable, PlatformColor, ScrollView, StyleSheet, Text } from 'react-native';

const KEYS = ['⇥', '{', '}', '(', ')', '[', ']', ';', '=', '=>', "'", '"', '`', '.', ',', ':', '!', '&&', '||', '+', '-', '*', '/', '<', '>', 'await ', 'const '];

/** Row of code symbols shown above the keyboard. */
export function KeyBar({ onKey, onHide }: { onKey: (text: string) => void; onHide: () => void }) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.content}>
      {KEYS.map((k) => (
        <Pressable key={k} onPress={() => onKey(k === '⇥' ? '  ' : k)} style={({ pressed }) => [styles.key, pressed && styles.pressed]}>
          <Text style={styles.label}>{k.trim()}</Text>
        </Pressable>
      ))}
      <Pressable onPress={onHide} style={({ pressed }) => [styles.key, pressed && styles.pressed]}>
        <Text style={styles.label}>⌄</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
    backgroundColor: PlatformColor('secondarySystemBackground'),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PlatformColor('separator'),
  },
  content: { paddingHorizontal: 6, paddingVertical: 6, gap: 6 },
  key: {
    minWidth: 40,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PlatformColor('tertiarySystemBackground'),
  },
  pressed: { opacity: 0.5 },
  label: { fontFamily: 'Menlo', fontSize: 16, color: PlatformColor('label') },
});
