import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { Keyboard, KeyboardAvoidingView, PlatformColor, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { IOSWebViewProps } from 'react-native-webview/lib/WebViewTypes';

import { ConsoleView } from '@/components/console-view';
import { IconButton } from '@/components/icon-button';
import { KeyBar } from '@/components/key-bar';
import { EDITOR_HTML } from '@/editor/editor-html';
import { startRun, stopRun, useRun } from '@/lib/runner';
import { readScript, writeScript } from '@/lib/scripts';

// react-native-webview's combined iOS/Android/Windows props collapse to `never` under this
// TypeScript version, so type the component with the iOS props only (the app is iOS-only).
const EditorWebView = WebView as unknown as ComponentType<IOSWebViewProps & { ref?: Ref<WebView> }>;

export default function EditorScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const web = useRef<WebView>(null);
  const text = useRef<string>('');
  const runAfterFlush = useRef(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const run = useRun(runId);
  // The iOS header is translucent and overlaps the screen, so push the editor below it.
  const headerHeight = useHeaderHeight();
  const running = run?.status === 'running';

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const js = (code: string) => web.current?.injectJavaScript(`${code}; true;`);

  const execute = () => {
    writeScript(name, text.current);
    Keyboard.dismiss();
    js('window.editorAPI.blur()');
    setConsoleOpen(true);
    setRunId(startRun(name, text.current));
  };

  const onMessage = (e: WebViewMessageEvent) => {
    const msg = JSON.parse(e.nativeEvent.data) as { type: string; text?: string };
    if (msg.type === 'ready') {
      text.current = readScript(name);
      js(`window.editorAPI.setText(${JSON.stringify(text.current)})`);
    } else if (msg.type === 'change' && msg.text !== undefined) {
      text.current = msg.text;
      writeScript(name, msg.text);
      if (runAfterFlush.current) {
        runAfterFlush.current = false;
        execute();
      }
    }
  };

  // The editor batches changes; flush it first so the run uses the latest text.
  const onRun = () => {
    runAfterFlush.current = true;
    js('window.editorAPI.flush()');
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () => (
            <View style={styles.header}>
              <IconButton
                name="terminal"
                label="Consola"
                onPress={() => setConsoleOpen((o) => !o)}
                tint={consoleOpen ? PlatformColor('systemBlue') : PlatformColor('secondaryLabel')}
              />
              {running ? (
                <IconButton name="stop.fill" label="Detener" tint={PlatformColor('systemRed')} onPress={() => stopRun(runId!)} />
              ) : (
                <IconButton name="play.fill" label="Ejecutar" onPress={onRun} />
              )}
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView style={[styles.flex, { paddingTop: headerHeight }]} behavior="padding">
        <EditorWebView
          ref={web}
          style={styles.flex}
          originWhitelist={['*']}
          source={{ html: EDITOR_HTML }}
          onMessage={onMessage}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          bounces={false}
        />
        {keyboard && <KeyBar onKey={(k) => js(`window.editorAPI.insert(${JSON.stringify(k)})`)} onHide={() => js('window.editorAPI.blur()')} />}
        {consoleOpen && !keyboard && (
          <View style={styles.console}>
            <Pressable onPress={() => setConsoleOpen(false)} style={styles.consoleBar}>
              <Text style={styles.consoleTitle}>Consola</Text>
              <Text style={styles.consoleHint}>Ocultar</Text>
            </Pressable>
            <ConsoleView run={run} />
          </View>
        )}
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  console: {
    height: '42%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: PlatformColor('separator'),
  },
  consoleBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: PlatformColor('secondarySystemBackground'),
  },
  consoleTitle: { fontWeight: '600', color: PlatformColor('label') },
  consoleHint: { color: PlatformColor('systemBlue') },
});
