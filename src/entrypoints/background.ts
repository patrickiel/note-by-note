import type { OffscreenCommand } from '@/core/messaging/protocol';
import { onMessage } from '@/core/messaging/rpc';
import { grantedOriginsItem } from '@/core/persist/storage';
import { CAN_CAPTURE_TAB, HAS_SIDE_PANEL_API } from '@/core/platform';
import { disablePanelForTab, enablePanelForTab, isPanelShowing } from '@/core/side-panel';

/** Firefox's sidebar API. WXT's `browser` types are Chromium-shaped and don't
 * declare it, so reach it through a narrow cast — only ever on the Firefox
 * build, where `sidebar_action` is the manifest key WXT emits for the sidepanel
 * entrypoint. */
function sidebarAction(): { toggle(): Promise<void> } {
  return (browser as unknown as { sidebarAction: { toggle(): Promise<void> } })
    .sidebarAction;
}

const ENGINE_SCRIPT = '/content-scripts/content.js';
const REGISTRATION_ID = 'note-by-note-engine';
const ALL_URLS = '<all_urls>';

function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

/** Content-script match patterns for the origins we hold. `<all_urls>` is a
 * valid permission origin but not a valid registration match, so the broad
 * grant collapses to the http(s) wildcard. */
function registrationMatches(origins: string[]): string[] {
  if (origins.includes(ALL_URLS)) return ['*://*/*'];
  return origins.filter((o) => o.startsWith('http'));
}

/** Keeps the persistent registration in sync with the granted match patterns so
 * the engine auto-loads on future visits without another injection round-trip. */
async function syncRegistration(matches: string[]) {
  const existing = await browser.scripting.getRegisteredContentScripts({
    ids: [REGISTRATION_ID],
  });
  if (!matches.length) {
    if (existing.length) {
      await browser.scripting.unregisterContentScripts({ ids: [REGISTRATION_ID] });
    }
    return;
  }
  const script: Browser.scripting.RegisteredContentScript = {
    id: REGISTRATION_ID,
    js: [ENGINE_SCRIPT],
    matches,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
  if (existing.length) await browser.scripting.updateContentScripts([script]);
  else await browser.scripting.registerContentScripts([script]);
}

/** Single source of truth: reconcile the persistent registration (and the
 * mirrored grantedOrigins store) with the host permissions Chrome actually
 * holds — however they were granted or revoked (banner prompt, chrome://
 * extensions UI, or revoke button). */
async function syncFromPermissions() {
  const { origins = [] } = await browser.permissions.getAll();
  await grantedOriginsItem.setValue(origins);
  await syncRegistration(registrationMatches(origins));
}

export default defineBackground(() => {
  // Scope the panel to the tabs it was opened on: the manifest's
  // `side_panel.default_path` enables it everywhere, so once opened it would
  // follow the user to every tab. With the default disabled and the click
  // handler enabling it per tab, Chrome hides the panel while a tab without it
  // is active and brings it back when the user returns to one that has it.
  // Idempotent, so re-applying on every worker start is fine (per-tab options
  // live browser-side and survive worker restarts).
  if (HAS_SIDE_PANEL_API) {
    browser.sidePanel
      .setOptions({ enabled: false })
      .catch((err: unknown) => console.error('sidePanel default disable', err));
  }

  // Open the side panel from an explicit action.onClicked handler rather than
  // setPanelBehavior({ openPanelOnActionClick: true }). With openPanelOnActionClick
  // the click is consumed by the panel and action.onClicked never fires, so the
  // tab is never "invoked" and tabCapture.getMediaStreamId fails with "Extension
  // has not been invoked for the current page". Handling the click ourselves is
  // what grants activeTab on the current tab, which tab capture relies on.
  browser.action.onClicked.addListener((tab) => {
    // Both branches must reach their API call synchronously from the click:
    // Firefox counts `toggle()` as a user gesture only then, and on Chromium
    // the action's gesture does not survive an `await` — `sidePanel.open()`
    // chained after `setOptions` is rejected with "may only be called in
    // response to a user gesture". Fire both back to back instead; the calls
    // are dispatched in order, so the per-tab option is in place when the
    // open is evaluated (verified against Chrome 151).
    if (!HAS_SIDE_PANEL_API) {
      sidebarAction()
        .toggle()
        .catch((err: unknown) => console.error('sidebarAction toggle', err));
      return;
    }
    if (tab.id != null) {
      const tabId = tab.id;
      // The click toggles. Its verdict can't gate the open (the gesture would
      // be gone by the time it resolves), so snapshot the pre-click state,
      // then enable + open unconditionally — a no-op when the panel is already
      // showing — and close once the snapshot says it was.
      const wasShowing = isPanelShowing(tabId);
      enablePanelForTab(tabId).catch((err: unknown) =>
        console.error('sidePanel enable for tab', err),
      );
      browser.sidePanel
        .open({ tabId })
        .catch((err: unknown) => console.error('sidePanel open', err));
      wasShowing
        .then((showing) => (showing ? disablePanelForTab(tabId) : undefined))
        .catch((err: unknown) => console.error('sidePanel toggle', err));
    }
  });

  // Reconcile registration whenever host permissions change or the worker
  // (re)starts — the grant may be made from the banner prompt or Chrome's own
  // extensions UI, so the permission events are the reliable trigger.
  // Failure here is silent and consequential: the registration drifts out of
  // sync with the granted origins, so the engine stops auto-loading on sites
  // the user already approved, and the only fix (revoke, then grant again) is
  // not something they would guess. Surface it in the worker's log at least.
  const reconcile = (trigger: string) => {
    syncFromPermissions().catch((err: unknown) =>
      console.error(`content-script registration out of sync after ${trigger}`, err),
    );
  };
  browser.permissions.onAdded.addListener(() => reconcile('permissions.onAdded'));
  browser.permissions.onRemoved.addListener(() => reconcile('permissions.onRemoved'));
  browser.runtime.onInstalled.addListener(() => reconcile('runtime.onInstalled'));
  browser.runtime.onStartup.addListener(() => reconcile('runtime.onStartup'));

  onMessage('ensureInjected', async ({ data }) => {
    const tab = await browser.tabs.get(data.tabId);
    const pattern = tab.url ? originPattern(tab.url) : null;
    if (!pattern) return { ok: false, error: 'unsupported-page' };

    const granted = await browser.permissions.contains({ origins: [pattern] });
    if (!granted) return { ok: false, error: 'no-permission' };

    try {
      // Re-running the content script would invalidate the live instance (WXT
      // tears down the previous execution) and orphan its MediaElementSource —
      // the element could never be re-captured until page reload. Probe the
      // isolated world first and only inject when the engine isn't booted.
      const [probe] = await browser.scripting.executeScript({
        target: { tabId: data.tabId },
        func: () => window.__noteByNote === true,
      });
      if (probe?.result !== true) {
        await browser.scripting.executeScript({
          target: { tabId: data.tabId },
          files: [ENGINE_SCRIPT],
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  onMessage('revokeAllPermissions', async () => {
    const { origins = [] } = await browser.permissions.getAll();
    if (origins.length) {
      await browser.permissions.remove({ origins }).catch(() => {
        // Some patterns may already be gone; onRemoved still reconciles below.
      });
    }
    // Explicit reconcile in case permissions.remove resolved without firing
    // onRemoved (e.g. nothing to remove).
    await syncFromPermissions();
  });

  // ─── Tab capture (Chromium only) ───────────────────────────

  // Firefox implements neither `tabCapture` nor `offscreen`, so there is no
  // second pipeline to fall back to — direct mode is the only mode. The panel
  // never offers capture there (see core/platform.ts), but answer explicitly
  // instead of letting a stray call reject on an undefined API.
  if (!CAN_CAPTURE_TAB) {
    onMessage('startCapture', async () => ({
      ok: false,
      error: 'Tab capture is not available in this browser',
    }));
    onMessage('stopCapture', async () => {});
    onMessage('isCapturing', async () => false);
    onMessage('captureParams', async () => {});
    onMessage('captureVolume', async () => {});
    return;
  }

  async function ensureOffscreen(): Promise<void> {
    const has = await browser.offscreen.hasDocument();
    if (has) return;
    await browser.offscreen.createDocument({
      url: '/offscreen.html',
      reasons: ['USER_MEDIA' as never],
      justification: 'Process captured tab audio for pitch shifting',
    });
  }

  async function toOffscreen(cmd: OffscreenCommand): Promise<unknown> {
    return browser.runtime.sendMessage(cmd);
  }

  onMessage('startCapture', async ({ data }) => {
    try {
      const streamId = await browser.tabCapture.getMediaStreamId({
        targetTabId: data.tabId,
      });
      await ensureOffscreen();
      const result = (await toOffscreen({
        target: 'offscreen',
        type: 'capture.start',
        tabId: data.tabId,
        streamId,
      })) as { ok: boolean; error?: string };
      return result;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  onMessage('stopCapture', async ({ data }) => {
    if (!(await browser.offscreen.hasDocument())) return;
    const result = (await toOffscreen({
      target: 'offscreen',
      type: 'capture.stop',
      tabId: data.tabId,
    })) as { active: number };
    if (result?.active === 0) await browser.offscreen.closeDocument();
  });

  onMessage('isCapturing', async ({ data }) => {
    if (!(await browser.offscreen.hasDocument())) return false;
    const result = (await toOffscreen({
      target: 'offscreen',
      type: 'capture.query',
      tabId: data.tabId,
    })) as { capturing: boolean };
    return result?.capturing ?? false;
  });

  onMessage('captureParams', async ({ data }) => {
    await toOffscreen({
      target: 'offscreen',
      type: 'params',
      tabId: data.tabId,
      patch: data.patch,
    });
  });

  onMessage('captureVolume', async ({ data }) => {
    await toOffscreen({
      target: 'offscreen',
      type: 'volume',
      tabId: data.tabId,
      volume: data.volume,
    });
  });
});
