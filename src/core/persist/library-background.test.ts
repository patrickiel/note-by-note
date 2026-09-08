import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { applyCommand, emptyLibrary } from './library.ts';
import { bytesUsed, encodeSnapshot, readSnapshot, PREFIX, SNAPSHOT_KEY } from '../../features/sync/persist/records.ts';

// Bundle the real worker with only its browser/RPC boundaries replaced. Each
// start gets fresh queues and listeners while its saved storage/alarms survive.
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./library-background.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'browser-test', setup(builder) {
    builder.onResolve({ filter: /^(#imports)$|\/messaging\/rpc$/ }, ({ path }) => ({ path, namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === '#imports'
      ? 'export const storage = { defineItem: (...args) => ({ getValue: () => globalThis.libraryTest.item(...args).getValue(), setValue: (v) => globalThis.libraryTest.item(...args).setValue(v) }) };'
      : 'export const onMessage = (...args) => globalThis.libraryTest.onMessage(...args); export const sendMessage = () => {};', loader: 'js' }));
  } }] });
const { startLibraryBackground } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

function harness(local: Record<string, any>, sync: Record<string, unknown> = {}) {
  const areas = { local: structuredClone(local), sync: structuredClone(sync) };
  const writes: { area: string; items: Record<string, any> }[] = [];
  const alarms = new Map<string, Record<string, number>>();
  const handlers = new Map<string, (message: { data: any }) => Promise<any>>();
  let changed: ((changes: Record<string, unknown>, area: string) => void)[] = [];
  let alarmListeners: ((alarm: { name: string }) => void)[] = [];
  const area = (name: keyof typeof areas) => ({
    async get(key: string | null) { return structuredClone(key === null ? areas[name] : { [key]: areas[name][key] }); },
    async set(items: Record<string, any>) {
      writes.push({ area: name, items: structuredClone(items) });
      Object.assign(areas[name], structuredClone(items));
      for (const listener of changed) listener(items, name);
    },
    async remove(keys: string[]) { for (const key of keys) delete areas[name][key]; },
  });
  const browserMock = {
    storage: { local: area('local'), sync: area('sync'), onChanged: { addListener: (fn: typeof changed[number]) => changed.push(fn) } },
    alarms: {
      async get(name: string) { return alarms.get(name); },
      async create(name: string, info: { when?: number; periodInMinutes?: number }) {
        alarms.set(name, { scheduledTime: info.when ?? Date.now() + info.periodInMinutes! * 60000 });
      },
      async clear(name: string) { return alarms.delete(name); },
      onAlarm: { addListener: (fn: typeof alarmListeners[number]) => alarmListeners.push(fn) },
    },
  };
  const global = globalThis as any;
  global.browser = browserMock;
  global.libraryTest = {
    onMessage: (name: string, fn: typeof handlers extends Map<string, infer V> ? V : never) => handlers.set(name, fn),
    item: (key: string, { fallback }: { fallback: unknown }) => ({
      async getValue() { return structuredClone(areas.local[key.split(':')[1]] ?? fallback); },
      async setValue(value: unknown) { await browserMock.storage.local.set({ [key.split(':')[1]]: value }); },
    }),
  };
  const rpc = (name: string, data?: unknown) => handlers.get(name)!({ data });
  return { areas, writes, alarms, rpc,
    async start() { changed = []; alarmListeners = []; handlers.clear(); startLibraryBackground(); await rpc('librarySync', 'now'); },
    async fire(name: string) { for (const listener of alarmListeners) listener({ name }); await rpc('librarySync', 'now'); },
  };
}
const config = { enabled: true, syncing: false, lastPushAt: 0, lastSyncedAt: 10, usedBytes: 0, lastError: null };
const saved = () => applyCommand(emptyLibrary(), { type: 'preset', name: 'Saved', gains: [1] }, 100);

test('settled sync and worker restarts do not rewrite data, flicker status or postpone safety alarms', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const library = saved();
  const { items } = await encodeSnapshot(library.shared);
  const h = harness({ library, syncConfig: { ...config, usedBytes: bytesUsed(items) } }, items);
  await h.start();
  const deadline = h.alarms.get('library-sync-safety')!.scheduledTime;
  assert.deepEqual(h.writes, []);
  now += 10000;
  await h.start();
  await h.rpc('libraryRead');
  await h.fire('library-sync-safety');
  assert.deepEqual(h.writes, []);
  assert.equal(h.alarms.get('library-sync-safety')!.scheduledTime, deadline);
});

test('a different equal-date remote snapshot is adopted once', async () => {
  const library = saved();
  const remote = { ...library.shared, presets: { Remote: [2] } };
  const { items } = await encodeSnapshot(remote);
  const h = harness({ library, syncConfig: config }, items);
  await h.start();
  assert.deepEqual(h.areas.local.library.shared, remote);
  assert.equal(h.writes.filter((w) => w.items.library).length, 1);
  h.writes.length = 0;
  await h.rpc('librarySync', 'now');
  assert.deepEqual(h.writes, []);
});

test('rate-limited uploads defer compression and status changes', async (t) => {
  t.mock.method(Date, 'now', () => 100000);
  const library = saved();
  const { items } = await encodeSnapshot(emptyLibrary().shared);
  const h = harness({ library, syncConfig: { ...config, lastPushAt: 99999, usedBytes: bytesUsed(items) } }, items);
  let compressed = 0;
  const compress = globalThis.CompressionStream;
  t.mock.method(globalThis, 'CompressionStream', class extends compress { constructor(format: CompressionFormat) { super(format); compressed++; } });
  await h.start();
  assert.equal(compressed, 0);
  assert.deepEqual(h.writes, []);
  assert.equal(h.alarms.get('library-sync')!.scheduledTime, 129999);
});

test('complete headerless data keeps the newer remote revision and repairs the header', async () => {
  const library = saved();
  const remote = { ...library.shared, updatedAt: 200, presets: { Newer: [2] } };
  const { items } = await encodeSnapshot(remote);
  delete items[SNAPSHOT_KEY];
  const h = harness({ library, syncConfig: config }, items);
  await h.start();
  assert.deepEqual(h.areas.local.library.shared, remote);
  assert.deepEqual(await readSnapshot(h.areas.sync), remote);
  assert.ok(h.areas.sync[SNAPSHOT_KEY]);
});

test('orphaned partial chunks repair after a bounded wait that survives worker restarts', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const library = saved();
  const h = harness({ library, syncConfig: config }, { [PREFIX + 'chunk:0']: 'partial' });
  await h.start();
  assert.equal(h.areas.local.syncConfig.incompleteSince, now);
  assert.equal(h.writes.filter((w) => w.area === 'sync').length, 0);
  now += 60000;
  await h.start();
  assert.equal(h.areas.local.syncConfig.incompleteSince, 100000);
  now += 60001;
  await h.fire('library-sync');
  assert.deepEqual(await readSnapshot(h.areas.sync), library.shared);
  assert.equal(h.areas.local.syncConfig.lastError, null);
});

test('a damaged saved library stays intact and can be replaced through the recovery import', async () => {
  const damaged = saved() as any;
  damaged.local.recent = { broken: 'bad date' };
  const h = harness({ library: damaged, syncConfig: config });
  await h.start();
  await assert.rejects(h.rpc('libraryRead'), /number/);
  assert.deepEqual(h.areas.local.library, damaged);
  const restored = saved();
  await h.rpc('libraryEdit', { type: 'import', library: restored });
  const library = await h.rpc('libraryRead');
  assert.deepEqual(library.shared.presets, restored.shared.presets);
  assert.deepEqual(h.areas.local.libraryRecovery, damaged);
  assert.equal(library.local.importRevision, 1);
});
