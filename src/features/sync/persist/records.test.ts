import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { applyCommand, emptyLibrary } from '../../../core/persist/library.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import { encodeSnapshot, readSnapshot, bytesUsed, IncompleteSnapshot, PREFIX, SNAPSHOT_KEY } from './records.ts';

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
  await assert.rejects(readSnapshot(noHeader), IncompleteSnapshot);
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

test('unsupported and damaged snapshots fail before adoption or upload', async () => {
  const { items } = await encodeSnapshot(save());
  const header = items[SNAPSHOT_KEY] as Record<string, unknown>;
  await assert.rejects(readSnapshot({ ...items, [SNAPSHOT_KEY]: { ...header, version: 2 } }), /Unsupported/);
  await assert.rejects(readSnapshot({ ...items, [SNAPSHOT_KEY]: { ...header, chunks: 10000 } }), /Damaged/);
  await assert.rejects(readSnapshot({ ...items, [SNAPSHOT_KEY]: { ...header, updatedAt: 999 } }), /revision/);
});
