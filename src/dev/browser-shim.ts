/** Dev-only: lets the side panel render in a plain browser tab (UI preview /
 * screenshots) by installing a minimal in-memory `chrome` polyfill. No-op when
 * real extension APIs exist. Import FIRST in the entrypoint. */

type Listener = (...args: unknown[]) => void;

function makeEvent() {
  const listeners = new Set<Listener>();
  return {
    addListener: (fn: Listener) => listeners.add(fn),
    removeListener: (fn: Listener) => listeners.delete(fn),
    hasListener: (fn: Listener) => listeners.has(fn),
    emit: (...args: unknown[]) => listeners.forEach((fn) => fn(...args)),
  };
}

function makeStorageArea(areaName: string, globalChanged: ReturnType<typeof makeEvent>) {
  const data = new Map<string, unknown>();
  const onChanged = makeEvent();
  // Real chrome.storage fires per-area and global events with a change map —
  // storage watchers (defineItem.watch, the sync engine) rely on them.
  function emit(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) {
    if (Object.keys(changes).length === 0) return;
    onChanged.emit(changes, areaName);
    globalChanged.emit(changes, areaName);
  }
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      const result: Record<string, unknown> = {};
      if (keys == null) {
        for (const [k, v] of data) result[k] = v;
      } else if (typeof keys === 'string') {
        if (data.has(keys)) result[keys] = data.get(keys);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) result[k] = data.get(k);
      } else {
        for (const k of Object.keys(keys)) {
          result[k] = data.has(k) ? data.get(k) : keys[k];
        }
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, v);
      }
      emit(changes);
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (data.has(k)) changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      emit(changes);
    },
    async clear() {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of data) changes[k] = { oldValue: v };
      data.clear();
      emit(changes);
    },
    onChanged,
  };
}

const globals = globalThis as Record<string, unknown>;
const existing = globals.chrome as { storage?: unknown } | undefined;

if (!existing?.storage) {
  const onChanged = makeEvent();
  const shim = {
    storage: {
      local: makeStorageArea('local', onChanged),
      session: makeStorageArea('session', onChanged),
      sync: makeStorageArea('sync', onChanged),
      onChanged,
    },
    runtime: {
      id: 'note-by-note-dev-shim',
      getURL: (path: string) => path,
      getManifest: () => ({ version: '1.0.0' }),
      onConnect: makeEvent(),
      onMessage: makeEvent(),
      connect: () => ({
        name: 'shim',
        postMessage: () => {},
        disconnect: () => {},
        onMessage: makeEvent(),
        onDisconnect: makeEvent(),
      }),
      sendMessage: async () => undefined,
    },
    tabs: {
      query: async () => [],
      get: async () => ({}),
      create: async () => ({ id: -1 }),
      update: async () => ({}),
      connect: () => ({
        name: 'shim',
        postMessage: () => {},
        disconnect: () => {},
        onMessage: makeEvent(),
        onDisconnect: makeEvent(),
      }),
      onActivated: makeEvent(),
      onUpdated: makeEvent(),
    },
    sidePanel: {
      setOptions: async () => {},
      open: async () => {},
    },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => true,
    },
  };
  // Mutate the page's real `chrome` object in place (rather than replacing the
  // reference) so any consumer that already captured `globalThis.chrome` — e.g.
  // @wxt-dev/browser reads it once at module-eval — sees the shimmed APIs
  // regardless of import order. Also expose it as `browser` for the polyfill.
  if (existing) Object.assign(existing, shim);
  else globals.chrome = shim;
  globals.browser = globals.chrome;
}

export {};
