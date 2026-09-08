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
  '/messaging/ports': 'export const connectToTab = () => h.port;',
  '/messaging/rpc': 'export const sendMessage = (...args) => h.rpc(...args);',
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
const [trackCode, syncCode, connectionCode, sessionCode] = await Promise.all([
  bundle('./track-sync.svelte.ts'), bundle('../../features/sync/panel/sync.svelte.ts'), bundle('./connect.svelte.ts'),
  bundle('./session.svelte.ts'),
]);
let instance = 0;
const load = (code: string) => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64') + '#' + instance++);
async function harness(initial: Library) {
  let saved = structuredClone(initial);
  const { session } = await load(sessionCode);
  const h = {
    library: { current: structuredClone(saved) },
    settings: { get current() { return saved.shared.settings; } },
    session, commands: [] as unknown[], autoPublish: true,
    markers: { list: [] as any[], onPersist: null as any, load(list: any[]) { this.list = list; } },
    snippets: { list: [] as any[], sequenceLoop: false, sequenceCountIn: false, onPersist: null as any,
      load(list: any[], loop: boolean, countIn: boolean) { this.list = list; this.sequenceLoop = loop; this.sequenceCountIn = countIn; } },
    chords: { chart: null, enabled: false, onPersist: null as any, load() {}, onDisconnect() {} },
    rpc: async (..._args: unknown[]): Promise<any> => ({ ok: true }),
    port: { disconnected: false, disconnect() {}, onMessage() {}, onDisconnect() {}, send(_command: unknown) {} },
    navigations: [] as string[], edits: [] as LibraryCommand[], watch: null as any,
    async read() { return structuredClone(saved); },
    async edit(command: LibraryCommand) {
      h.edits.push(structuredClone(command));
      saved = applyCommand(saved, JSON.parse(JSON.stringify(command)));
      if (h.autoPublish) h.publish();
      return saved.shared.updatedAt;
    },
    publish() { h.library.current = structuredClone(saved); h.watch?.(h.library.current); },
    replace(library: Library) { saved = applyCommand(saved, { type: 'import', library }); h.publish(); },
  };
  (globalThis as any).panelTest = h;
  (globalThis as any).browser = { tabs: { update: (_id: number, { url }: { url: string }) => h.navigations.push(url) } };
  session.attachTransport((command: unknown) => h.commands.push(command));
  return h;
}
async function connectTrack(h: Awaited<ReturnType<typeof harness>>) {
  const { trackSync } = await load(trackCode);
  trackSync.init();
  h.session.onUserParamsChange = () => trackSync.onParamsChanged();
  h.session.onEngineDetached = () => trackSync.onEngineLost();
  return trackSync;
}
const a = makeTrackIdentity('chrome-extension://test/local-player.html', 'A.mp3', 100);
const b = makeTrackIdentity('chrome-extension://test/local-player.html', 'B.mp3', 100);
const media = { title: a.title, pageUrl: a.normalizedUrl, duration: 100, hasVideo: false };
const withMarker = (id: string) => applyCommand(emptyLibrary(), { type: 'practice', identity: a,
  patch: { params: DEFAULT_PARAMS, markers: [{ id, t: 3, label: id }] }, recent: true });

test('real session restoration reaches the engine without triggering a user edit', async () => {
  const h = await harness(emptyLibrary());
  let edits = 0;
  h.session.onUserParamsChange = () => edits++;
  h.session.restoreParams({ ...DEFAULT_PARAMS, speed: 0.6 });
  assert.equal(h.session.params.speed, 0.6);
  assert.equal(edits, 0);
  assert.equal((h.commands[0] as any).patch.speed, 0.6);
  h.session.patchParams({ speed: 0.8 });
  assert.equal(edits, 1);
});

test('remembered edits work before connecting and on immediate track switches before storage echoes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = applyCommand(emptyLibrary(), { type: 'settings', patch: {
    rememberSettings: true, lastUsedParams: { ...DEFAULT_PARAMS, speed: 0.9 },
  } });
  const h = await harness(initial);
  const trackSync = await connectTrack(h);
  h.autoPublish = false;
  h.session.patchParams({ speed: 0.7 });
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).local.lastUsedParams!.speed, 0.7);
  assert.deepEqual((await h.read()).shared.songs, {});
  await trackSync.onMedia(media);
  assert.equal(h.session.params.speed, 0.7);
  h.session.patchParams({ speed: 0.6 });
  await trackSync.onMedia({ ...media, title: b.title });
  assert.equal(h.session.params.speed, 0.6);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.6);
  h.publish();
  // Imported preferences and last-used values replace all pending local ones.
  const imported = applyCommand(emptyLibrary(), { type: 'settings', patch: {
    rememberSettings: true, lastUsedParams: { ...DEFAULT_PARAMS, speed: 0.8 },
  } });
  h.session.patchParams({ speed: 0.5 });
  h.replace(imported);
  assert.equal(h.session.params.speed, 0.8);
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).local.lastUsedParams!.speed, 0.8);
});

test('track changes use the ready mirror and a visit failure cannot mix song data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = applyCommand(withMarker('A marker'), { type: 'practice', identity: b,
    patch: { params: { ...DEFAULT_PARAMS, speed: 0.6 }, markers: [{ id: 'B', t: 7, label: 'B marker' }] }, recent: true });
  const h = await harness(initial);
  const trackSync = await connectTrack(h);
  t.mock.method(h, 'read', async () => { throw new Error('The worker read is unavailable'); });
  await trackSync.onMedia(media);
  t.mock.timers.tick(2000);
  assert.equal(h.edits.filter((c) => c.type === 'practice').length, 0);
  const edit = h.edit.bind(h);
  t.mock.method(h, 'edit', (command: LibraryCommand) => command.type === 'visit'
    ? Promise.reject(new Error('Visit failed')) : edit(command));
  await assert.rejects(trackSync.onMedia({ ...media, title: b.title }), /Visit failed/);
  assert.equal(h.markers.list[0].id, 'B');
  h.markers.list[0].t = 9;
  h.markers.onPersist(h.markers.list);
  t.mock.timers.tick(2000);
  assert.equal(h.library.current.shared.songs[a.key].practice.markers[0].t, 3);
  assert.equal(h.library.current.shared.songs[b.key].practice.markers[0].t, 9);
});

test('pending edits capture their track and values before an engine snapshot replaces parameters', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  h.session.patchParams({ speed: 0.75 });
  // An incoming engine snapshot changes params before it reports the new media.
  h.session.params = structuredClone(DEFAULT_PARAMS);
  await trackSync.onMedia({ ...media, title: b.title });
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.75);
  assert.equal((await h.read()).shared.songs[a.key].practice.pageUrl, media.pageUrl);
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).shared.songs[b.key], undefined);
});

test('rapid return and explicit reopen retain edits until the library watch catches up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  h.autoPublish = false;
  h.session.patchParams({ speed: 0.75 });
  h.markers.list[0].t = 12;
  h.markers.onPersist(h.markers.list);
  await trackSync.onMedia({ ...media, title: b.title });
  assert.equal(h.library.current.shared.songs[a.key].practice.params!.speed, 1);
  await trackSync.onMedia(media);
  assert.equal(h.session.params.speed, 0.75);
  assert.equal(h.markers.list[0].t, 12);
  await trackSync.openHistoryEntry(4, { identity: a, pageUrl: a.normalizedUrl, updatedAt: 1, params: DEFAULT_PARAMS });
  assert.equal(h.session.params.speed, 0.75);
  h.publish();
  await h.edit({ type: 'practice', identity: a, patch: { params: { ...DEFAULT_PARAMS, speed: 0.9 } }, recent: true });
  h.publish();
  // Acknowledged patches must not mask subsequent library changes.
  await trackSync.openHistoryEntry(4, { identity: a, pageUrl: a.normalizedUrl, updatedAt: 1, params: DEFAULT_PARAMS });
  assert.equal(h.session.params.speed, 0.9);
});

test('marker and snippet bursts share one immutable save and engine detach flushes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  for (let i = 0; i < 50; i++) {
    h.markers.list[0].t = i;
    h.markers.onPersist(h.markers.list);
  }
  h.snippets.list = [{ id: 's', name: 'Verse', startT: 2, endT: 8, repeats: Infinity, enabled: true, overrides: {} }];
  h.snippets.onPersist();
  assert.equal(h.edits.filter((c) => c.type === 'practice').length, 0);
  // Mutating the live store later cannot alter the already queued edit.
  h.markers.list[0].t = 99;
  h.session.detachTransport();
  const practice = (await h.read()).shared.songs[a.key].practice;
  assert.equal(practice.markers[0].t, 49);
  assert.equal(practice.snippets[0].endT, 8);
  assert.equal(practice.snippets[0].repeats, null);
  assert.equal(h.edits.filter((c) => c.type === 'practice').length, 1);
  await trackSync.onMedia(media);
  h.session.patchParams({ speed: 0.7 });
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.7);
});

test('failed hydration leaves no writable track and a later load can recover', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  const loadMarkers = h.markers.load.bind(h.markers);
  let failed = false;
  t.mock.method(h.markers, 'load', (list: any[]) => {
    if (!failed) { failed = true; throw new Error('Cannot hydrate'); }
    loadMarkers(list);
  });
  await assert.rejects(trackSync.onMedia({ ...media, title: b.title }), /Cannot hydrate/);
  assert.deepEqual(h.markers.list, []);
  h.session.patchParams({ speed: 0.5 });
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).shared.songs[b.key], undefined);
  await trackSync.onMedia({ ...media, title: b.title });
  h.session.patchParams({ speed: 0.6 });
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).shared.songs[b.key].practice.params!.speed, 0.6);
});

test('a later edit survives acknowledgement of an earlier save and panel flush commits it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  h.autoPublish = false;
  h.session.patchParams({ speed: 0.8 });
  trackSync.flush();
  h.session.patchParams({ speed: 0.6 });
  await new Promise((resolve) => setImmediate(resolve));
  h.publish();
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.8);
  await trackSync.onMedia({ ...media, title: b.title });
  await trackSync.onMedia(media);
  assert.equal(h.session.params.speed, 0.6);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.6);
});

test('engine loss while a visit is in flight cannot disable later saves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  const edit = h.edit.bind(h);
  let finish!: () => void;
  let delay = true;
  t.mock.method(h, 'edit', async (command: LibraryCommand) => {
    if (command.type === 'visit' && delay) {
      delay = false;
      await new Promise<void>((resolve) => { finish = resolve; });
    }
    return edit(command);
  });
  const loading = trackSync.onMedia(media);
  h.session.detachTransport();
  finish();
  await loading;
  await trackSync.onMedia(media);
  h.session.patchParams({ speed: 0.7 });
  t.mock.timers.tick(2000);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.7);
});

test('import replaces active markers and cancels pending parameter saves before another edit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('old'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  h.session.patchParams({ speed: 0.5 });
  h.replace(withMarker('imported'));
  // Replacement is synchronous, so there is no gap with the old stores.
  assert.equal(h.markers.list[0].id, 'imported');
  t.mock.timers.tick(2000);
  assert.equal(h.edits.filter((command) => command.type === 'practice').length, 0);
  h.markers.list[0].t = 20;
  h.markers.onPersist(h.markers.list);
  t.mock.timers.tick(2000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await h.read()).shared.songs[a.key].practice.markers, [{ id: 'imported', t: 20, label: 'imported' }]);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 1);
});

test('opening another local preset preserves pending edits and never saves the preview onto the loaded file', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(withMarker('A marker'));
  const trackSync = await connectTrack(h);
  await trackSync.onMedia(media);
  h.session.patchParams({ speed: 0.8 });
  await trackSync.openHistoryEntry(4, { identity: b, pageUrl: b.normalizedUrl, updatedAt: 1, params: { ...DEFAULT_PARAMS, speed: 0.6 } });
  assert.deepEqual(h.navigations, []);
  assert.equal(h.session.params.speed, 0.6);
  assert.equal(h.markers.list[0].id, 'A marker');
  h.markers.onPersist(h.markers.list);
  t.mock.timers.tick(2000);
  assert.ok((await h.read()).shared.songs[a.key]);
  assert.equal((await h.read()).shared.songs[a.key].practice.params!.speed, 0.8);
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
  const h = await harness(emptyLibrary());
  const { pushSettings } = await load(connectionCode);
  pushSettings();
  await h.edit({ type: 'uiPrefs', patch: { markerView: 'list' } });
  pushSettings();
  assert.equal(h.commands.length, 1);
  await h.edit({ type: 'settings', patch: { countInBeats: 8 } });
  pushSettings();
  assert.equal(h.commands.length, 2);
  pushSettings(true);
  assert.equal(h.commands.length, 3);
});

test('an injection RPC rejection uses connection state and keeps reconnect listeners working', async (t) => {
  const h = await harness(withMarker('A marker'));
  const global = globalThis as any;
  const previousLocation = global.location;
  global.location = { search: '?tabId=4' };
  t.after(() => { global.location = previousLocation; });
  let onUpdated: (tabId: number, info: object) => void = () => {};
  global.browser = {
    runtime: { getURL: (path: string) => 'chrome-extension://test' + path },
    permissions: { contains: async () => true },
    tabs: { get: async () => ({ id: 4, url: 'https://example.com/song' }),
      onUpdated: { addListener: (fn: typeof onUpdated) => { onUpdated = fn; } } },
  };
  let attempts = 0;
  h.rpc = async () => {
    if (++attempts === 1) throw new Error('Worker restarted');
    return { ok: true };
  };
  t.mock.method(console, 'error', () => {});
  const send = t.mock.method(h.port, 'send', (_command: unknown) => {});
  const { connection } = await load(connectionCode);
  await connection.init();
  assert.equal(h.session.connection, 'stale');
  assert.equal((await h.read()).shared.songs[a.key].practice.markers[0].id, 'A marker');
  onUpdated(4, { status: 'complete' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.ok(send.mock.calls.some((call) => (call.arguments[0] as any)?.type === 'hello'));
});
