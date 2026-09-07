import type { PanelFeature } from '../../../core/features';
import { library } from './library.svelte';
export const libraryFeature: PanelFeature = { init: () => library.init() };
