import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// Persistent dev profile: extensions installed here (e.g. uBlock Origin
// Lite for YouTube-breakage repros), logins, and site data survive between
// `pnpm dev` runs. Delete .wxt/chrome-data to start fresh.
// chrome-launcher expects the directory to exist (it opens chrome-out.log
// inside it without creating it), so ensure it here.
const chromiumProfile = resolve('.wxt/chrome-data');
mkdirSync(chromiumProfile, { recursive: true });

/** chrome-launcher shallow-merges web-ext's prefs into the profile's
 * Preferences file on every launch, and web-ext always writes
 * `extensions.ui.developer_mode` — replacing the profile's ENTIRE
 * `extensions` section, which is where toolbar pins and extension keyboard
 * shortcuts live. Read the current section and pass it back through so the
 * overwrite round-trips it instead of wiping it. */
function preservedExtensionsPrefs(): Record<string, unknown> {
  let extensions: Record<string, unknown> = {};
  try {
    const prefsPath = resolve(chromiumProfile, 'Default/Preferences');
    extensions = JSON.parse(readFileSync(prefsPath, 'utf8')).extensions ?? {};
  } catch {
    // First launch: no Preferences file yet.
  }
  return {
    ...extensions,
    ui: { ...(extensions.ui as Record<string, unknown>), developer_mode: true },
  };
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  targetBrowsers: ['chrome', 'firefox'],
  // Firefox defaults to MV2 in WXT, which would drop `optional_host_permissions`
  // (MV3-only) without translating it — `permissions.request()` could then never
  // succeed. Firefox has shipped MV3 event pages since 109 and
  // `optional_host_permissions` since 127, so both targets build MV3.
  manifestVersion: 3,
  // onnxruntime-web (chord model runtime, dynamically imported in the panel)
  // ships .mjs worker/wasm glue that Vite's dev dep-optimizer can't pre-bundle
  // — it looks for ort-wasm-*.mjs under .vite/deps and fails. Exclude it so dev
  // serves it as-is (the production build bundles it normally).
  vite: () => ({
    plugins: [tailwindcss()],
    optimizeDeps: { exclude: ['onnxruntime-web'] },
  }),
  hooks: {
    // Keep the worklet bundles fresh in dev/build/zip.
    'build:before': async () => {
      const [vocal, rubberband, pcmTap] = await Promise.all([
        // @ts-ignore -- plain .mjs build scripts without type declarations
        import('./scripts/build-vocal-worklet.mjs'),
        // @ts-ignore
        import('./scripts/build-rubberband-worklet.mjs'),
        // @ts-ignore
        import('./scripts/build-pcm-tap-worklet.mjs'),
      ]);
      await Promise.all([
        vocal.buildWorklet(),
        rubberband.buildWorklet(),
        pcmTap.buildWorklet(),
      ]);
    },
  },
  webExt: {
    // WXT_NO_LAUNCH=1 skips the auto-launched dev browser; load
    // .output/chrome-mv3 unpacked in a regular Chrome instead (HMR still
    // connects to the dev server).
    disabled: process.env.WXT_NO_LAUNCH === '1',
    chromiumProfile,
    keepProfileChanges: true,
    chromiumPref: {
      extensions: preservedExtensionsPrefs(),
    },
  },
  manifest: ({ mode, browser }) => ({
    // E2E runs can't click native permission prompts — grant hosts up front.
    // Nothing is required otherwise: a required host would make Chrome disable
    // the extension on update until re-approved, and Firefox treats MV3
    // `host_permissions` as opt-in anyway.
    ...(mode === 'testing' ? { host_permissions: ['<all_urls>'] } : {}),
    name:
      browser === 'firefox'
        // AMO hard-caps manifest name at 45 characters.
        ? 'Note by Note ♪ Pitch Shifter ♭ Slow Down'
        : 'Note by Note ♪ Pitch Shifter ♯ Transpose ♭ Slow Down ⏱ Loop ⟳ Vocal Remover',
    short_name: 'Note by Note',
    description: 'Practice music with pitch, speed, loops, and snippets on any audio or video.',
    homepage_url: 'https://github.com/patrickiel/note-by-note',
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              // MV3 requires an explicit add-on id.
              id: 'note-by-note@patrickiel.github.io',
              // Floor set by the newest key below, not by the APIs:
              // `optional_host_permissions` landed in 127, but
              // `data_collection_permissions` only in 140 — which is also the
              // current ESR line, so nothing supported is left behind.
              strict_min_version: '140.0',
              // Recent/Favorites carry the page URL, title and thumbnail of
              // every track practised, and with sync on (the default —
              // DEFAULT_SYNC_CONFIG.enabled) they leave the device through
              // Firefox Sync's extension storage. AMO counts that as browsing
              // activity; `required` rather than `optional` so the manifest
              // matches the submission form (a contradiction is a rejection).
              // Nothing else is declared: no audio, no page content, no
              // telemetry, and no server of ours. See PRIVACY.md.
              data_collection_permissions: { required: ['browsingActivity'] },
            },
            // Firefox for Android has no sidebar, so this is a floor rather
            // than a claim of support — 142 is where it learned
            // `data_collection_permissions`.
            gecko_android: { strict_min_version: '142.0' },
          },
        }
      : { minimum_chrome_version: '116' }),
    // `sidePanel` is added by WXT itself from the sidepanel entrypoint (Firefox
    // gets `sidebar_action`, which needs no permission). `tabCapture` and
    // `offscreen` are Chromium-only APIs — see src/core/platform.ts, which
    // gates every caller on the same build target. No `identity`: without
    // `identity.email` (an install warning) it cannot tell whether the
    // profile's sync is on, which was the only question it was asked.
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'tabs',
      ...(browser === 'firefox' ? [] : ['tabCapture', 'offscreen']),
    ],
    // What Connect asks for, in a user gesture — never at install time.
    optional_host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Note by Note',
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    web_accessible_resources: [
      {
        // Only the worklets need this: the page's own AudioContext fetches them
        // via `audioWorklet.addModule`. Content scripts are injected through
        // `scripting.executeScript`/`registerContentScripts`, which don't
        // consult this list — exposing them would only help a page fingerprint
        // the extension.
        resources: ['worklets/*'],
        matches: ['<all_urls>'],
      },
    ],
  }),
});
