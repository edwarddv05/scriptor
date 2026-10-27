import { NativeModule, requireNativeModule } from 'expo';

export type LogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';

export type LogEntry = { level: LogLevel; message: string; time: number };

export type ScriptFile = { name: string; modified: number; size: number };

type Events = {
  onLogs(event: { runId: string; logs: LogEntry[] }): void;
  onFinish(event: { runId: string; result?: string; error?: string }): void;
};

declare class ScriptEngineModule extends NativeModule<Events> {
  documentsPath: string;
  run(runId: string, name: string, source: string, input: Record<string, unknown> | null): void;
  stop(runId: string): void;
  listScripts(): ScriptFile[];
  readScript(name: string): string;
  writeScript(name: string, content: string): void;
  deleteScript(name: string): void;
  renameScript(from: string, to: string): void;
}

export default requireNativeModule<ScriptEngineModule>('ScriptEngine');
