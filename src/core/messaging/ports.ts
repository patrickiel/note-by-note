import type { Browser } from 'wxt/browser';

/** Thin typed wrapper around a chrome.runtime Port. `In` = messages we receive,
 * `Out` = messages we send. */
export class TypedPort<In, Out> {
  #port: Browser.runtime.Port;
  #listeners = new Set<(msg: In) => void>();
  #disconnectListeners = new Set<() => void>();
  disconnected = false;

  constructor(port: Browser.runtime.Port) {
    this.#port = port;
    port.onMessage.addListener((msg) => {
      for (const fn of this.#listeners) fn(msg as In);
    });
    port.onDisconnect.addListener(() => {
      this.disconnected = true;
      for (const fn of this.#disconnectListeners) fn();
    });
  }

  send(msg: Out): void {
    if (this.disconnected) return;
    try {
      this.#port.postMessage(msg);
    } catch {
      this.disconnected = true;
    }
  }

  onMessage(fn: (msg: In) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  onDisconnect(fn: () => void): () => void {
    if (this.disconnected) fn();
    this.#disconnectListeners.add(fn);
    return () => this.#disconnectListeners.delete(fn);
  }

  disconnect(): void {
    this.disconnected = true;
    try {
      this.#port.disconnect();
    } catch {
      // already gone
    }
  }
}

/** Side-panel side: connect to the engine in a tab's content script (or the
 * local player page, which also listens via runtime.onConnect). */
export function connectToTab<In, Out>(tabId: number, name: string): TypedPort<In, Out> {
  return new TypedPort<In, Out>(browser.tabs.connect(tabId, { name }));
}

export function connectToRuntime<In, Out>(name: string): TypedPort<In, Out> {
  return new TypedPort<In, Out>(browser.runtime.connect({ name }));
}

/** Engine side: accept incoming ports by name. Returns an unsubscribe fn. */
export function acceptPorts<In, Out>(
  name: string,
  onConnect: (port: TypedPort<In, Out>) => void,
): () => void {
  const listener = (raw: Browser.runtime.Port) => {
    if (raw.name !== name) return;
    onConnect(new TypedPort<In, Out>(raw));
  };
  browser.runtime.onConnect.addListener(listener);
  return () => browser.runtime.onConnect.removeListener(listener);
}
