import { Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { startPip, startPythonLine, startRun, stopRun, useRun, whenDone } from '@/lib/runner';
import { readScript } from '@/lib/scripts';
import { colors, radius, spacing, type } from '@/theme';

// A terminal for Python: pip, a REPL whose variables last while the screen is open, and a few
// file commands on Documents. iOS runs no processes, so these are all built in.

type Entry = { id: number; command: string; prompt: string; runId?: string; text?: string; error?: boolean };

const HELP = `Comandos:
  pip install paquete     instala desde PyPI (queda instalado para los scripts .py)
  pip list | uninstall | show | freeze
  python archivo.py [args]  ejecuta un script (sys.argv lleva los args)
  ls [carpeta]   cd carpeta   pwd   cat archivo
  cp origen destino   mv origen destino   rm ruta   mkdir carpeta   touch archivo
  clear          limpia la pantalla
Lo demás se ejecuta como Python: x = 2, import numpy as np, await Device.info()…
Un ! delante fuerza un comando (!ls) si el nombre choca con una variable.`;

const SHELL = new Set(['ls', 'cd', 'pwd', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'clear', 'help', 'pip', 'python', 'python3']);

/** Splits a command line into words; quotes keep spaces. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** A shell command, or null for a Python line. `cat = 2` or `pwd()` stay Python. */
function asCommand(line: string): string[] | null {
  const forced = line.startsWith('!');
  const parts = words(forced ? line.slice(1) : line);
  if (!parts.length) return null;
  if (forced) return parts;
  if (!SHELL.has(parts[0]) || /^\s*\w+(\s*(=(?!=)|[-+*/%]=|:)|[(.[])/.test(line)) return null;
  return parts;
}

/** `to` from the folder `cwd`, both relative to Documents ("" is Documents itself). */
function join(cwd: string, to: string): string {
  if (to.startsWith('/')) return to;
  const parts = to === '~' || to.startsWith('~/') ? [] : cwd.split('/').filter(Boolean);
  for (const part of to.replace(/^~\/?/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

// File commands run as a tiny JavaScript script, so they use the same FS as every script.
function fileScript(command: string, paths: string[]): string | null {
  const [a, b] = paths.map((p) => JSON.stringify(p));
  const into = `const to = FS.isDir(${b}) ? FS.join(${b}, ${a}.split('/').pop()) : ${b};`;
  switch (command) {
    case 'ls':
      return `for (const n of FS.list(${a})) console.log(FS.isDir(${a} ? ${a} + '/' + n : n) ? n + '/' : n);`;
    case 'cd':
      return `if (!FS.isDir(${a})) throw new Error('No es una carpeta: ' + (${a} || '~'));`;
    case 'cat':
      return `console.log(FS.readText(${a}));`;
    case 'cp':
      return `${into} FS.copy(${a}, to);`;
    case 'mv':
      return `${into} FS.move(${a}, to);`;
    case 'rm':
      return `if (!FS.exists(${a})) throw new Error('No existe: ' + ${a}); FS.remove(${a});`;
    case 'mkdir':
      return `FS.mkdir(${a});`;
    case 'touch':
      return `if (!FS.exists(${a})) FS.writeText(${a}, '');`;
    default:
      return null;
  }
}

const ARGS: Record<string, number> = { cat: 1, cp: 2, mv: 2, rm: 1, mkdir: 1, touch: 1 };

export default function TerminalScreen() {
  const [entries, setEntries] = useState<Entry[]>([{ id: 0, command: '', prompt: '', text: 'Python de Scriptor. Escribe help para ver los comandos.' }]);
  const [line, setLine] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const back = useRef(0);
  const nextId = useRef(1);
  const list = useRef<FlatList<Entry>>(null);
  // One Python session per opened terminal: its variables last until the screen closes.
  const [session] = useState(() => `terminal-${Date.now()}`);
  const insets = useSafeAreaInsets();
  const running = useRun(busy);

  const add = (entry: Omit<Entry, 'id'>) => setEntries((all) => [...all, { ...entry, id: nextId.current++ }]);

  const follow = async (entry: Omit<Entry, 'id' | 'runId'>, runId: string) => {
    add({ ...entry, runId });
    setBusy(runId);
    const done = await whenDone(runId);
    setBusy((id) => (id === runId ? null : id));
    return done;
  };

  const submit = async () => {
    const code = line.trimEnd();
    if (!code.trim() || busy) return;
    setLine('');
    history.current.push(code);
    back.current = 0;
    const prompt = asCommand(code) ? `${cwd ? `~/${cwd}` : '~'} $` : '>>>';
    const parts = asCommand(code);

    if (!parts) return void follow({ command: code, prompt }, startPythonLine(session, code));

    const [command, ...rest] = parts;
    if (command === 'clear') return setEntries([]);
    if (command === 'help') return add({ command: code, prompt, text: HELP });
    if (command === 'pwd') return add({ command: code, prompt, text: cwd ? `~/${cwd}` : '~' });
    if (command === 'pip') return void follow({ command: code, prompt }, startPip(rest));
    if (command === 'python' || command === 'python3') {
      if (!rest.length) return add({ command: code, prompt, text: 'Escribe el código aquí mismo, o python archivo.py para ejecutar un script.' });
      const file = join(cwd, rest[0]);
      let source: string;
      try {
        source = readScript(file);
      } catch {
        return add({ command: code, prompt, text: `No existe ${rest[0]}`, error: true });
      }
      return void follow({ command: code, prompt }, startRun(file, source, { argv: [rest[0], ...rest.slice(1)] }));
    }

    // Flags (ls -la, rm -r) change nothing here: rm and cp already work on whole folders.
    const names = rest.filter((word) => !word.startsWith('-'));
    if ((ARGS[command] ?? 0) > names.length) return add({ command: code, prompt, text: `Faltan argumentos. Escribe help.`, error: true });
    const paths = command === 'ls' || command === 'cd' ? [join(cwd, names[0] ?? (command === 'cd' ? '~' : '.'))] : names.map((p) => join(cwd, p));
    const source = fileScript(command, paths)!;
    const done = await follow({ command: code, prompt }, startRun('terminal', source));
    if (command === 'cd' && done.status === 'done') setCwd(paths[0]);
  };

  // ↑ and ↓ walk the history, newest first.
  const recall = (step: number) => {
    const all = history.current;
    if (!all.length) return;
    back.current = Math.max(0, Math.min(all.length, back.current + step));
    setLine(back.current === 0 ? '' : all[all.length - back.current]);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Terminal' }} />
      <Stack.Toolbar placement="right">
        {running?.status === 'running' ? (
          <Stack.Toolbar.Button icon="stop.fill" accessibilityLabel="Detener" tintColor={colors.danger} onPress={() => stopRun(busy!)} />
        ) : (
          <Stack.Toolbar.Button icon="trash" accessibilityLabel="Limpiar" onPress={() => setEntries([])} />
        )}
      </Stack.Toolbar>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <FlatList
          ref={list}
          style={styles.flex}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          data={entries}
          keyExtractor={(e) => String(e.id)}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => <TerminalEntry entry={item} />}
        />
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Comando anterior" hitSlop={6} onPress={() => recall(1)}>
            <SymbolView name="chevron.up" size={18} tintColor={colors.secondaryLabel} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Comando siguiente" hitSlop={6} onPress={() => recall(-1)}>
            <SymbolView name="chevron.down" size={18} tintColor={colors.secondaryLabel} />
          </Pressable>
          <TextInput
            style={[type.code, styles.input]}
            value={line}
            onChangeText={setLine}
            onSubmitEditing={submit}
            // Return runs the line; pasted code keeps its line breaks.
            multiline
            submitBehavior="submit"
            returnKeyType="go"
            placeholder={busy ? 'Ejecutando…' : 'pip install …, código Python o help'}
            placeholderTextColor={colors.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            autoFocus
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Ejecutar" disabled={!!busy} hitSlop={6} onPress={submit}>
            <SymbolView name="arrow.up.circle.fill" size={28} tintColor={busy ? colors.tertiaryLabel : colors.accent} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const levelColor = { log: colors.label, info: colors.accent, debug: colors.secondaryLabel, warn: colors.warning, error: colors.danger } as const;

/** A command and what it printed, live while it runs. */
function TerminalEntry({ entry }: { entry: Entry }) {
  const run = useRun(entry.runId ?? null);
  return (
    <View style={styles.entry}>
      {entry.command ? (
        <Text selectable style={type.code}>
          <Text style={styles.prompt}>{entry.prompt} </Text>
          {entry.command}
        </Text>
      ) : null}
      {entry.text ? <Text selectable style={[type.code, { color: entry.error ? colors.danger : colors.secondaryLabel }]}>{entry.text}</Text> : null}
      {run?.logs.map((log, i) => (
        <Text key={i} selectable style={[type.code, { color: levelColor[log.level] ?? colors.label }]}>
          {log.message}
        </Text>
      ))}
      {run?.error && run.error !== 'Stopped' ? <Text selectable style={[type.code, { color: colors.danger }]}>{run.error}</Text> : null}
      {run?.status === 'stopped' ? <Text style={[type.code, { color: colors.secondaryLabel }]}>Detenido. Las variables de la sesión se perdieron.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.md, gap: spacing.sm },
  entry: { gap: 2 },
  prompt: { color: colors.accent, fontWeight: '600' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.raised,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    color: colors.label,
    backgroundColor: colors.fill,
  },
});
