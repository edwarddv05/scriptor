import { useSyncExternalStore } from 'react';

import ScriptEngine, { type LogEntry } from '../../modules/script-engine';

export type RunStatus = 'running' | 'done' | 'error' | 'stopped';

export type RunState = {
  runId: string;
  name: string;
  status: RunStatus;
  logs: LogEntry[];
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
};

const MAX_LOGS = 2000;
const runs = new Map<string, RunState>();
const listeners = new Set<() => void>();
let counter = 0;

function update(runId: string, patch: (run: RunState) => RunState) {
  const run = runs.get(runId);
  if (!run) return;
  runs.set(runId, patch(run));
  listeners.forEach((l) => l());
}

ScriptEngine.addListener('onLogs', ({ runId, logs }) => {
  update(runId, (run) => {
    const all = run.logs.concat(logs);
    return { ...run, logs: all.length > MAX_LOGS ? all.slice(all.length - MAX_LOGS) : all };
  });
});

ScriptEngine.addListener('onFinish', ({ runId, result, error }) => {
  update(runId, (run) => ({
    ...run,
    status: error === 'Stopped' ? 'stopped' : error ? 'error' : 'done',
    result,
    error,
    endedAt: Date.now(),
  }));
});

export function startRun(name: string, source: string, input: Record<string, unknown> = {}): string {
  const runId = `${Date.now()}-${++counter}`;
  runs.set(runId, { runId, name, status: 'running', logs: [], startedAt: Date.now() });
  listeners.forEach((l) => l());
  ScriptEngine.run(runId, `${name}.js`, source, input);
  return runId;
}

export function stopRun(runId: string) {
  ScriptEngine.stop(runId);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRun(runId: string | null): RunState | undefined {
  return useSyncExternalStore(subscribe, () => (runId ? runs.get(runId) : undefined));
}
