import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, canonical, cell, emptyLibrary, favoriteEntries, mergeShared, nextRevision, recentEntries } from './library.ts';
import { migrateBackup } from './library-migration.ts';
import { parseBackupJson } from './backup-codec.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';

const identity = makeTrackIdentity('https://www.youtube.com/watch?v=example', 'Song', 200);
const save = (library = emptyLibrary(), speed = 0.8) => applyCommand(library, {
  type: 'practice', identity, patch: { params: { ...DEFAULT_PARAMS, speed } }, recent: true,
}, 100);

test('Recent and Favorites project the same saved parameters; removing Recent preserves the song', () => {
  let library = applyCommand(save(), { type: 'favorite', key: identity.key, value: true }, 200);
  library = save(library, 0.5);
  assert.equal(recentEntries(library)[0].params.speed, 0.5);
  assert.equal(favoriteEntries(library)[0].params.speed, 0.5);
  library = applyCommand(library, { type: 'recent.remove', key: identity.key });
  assert.equal(recentEntries(library).length, 0);
  assert.equal(favoriteEntries(library)[0].params.speed, 0.5);
  assert.equal(Object.keys(library.shared.songs).length, 1);
});

test('an independent practice edit cannot undo an unfavorite', () => {
  const base = applyCommand(save(), { type: 'favorite', key: identity.key, value: true }, 200);
  const removed = applyCommand(base, { type: 'favorite', key: identity.key, value: false }, 300);
  const edited = save(base, 0.4);
  const merged = mergeShared(edited.shared, removed.shared);
  assert.equal(merged.songs[identity.key].favorite.value, false);
  assert.equal(merged.songs[identity.key].practice.value!.params!.speed, 0.4);
});

test('merge is commutative, associative and idempotent, including deletions and order', () => {
  const a = save().shared;
  const b = applyCommand(save(), { type: 'favorite', key: identity.key, value: true }, 200).shared;
  const c = applyCommand(save(), { type: 'import', library: emptyLibrary() }, 300).shared;
  for (const x of [a, b, c]) for (const y of [a, b, c]) for (const z of [a, b, c]) {
    assert.equal(canonical(mergeShared(x, y)), canonical(mergeShared(y, x)));
    assert.equal(canonical(mergeShared(x, x)), canonical(x));
    assert.equal(canonical(mergeShared(mergeShared(x, y), z)), canonical(mergeShared(x, mergeShared(y, z))));
  }
});

test('local activity, layout, last-used parameters and chord analysis never change shared data', () => {
  const original = save();
  let next = applyCommand(original, { type: 'visit', key: identity.key });
  next = applyCommand(next, { type: 'recent.remove' });
  next = applyCommand(next, { type: 'chart', key: identity.key, chart: null });
  next = applyCommand(next, { type: 'uiPrefs', value: { ...DEFAULT_UI_PREFS, markerView: 'list' } });
  next = applyCommand(next, { type: 'settings', patch: { lastUsedParams: { ...DEFAULT_PARAMS, speed: 0.2 } } });
  assert.deepEqual(next.shared, original.shared);
});

test('field patches preserve other session and remote edits', () => {
  let library = save();
  library = applyCommand(library, { type: 'practice', identity, patch: { markers: [{ id: 'm', t: 4, label: 'Verse' }] }, recent: true });
  library = save(library, 0.3);
  assert.deepEqual(library.shared.songs[identity.key].practice.value!.markers, [{ id: 'm', t: 4, label: 'Verse' }]);
});

test('replacement import dates both present and absent records after observed future revisions', () => {
  let current = save();
  current = applyCommand(current, { type: 'preset', name: 'Old', gains: [1] }, 100000);
  const replaced = applyCommand(current, { type: 'import', library: emptyLibrary() }, 1);
  assert.equal(replaced.shared.songs[identity.key].practice.value, null);
  assert.equal(replaced.shared.presets.Old.value, null);
  assert.deepEqual(mergeShared(current.shared, replaced.shared), replaced.shared);
  const revived = save(replaced);
  assert.ok(revived.shared.songs[identity.key].practice.at > replaced.shared.songs[identity.key].practice.at);
  assert.ok(nextRevision(revived.shared, 0) > 100000);
});

test('migration collapses parameters, favorites and markers without syncing local data', () => {
  const entry = { identity, pageUrl: identity.normalizedUrl, params: { ...DEFAULT_PARAMS, speed: 0.7 }, createdAt: 1, updatedAt: 10 };
  const migrated = migrateBackup({ format: 'note-by-note-backup', version: 1, exportedAt: 20, appVersion: '',
    settings: { ...DEFAULT_SETTINGS, lastUsedParams: DEFAULT_PARAMS }, uiPrefs: DEFAULT_UI_PREFS, eqPresets: [],
    history: [entry], favorites: [{ ...entry, params: DEFAULT_PARAMS, updatedAt: 5, favoritedAt: 15, lastAccessedAt: 16 }],
    tracks: [{ identity, updatedAt: 11, markers: [{ id: 'm', t: 42, label: '' }], snippets: [], sequenceLoop: false, sequenceCountIn: false, chordChart: null }],
  });
  const song = migrated.shared.songs[identity.key];
  assert.equal(song.practice.value!.params!.speed, 0.7);
  assert.equal(song.practice.value!.markers[0].t, 42);
  assert.equal(song.favorite.value, true);
  assert.equal(migrated.local.recent[identity.key].lastAccessedAt, 16);
  assert.equal(migrated.shared.settings.value.lastUsedParams, undefined);
});

test('new backups round-trip complete data and reject malformed or unsupported formats', () => {
  const backup = { format: 'note-by-note-backup', version: 4, exportedAt: 100, ...save() };
  assert.deepEqual(parseBackupJson(JSON.parse(JSON.stringify(backup))), backup);
  assert.throws(() => parseBackupJson({ ...backup, version: 5 }), /newer version/);
  assert.throws(() => parseBackupJson({ ...backup, version: 2 }), /no longer reads/);
  const damaged = structuredClone(backup);
  damaged.shared.songs[identity.key].practice.value!.identity.key = 'old-key';
  assert.equal(parseBackupJson(damaged).shared.songs[identity.key].practice.value!.identity.key, identity.key);
  damaged.shared.songs[identity.key].practice.value!.identity.normalizedUrl = 'https://different.example';
  assert.throws(() => parseBackupJson(damaged), /identity/);
});
