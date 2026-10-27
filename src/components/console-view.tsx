import { useEffect, useRef } from 'react';
import { FlatList, PlatformColor, StyleSheet, Text, View } from 'react-native';

import type { LogEntry } from '../../modules/script-engine';
import type { RunState } from '@/lib/runner';

const levelColor = {
  log: PlatformColor('label'),
  info: PlatformColor('systemBlue'),
  debug: PlatformColor('secondaryLabel'),
  warn: PlatformColor('systemOrange'),
  error: PlatformColor('systemRed'),
} as const;

const statusText = {
  running: 'Ejecutando…',
  done: 'Terminado',
  error: 'Error',
  stopped: 'Detenido',
} as const;

export function ConsoleView({ run }: { run: RunState | undefined }) {
  const list = useRef<FlatList<LogEntry>>(null);
  const count = run?.logs.length ?? 0;

  useEffect(() => {
    if (count > 0) list.current?.scrollToEnd({ animated: false });
  }, [count]);

  if (!run) {
    return (
      <View style={styles.empty}>
        <Text style={styles.muted}>Pulsa ▶︎ para ejecutar el script.</Text>
      </View>
    );
  }

  const seconds = run.endedAt ? ((run.endedAt - run.startedAt) / 1000).toFixed(2) : '';
  const footer =
    run.status === 'running'
      ? statusText.running
      : `${statusText[run.status]} en ${seconds} s${run.result ? ` · ← ${run.result}` : ''}`;

  return (
    <FlatList
      ref={list}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={run.logs}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item }: { item: LogEntry }) => (
        <Text selectable style={[styles.line, { color: levelColor[item.level as keyof typeof levelColor] ?? levelColor.log }]}>
          {item.message}
        </Text>
      )}
      ListFooterComponent={
        <Text style={[styles.footer, run.status === 'error' && { color: levelColor.error }]}>{footer}</Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: PlatformColor('secondarySystemBackground') },
  content: { padding: 12, gap: 4 },
  line: { fontFamily: 'Menlo', fontSize: 12.5, lineHeight: 18 },
  footer: { fontSize: 12, color: PlatformColor('secondaryLabel'), marginTop: 8 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PlatformColor('secondarySystemBackground'),
  },
  muted: { color: PlatformColor('secondaryLabel'), fontSize: 14 },
});
