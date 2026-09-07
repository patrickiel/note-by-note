import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyLibrary, favoriteEntries, newestSnapshot, recentEntries } from './library.ts';
import { parseBackupJson, parseLibrary } from './backup-codec.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';

const identity = makeTrackIdentity('https://www.youtube.com/watch?v=example', 'Song', 200);
const save = (library = emptyLibrary(), speed = 0.8, now = 100) => applyCommand(library, {
  type: 'practice', identity, patch: { params: { ...DEFAULT_PARAMS, speed } }, recent: true,
}, now);

test('Recent and Favorites project the same saved parameters; removing Recent preserves a favorite', () => {
  let library = applyCommand(save(), { type: 'favorite', key: identity.key, value: true }, 200);
  library = save(library, 0.5);
  assert.equal(recentEntries(library)[0].params.speed, 0.5);
  assert.equal(favoriteEntries(library)[0].params.speed, 0.5);
  library = applyCommand(library, { type: 'recent.remove', key: identity.key });
  assert.equal(recentEntries(library).length, 0);
  assert.equal(favoriteEntries(library)[0].params.speed, 0.5);
  library = applyCommand(library, { type: 'visit', key: identity.key }, 1000);
  assert.equal(recentEntries(library).length, 0);
  assert.equal(favoriteEntries(library)[0].lastAccessedAt, 1000);
});

test('the newer complete snapshot wins, including conflicting edits and unrelated changes', () => {
  const base = applyCommand(save(), { type: 'favorite', key: identity.key, value: true }, 200);
  const removed = applyCommand(base, { type: 'favorite', key: identity.key, value: false }, 300);
  const edited = save(base, 0.4, 400);
  const winner = newestSnapshot(removed.shared, edited.shared);
  assert.equal(winner, edited.shared);
  assert.equal(newestSnapshot(edited.shared, removed.shared), edited.shared);
  // The later edit wins as a whole, even though it carries the older star.
  assert.equal(winner.songs[identity.key].favoritedAt, 200);
  assert.equal(winner.songs[identity.key].practice.params!.speed, 0.4);
  const otherDevice = applyCommand(emptyLibrary(), { type: 'preset', name: 'Only remote', gains: [2] }, 500);
  assert.equal(newestSnapshot(edited.shared, otherDevice.shared), otherDevice.shared);
  assert.deepEqual(otherDevice.shared.songs, {});
});

test('equal timestamps adopt the synced snapshot and stay settled', () => {
  const local = save(emptyLibrary(), 0.8, 100).shared;
  const remote = save(emptyLibrary(), 0.5, 100).shared;
  assert.equal(newestSnapshot(local, remote), remote);
  assert.equal(newestSnapshot(remote, remote), remote);
});

test('local activity, layout, last-used parameters and chord analysis never date shared data', () => {
  const original = save();
  let next = applyCommand(original, { type: 'visit', key: identity.key });
  next = applyCommand(next, { type: 'chart', key: identity.key, chart: null });
  next = applyCommand(next, { type: 'uiPrefs', patch: { markerView: 'list' } });
  next = applyCommand(next, { type: 'settings', patch: { lastUsedParams: { ...DEFAULT_PARAMS, speed: 0.2 } } });
  assert.deepEqual(next.shared, original.shared);
});

test('deleting songs and presets removes them from the winning snapshot without tombstones', () => {
  const library = applyCommand(save(), { type: 'preset', name: 'Old', gains: [1] }, 200);
  let removed = applyCommand(library, { type: 'recent.remove', key: identity.key }, 300);
  removed = applyCommand(removed, { type: 'preset', name: 'Old', gains: null }, 400);
  assert.deepEqual(removed.shared.songs, {});
  assert.deepEqual(removed.shared.presets, {});
  assert.deepEqual(removed.local.recent, {});
  assert.deepEqual(removed.local.lastAccessed, {});
  assert.equal(newestSnapshot(library.shared, removed.shared), removed.shared);
  assert.deepEqual(applyCommand(library, { type: 'recent.remove' }).shared.songs, {});
});

test('field patches from panels preserve other changes on the same device', () => {
  let library = save();
  library = applyCommand(library, { type: 'practice', identity, patch: { markers: [{ id: 'm', t: 4, label: 'Verse' }] }, recent: true });
  library = save(library, 0.3);
  assert.deepEqual(library.shared.songs[identity.key].practice.markers, [{ id: 'm', t: 4, label: 'Verse' }]);
});

test('preference patches preserve other controls and do not create a sync revision', () => {
  const original = save();
  let library = applyCommand(original, { type: 'uiPrefs', patch: { collapsedSections: { looper: true } } });
  library = applyCommand(library, { type: 'uiPrefs', patch: { collapsedSections: { tools: true } } });
  library = applyCommand(library, { type: 'uiPrefs', patch: { boundaryLabels: { start: 'Intro' } } });
  library = applyCommand(library, { type: 'uiPrefs', patch: { boundaryLabels: { end: 'Outro' }, markerView: 'list' } });
  assert.deepEqual(library.local.uiPrefs.collapsedSections, { ...DEFAULT_UI_PREFS.collapsedSections, looper: true, tools: true });
  assert.deepEqual(library.local.uiPrefs.boundaryLabels, { start: 'Intro', end: 'Outro' });
  assert.equal(library.local.uiPrefs.markerView, 'list');
  assert.deepEqual(library.shared, original.shared);
});

test('the storage boundary fills defaults for older settings and nested UI preferences', () => {
  const older = JSON.parse(JSON.stringify(save()));
  delete older.shared.settings.keymap.playPause;
  delete older.shared.settings.countInBeep;
  delete older.local.uiPrefs.collapsedSections.looper;
  delete older.local.uiPrefs.boundaryLabels;
  const restored = parseLibrary(older);
  assert.equal(restored.shared.settings.keymap.playPause, DEFAULT_SETTINGS.keymap.playPause);
  assert.equal(restored.shared.settings.countInBeep, DEFAULT_SETTINGS.countInBeep);
  assert.equal(restored.local.uiPrefs.collapsedSections.looper, DEFAULT_UI_PREFS.collapsedSections.looper);
  assert.deepEqual(restored.local.uiPrefs.boundaryLabels, DEFAULT_UI_PREFS.boundaryLabels);
});

test('missing or null preference groups use defaults without changing saved songs or dates', () => {
  const saved = applyCommand(save(), { type: 'favorite', key: identity.key, value: true }, 200);
  for (const absent of [undefined, null]) {
    const older = { ...saved, local: { ...saved.local, uiPrefs: absent } };
    const before = structuredClone(older);
    assert.deepEqual(parseLibrary(older), saved);
    assert.deepEqual(older, before);
    const partial = { ...saved, shared: { ...saved.shared, settings: { theme: 'dark', keymap: absent } },
      local: { ...saved.local, uiPrefs: { markerView: 'list', collapsed: absent, collapsedSections: absent, boundaryLabels: absent } } };
    const restored = parseLibrary(partial);
    assert.deepEqual(restored.shared.settings, { ...DEFAULT_SETTINGS, theme: 'dark' });
    assert.deepEqual(restored.local.uiPrefs, { ...DEFAULT_UI_PREFS, markerView: 'list' });
    assert.deepEqual(restored.shared.songs, saved.shared.songs);
    assert.deepEqual(parseLibrary(restored), restored);
    assert.deepEqual(parseLibrary({ ...saved, shared: { ...saved.shared, settings: absent } }), saved);
  }
});

test('absent local metadata defaults independently while malformed present data is rejected', () => {
  const saved = save();
  for (const absent of [undefined, null]) {
    for (const key of ['recent', 'lastAccessed', 'charts']) {
      const older = { ...saved, local: { ...saved.local, [key]: absent } };
      assert.deepEqual(parseLibrary(older), { ...saved, local: { ...saved.local, [key]: {} } });
    }
    assert.deepEqual(parseLibrary({ ...saved, local: absent }), { ...saved, local: emptyLibrary().local });
  }
  for (const invalid of [false, 1, 'invalid', []]) {
    assert.throws(() => parseLibrary({ ...saved, local: { ...saved.local, uiPrefs: invalid } }), /data/);
  }
  assert.throws(() => parseLibrary({ ...saved, shared: null }), /data/);
  assert.throws(() => parseLibrary({ ...saved, local: { ...saved.local, recent: { [identity.key]: NaN } } }), /number/);
});

test('replacement imports and subsequent edits advance beyond observed or imported future dates', () => {
  const current = save(emptyLibrary(), 0.8, 100000);
  const replaced = applyCommand(current, { type: 'import', library: emptyLibrary() }, 1);
  assert.deepEqual(replaced.shared.songs, {});
  assert.equal(replaced.shared.updatedAt, 100001);
  assert.equal(newestSnapshot(current.shared, replaced.shared), replaced.shared);
  assert.ok(save(replaced).shared.updatedAt > replaced.shared.updatedAt);
  const future = save(emptyLibrary(), 0.5, 200000);
  assert.equal(applyCommand(current, { type: 'import', library: future }, 1).shared.updatedAt, 200001);
});

test('released version-1 backups import parameters, favorites, markers and presets', () => {
  const entry = { identity, pageUrl: identity.normalizedUrl, params: { ...DEFAULT_PARAMS, speed: 0.7 }, updatedAt: 10 };
  const migrated = parseBackupJson({ format: 'note-by-note-backup', version: 1,
    settings: { ...DEFAULT_SETTINGS, lastUsedParams: DEFAULT_PARAMS }, uiPrefs: DEFAULT_UI_PREFS,
    eqPresets: [{ name: 'Practice', gains: [1, 2, 3] }],
    history: [entry], favorites: [{ ...entry, params: DEFAULT_PARAMS, updatedAt: 5, favoritedAt: 15, lastAccessedAt: 16 }],
    tracks: [{ identity, updatedAt: 11, markers: [{ id: 'm', t: 42, label: '' }], snippets: [], sequenceLoop: false, sequenceCountIn: false, chordChart: null }],
  });
  const song = migrated.shared.songs[identity.key];
  assert.equal(song.practice.params!.speed, 0.7);
  assert.equal(song.practice.markers[0].t, 42);
  assert.equal(song.favoritedAt, 15);
  assert.equal(migrated.shared.updatedAt, 15);
  assert.equal(migrated.local.lastAccessed[identity.key], 16);
  assert.equal(migrated.shared.settings.lastUsedParams, undefined);
  assert.deepEqual(migrated.shared.presets, { Practice: [1, 2, 3] });
  assert.deepEqual(migrated.local.lastUsedParams, DEFAULT_PARAMS);
  assert.equal(migrated.version, 2);
  const exported = JSON.parse(JSON.stringify(migrated));
  assert.deepEqual(parseBackupJson(exported), exported);
});

test('new backups round-trip and reject malformed or unsupported formats', () => {
  const backup = { format: 'note-by-note-backup', version: 2, exportedAt: 100, ...save() };
  assert.deepEqual(parseBackupJson(JSON.parse(JSON.stringify(backup))), backup);
  for (const version of [3, 4, 5]) assert.throws(() => parseBackupJson({ ...backup, version }), /newer version/);
  assert.throws(() => parseBackupJson({ ...backup, version: 0 }), /no longer reads/);
  const damaged = structuredClone(backup);
  damaged.shared.songs[identity.key].practice.identity.key = 'old-key';
  assert.equal(parseBackupJson(damaged).shared.songs[identity.key].practice.identity.key, identity.key);
  damaged.shared.songs[identity.key].practice.identity.normalizedUrl = 'https://different.example';
  assert.throws(() => parseBackupJson(damaged), /identity/);
  assert.throws(() => parseBackupJson({ ...backup, shared: { ...backup.shared, updatedAt: -1 } }), /revision/);
});

test('preset names matching object properties can be saved, backed up and deleted', () => {
  let library = emptyLibrary();
  for (const name of ['constructor', '__proto__']) library = applyCommand(library, { type: 'preset', name, gains: [1] });
  assert.deepEqual(Object.keys(parseLibrary(library).shared.presets), ['constructor', '__proto__']);
  library = applyCommand(library, { type: 'preset', name: '__proto__', gains: null });
  assert.deepEqual(Object.keys(library.shared.presets), ['constructor']);
});
