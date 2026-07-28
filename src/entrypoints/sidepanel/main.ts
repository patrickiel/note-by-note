// Must come first: polyfills `chrome` when previewing outside the extension.
import '@/dev/browser-shim';
import { mount } from 'svelte';
import App from './App.svelte';
import '@/assets/theme.css';

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
