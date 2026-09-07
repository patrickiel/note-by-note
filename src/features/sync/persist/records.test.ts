import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyLibrary, canonical } from '../../../core/persist/library.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import { changedRecords, readRecords, bytesUsed } from './records.ts';

const song = (id: number) => makeTrackIdentity('https://youtube.com/watch?v=song' + id, 'Song', 200);
test('records round-trip independently, and an unchanged copy has nothing to upload', async () => {
  const library = applyCommand(emptyLibrary(), { type: 'practice', identity: song(1), patch: {}, recent: true });
  const { changes: items } = await changedRecords(library.shared, emptyLibrary().shared, {});
  const restored = await readRecords(items);
  assert.equal(canonical(restored), canonical(library.shared));
  assert.deepEqual((await changedRecords(library.shared, restored, items)).changes, {});
  const edited = applyCommand(library, { type: 'favorite', key: song(1).key, value: true });
  const { changes } = await changedRecords(edited.shared, restored, items);
  assert.deepEqual(Object.keys(changes), ['nbn4:order', 'nbn4:song:' + song(1).key]);
  assert.ok(bytesUsed(items) < 8192);
});

test('partial arrival yields complete individual songs, with no global blob to assemble', async () => {
  let library = emptyLibrary();
  for (const n of [1, 2]) library = applyCommand(library, { type: 'practice', identity: song(n), patch: {}, recent: true });
  const { changes: items } = await changedRecords(library.shared, emptyLibrary().shared, {});
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

test('a record too large to sync is reported and left behind, never blocking the rest', async () => {
  let library = applyCommand(emptyLibrary(), { type: 'practice', identity: song(1), patch: {}, recent: true });
  const markers = Array.from({ length: 2000 }, (_, n) => ({ id: 'm' + n, t: n, label: 'Marker ' + n }));
  library = applyCommand(library, { type: 'practice', identity: song(2), patch: { markers }, recent: true });
  const { changes, skipped } = await changedRecords(library.shared, emptyLibrary().shared, {});
  assert.deepEqual(skipped, ['nbn4:song:' + song(2).key]);
  assert.ok(Object.keys(changes).includes('nbn4:song:' + song(1).key));
  assert.equal(library.shared.songs[song(2).key].practice.value!.markers.length, 2000);
});

test('unsupported records are rejected before any application or upload', async () => {
  await assert.rejects(readRecords({ 'nbn4:settings': { version: 5, data: '' } }), /Unsupported/);
});

test('a record the library no longer holds is removed remotely, not merged back', async () => {
  const library = applyCommand(emptyLibrary(), { type: 'practice', identity: song(1), patch: {}, recent: true });
  const { changes: items } = await changedRecords(library.shared, emptyLibrary().shared, {});
  const remote = await readRecords(items);
  // The song is gone locally: sync must drop it rather than read it back forever.
  const { removals } = await changedRecords(emptyLibrary().shared, remote, items);
  assert.deepEqual(removals, ['nbn4:song:' + song(1).key]);
  // A record this build does not own belongs to a newer one and is left alone.
  const foreign = { ...items, 'nbn4:future:1': { version: 4, data: '' } };
  assert.ok(!(await changedRecords(library.shared, remote, foreign)).removals.includes('nbn4:future:1'));
});

test('one damaged record costs only itself, never the rest or the upload', async () => {
  let library = emptyLibrary();
  for (const n of [1, 2]) library = applyCommand(library, { type: 'practice', identity: song(n), patch: {}, recent: true });
  const { changes: items } = await changedRecords(library.shared, emptyLibrary().shared, {});
  const damaged = { ...items, ['nbn4:song:' + song(1).key]: { version: 4, data: 'not-gzip-at-all' } };
  const remote = await readRecords(damaged);
  assert.deepEqual(Object.keys(remote.songs), [song(2).key]);
  // The undamaged song still round-trips, so this device is not locked out.
  assert.equal(canonical(remote.songs[song(2).key]), canonical(library.shared.songs[song(2).key]));
});

test('over budget, songs are held back and reported; the small records still sync', async () => {
  let library = emptyLibrary();
  const markers = Array.from({ length: 300 }, (_, n) => ({ id: 'm' + n, t: n, label: 'Marker ' + n }));
  for (const n of [1, 2, 3]) library = applyCommand(library, { type: 'practice', identity: song(n), patch: { markers }, recent: true });
  const before = canonical(library);
  const padded = { unrelated: 'x'.repeat(102400 - 3000) };
  const { changes, skipped, usedBytes } = await changedRecords(library.shared, emptyLibrary().shared, padded);
  assert.ok(skipped.length > 0, 'the songs that do not fit are reported');
  assert.ok(Object.keys(changes).includes('nbn4:settings'), 'settings are small and always get through');
  assert.ok(usedBytes <= 102400, 'what is written fits the quota');
  assert.equal(canonical(library), before, 'nothing is trimmed from the library itself');
});
