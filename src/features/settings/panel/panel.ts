import type { PanelFeature } from '../../../core/features';
import { settings, uiPrefs } from './settings.svelte';

/** Settings + cosmetic UI prefs load from storage at panel boot. */
export const settingsFeature: PanelFeature = {
  async init() {
    await Promise.all([settings.init(), uiPrefs.init()]);
  },
};
