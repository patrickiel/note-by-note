import type { PanelFeature } from '../../../core/features';
import { favorites } from './favorites.svelte';
import { history } from './history.svelte';

/** Recent history + favorites load from storage at panel boot. */
export const libraryFeature: PanelFeature = {
  async init() {
    await Promise.all([history.init(), favorites.init()]);
  },
};
