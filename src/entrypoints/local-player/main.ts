import { mount } from 'svelte';
import LocalPlayer from './LocalPlayer.svelte';
import '@/assets/theme.css';
import { applyTheme } from '@/features/settings/panel/settings.svelte';
import { settingsItem } from '@/core/persist/storage';

// Match the side panel's chosen theme. Apply 'auto' synchronously (follows the
// OS, live) to avoid a flash, then refine from the stored choice once loaded.
applyTheme('auto');
void settingsItem
  .getValue()
  .then((s) => applyTheme(s?.theme ?? 'auto'))
  .catch(() => {});

const app = mount(LocalPlayer, {
  target: document.getElementById('app')!,
});

export default app;
