import { storage } from '#imports';
import type { Settings, UiPrefs } from '../model/types';
import { editLibrary, readLibrary, watchLibrary } from './library-client';

/** Feature stores read projections and send changes to the single background writer. */
const settingsOf = (library: Awaited<ReturnType<typeof readLibrary>>): Settings => ({
  ...library.shared.settings.value, lastUsedParams: library.local.lastUsedParams,
});
export const settingsItem = {
  getValue: async () => settingsOf(await readLibrary()),
  setValue: (value: Settings) => editLibrary({ type: 'settings', patch: value }),
  watch: (listener: (value: Settings) => void) => watchLibrary(settingsOf, listener),
};
export const uiPrefsItem = {
  getValue: async () => (await readLibrary()).local.uiPrefs,
  setValue: (value: UiPrefs) => editLibrary({ type: 'uiPrefs', value }),
  watch: (listener: (value: UiPrefs) => void) => watchLibrary((library) => library.local.uiPrefs, listener),
};
export const grantedOriginsItem = storage.defineItem<string[]>('local:grantedOrigins', { fallback: [] });
