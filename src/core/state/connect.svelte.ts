import { UI_PORT, type EngineCommand, type EngineEvent } from '../messaging/protocol';
import { connectToTab, type TypedPort } from '../messaging/ports';
import { sendMessage } from '../messaging/rpc';
import { features } from '../features';
import { session } from './session.svelte';
import { settings } from '../../features/settings/panel/settings.svelte';

function isRestricted(url: string | undefined): boolean {
  if (!url) return true;
  return !/^https?:/.test(url) && !url.startsWith('file:');
}

function isLocalPlayer(url: string | undefined): boolean {
  return !!url && url.startsWith(browser.runtime.getURL('/local-player.html'));
}

/** A fresh engine starts on the default preset, so this runs on every attach as
 * well as on change — a no-op while nothing is attached. */
function pushSettings() {
  session.send({
    type: 'settings',
    seekInterval: settings.current.seekInterval,
    lowLatency: settings.current.lowLatency,
    formantPreserved: settings.current.formantPreserved,
    countInBeats: settings.current.countInBeats,
    countInBpm: settings.current.countInBpm,
    countInBeep: settings.current.countInBeep,
  });
}

/** Side-panel side of the connection: binds the session store to the engine in
 * the active tab — permission grant, injection, port lifecycle, reconnection. */
class ConnectionManager {
  tabId = $state<number | null>(null);
  /** Origin pattern needing a grant before we can connect (null = granted). */
  needsPermission = $state<string | null>(null);

  #port: TypedPort<EngineEvent, EngineCommand> | null = null;
  #generation = 0;

  async init() {
    settings.onChange = pushSettings;

    // Chromium opens one panel document per tab at `sidepanel.html?tabId=N`
    // (see core/side-panel.ts): pin to that tab. Hidden behind another tab
    // this document stays alive, and following activation there would leave
    // it mirroring the wrong tab when Chrome shows it again. The E2E harness
    // uses the same parameter to pin a panel opened as a plain tab. Firefox's
    // window-global sidebar has no such parameter and follows the active tab.
    const pinned = new URLSearchParams(location.search).get('tabId');
    if (pinned) {
      await this.bindTab(Number(pinned));
    } else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) await this.bindTab(tab.id);
      browser.tabs.onActivated.addListener(({ tabId }) => {
        void this.bindTab(tabId);
      });
    }
    browser.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId !== this.tabId) return;
      // Navigation completed: the engine needs re-injection + reconnect.
      if (info.status === 'complete') void this.#connect();
      if (info.audible !== undefined) void this.#refineNoPlayer();
    });
  }

  async bindTab(tabId: number) {
    if (this.tabId === tabId && this.#port && !this.#port.disconnected) return;
    this.tabId = tabId;
    await this.#connect();
  }

  /** Called from the banner's Connect button — must run in a user gesture.
   * Requests the broad `<all_urls>` host permission in a single prompt so the
   * user is never asked again as they move between sites. */
  async requestAndConnect() {
    if (this.tabId == null) return;
    if (this.needsPermission) {
      const granted = await browser.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) return;
      this.needsPermission = null;
    }
    await this.#connect();
  }

  async #connect() {
    const generation = ++this.#generation;
    this.#port?.disconnect();
    this.#port = null;
    session.detachTransport();
    // Errors describe the attempt that produced them, not the panel. Without
    // this, one failed capture leaves its message on every banner, on every
    // tab, for as long as the panel stays open.
    session.lastError = null;

    const tabId = this.tabId;
    if (tabId == null) return;

    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || generation !== this.#generation) return;

    if (isRestricted(tab.url) && !isLocalPlayer(tab.url)) {
      session.connection = 'restricted';
      session.setMedia(null);
      return;
    }

    // The local player page (M8) speaks the same protocol via its own tab.
    if (!isLocalPlayer(tab.url)) {
      let pattern: string | null = null;
      try {
        pattern = `${new URL(tab.url!).origin}/*`;
      } catch {
        session.connection = 'restricted';
        return;
      }
      const granted = await browser.permissions.contains({ origins: [pattern] });
      if (generation !== this.#generation) return;
      if (!granted) {
        this.needsPermission = pattern;
        session.connection = 'idle';
        session.setMedia(null);
        return;
      }
      this.needsPermission = null;

      const injected = await sendMessage('ensureInjected', { tabId });
      if (generation !== this.#generation) return;
      if (!injected.ok) {
        session.connection = injected.error === 'unsupported-page' ? 'restricted' : 'stale';
        return;
      }
    }

    const port = connectToTab<EngineEvent, EngineCommand>(tabId, UI_PORT);
    this.#port = port;
    port.onMessage((event) => {
      session.apply(event);
      // Feature-owned traffic that lives outside the session mirror (e.g. the
      // chords store) is routed through the panel feature registry.
      for (const f of features) f.routeEvent?.(event);
      if (event.type === 'snapshot') for (const f of features) f.onSnapshot?.(event);
      if (event.type === 'state' || event.type === 'snapshot') {
        void this.#refineNoPlayer();
      }
    });
    port.onDisconnect(() => {
      if (this.#port !== port) return;
      this.#port = null;
      session.detachTransport();
      for (const f of features) f.onDisconnect?.();
      if (session.connection !== 'restricted' && session.connection !== 'idle') {
        session.connection = 'stale';
      }
    });
    session.attachTransport((cmd) => port.send(cmd));
    port.send({ type: 'hello' });
    pushSettings();
  }

  /** "No compatible player": engine finds nothing but the tab is audible. */
  async #refineNoPlayer() {
    if (session.connection !== 'detecting' || this.tabId == null) return;
    const tab = await browser.tabs.get(this.tabId).catch(() => null);
    if (tab?.audible && session.connection === 'detecting') {
      session.connection = 'no-player';
    }
  }

  async startCapture() {
    const tabId = this.tabId;
    if (tabId == null) return;
    // A retry starts clean, so a success can't leave the previous failure up.
    session.lastError = null;
    const result = await sendMessage('startCapture', { tabId });
    if (!result.ok) {
      session.lastError = { code: 'capture-failed', detail: result.error };
      return;
    }
    session.capturing = true;
    session.captureRelay = {
      params: (patch) => void sendMessage('captureParams', { tabId, patch }),
      volume: (volume) => void sendMessage('captureVolume', { tabId, volume }),
    };
    // Seed the offscreen pipeline with the panel's current state.
    session.captureRelay.params($state.snapshot(session.params));
    session.captureRelay.volume(session.volume);
    if (session.connection === 'pitch-unavailable') {
      session.connection = 'connected-hybrid';
    } else if (session.connection === 'no-player' || session.connection === 'detecting') {
      session.connection = 'connected-capture';
    }
  }

  async stopCapture() {
    if (this.tabId == null) return;
    await sendMessage('stopCapture', { tabId: this.tabId });
    session.capturing = false;
    session.captureRelay = null;
    await this.#connect();
  }
}

export const connection = new ConnectionManager();
