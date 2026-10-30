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

function track(name: string): string {
  const runId = `${Date.now()}-${++counter}`;
  runs.set(runId, { runId, name, status: 'running', logs: [], startedAt: Date.now() });
  listeners.forEach((l) => l());
  return runId;
}

export function startRun(name: string, source: string, input: Record<string, unknown> = {}): string {
  const runId = track(name);
  // A .js script's name goes without its extension; a .py one keeps it and runs as Python.
  ScriptEngine.run(runId, /\.py$/i.test(name) ? name : `${name}.js`, source, input);
  return runId;
}

/** One line of the Python terminal; lines with the same session share their variables. */
export function startPythonLine(session: string, code: string): string {
  const runId = track('<terminal>');
  ScriptEngine.pythonLine(runId, session, code);
  return runId;
}

/** A pip command as its words: ['install', 'pandas']. */
export function startPip(args: string[]): string {
  const runId = track('<pip>');
  ScriptEngine.pythonPip(runId, args);
  return runId;
}

/** Resolves when the run ends, with its final state. */
export function whenDone(runId: string): Promise<RunState> {
  return new Promise((resolve) => {
    const check = () => {
      const run = runs.get(runId);
      if (!run || run.status === 'running') return;
      listeners.delete(check);
      resolve(run);
    };
    listeners.add(check);
    check();
  });
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
