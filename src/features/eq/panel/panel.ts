import type { PanelFeature } from '../../../core/features';
import { eqPresets } from './eq-presets.svelte';

/** User-saved EQ presets load from storage at panel boot. */
export const eqFeature: PanelFeature = {
  init: () => eqPresets.init(),
};
