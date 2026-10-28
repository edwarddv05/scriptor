import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';

import type { LogEntry } from '../../modules/script-engine';
import type { RunState } from '@/lib/runner';
import { colors, spacing, type } from '@/theme';

const levelColor = {
  log: colors.label,
  info: colors.accent,
  debug: colors.secondaryLabel,
  warn: colors.warning,
  error: colors.danger,
} as const;

const statusColor = {
  running: colors.accent,
  done: colors.success,
  error: colors.danger,
  stopped: colors.secondaryLabel,
} as const;

const seconds = new Intl.NumberFormat('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function statusText(run: RunState) {
  if (run.status === 'running') return 'Ejecutando…';
  const time = `${seconds.format(((run.endedAt ?? Date.now()) - run.startedAt) / 1000)} s`;
  if (run.status === 'done') return `Terminado en ${time}`;
  if (run.status === 'stopped') return `Detenido a los ${time}`;
  return `Error a los ${time}`;
}

/** Status line of a run: a colored dot, what happened and how long it took. */
export function RunStatus({ run, onClose }: { run: RunState | undefined; onClose?: () => void }) {
  return (
    <View style={styles.header}>
      <View style={[styles.dot, { backgroundColor: run ? statusColor[run.status] : colors.tertiaryLabel }]} />
      <Text style={[type.headline, styles.flex]} numberOfLines={1}>
        {run ? statusText(run) : 'Consola'}
      </Text>
      {onClose && (
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cerrar consola">
          <SymbolView name="xmark.circle.fill" size={22} tintColor={colors.tertiaryLabel} />
        </Pressable>
      )}
    </View>
  );
}

/** Log lines of a run, kept scrolled to the newest one. */
export function ConsoleView({ run, tint }: { run: RunState | undefined; tint?: ColorValue }) {
  const list = useRef<FlatList<LogEntry>>(null);
  const count = run?.logs.length ?? 0;

  useEffect(() => {
    if (count > 0) list.current?.scrollToEnd({ animated: false });
  }, [count]);

  if (!run) {
    return (
      <View style={styles.empty}>
        <SymbolView name="play.circle" size={28} tintColor={tint ?? colors.tertiaryLabel} />
        <Text style={[type.footnote, styles.center]}>Ejecuta el script para ver aquí lo que escribe con console.log.</Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={list}
      style={styles.flex}
      contentContainerStyle={styles.content}
      data={run.logs}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item }: { item: LogEntry }) => (
        <Text selectable style={[type.code, { color: levelColor[item.level] ?? levelColor.log }]}>
          {item.message}
        </Text>
      )}
      ListEmptyComponent={
        run.status === 'running' ? undefined : <Text style={type.footnote}>El script no escribió nada en la consola.</Text>
      }
      ListFooterComponent={
        run.result ? (
          <Text selectable style={[type.code, { color: colors.secondaryLabel }]}>← {run.result}</Text>
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  center: { textAlign: 'center', maxWidth: 260 },
});
