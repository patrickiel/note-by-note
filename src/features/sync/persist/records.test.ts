import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyLibrary, canonical } from '../../../core/persist/library.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import { changedRecords, readRecords, bytesUsed } from './records.ts';

const song = (id: number) => makeTrackIdentity('https://youtube.com/watch?v=song' + id, 'Song', 200);
test('records round-trip independently, and an unchanged copy has nothing to upload', async () => {
  const library = applyCommand(emptyLibrary(), { type: 'practice', identity: song(1), patch: {}, recent: true });
  const items = await changedRecords(library.shared, emptyLibrary().shared, {});
  const restored = await readRecords(items);
  assert.equal(canonical(restored), canonical(library.shared));
  assert.deepEqual(await changedRecords(library.shared, restored, items), {});
  const edited = applyCommand(library, { type: 'favorite', key: song(1).key, value: true });
  const changes = await changedRecords(edited.shared, restored, items);
  assert.deepEqual(Object.keys(changes), ['nbn4:order', 'nbn4:song:' + song(1).key]);
  assert.ok(bytesUsed(items) < 8192);
});

test('partial arrival yields complete individual songs, with no global blob to assemble', async () => {
  let library = emptyLibrary();
  for (const n of [1, 2]) library = applyCommand(library, { type: 'practice', identity: song(n), patch: {}, recent: true });
  const items = await changedRecords(library.shared, emptyLibrary().shared, {});
  const key = 'nbn4:song:' + song(2).key;
  const partial = await readRecords({ [key]: items[key] });
  assert.deepEqual(Object.keys(partial.songs), [song(2).key]);
});

test('capacity failure leaves the library intact and never silently trims records', async () => {
  const library = applyCommand(emptyLibrary(), { type: 'practice', identity: song(1), patch: {}, recent: true });
  const before = canonical(library);
  await assert.rejects(changedRecords(library.shared, emptyLibrary().shared, { unrelated: 'x'.repeat(102400) }), /storage is full/);
  assert.equal(canonical(library), before);
});

test('unsupported records are rejected before any application or upload', async () => {
  await assert.rejects(readRecords({ 'nbn4:settings': { version: 5, data: '' } }), /Unsupported/);
});
