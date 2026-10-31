import { NativeModule, requireNativeModule, requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { ColorValue, ViewProps } from 'react-native';

export type LogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

export type LogEntry = { level: LogLevel; message: string; time: number };

/** `color` and `glyph` come from Scriptable's `// icon-color: x; icon-glyph: y;` header. */
export type ScriptFile = {
  name: string;
  modified: number;
  size: number;
  color?: string;
  glyph?: string;
  summary?: string;
  /** A .jsx/.tsx miniapp; its name keeps the extension. */
  app?: boolean;
};

/** A result, error or callback call from a miniapp's host run (see hostCall). */
export type HostMessage = { runId: string; id: number; kind: 'done' | 'error' | 'event'; value: string; fn?: number; reply?: number };

type Events = {
  onLogs(event: { runId: string; logs: LogEntry[] }): void;
  onFinish(event: { runId: string; result?: string; error?: string }): void;
  onHost(event: HostMessage): void;
};

declare class ScriptEngineModule extends NativeModule<Events> {
  documentsPath: string;
  run(runId: string, name: string, source: string, input: Record<string, unknown> | null): void;
  stop(runId: string): void;
  /** One line of the Python terminal; lines with the same session share variables. Output arrives as onLogs/onFinish of runId. */
  pythonLine(runId: string, session: string, code: string): void;
  /** A pip command as its words, e.g. ['install', 'pandas']. */
  pythonPip(runId: string, args: string[]): void;
  /** Starts a background run that serves a miniapp's calls to Scriptor's API until stop(). */
  hostStart(runId: string, name: string): void;
  /** Calls the global at `path` ("FS.readText") with JSON `args`; the answer arrives as onHost. */
  hostCall(runId: string, callId: number, path: string, args: string): void;
  listScripts(): ScriptFile[];
  readScript(name: string): string;
  writeScript(name: string, content: string): void;
  deleteScript(name: string): void;
  renameScript(from: string, to: string): void;
  /** Copies the file to the pasteboard, as a file and as text. */
  copyScript(name: string): void;
  /** Completes a pending CallbackURL.open() in a running script. */
  deliverCallback(token: string, status: string, params: Record<string, string>): void;
}

export default requireNativeModule<ScriptEngineModule>('ScriptEngine');

export type ScriptEditorProps = ViewProps & {
  /** Script loaded from Documents/<scriptName>.js; the editor saves it back by itself. */
  scriptName: string;
  completions?: { label: string; detail: string }[];
  /** Cursor and selection color. */
  tint?: ColorValue;
  /** ⌘R on a hardware keyboard. */
  onRunShortcut?: () => void;
  ref?: Ref<ScriptEditorRef>;
};

/** Methods on a ScriptEditor ref. */
export type ScriptEditorRef = {
  /** Writes pending edits to disk and returns the current text. */
  save(): Promise<string>;
  blur(): Promise<void>;
};

export const ScriptEditor = requireNativeView<ScriptEditorProps>('ScriptEditor');
