import ScriptEngine from '../../modules/script-engine';

// A miniapp runs in the app's React runtime, while Scriptor's API (FS, Net, Photos, Video…)
// lives in the script engine. Each miniapp keeps one engine run alive in the background and
// calls it by global path: `FS.readText('a.txt')` here becomes "FS.readText" with JSON
// arguments there, and the answer comes back as an onHost event. Every call is async.

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; fns: ((...args: unknown[]) => void)[] };

export type Host = {
  call: (path: string, args?: unknown[]) => Promise<unknown>;
  /** `api('FS').readText(path)` calls FS.readText; any path below the root works. No root: any global. */
  api: (root?: string) => any;
  dispose: () => void;
};

let counter = 0;

function toBase64(view: ArrayBufferView | ArrayBuffer) {
  const bytes = view instanceof ArrayBuffer ? new Uint8Array(view) : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
}

function fromBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Bytes travel as base64 and dates as ISO text, both tagged. A function becomes { __fn: n }:
// the engine sends its calls back as events.
function encode(args: unknown[], fns: Pending['fns']) {
  const tag = (value: unknown) => {
    if (typeof value === 'function') {
      fns.push(value as Pending['fns'][number]);
      return { __fn: fns.length - 1 };
    }
    if (value instanceof Date) return { __date: value.toISOString() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { __bytes: toBase64(value) };
    return value;
  };
  // The replacer sees a Date already turned into text by toJSON, so it reads the raw value from the holder.
  return JSON.stringify(args, function (this: Record<string, unknown>, key, value) {
    return key === '' ? value : tag(this[key]);
  });
}

function decode(text: string): unknown {
  return JSON.parse(text, (_key, value) => {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.__bytes === 'string') return fromBase64(value.__bytes);
    if (typeof value.__date === 'string') return new Date(value.__date);
    return value;
  });
}

function apiProxy(call: Host['call'], path: string[]): any {
  return new Proxy(function () {}, {
    get(_target, key) {
      // Not a thenable, so awaiting the proxy itself does not call "then" on Scriptor.
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return apiProxy(call, [...path, key]);
    },
    apply(_target, _this, args) {
      return call(path.join('.'), args);
    },
  });
}

/** Starts the engine run for one miniapp run. `onLog` receives what the engine side logs. */
export function createHost(fileName: string, onLog: (level: string, text: string) => void): Host {
  const runId = `app-${Date.now()}-${++counter}`;
  const pending = new Map<number, Pending>();
  let next = 1;
  let closed = false;

  const fail = (message: string) => {
    for (const call of pending.values()) call.reject(new Error(message));
    pending.clear();
  };
  const subscriptions = [
    ScriptEngine.addListener('onHost', (message) => {
      if (message.runId !== runId) return;
      const call = pending.get(message.id);
      if (!call) return;
      if (message.kind === 'event') {
        const args = decode(message.value);
        const reply = message.reply;
        // What the callback returns (a Net.serve response) goes back through __hostReply.
        new Promise((resolve) => resolve(call.fns[message.fn ?? -1]?.(...(Array.isArray(args) ? args : [args])))).then(
          (result) => {
            if (reply !== undefined) send('__hostReply', [reply, result === undefined ? null : result, null]).catch(() => {});
          },
          (error) => {
            onLog('error', error instanceof Error ? error.message : String(error));
            if (reply !== undefined) send('__hostReply', [reply, null, error instanceof Error ? error.message : String(error)]).catch(() => {});
          },
        );
        return;
      }
      pending.delete(message.id);
      if (message.kind === 'done') call.resolve(decode(message.value));
      else call.reject(new Error(message.value));
    }),
    ScriptEngine.addListener('onLogs', ({ runId: id, logs }) => {
      if (id === runId) logs.forEach((log) => onLog(log.level, log.message));
    }),
    ScriptEngine.addListener('onFinish', ({ runId: id, error }) => {
      if (id !== runId) return;
      closed = true;
      fail(error && error !== 'Stopped' ? error : 'Scriptor ya no responde a esta miniapp.');
    }),
  ];
  ScriptEngine.hostStart(runId, fileName);

  // Declared as a function so the event listener above can reply before this line runs.
  function send(path: string, args: unknown[]) {
    return call(path, args);
  }
  const call: Host['call'] = (path, args = []) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('La miniapp ya terminó.'));
      const id = next++;
      const fns: Pending['fns'] = [];
      let json: string;
      try {
        json = encode(args, fns);
      } catch (error) {
        return reject(error instanceof Error ? error : new Error(String(error)));
      }
      pending.set(id, { resolve, reject, fns });
      ScriptEngine.hostCall(runId, id, path, json);
    });

  return {
    call,
    api: (root) => apiProxy(call, root ? [root] : []),
    dispose: () => {
      if (closed) return;
      closed = true;
      subscriptions.forEach((subscription) => subscription.remove());
      pending.clear();
      ScriptEngine.stop(runId);
    },
  };
}
