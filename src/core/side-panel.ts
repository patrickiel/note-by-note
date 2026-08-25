import { HAS_SIDE_PANEL_API } from '@/core/platform';

/** Tab-scoped side panel (Chromium).
 *
 * The manifest's `side_panel.default_path` enables the panel on every tab, so
 * once opened it followed the user to every tab they switched to. Instead the
 * background disables the panel by default and it is enabled per tab, only
 * where the user summoned it — Chrome then hides the panel while a tab without
 * it is active and brings it back when the user returns to one that has it.
 * Per-tab options die with their tab, so nothing accumulates.
 *
 * Facts that shape the call sites (all measured against Chrome 151):
 * - `sidePanel.open()` needs a user gesture, and the gesture of a toolbar
 *   click in the service worker dies at the first `await` — the background
 *   must call it synchronously from `action.onClicked`. A click inside an
 *   extension *page* instead grants transient activation that survives awaits.
 * - Enabling the panel on a tab does not show it there: a freshly enabled tab
 *   that becomes active still needs an explicit `open()`.
 * - Every tab gets its own panel document, which lives while the panel is
 *   open for that tab (it survives being hidden behind another tab) and dies
 *   when the panel is closed there — by the ✕, by `sidePanel.close()`, or by
 *   disabling the tab. Disabling is the close primitive used here: unlike
 *   `sidePanel.close()` it exists on every Chrome we support, and it tears
 *   the document down at once (~4 ms), so an immediate re-click reopens.
 *   After the ✕ the document lingers ~360 ms — too short for a hand to reach
 *   the toolbar, so the icon-click toggle below can treat "document exists"
 *   as "showing".
 * - `runtime.getContexts` lists those documents but reports `tabId: -1` /
 *   `windowId: -1` for all of them, so the tab is encoded in the path
 *   instead (`?tabId=`) and read back from `documentUrl`. The panel honors
 *   that parameter by pinning itself to the tab — the right thing for a
 *   per-tab document, which must not follow tab activation while hidden.
 *
 * Firefox has no per-tab sidebar (`sidebar_action` is window-global), so these
 * helpers reduce to plain tab handling there.
 */

/** The built sidepanel entrypoint — must match the `side_panel.default_path`
 * WXT emits into the manifest. */
const PANEL_PATH = 'sidepanel.html';

/** The per-tab panel URL: the tab is carried in the query so the panel pins
 * itself to it and `isPanelShowing` can recognise its document. */
function panelPath(tabId: number): string {
  return `${PANEL_PATH}?tabId=${tabId}`;
}

function tabOfPanelDocument(documentUrl: string | undefined): number | null {
  if (!documentUrl) return null;
  const raw = new URL(documentUrl).searchParams.get('tabId');
  return raw == null ? null : Number(raw);
}

/** Enable the panel on one tab. No-op on Firefox. Returns the API promise
 * without awaiting anything first, so a caller inside a user-gesture callback
 * can fire this and `sidePanel.open()` back to back. */
export function enablePanelForTab(tabId: number): Promise<void> {
  if (!HAS_SIDE_PANEL_API) return Promise.resolve();
  return browser.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true });
}

/** Close the panel on one tab by disabling it there. No-op on Firefox. */
export function disablePanelForTab(tabId: number): Promise<void> {
  if (!HAS_SIDE_PANEL_API) return Promise.resolve();
  return browser.sidePanel.setOptions({ tabId, enabled: false });
}

/** Whether the panel is open for `tabId`: its document exists. For the
 * active tab that means showing. The read is dispatched immediately, so a
 * caller in a click handler can fire this ahead of the synchronous enable +
 * open and still get the pre-click state — the browser handles extension API
 * calls in dispatch order. */
export async function isPanelShowing(tabId: number): Promise<boolean> {
  if (!HAS_SIDE_PANEL_API) return false;
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['SIDE_PANEL' as Browser.runtime.ContextType],
  });
  return contexts.some((c) => tabOfPanelDocument(c.documentUrl) === tabId);
}

/** Open `url` in a new foreground tab that the side panel follows. For flows
 * started from a click inside the open panel (local player, Songs list): a
 * plain `tabs.create` would activate a tab the panel isn't enabled on and hide
 * it. Must be called from the panel document itself, inside the click's
 * transient activation — not routed through the background, where
 * `sidePanel.open()` has no gesture to run on. */
export async function openTabWithPanel(url: string): Promise<Browser.tabs.Tab> {
  if (!HAS_SIDE_PANEL_API) return browser.tabs.create({ url });
  // The tab starts inactive: activating it before the panel is enabled and
  // opened there would hide the panel — the very document running this code.
  const tab = await browser.tabs.create({ url, active: false });
  const tabId = tab.id!;
  await enablePanelForTab(tabId);
  // The activation below must run either way; without the open the panel is
  // merely hidden on the new tab and the icon brings it back.
  await browser.sidePanel
    .open({ tabId })
    .catch((err: unknown) => console.error('sidePanel open for new tab', err));
  await browser.tabs.update(tabId, { active: true });
  return tab;
}
