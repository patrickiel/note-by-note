import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../../../core/model/defaults';
import type { PanelId, SectionId, Settings, UiPrefs } from '../../../core/model/types';
import { settingsItem, uiPrefsItem } from '../../../core/persist/storage';

/** Settings synced two-way with storage.local. Components mutate via `update`. */
class SettingsStore {
  current = $state<Settings>({ ...DEFAULT_SETTINGS });
  loaded = $state(false);
  #writing = false;

  /** Wired by the connection layer, which pushes the engine-relevant settings
   * to the tab. Fires on every path that lands a new value in
   * `current` — the engine can't observe this store itself. */
  onChange: ((next: Settings) => void) | null = null;

  /** Stored settings may predate newly added fields — backfill from defaults so
   * a missing key never reaches the engine as `undefined` (which the port drops,
   * e.g. a NaN count-in duration that never elapses). */
  #withDefaults(value: Settings | null): Settings {
    return { ...DEFAULT_SETTINGS, ...value };
  }

  async init() {
    this.current = this.#withDefaults(await settingsItem.getValue());
    this.loaded = true;
    settingsItem.watch((value) => {
      if (this.#writing) return;
      this.current = this.#withDefaults(value);
      this.onChange?.(this.current);
    });
  }

  async update(patch: Partial<Settings>) {
    const next = { ...this.current, ...patch };
    // Auto Reset and Remember settings are alternatives — enabling one
    // switches the other off.
    if (patch.rememberSettings) next.autoReset = false;
    if (patch.autoReset) next.rememberSettings = false;
    this.current = next;
    this.onChange?.(next);
    this.#writing = true;
    try {
      await settingsItem.setValue(next);
    } finally {
      this.#writing = false;
    }
  }

  async reset() {
    this.current = { ...DEFAULT_SETTINGS };
    this.onChange?.(this.current);
    await settingsItem.setValue(this.current);
  }
}

class UiPrefsStore {
  current = $state<UiPrefs>(structuredClone(DEFAULT_UI_PREFS));
  #writing = false;

  /** Stored values may predate newly added prefs — backfill from defaults. */
  #withDefaults(value: UiPrefs | null): UiPrefs {
    return { ...structuredClone(DEFAULT_UI_PREFS), ...value };
  }

  async init() {
    this.current = this.#withDefaults(await uiPrefsItem.getValue());
    uiPrefsItem.watch((value) => {
      if (this.#writing) return;
      this.current = this.#withDefaults(value);
    });
  }

  async #save() {
    this.#writing = true;
    try {
      await uiPrefsItem.setValue($state.snapshot(this.current));
    } finally {
      this.#writing = false;
    }
  }

  toggleCollapsed(panel: PanelId) {
    this.current.collapsed[panel] = !this.current.collapsed[panel];
    void this.#save();
  }

  toggleSectionCollapsed(section: SectionId) {
    this.current.collapsedSections[section] = !this.current.collapsedSections[section];
    void this.#save();
  }

  setMarkerView(view: UiPrefs['markerView']) {
    this.current.markerView = view;
    void this.#save();
  }

  setFavoritesSort(sort: UiPrefs['favoritesSort']) {
    this.current.favoritesSort = sort;
    void this.#save();
  }

  setLibraryTab(tab: UiPrefs['libraryTab']) {
    this.current.libraryTab = tab;
    void this.#save();
  }

  /** Override a virtual boundary marker's label; empty text restores the
   * default ("Start"/"End"). */
  setBoundaryLabel(which: 'start' | 'end', label: string) {
    this.current.boundaryLabels[which] = label.trim();
    void this.#save();
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
