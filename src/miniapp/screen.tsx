// Runs one .jsx/.tsx miniapp on the whole screen: only what the file draws. Shaking the
// iPhone opens Scriptor's menu to restart, edit, read the console or close it; the file's own
// close() also leaves. Errors replace the view until the file runs again.

import { BottomSheet, Button, Form, Group, Host, HStack, Image, LazyVStack, ProgressView, ScrollView, Section, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import * as SwiftUI from '@expo/ui/swift-ui';
import * as Modifiers from '@expo/ui/swift-ui/modifiers';
import { buttonStyle, controlSize, defaultScrollAnchor, font, foregroundStyle, frame, glassEffect, lineLimit, padding, presentationDetents, presentationDragIndicator, textSelection, tint } from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Accelerometer } from 'expo-sensors';
import React, { Component, Fragment, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PlatformColor } from 'react-native';

import { readScript } from '@/lib/scripts';

import { COMPONENTS, TEXT_TYPES, TintContext, prefetchImages } from './components';
import { listenAccelerometer, useAccelerometer, useAppState, useBarometer, useGyroscope, useHeading, useLocation } from './device';
import { createHost, type Host as ScriptorHost } from './host';
import { loadModules } from './modules';
import { LOOP_GUARD, MiniappError, appComponent, baseName, compileFile, createLoopGuard, evaluate, formatLog } from './runtime';

const liquidGlass = isLiquidGlassAvailable();
const red = PlatformColor('systemRed');
const secondary = PlatformColor('secondaryLabel');

// What a miniapp writes with console.*, kept outside React state so logging while drawing never redraws it.
type LogLevel = 'log' | 'info' | 'warn' | 'error';
type LogEntry = { id: number; level: LogLevel; text: string; time: number };
const MAX_LOGS = 500;

function createLogBook() {
  let entries: LogEntry[] = [];
  let next = 0;
  const listeners = new Set<() => void>();
  return {
    add(level: string, text: string) {
      const kind: LogLevel = level === 'warn' || level === 'error' || level === 'info' ? level : 'log';
      entries = [...entries.slice(-(MAX_LOGS - 1)), { id: next++, level: kind, text, time: Date.now() }];
      listeners.forEach((listener) => listener());
    },
    clear() {
      entries = [];
      listeners.forEach((listener) => listener());
    },
    get: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
type LogBook = ReturnType<typeof createLogBook>;

// Scriptor's API under the same names .js scripts use. Each call returns a Promise.
const API_ROOTS = ['FS', 'Net', 'Photos', 'Camera', 'Video', 'Audio', 'Speech', 'Pasteboard', 'Notify', 'Device', 'Keychain', 'Crypto', 'Location', 'Calendar', 'Contacts', 'Safari', 'Mail', 'Message', 'ShareSheet', 'QuickLook', 'Dictation', 'DocumentPicker', 'UI', 'Script'];
const RAW_MODIFIERS = { ...Modifiers };

type Runtime = { scope: Record<string, unknown>; modules: Record<string, unknown>; dispose: () => void };

function createRuntime(host: ScriptorHost, dataPath: string, data: Record<string, unknown>, input: Record<string, string>, report: (error: unknown) => void, close: () => void, logs: LogBook): Runtime {
  let disposed = false;
  const timers = new Map<ReturnType<typeof setTimeout>, 'timeout' | 'interval'>();

  // Event handlers and timers run guarded: a throw or a rejected promise becomes the error screen.
  const guard = <T extends (...args: never[]) => unknown>(fn: T) => (...args: Parameters<T>) => {
    if (disposed) return undefined;
    try {
      const result = fn(...args);
      if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, report);
      return result;
    } catch (error) {
      report(error);
      return undefined;
    }
  };

  // JSX lands here. Lowercase tags are refused and loose text inside a stack becomes a Text,
  // so SwiftUI always gets views.
  function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === 'string') throw new MiniappError(`<${type}> no es un componente. Usa <Text>, <VStack>…`);
    if (type === undefined || type === null) throw new MiniappError('Un componente del JSX no existe.');
    let next = props;
    if (props) {
      for (const key of Object.keys(props)) {
        if (/^on[A-Z]/.test(key) && typeof props[key] === 'function') {
          if (next === props) next = { ...props };
          next![key] = guard(props[key] as (...args: never[]) => unknown);
        }
      }
    }
    const kids = TEXT_TYPES.has(type) ? children : children.map((child) => (typeof child === 'string' || typeof child === 'number' ? React.createElement(COMPONENTS.Text, null, String(child)) : child));
    return React.createElement(type as React.ElementType, next, ...(kids as ReactNode[]));
  }

  // Stored values live in one JSON file per miniapp, written a moment after the last change.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  const flush = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    host.call('FS.writeText', [dataPath, JSON.stringify(data)]).catch((error) => logs.add('error', `No se pudieron guardar los datos: ${error.message}`));
  };
  const changed = () => {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  };
  const storage = {
    get: (key: string, fallback: unknown = null) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback),
    set: (key: string, value: unknown) => {
      if (value === undefined) delete data[String(key)];
      else data[String(key)] = JSON.parse(JSON.stringify(value));
      changed();
    },
    remove: (key: string) => {
      delete data[String(key)];
      changed();
    },
    keys: () => Object.keys(data),
    clear: () => {
      for (const key of Object.keys(data)) delete data[key];
      changed();
    },
  };

  function useStored<T>(key: string, initial: T) {
    const [value, setValue] = useState<T>(() => storage.get(key, initial) as T);
    const set = useCallback(
      (next: T | ((previous: T) => T)) => {
        setValue((previous) => {
          const resolved = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
          storage.set(key, resolved);
          return resolved;
        });
      },
      [key],
    );
    return [value, set] as const;
  }

  const startTimer = (kind: 'timeout' | 'interval') => (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const run = guard(fn);
    const id: ReturnType<typeof setTimeout> =
      kind === 'timeout'
        ? setTimeout(() => {
            timers.delete(id);
            run(...args);
          }, ms)
        : setInterval(() => run(...args), ms);
    timers.set(id, kind);
    return id;
  };
  const stopTimer = (id: ReturnType<typeof setTimeout>) => {
    const kind = timers.get(id);
    if (kind === 'interval') clearInterval(id);
    else if (kind) clearTimeout(id);
    timers.delete(id);
  };

  const write = (level: LogLevel) => (...args: unknown[]) => {
    if (!disposed) logs.add(level, formatLog(args));
  };
  const console = { log: write('log'), info: write('info'), debug: write('log'), warn: write('warn'), error: write('error'), clear: () => logs.clear() };

  const api: Record<string, unknown> = {};
  for (const root of API_ROOTS) api[root] = host.api(root);
  // `Video` is both the <Video> component and the API (Video.play, Video.info…).
  // Only the API's own names go to Scriptor, so React reading defaultProps or displayName sees the component.
  const videoApi = api.Video as Record<string, unknown>;
  const VIDEO_API = new Set(['play', 'info', 'thumbnail', 'export', 'extractAudio']);
  api.Video = new Proxy(COMPONENTS.Video, { get: (component, key) => (typeof key === 'string' && VIDEO_API.has(key) ? videoApi[key] : Reflect.get(component, key)) });
  const scope: Record<string, unknown> = {
    React, Fragment, h,
    useState, useEffect, useMemo, useRef, useCallback, useReducer, useContext, useStored,
    useLocation, useHeading, useAccelerometer, useGyroscope, useBarometer,
    // The change handler runs guarded, like an onPress: a throw becomes the error screen.
    useAppState: (onChange?: (state: string) => void) => useAppState(onChange && guard(onChange)),
    ...COMPONENTS,
    ...api,
    Scriptor: host.api(),
    storage, console,
    input: Object.freeze({ ...input }),
    alert: (message: unknown, title?: string) => host.call('alert', [String(message), title]),
    confirm: (message: unknown, title?: string) => host.call('confirm', [String(message), title]),
    prompt: (message: unknown, value = '', title?: string) => host.call('prompt', [String(message), value, title]),
    haptic: (kind = 'light') => host.call('UI.haptic', [kind]),
    prefetchImages,
    close: () => {
      if (!disposed) close();
    },
    setTimeout: startTimer('timeout'),
    setInterval: startTimer('interval'),
    clearTimeout: stopTimer,
    clearInterval: stopTimer,
    SwiftUI,
    modifiers: RAW_MODIFIERS,
    [LOOP_GUARD]: createLoopGuard(),
  };
  const modules = { scriptor: scope, react: React, '@expo/ui/swift-ui': SwiftUI, '@expo/ui/swift-ui/modifiers': RAW_MODIFIERS };

  return {
    scope,
    modules,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const id of [...timers.keys()]) stopTimer(id);
      // The last write is sent before the engine run stops; the engine runs both in order.
      flush();
      host.dispose();
    },
  };
}

type Failure = { message: string; line: number | null };

const describe = (error: unknown): Failure =>
  error instanceof MiniappError ? { message: error.message, line: error.line } : { message: error instanceof Error ? error.message : String(error), line: null };

class Boundary extends Component<{ onError: (error: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Calls `onShake` when the iPhone is shaken, while `enabled`. The accelerometer runs only then. */
function useShake(enabled: boolean, onShake: () => void) {
  const latest = useRef(onShake);
  useEffect(() => {
    latest.current = onShake;
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    // A shake is several strong jolts within a second; one bump counts once.
    let jolts: number[] = [];
    let quietUntil = 0;
    Accelerometer.isAvailableAsync().then(
      (available) => {
        if (!available || cancelled) return;
        // Shared with the miniapp's useAccelerometer, so neither changes the other's rate.
        stop = listenAccelerometer(50, ({ x, y, z }) => {
          const now = Date.now();
          if (now < quietUntil || Math.sqrt(x * x + y * y + z * z) < 2.2) return;
          if (jolts.length && now - jolts[jolts.length - 1] < 100) return;
          jolts = [...jolts.filter((time) => now - time <= 1000), now];
          if (jolts.length < 3) return;
          jolts = [];
          quietUntil = now + 1500;
          latest.current();
        });
      },
      () => {},
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [enabled]);
}

const timeFormat = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const LOG_COLORS: Record<LogLevel, ReturnType<typeof PlatformColor>> = {
  log: PlatformColor('label'),
  info: PlatformColor('systemBlue'),
  warn: PlatformColor('systemOrange'),
  error: red,
};

function ConsolePanel({ logs }: { logs: LogBook }) {
  const entries = useSyncExternalStore(logs.subscribe, logs.get);
  if (!entries.length) {
    return (
      <VStack modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
        <Text modifiers={[foregroundStyle(secondary)]}>Sin mensajes</Text>
      </VStack>
    );
  }
  return (
    <ScrollView modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity }), defaultScrollAnchor('bottom')]}>
      <LazyVStack alignment="leading" spacing={8} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ horizontal: 20, top: 24, bottom: 24 })]}>
        {entries.map((entry) => (
          <HStack key={entry.id} alignment="firstTextBaseline" spacing={8} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
            <Text modifiers={[foregroundStyle(secondary), font({ size: 11, design: 'monospaced' })]}>{timeFormat.format(entry.time)}</Text>
            <Text modifiers={[foregroundStyle(LOG_COLORS[entry.level]), font({ size: 13, design: 'monospaced' }), textSelection(true), frame({ maxWidth: Infinity, alignment: 'leading' })]}>{entry.text}</Text>
          </HStack>
        ))}
      </LazyVStack>
    </ScrollView>
  );
}

function FailureView({ failure, onRetry, onEdit, onConsole, onClose }: { failure: Failure; onRetry: () => void; onEdit: () => void; onConsole: () => void; onClose: () => void }) {
  const big = (prominent: boolean) => [buttonStyle(prominent ? (liquidGlass ? 'glassProminent' : 'borderedProminent') : liquidGlass ? 'glass' : 'bordered'), controlSize('large')];
  return (
    <ScrollView modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
      <VStack alignment="leading" spacing={12} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ horizontal: 20, top: 24, bottom: 32 })]}>
        <HStack spacing={10}>
          <Image systemName="exclamationmark.triangle.fill" modifiers={[font({ size: 20 }), foregroundStyle(red)]} />
          <Text modifiers={[font({ textStyle: 'headline', weight: 'semibold' })]}>{failure.line ? `Error en la línea ${failure.line}` : 'Error'}</Text>
        </HStack>
        <Text modifiers={[font({ textStyle: 'callout', design: 'monospaced' }), textSelection(true)]}>{failure.message}</Text>
        <HStack spacing={12} modifiers={[padding({ top: 6 })]}>
          <Button label="Editar" systemImage="pencil" onPress={onEdit} modifiers={big(true)} />
          <Button label="Reintentar" systemImage="arrow.clockwise" onPress={onRetry} modifiers={big(false)} />
          <Button label="Cerrar" systemImage="xmark" onPress={onClose} modifiers={big(false)} />
        </HStack>
        <Button label="Consola" systemImage="text.alignleft" onPress={onConsole} modifiers={[buttonStyle('plain'), foregroundStyle(PlatformColor('systemBlue'))]} />
      </VStack>
    </ScrollView>
  );
}

type Loaded = { App: React.ComponentType; runtime: Runtime };

function Miniapp({ name, input, onClose, onEdit }: { name: string; input: Record<string, string>; onClose: () => void; onEdit: () => void }) {
  const [run, setRun] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [panel, setPanel] = useState<'menu' | 'console' | null>(null);
  const [hint, setHint] = useState(true);
  const logs = useMemo(() => createLogBook(), []);
  const report = useCallback(
    (error: unknown) => {
      const found = describe(error);
      logs.add('error', found.line ? `Línea ${found.line}: ${found.message}` : found.message);
      setFailure((current) => current ?? found);
    },
    [logs],
  );
  const closeRef = useRef(onClose);
  const inputRef = useRef(input);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useShake(!panel, () => setPanel('menu'));

  useEffect(() => {
    const timer = setTimeout(() => setHint(false), 3500);
    return () => clearTimeout(timer);
  }, []);

  // Each run gets its own engine host, stored values and runtime; leaving or restarting ends them.
  useEffect(() => {
    let cancelled = false;
    let runtime: Runtime | null = null;
    const host = createHost(name, (level, text) => logs.add(level, text));
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoaded(null);
    setFailure(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    void (async () => {
      try {
        const code = compileFile(readScript(name), name);
        const library = String(await host.call('FS.library'));
        const dataPath = `${library}/miniapps/data/${name}.json`;
        let data: Record<string, unknown> = {};
        if (await host.call('FS.exists', [dataPath])) {
          try {
            const parsed = JSON.parse(String(await host.call('FS.readText', [dataPath])));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
          } catch {
            logs.add('warn', 'Los datos guardados no se pudieron leer; la miniapp empieza sin ellos.');
          }
        }
        const imports = await loadModules(code, host, library);
        if (cancelled) return;
        runtime = createRuntime(host, dataPath, data, inputRef.current, report, () => closeRef.current(), logs);
        const exports = evaluate(code, runtime.scope, runtime.modules, imports.table, imports.requests);
        if (!cancelled) setLoaded({ App: appComponent(exports) as React.ComponentType, runtime });
      } catch (error) {
        if (!cancelled) report(error);
      }
    })();
    return () => {
      cancelled = true;
      if (runtime) runtime.dispose();
      else host.dispose();
    };
  }, [name, run, report, logs]);

  // A failed run stops its timers so nothing keeps firing behind the error.
  useEffect(() => {
    if (failure) loaded?.runtime.dispose();
  }, [failure, loaded]);

  const restart = () => {
    setPanel(null);
    setRun((value) => value + 1);
  };

  return (
    <ZStack alignment="bottom" modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
      {failure ? (
        <FailureView failure={failure} onRetry={restart} onEdit={onEdit} onConsole={() => setPanel('console')} onClose={onClose} />
      ) : !loaded ? (
        <VStack modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
          <ProgressView />
        </VStack>
      ) : (
        <Boundary key={run} onError={report}>
          <VStack spacing={0} modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}>
            {React.createElement(loaded.App)}
          </VStack>
        </Boundary>
      )}
      {hint && !failure ? (
        <Text
          modifiers={[
            font({ textStyle: 'footnote', weight: 'medium' }),
            foregroundStyle(secondary),
            padding({ horizontal: 14, vertical: 8 }),
            ...(liquidGlass ? [glassEffect({ glass: { variant: 'regular' }, shape: 'capsule' })] : [Modifiers.background({ type: 'material', material: 'regular' }), Modifiers.clipShape('capsule')]),
            padding({ bottom: 12 }),
            lineLimit(1),
          ]}>
          Agita el iPhone para ver el menú
        </Text>
      ) : null}
      <BottomSheet isPresented={panel !== null} onIsPresentedChange={(open) => !open && setPanel(null)}>
        {panel === 'menu' ? (
          <Group modifiers={[presentationDetents([{ height: 330 }]), presentationDragIndicator('visible')]}>
            <Form>
              <Section title={baseName(name)}>
                <Button label="Reiniciar" systemImage="arrow.clockwise" onPress={restart} modifiers={[tint(PlatformColor('systemBlue'))]} />
                <Button label="Editar" systemImage="pencil" onPress={() => { setPanel(null); onEdit(); }} modifiers={[tint(PlatformColor('systemBlue'))]} />
                <Button onPress={() => setPanel('console')} modifiers={[tint(PlatformColor('systemBlue'))]}>
                  <HStack>
                    <SwiftUI.Label title="Consola" systemImage="text.alignleft" />
                    <Spacer />
                    {logs.get().length ? <Text modifiers={[foregroundStyle(secondary), Modifiers.monospacedDigit()]}>{String(logs.get().length)}</Text> : null}
                  </HStack>
                </Button>
              </Section>
              <Section>
                <Button label="Cerrar miniapp" systemImage="xmark.circle" role="destructive" onPress={() => { setPanel(null); onClose(); }} />
              </Section>
            </Form>
          </Group>
        ) : panel === 'console' ? (
          <Group modifiers={[presentationDetents(['medium', 'large']), presentationDragIndicator('visible')]}>
            <ConsolePanel logs={logs} />
          </Group>
        ) : (
          <Group>{null}</Group>
        )}
      </BottomSheet>
    </ZStack>
  );
}

/** The miniapp `name` (a .jsx or .tsx file) filling its own SwiftUI host. */
export function MiniappScreen({ name, tint: accent, input, onClose, onEdit }: { name: string; tint: string; input: Record<string, string>; onClose: () => void; onEdit: () => void }) {
  return (
    <Host style={{ flex: 1, backgroundColor: PlatformColor('systemBackground') }} seedColor={accent} useViewportSizeMeasurement>
      <TintContext.Provider value={accent}>
        <Miniapp name={name} input={input} onClose={onClose} onEdit={onEdit} />
      </TintContext.Provider>
    </Host>
  );
}
