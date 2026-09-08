import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, transformSync } from 'esbuild';
import { compileModule } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyCommand, emptyLibrary, type Library, type LibraryCommand } from '../persist/library.ts';
import { DEFAULT_PARAMS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';

const stubs: Record<string, string> = {
  '/library-client': 'export const readLibrary = () => h.read(); export const editLibrary = (command) => h.edit(command); export const libraryItem = { watch: (fn) => h.watch = fn };',
  '/library.svelte': 'export const library = h.library;',
  '/session.svelte': 'export const session = h.session;',
  '/settings.svelte': 'export const settings = h.settings;',
  '/markers.svelte': 'export const markers = h.markers;',
  '/snippets.svelte': 'export const snippets = h.snippets;',
  '/chords.svelte': 'export const chords = h.chords;',
  '/side-panel': 'export const openTabWithPanel = (url) => h.navigations.push(url);',
  '/messaging/ports': 'export const connectToTab = () => {};',
  '/messaging/rpc': 'export const sendMessage = () => {};',
  '/persist/sync-config': 'export const DEFAULT_SYNC_CONFIG = {}; export const withSyncDefaults = (v) => v; export const loadSyncConfig = () => h.loadConfig(); export const syncConfigItem = { watch: (fn) => h.watch = fn };',
};
async function bundle(file: string) {
  const built = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'esm', plugins: [{ name: 'panel-test', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => {
        const stub = Object.keys(stubs).find((suffix) => path.endsWith(suffix));
        return stub ? { path: stub, namespace: 'test' } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: 'const h = globalThis.panelTest; ' + stubs[path] }));
      builder.onLoad({ filter: /\.svelte\.ts$/, namespace: 'file' }, ({ path }) => ({
        contents: compileModule(transformSync(readFileSync(path, 'utf8'), { loader: 'ts', target: 'esnext' }).code,
          { filename: path, generate: 'client' }).js.code,
      }));
    } }] });
  return built.outputFiles[0].text;
}
const [trackCode, syncCode, connectionCode] = await Promise.all([
  bundle('./track-sync.svelte.ts'), bundle('../../features/sync/panel/sync.svelte.ts'), bundle('./connect.svelte.ts'),
]);
let instance = 0;
const load = (code: string) => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64') + '#' + instance++);
function harness(initial: Library) {
  let saved = structuredClone(initial);
  const h = {
    library: { current: saved },
    settings: { get current() { return saved.shared.settings; } },
    session: { params: structuredClone(DEFAULT_PARAMS), commands: [] as unknown[],
      patchParams(params: object) { Object.assign(this.params, params); },
      send(command: unknown) { this.commands.push(command); return true; },
      stopSequence() {}, clearLoop() {},
    },
    markers: { list: [] as any[], onPersist: null as any, load(list: any[]) { this.list = list; } },
    snippets: { list: [] as any[], sequenceLoop: false, sequenceCountIn: false, onPersist: null as any,
      load(list: any[], loop: boolean, countIn: boolean) { this.list = list; this.sequenceLoop = loop; this.sequenceCountIn = countIn; } },
    chords: { chart: null, enabled: false, onPersist: null as any, load() {} },
    navigations: [] as string[], edits: [] as LibraryCommand[], watch: null as any,
    async read() { return structuredClone(saved); },
    async edit(command: LibraryCommand) { h.edits.push(command); saved = applyCommand(saved, command); },
    replace(library: Library) { saved = applyCommand(saved, { type: 'import', library }); h.library.current = saved; h.watch(saved); },
  };
  (globalThis as any).panelTest = h;
  (globalThis as any).browser = { tabs: { update: (_id: number, { url }: { url: string }) => h.navigations.push(url) } };
  return h;
}
const a = makeTrackIdentity('chrome-extension://test/local-player.html', 'A.mp3', 100);
const b = makeTrackIdentity('chrome-extension://test/local-player.html', 'B.mp3', 100);
const media = { title: a.title, pageUrl: a.normalizedUrl, duration: 100, hasVideo: false };
const withMarker = (id: string) => applyCommand(emptyLibrary(), { type: 'practice', identity: a,
  patch: { params: DEFAULT_PARAMS, markers: [{ id, t: 3, label: id }] }, recent: true });

test('import replaces active markers and cancels pending parameter saves before another edit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(withMarker('old'));
  const { trackSync } = await load(trackCode);
  trackSync.init();
  await trackSync.onMedia(media);
  h.session.params.speed = 0.5;
  trackSync.onParamsChanged();
  h.replace(withMarker('imported'));
  // Even an input event in the async reload gap cannot save the old list.
  h.markers.onPersist([{ id: 'stale', t: 1, label: '' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.markers.list[0].id, 'imported');
  t.mock.timers.tick(2000);
  assert.equal(h.edits.filter((command) => command.type === 'practice').length, 0);
  h.markers.list[0].t = 20;
  h.markers.onPersist(h.markers.list);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await h.read()).shared.songs[a.key].practice.markers, [{ id: 'imported', t: 20, label: 'imported' }]);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 1);
});

test('opening another local preset keeps the loaded file and applies its parameters in place', async () => {
  const h = harness(withMarker('A marker'));
  const { trackSync } = await load(trackCode);
  trackSync.init();
  await trackSync.onMedia(media);
  await trackSync.openHistoryEntry(4, { identity: b, pageUrl: b.normalizedUrl, updatedAt: 1, params: { ...DEFAULT_PARAMS, speed: 0.6 } });
  assert.deepEqual(h.navigations, []);
  assert.equal(h.session.params.speed, 0.6);
  assert.equal(h.markers.list[0].id, 'A marker');
  h.markers.onPersist(h.markers.list);
  assert.ok((await h.read()).shared.songs[a.key]);
  assert.equal((await h.read()).shared.songs[b.key], undefined);
});

test('sync status changes during the initial read cannot be missed or overwritten', async () => {
  let finish!: (value: unknown) => void;
  const h = { watch: null as any, loadConfig: () => new Promise((resolve) => { finish = resolve; }) };
  (globalThis as any).panelTest = h;
  const { sync } = await load(syncCode);
  const ready = sync.init();
  assert.equal(typeof h.watch, 'function');
  h.watch({ enabled: true, syncing: false, lastError: null });
  finish({ enabled: true, syncing: true });
  await ready;
  assert.equal(sync.status, 'idle');
});

test('engine settings are sent only on meaningful changes or a forced engine attach', async () => {
  const h = harness(emptyLibrary());
  const { pushSettings } = await load(connectionCode);
  pushSettings();
  await h.edit({ type: 'uiPrefs', patch: { markerView: 'list' } });
  pushSettings();
  assert.equal(h.session.commands.length, 1);
  await h.edit({ type: 'settings', patch: { countInBeats: 8 } });
  pushSettings();
  assert.equal(h.session.commands.length, 2);
  pushSettings(true);
  assert.equal(h.session.commands.length, 3);
});
