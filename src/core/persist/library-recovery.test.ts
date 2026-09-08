import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverLegacyStorage } from './library-recovery.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';
import { parseBackupJson } from './backup-codec.ts';

const a = makeTrackIdentity('https://youtube.com/watch?v=a', 'A', 100);
const b = makeTrackIdentity('https://youtube.com/watch?v=b', 'B', 200);
const marker = { id: 'good', t: 12, label: 'Verse' };
const snippet = { id: 's', name: 'Solo', startT: 2, endT: 8, repeats: null, enabled: true, overrides: {} };

test('one damaged legacy row or field cannot discard unrelated saved work', () => {
  const raw = {
    history: [{ identity: a, pageUrl: a.normalizedUrl, params: { ...DEFAULT_PARAMS, speed: 0.7 } },
      { identity: b, updatedAt: 50, pageUrl: b.normalizedUrl, params: DEFAULT_PARAMS }, null],
    favorites: [{ identity: b, updatedAt: 50, favoritedAt: 60, lastAccessedAt: 70, params: DEFAULT_PARAMS }],
    'track:a': { identity: a, updatedAt: 10, markers: [marker, { ...marker, id: 'bad', t: NaN }],
      snippets: [snippet, { ...snippet, id: 'bad', startT: 'broken' }], sequenceLoop: true, chordChart: { coverage: 'bad' } },
    'track:b': { identity: b, updatedAt: 20, markers: [{ ...marker, id: 'b' }], snippets: [snippet] },
    eqPresets: [{ name: 'Keep me', gains: [1, 2] }, { name: 'Bad', gains: ['bad'] }],
    settings: { theme: 'dark', seekInterval: 'broken', keymap: { playPause: 'KeyP', seekBack: 123 } },
    uiPrefs: { collapsedSections: { looper: true, tools: 'broken' } },
  };
  const before = structuredClone(raw);
  const recovered = recoverLegacyStorage(raw);
  assert.deepEqual(raw, before, 'source records stay available for recovery');
  assert.deepEqual(Object.keys(recovered.shared.songs), [a.key, b.key]);
  assert.deepEqual(recovered.shared.songs[a.key].practice.markers, [marker]);
  assert.deepEqual(recovered.shared.songs[a.key].practice.snippets, [snippet]);
  assert.equal(recovered.shared.songs[a.key].practice.params!.speed, 0.7);
  assert.equal(recovered.local.recent[a.key], 0, 'missing dates use a safe default');
  assert.equal(recovered.shared.songs[b.key].favoritedAt, 60);
  assert.equal(recovered.shared.songs[b.key].practice.markers[0].id, 'b');
  assert.deepEqual(recovered.shared.presets, { 'Keep me': [1, 2] });
  assert.equal(recovered.shared.settings.theme, 'dark');
  assert.equal(recovered.shared.settings.seekInterval, DEFAULT_SETTINGS.seekInterval);
  assert.equal(recovered.shared.settings.keymap.playPause, 'KeyP');
  assert.equal(recovered.shared.settings.keymap.seekBack, DEFAULT_SETTINGS.keymap.seekBack);
  assert.equal(recovered.local.uiPrefs.collapsedSections.looper, true);
  assert.equal(recovered.local.charts[a.key], null);
});

test('a malformed legacy group does not discard other groups', () => {
  const recovered = recoverLegacyStorage({ history: false, favorites: [null], settings: 'bad',
    'track:good': { identity: a, markers: [marker] }, eqPresets: [{ name: 'Still here', gains: [3] }] });
  assert.equal(recovered.shared.songs[a.key].practice.markers[0].t, 12);
  assert.deepEqual(recovered.shared.presets, { 'Still here': [3] });
});

test('automatic recovery does not make backup imports accept damaged records', () => {
  assert.throws(() => parseBackupJson({ format: 'note-by-note-backup', version: 1,
    history: [], favorites: [], eqPresets: [],
    tracks: [{ identity: a, updatedAt: 1, markers: [{ ...marker, t: 'broken' }], snippets: [], sequenceLoop: false, sequenceCountIn: false }],
  }), /number/);
});
