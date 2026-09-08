import type { PanelId, SectionId, Settings, UiPrefs } from '../../../core/model/types';
import { mergeUiPrefs, type UiPrefsPatch } from '../../../core/persist/library';
import { editLibrary, libraryItem } from '../../../core/persist/library-client';
import { library } from '../../../core/state/library.svelte';

/** Views of the single library copy. All changes go through the background. */
class SettingsStore {
  current = $derived<Settings>({
    ...library.current.shared.settings, lastUsedParams: library.current.local.lastUsedParams,
  });

  update(patch: Partial<Settings>) {
    return editLibrary({ type: 'settings', patch: $state.snapshot(patch) });
  }

  reset() {
    return editLibrary({ type: 'settings', patch: {}, reset: true });
  }
}

class UiPrefsStore {
  /** Preferences are device-local, so a toggle can show immediately instead of
   * waiting for the service worker to wake, write and echo back. Held only until
   * the saved copy matches, so another tab's panel still wins afterwards. */
  #optimistic = $state.raw<UiPrefs | null>(null);
  current = $derived(this.#optimistic ?? library.current.local.uiPrefs);

  init() {
    libraryItem.watch((value) => {
      if (this.#optimistic && JSON.stringify(value?.local.uiPrefs) === JSON.stringify(this.#optimistic)) {
        this.#optimistic = null;
      }
    });
  }

  update(patch: UiPrefsPatch) {
    this.#optimistic = mergeUiPrefs(this.current, patch);
    // A rejected write must not keep showing a preference that was never saved.
    // Nothing awaits these, so revert and report rather than throwing.
    return editLibrary({ type: 'uiPrefs', patch }).catch((error: unknown) => {
      this.#optimistic = null;
      console.error('[note-by-note] saving preferences failed', error);
    });
  }

  toggleCollapsed(panel: PanelId) {
    return this.update({ collapsed: { [panel]: !this.current.collapsed[panel] } });
  }

  toggleSectionCollapsed(section: SectionId) {
    return this.update({ collapsedSections: { [section]: !this.current.collapsedSections[section] } });
  }

  setMarkerView(markerView: UiPrefs['markerView']) { return this.update({ markerView }); }
  setTimelineFollow(timelineFollow: boolean) { return this.update({ timelineFollow }); }
  setFavoritesSort(favoritesSort: UiPrefs['favoritesSort']) { return this.update({ favoritesSort }); }
  setLibraryTab(libraryTab: UiPrefs['libraryTab']) { return this.update({ libraryTab }); }

  setBoundaryLabel(which: 'start' | 'end', label: string) {
    void this.update({ boundaryLabels: { [which]: label.trim() } });
  }
}

export const settings = new SettingsStore();
export const uiPrefs = new UiPrefsStore();

/** The OS preference, used to resolve the 'auto' choice. Null in any context
 * without `matchMedia` (guards module import outside a real window). */
const prefersLight =
  typeof matchMedia === 'function'
    ? matchMedia('(prefers-color-scheme: light)')
    : null;

/** The user's current choice, tracked so the OS-change listener below only acts
 * while it is 'auto'. */
let themeChoice: Settings['theme'] = 'auto';

function resolveTheme(theme: Settings['theme']): 'light' | 'dark' {
  if (theme === 'auto') return prefersLight?.matches ? 'light' : 'dark';
  return theme;
}

/** Apply the chosen theme to <html data-theme>, which flips the palette in
 * theme.css. 'auto' follows the OS light/dark preference and keeps following it
 * live (see the listener below). */
export function applyTheme(theme: Settings['theme']) {
  themeChoice = theme;
  document.documentElement.dataset.theme = resolveTheme(theme);
}

// Re-apply when the OS preference changes, but only while the choice is 'auto'.
// Registered once at module load so repeated applyTheme() calls never stack
// listeners.
prefersLight?.addEventListener('change', () => {
  if (themeChoice === 'auto') applyTheme('auto');
});
