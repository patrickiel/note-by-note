import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { applyCommand, emptyLibrary } from '../../../core/persist/library.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import { encodeSnapshot, fitSnapshot, readSnapshot, bytesUsed, IncompleteSnapshot, PREFIX, SNAPSHOT_KEY } from './records.ts';

const song = makeTrackIdentity('https://youtube.com/watch?v=song', 'Song', 200);
const save = (label = '', now = 100) => applyCommand(emptyLibrary(), {
  type: 'practice', identity: song, patch: { markers: [{ id: 'm', t: 1, label }] }, recent: true,
}, now).shared;

test('sync round-trips exactly the shared snapshot, including large songs across chunks', async () => {
  const shared = save(randomBytes(18000).toString('base64'));
  const { items, usedBytes } = await encodeSnapshot(shared);
  assert.deepEqual(await readSnapshot(items), shared);
  assert.ok((items[SNAPSHOT_KEY] as { chunks: number }).chunks > 1);
  assert.equal(usedBytes, bytesUsed(items));
  for (const [key, value] of Object.entries(items)) assert.ok(bytesUsed({ [key]: value }) <= 8192);
  assert.deepEqual((await encodeSnapshot(shared, items)).items, items);
});

test('missing, reordered and mixed chunks never produce a partial library', async () => {
  const { items } = await encodeSnapshot(save(randomBytes(18000).toString('base64')));
  const missing = { ...items };
  delete missing[PREFIX + 'chunk:1'];
  await assert.rejects(readSnapshot(missing), IncompleteSnapshot);
  const noHeader = { ...items };
  delete noHeader[SNAPSHOT_KEY];
  assert.deepEqual(await readSnapshot(noHeader), await readSnapshot(items));
  const { items: other } = await encodeSnapshot(save('other device at the same timestamp'));
  await assert.rejects(readSnapshot({ ...items, [PREFIX + 'chunk:0']: other[PREFIX + 'chunk:0'] }), IncompleteSnapshot);
  const reversed = Object.fromEntries(Object.entries(items).reverse());
  assert.deepEqual(await readSnapshot(reversed), await readSnapshot(items));
});

test('a smaller replacement clears all old chunks in the same write', async () => {
  const { items: large } = await encodeSnapshot(save(randomBytes(18000).toString('base64')));
  const small = applyCommand({ shared: save(), local: emptyLibrary().local }, { type: 'import', library: emptyLibrary() }, 200).shared;
  const { items } = await encodeSnapshot(small, large);
  assert.equal(items[PREFIX + 'chunk:1'], '');
  assert.deepEqual(await readSnapshot({ ...large, ...items }), small);
});

test('capacity failures leave both the library and existing sync storage intact', async () => {
  const shared = save(randomBytes(100000).toString('base64'));
  const before = structuredClone(shared);
  const { items: existing } = await encodeSnapshot(save('last complete upload'));
  const existingBefore = structuredClone(existing);
  await assert.rejects(encodeSnapshot(shared, existing), /storage is full/);
  assert.deepEqual(shared, before);
  assert.deepEqual(existing, existingBefore);
  await assert.rejects(encodeSnapshot(save(), { unrelated: 'x'.repeat(102400) }), /storage is full/);
});

test('empty sync storage is distinct from a valid empty library or an incomplete transfer', async () => {
  assert.equal(await readSnapshot({ unrelated: 'kept' }), null);
  const { items } = await encodeSnapshot(emptyLibrary().shared);
  assert.deepEqual(await readSnapshot(items), emptyLibrary().shared);
  const broken = { ...items, [PREFIX + 'chunk:0']: '' };
  await assert.rejects(readSnapshot(broken), (error: unknown) => error instanceof IncompleteSnapshot && error.updatedAt === 0);
});

test('a lost header is recovered from complete chunks with the original revision', async () => {
  const shared = save();
  const { items } = await encodeSnapshot(shared);
  delete items[SNAPSHOT_KEY];
  assert.deepEqual(await readSnapshot(items), shared);
  items[PREFIX + 'chunk:0'] = 'interrupted';
  await assert.rejects(readSnapshot(items), (error: unknown) => error instanceof IncompleteSnapshot && error.updatedAt === null);
});

test('unsupported and damaged snapshots fail before adoption or upload', async () => {
  const { items } = await encodeSnapshot(save());
  const header = items[SNAPSHOT_KEY] as Record<string, unknown>;
  await assert.rejects(readSnapshot({ ...items, [SNAPSHOT_KEY]: { ...header, version: 2 } }), /Unsupported/);
  await assert.rejects(readSnapshot({ ...items, [SNAPSHOT_KEY]: { ...header, chunks: 10000 } }), /Damaged/);
  await assert.rejects(readSnapshot({ ...items, [SNAPSHOT_KEY]: { ...header, updatedAt: 999 } }), /revision/);
});

const bulky = (count: number, favorite: (n: number) => boolean = () => false) => {
  const keys: string[] = [];
  let library = emptyLibrary();
  for (let n = 0; n < count; n++) {
    const identity = makeTrackIdentity(`https://youtube.com/watch?v=song${n}`, `Song ${n}`, 200);
    keys.push(identity.key);
    // Random base64 barely compresses, so a handful of songs overflow the quota.
    library = applyCommand(library, { type: 'practice', identity,
      patch: { markers: [{ id: 'm', t: 1, label: randomBytes(4000).toString('base64') }] }, recent: true }, 100 + n);
  }
  for (const [n, key] of keys.entries()) {
    if (favorite(n)) library = applyCommand(library, { type: 'favorite', key, value: true }, 1000);
  }
  return { ...library, keys };
};

test('a snapshot that already fits is uploaded whole', async () => {
  const { shared, local } = bulky(3);
  const fitted = await fitSnapshot(shared, local.lastAccessed);
  assert.deepEqual(fitted.dropped, []);
  assert.equal(fitted.shared, shared);
  assert.equal(fitted.usedBytes, bytesUsed(fitted.items));
  assert.deepEqual(await readSnapshot(fitted.items), shared);
});

test('an oversized snapshot drops the least recently used songs, and only as few as needed', async () => {
  const { shared, local, keys } = bulky(40, (n) => n < 2);
  await assert.rejects(encodeSnapshot(shared), /storage is full/);
  const fitted = await fitSnapshot(shared, local.lastAccessed);
  assert.ok(fitted.dropped.length > 0);
  assert.deepEqual(await readSnapshot(fitted.items), fitted.shared);
  assert.equal(fitted.usedBytes, bytesUsed(fitted.items));
  // Favorites are kept even though they are the two oldest songs, and nothing
  // outside the song list is ever cut.
  for (const key of keys.slice(0, 2)) assert.ok(fitted.shared.songs[key], `${key} was dropped`);
  assert.deepEqual(fitted.shared.settings, shared.settings);
  assert.deepEqual(fitted.shared.presets, shared.presets);
  assert.deepEqual(fitted.shared.favoriteOrder, shared.favoriteOrder);
  // Oldest first: every dropped song was accessed before every song kept.
  const age = (key: string) => local.lastAccessed[key];
  const kept = Object.keys(fitted.shared.songs).filter((key) => !keys.slice(0, 2).includes(key));
  assert.ok(Math.max(...fitted.dropped.map(age)) < Math.min(...kept.map(age)));
  // Minimal: putting the most recent casualty back overflows again.
  const restored = fitted.dropped[fitted.dropped.length - 1];
  await assert.rejects(encodeSnapshot({ ...fitted.shared,
    songs: { ...fitted.shared.songs, [restored]: shared.songs[restored] } }), /storage is full/);
});

test('an overflow of favorites alone still reports capacity failure', async () => {
  const { shared, local } = bulky(40, () => true);
  await assert.rejects(fitSnapshot(shared, local.lastAccessed), /storage is full/);
});

test('one song too big to sync is reported, never made to fit by dropping the rest', async () => {
  const { shared, local, keys } = bulky(4);
  const newest = keys[keys.length - 1];
  const huge = { ...shared, songs: { ...shared.songs, [newest]: { ...shared.songs[newest],
    practice: { ...shared.songs[newest].practice, markers: [{ id: 'm', t: 1, label: randomBytes(120000).toString('base64') }] } } } };
  await assert.rejects(fitSnapshot(huge, local.lastAccessed), /storage is full/);
});
