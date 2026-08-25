# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Note by Note** (package name `note-by-note`) is a Chrome/Firefox MV3 extension for practicing music along with any browser audio/video: pitch shift, speed, loop ranges, timeline markers, chained practice snippets, vocal reducer, and 10-band EQ. Built with WXT + Svelte 5 (runes) + TypeScript. Dev environment is Windows/PowerShell — chain shell commands with `;`, use `pnpm`.

## Commands

```powershell
pnpm install          # runs postinstall: wxt prepare + generates both worklet bundles
pnpm dev              # launch Chrome with the extension + HMR (uses a persistent .wxt/chrome-data profile)
pnpm dev:firefox      # same, Firefox
pnpm check            # svelte-check / TypeScript — the only type/lint gate
pnpm build            # production build → .output/chrome-mv3
pnpm zip              # store package
pnpm test:dsp         # fast DSP unit tests (node --test on src/features/**/*.test.ts)
pnpm release:dry      # show the release plan (version bump, tag) without changing anything
pnpm release          # full release: check + test, bump patch, build both zips, commit, tag, push
```

[scripts/release.ps1](scripts/release.ps1) is the release path. It refuses to run on a dirty tree, on a
branch other than `main`, when `main` is behind `origin/main`, or when the tag already exists; unpushed
commits are fine (they go out with the release). Non-patch bumps take a flag, so run the script directly:
`.\scripts\release.ps1 -Bump minor` (also `-Bump major`, `-Version 2.0.0`, `-SkipTests`, `-Branch <name>`).
If a build fails after the version was written, the bump is reverted. The zips land in `.output/`
(Chrome store zip, Firefox zip, and the sources zip AMO requires).

- `WXT_NO_LAUNCH=1 pnpm dev` skips the auto-launched browser; load `.output/chrome-mv3` unpacked in a normal Chrome (HMR still connects).
- **UI preview without an extension context** (mock data + in-memory `chrome` shim): build, serve `.output/chrome-mv3` statically, open `sidepanel.html?mock=1`.
- **Run a single DSP test**: `node --test src/features/vocal-reducer/engine/center-cut-dsp.test.ts` (or `node --test --test-name-pattern "WOLA" src/features/vocal-reducer/engine/center-cut-dsp.test.ts`).

### E2E (real browser, measures processed audio output)
```powershell
pnpm dlx @puppeteer/browsers install chrome@stable --path ./.browsers   # once
node e2e/make-tone.mjs ; node e2e/make-stereo-mix.mjs                    # once, generates WAV fixtures
pnpm wxt build --mode testing   # `testing` mode grants <all_urls> host perms so no native prompts block the run
node e2e/run.mjs                # add --headful to watch
```
The harness plays a 440 Hz tone and asserts on the **processed output** (e.g. 880 Hz after +12 st) via `window.__noteByNoteDebug` in the content script and `window.__panelDebug` in the side panel.

### Sync server (`server/`, separate pnpm workspace)
`cd server ; pnpm install` — it has its own lockfile, `tsconfig.json` (Cloudflare Workers types), and is `exclude`d from the root tsconfig. See [server/README.md](server/README.md) for deploy. `pnpm run dev` there serves `http://localhost:8787`, which the extension's dev build targets automatically.

## Architecture

This is a **multi-context extension**. The single most important structural fact: **the audio engine lives in the page (content script), not in the side panel.** The side panel is a thin UI mirror that connects to the engine over a typed `chrome.runtime` Port. This is why practice flows (loops, sequences, playback) survive the side panel closing.

### Source layout (vertical feature slices)
The tree is organized by **feature**, not by layer:
- **`src/core/`** — shared platform: `engine/` (controller, media-engine/-detect, attach-audio), `audio/` (pipeline, fft, silence-detector), `messaging/` (protocol shell, ports, rpc), `model/` (shared types + defaults + format + track-identity + thumbnail), `persist/` (storage, backup, track-data descriptor registry), `state/` (session, track-sync, connect, view), and `features.ts` (the panel-feature registry).
- **`src/features/<feature>/`** — one folder per product feature (chords, pitch, speed, vocal-reducer, eq, loops, markers, snippets, count-in, library, sync, settings, shortcuts), each with an `engine/` subfolder (content-script code: worklets, schedulers, DSP factories) and/or a `panel/` subfolder (side-panel stores + components), plus optional `protocol.ts` (its wire-message fragment), `panel/panel.ts` (registration object), and `persist.svelte.ts` (per-track descriptor). **`engine/` and `panel/` never cross-import**, so the content and panel bundles stay separate.
- **`src/ui/`** — shared/presentational UI (Workspace, Panel, PanelStack, Timeline, chrome bars, `shared/` primitives, icons, dismiss).
- **`src/dev/`** — preview-only helpers (`browser-shim`, `mock`).
- **`src/entrypoints/`** — thin WXT composition roots (unchanged location).

**Dependency direction:** `entrypoints → core composition roots (pipeline, controller, protocol, App, features.ts, track-sync) → features → core primitives (model, messaging, audio/fft, ui)`. Composition roots **import feature contributions** (the "light registration"); **features never import the orchestrators**. Domain types stay central in `core/model/types.ts` (they are the shared engine↔panel wire + persistence contract).

### Execution contexts (`src/entrypoints/`)
- **`sidepanel/`** — the Svelte UI. Holds no engine state of its own; mirrors the active tab's engine.
- **`content.ts` → `src/core/engine/`** — the engine. Media detection, connection state machine, transport, and the Web Audio DSP chain; the loop/sequence/count-in schedulers it drives live in `src/features/*/engine/`. Guards against double-boot via `window.__noteByNote`; tears down on `ctx.onInvalidated` (extension reload) to avoid orphaned instances fighting the page.
- **`offscreen/`** — hosts the tab-capture DSP pipeline (one `AudioContext` per captured tab). Same shared pipeline as direct mode.
- **`background.ts`** — service worker broker: per-origin permission grants, content-script registration/injection, tab-capture stream brokering, offscreen document lifecycle. Reconciles the persistent content-script registration from the actual `permissions` API (single source of truth) on every permission change or worker restart. Also owns tab-scoped panel visibility (Chromium): the side panel is disabled by default and the icon click toggles it per tab, so Chrome hides it on other tabs and re-shows it on return. Chrome gives each tab its own panel document, opened at `sidepanel.html?tabId=N` so the panel pins itself to that tab and the worker can recognise the document in `runtime.getContexts` (which reports `tabId: -1` for side panels). Measured gotchas, all documented in [core/side-panel.ts](src/core/side-panel.ts): the toolbar click's gesture dies at the first `await` in the worker, so the toggle snapshots "is it showing" via `getContexts`, fires `setOptions` + `open` synchronously (a no-op when already open), and disables the tab afterwards if the snapshot said it was showing; enabling a tab does not show the panel there, so panel-initiated new tabs (local player, Songs list) go through `openTabWithPanel` **from the panel document** (whose click activation survives awaits), not via the background. Firefox's sidebar is window-global — no per-tab behavior.
- **`local-player/`** — a full extension page that plays local files and speaks the same engine protocol via its own tab.

### Three connection modes (the fallback chain)
1. **Direct** — Web Audio pipeline attached straight to the page's `<media>` element. Full feature set (YouTube works).
2. **Tab capture** — fallback when the element is CORS-tainted, DRM'd, or the page CSP blocks the worklet: all tab audio is processed in the offscreen document (pitch only; transport still drives the element if one exists). Shows as `connected-capture` or `connected-hybrid`.
3. **Local file** — the local-player page, where everything works.

`ConnectionState` transitions (`detecting → connected-direct / pitch-unavailable / media-paused / restricted / no-player / stale …`) are driven by [controller.ts](src/core/engine/controller.ts) engine-side and mirrored into `session.connection` panel-side.

### Shared audio pipeline (`src/core/audio/`)
[pipeline.ts](src/core/audio/pipeline.ts) is a **composition root**: it imports each feature's DSP stage factory from `src/features/*/engine/` and wires **one wet/dry graph used identically** by the content script, offscreen document, and local player:
```
source ─┬─ dryGain ───────────────────────────────────────┬─ master ─ destination
        └─ wetIn ─ reducer ─┬─ stretch ─ stretchWet ─┬─ eq ┘
                            └─ stretchBypass ─────────┘
```
- dry⇄wet crossfade = the **Power** toggle; stretch bypass = zero-latency path while pitch is neutral (preserves A/V sync for speed-only).
- Two WASM AudioWorklets: **Rubber Band** (pitch — the realtime R3 "Finer" engine, `src/features/pitch/engine/rubberband.worklet.ts`) and the **first-party vocal reducer** (STFT center-cut, `src/features/vocal-reducer/engine/vocal-reducer.worklet.ts`, DSP core in `center-cut-dsp.ts` + shared `src/core/audio/fft.ts`). Loads overlap via `Promise.all`; if a worklet fails, the dry route stays live so audio never drops. (A third, non-WASM analysis worklet — the PCM tap for chord detection — lives in `src/features/chords/engine/pcm-tap.worklet.ts`.)

### Worklets & CSP (important, non-obvious)
Both worklet processors are shipped as **static files under `public/worklets/`** and loaded from `chrome-extension://` URLs, because Blob-URL worklets are blocked by the extension CSP and many sites' CSP.
- The Rubber Band worklet bundles the GPL `@echogarden/rubberband-wasm` Emscripten glue via `scripts/build-rubberband-worklet.mjs` (esbuild → IIFE). Its WASM ships **separately** as `public/worklets/rb.wasm` (copied from the npm package by `scripts/copy-rubberband-wasm.mjs` at postinstall; committed): the main thread `fetch`es those bytes and hands them to the processor via `processorOptions.wasmBytes`, which the worklet instantiates with `wasmBinary`/`instantiateWasm` — no fetch/eval/Blob inside the worklet, so it stays CSP-safe. The generated `rubberband-worklet.js` is **gitignored** — you must `pnpm install` before anything audio-related works.
- The vocal-reducer bundle is built by `scripts/build-vocal-worklet.mjs` and the PCM tap by `scripts/build-pcm-tap-worklet.mjs` (esbuild → IIFE). All worklet bundles are built at postinstall **and rebuilt on every `wxt build`** via the `build:before` hook in [wxt.config.ts](wxt.config.ts); the `build-*-worklet.mjs` `entryPoints` point at `src/features/*/engine/*.worklet.ts` (outputs stay `public/worklets/*.js`). **In `postinstall` the build scripts must run *before* `wxt prepare`**, because `wxt prepare` derives the `PublicPath` union in `.wxt/types/paths.d.ts` from the files actually present in `public/` — prepare first and the three `browser.runtime.getURL('/worklets/…')` call sites fail `pnpm check` on any fresh clone (they pass on a warm tree only because a later prepare regenerates the types). Because those esbuild bundles have **no `@/` alias**, worklet sources and anything they import must use **relative** imports. Editing a `src/features/*/engine/*.worklet.ts` or `center-cut-dsp.ts` mid-`pnpm dev` does **not** hot-reload — rerun the matching `scripts/build-*-worklet.mjs` (or restart the dev server).
- Pages whose CSP lacks `wasm-unsafe-eval` make the pitch worklet's ready handshake time out → "Pitch not available" + tab-capture prompt (verified in E2E).

### Messaging (`src/core/messaging/`)
[protocol.ts](src/core/messaging/protocol.ts) composes the wire protocol from **per-feature fragments** (`src/features/<f>/protocol.ts`) — each feature declares its own `EngineEvent`/`EngineCommand` members and `protocol.ts` unions them (the `snapshot` event keeps its per-feature fields inline as a documented exception). Change a fragment or the shell and both ends must follow:
- `EngineEvent` (engine → panel) and `EngineCommand` (panel → engine) flow over `TypedPort` (a thin typed wrapper around `chrome.runtime.Port`, `ports.ts`). ~30 Hz playhead updates.
- `OffscreenCommand` — background → offscreen `runtime` messages (offscreen filters by `target: 'offscreen'`).
- `ProtocolMap` — request/response RPC handled by the background worker via `@webext-core/messaging` (`ensureInjected`, `startCapture`, `revokeAllPermissions`, etc.).

### State layer (Svelte 5 runes stores, `*.svelte.ts`)
Runes stores (classes with `$state`), one singleton exported per file. All panel-side. Split by ownership:
- **Core (`src/core/state/`):** `session` — mirror of the active tab's engine + the command surface panels call (while no engine is attached, commands fall back to **optimistic local state**, staged and pushed on connect); `connection` (`connect.svelte.ts`) — owns the port lifecycle (one `<all_urls>` prompt from the banner's Connect button in a user gesture, injection, reconnect, capture start/stop; a `#generation` counter drops stale async work) and iterates the **panel-feature registry** ([core/features.ts](src/core/features.ts)) to route engine events into feature stores; `track-sync` — reacts to track changes (auto-save to Recent, reset/remember/carry-over params) and iterates the **per-track descriptor registry** ([core/persist/track-data.ts](src/core/persist/track-data.ts)) to swap each feature's slice in/out of storage; `view`.
- **Feature-owned (`src/features/<f>/panel/`):** `markers`, `snippets`, `chords`, `settings`, `favorites`/`history` (library), `eq-presets`, `shortcuts`. Preview data (`mock`) lives in `src/dev/`.
- Features contribute boot init + event routing via `panel/panel.ts` (registered in `core/features.ts`) and per-track persistence via `persist.svelte.ts` (registered in `core/persist/track-data.ts`).

### Persistence & sync
- [storage.ts](src/core/persist/storage.ts) — WXT `storage.defineItem` wrappers (the full storage schema stays central here). **Per-track data is keyed by a normalized track identity** ([track-identity.ts](src/core/model/track-identity.ts)): site-aware URL normalization (strips `t`/`si`/`utm_*` etc.; collapses YouTube to `watch?v=`) + rounded duration, hashed to `local:track:<key>`. The per-track `TrackData` record is assembled/scattered by feature descriptors ([core/persist/track-data.ts](src/core/persist/track-data.ts)). EQ presets and granted origins live in their own items so "Reset Settings" can't wipe them.
- Optional **cross-device sync** (`src/features/sync/` + `server/`): last-write-wins backup snapshots to a Cloudflare Worker + KV. The secret sync ID **is the whole capability** (open CORS, no other auth). `SYNC_ENDPOINT` in [api.ts](src/features/sync/panel/api.ts) points at localhost in dev, the deployed Worker in prod.

## Conventions & gotchas
- Path alias `@/` → `src/` (so `@/core/*`, `@/features/*`, `@/ui/*`, `@/dev/*` all resolve). WXT provides the `#imports` virtual module (`storage`, `defineBackground`, `defineContentScript`, the `browser` global) — no explicit import of `browser`.
- **`@/` does not work in two contexts** (they don't share the WXT/Vite resolver): the `node --test` DSP files (`src/features/**/*.test.ts` and the modules they import as *values* — `fft.ts`, `center-cut-dsp.ts`, `detect-bpm.ts`) must use **relative imports with explicit `.ts` extensions**; the esbuild worklet bundles (`src/features/*/engine/*.worklet.ts`) must use **relative imports**. (`import type` is erased, so type-only imports may omit the extension.)
- **Both browsers build MV3** (`manifestVersion: 3` is pinned in [wxt.config.ts](wxt.config.ts) — Firefox would otherwise default to MV2 and drop `optional_host_permissions`). Chromium-only APIs are gated on the build-time flags in [core/platform.ts](src/core/platform.ts) (`CAN_CAPTURE_TAB`, `HAS_SIDE_PANEL_API`), never on runtime `browser.*` probes: Firefox has no `tabCapture`/`offscreen` (so no capture fallback — the offscreen entrypoint is excluded from that build) and no `sidePanel` (the same page is registered as `sidebar_action`). Panel-side the capability travels as a **prop**: an absent `oncapture`/`ontabaudio` is what makes the shared UI drop the affordance.
- Debug globals are named `__noteByNote*` / `__panelDebug`. The processor name literal is `note-by-note-center-cut` and **must match on both sides** (`vocal-reducer.worklet.ts` registers it, `vocal-reducer.ts` constructs it) — mismatches throw `InvalidStateError` at runtime and `tsc` won't catch them.
- A `MediaElementSource` can be created only once per element per document lifetime, so **extension reloads require a page reload** to reattach.
- The `README.md` is the best prose overview.
- There is no test runner config beyond `node --test`; `pnpm check` (svelte-check) is the type gate. There is no ESLint/Prettier config — match surrounding style.
