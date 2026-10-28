import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScriptEditor, type ScriptEditorRef } from '../../../modules/script-engine';
import { ConsoleView, RunStatus } from '@/components/console-view';
import { DocsList } from '@/components/docs-list';
import { COMPLETIONS } from '@/lib/api-docs';
import { startRun, stopRun, useRun } from '@/lib/runner';
import { listScripts } from '@/lib/scripts';
import { colorFor, colors, radius, scriptColors, spacing } from '@/theme';

const completions = COMPLETIONS.map(({ label, detail }) => ({ label, detail }));
const liquidGlass = isLiquidGlassAvailable();

type Panel = 'console' | 'docs' | null;

export default function EditorScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const editor = useRef<ScriptEditorRef>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [docsQuery, setDocsQuery] = useState('');
  const run = useRun(runId);
  const insets = useSafeAreaInsets();
  // The header is translucent and overlaps the screen; the side panel starts below it.
  const headerHeight = useHeaderHeight();
  const { width } = useWindowDimensions();
  // iPad (and wide split view) keeps the console or docs in a column beside the code.
  const wide = width >= 740;
  const running = run?.status === 'running';

  const tint = useMemo(() => {
    const script = listScripts().find((s) => s.name === name);
    return scriptColors[colorFor(script ?? { name })][1];
  }, [name]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const execute = async () => {
    const source = await editor.current?.save();
    if (source === undefined) return;
    if (!wide) editor.current?.blur();
    setPanel('console');
    setRunId(startRun(name, source));
  };

  const toggle = (p: Exclude<Panel, null>) => {
    if (p === 'docs' && !wide) return router.push('/docs');
    setPanel((current) => (current === p ? null : p));
  };

  const panelContent =
    panel === 'docs' ? (
      <DocsList
        query={docsQuery}
        header={
          <TextInput
            style={styles.search}
            placeholder="Buscar en la API"
            placeholderTextColor={colors.tertiaryLabel}
            value={docsQuery}
            onChangeText={setDocsQuery}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        }
      />
    ) : (
      <>
        <RunStatus run={run} onClose={() => setPanel(null)} />
        <ConsoleView run={run} tint={tint} />
      </>
    );

  return (
    <>
      <Stack.Screen options={{ title: name, headerLargeTitle: false }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="book"
          accessibilityLabel="Documentación"
          selected={panel === 'docs'}
          onPress={() => toggle('docs')}
        />
        <Stack.Toolbar.Button
          icon="text.alignleft"
          accessibilityLabel="Consola"
          selected={panel === 'console'}
          onPress={() => toggle('console')}
        />
        {running ? (
          <Stack.Toolbar.Button icon="stop.fill" accessibilityLabel="Detener" variant="prominent" tintColor={colors.danger} onPress={() => stopRun(runId!)} />
        ) : (
          <Stack.Toolbar.Button icon="play.fill" accessibilityLabel="Ejecutar" variant="prominent" tintColor={tint} onPress={execute} />
        )}
      </Stack.Toolbar>

      <View style={styles.row}>
        <ScriptEditor
          ref={editor}
          style={styles.flex}
          scriptName={name}
          completions={completions}
          tint={tint}
          onRunShortcut={execute}
        />
        {wide && panel && <View style={[styles.side, { paddingTop: headerHeight }]}>{panelContent}</View>}
      </View>

      {!wide && panel === 'console' && !keyboard && (
        <GlassView
          glassEffectStyle="regular"
          style={[styles.sheet, { bottom: Math.max(insets.bottom, spacing.sm) }, !liquidGlass && styles.sheetFallback]}>
          {panelContent}
        </GlassView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flex: 1, flexDirection: 'row', backgroundColor: colors.surface },
  side: {
    width: 360,
    backgroundColor: colors.raised,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.separator,
  },
  sheet: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    height: '42%',
    borderRadius: radius.panel,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  sheetFallback: {
    backgroundColor: colors.raised,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
  },
  search: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    paddingHorizontal: 12,
    height: 38,
    borderRadius: radius.sm,
    fontSize: 16,
    color: colors.label,
    backgroundColor: colors.fill,
  },
});
