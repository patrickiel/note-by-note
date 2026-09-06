// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBackups } from './merge.ts';
import { BACKUP_FORMAT, type Backup } from '../../../core/persist/backup-codec.ts';
import {
  favoriteDeletion,
  HISTORY_CLEARED,
  historyDeletion,
} from '../../../core/persist/deletions.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS, HISTORY_LIMIT } from '../../../core/model/defaults.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import type { ChordChart, FavoriteEntry, HistoryEntry, TrackData, TrackIdentity } from '../../../core/model/types.ts';

const T0 = 1_757_000_000_000;
const NOW = T0 + 10 * 60_000;

const song = (n: number, duration = 200) =>
  makeTrackIdentity(`https://www.youtube.com/watch?v=vid${n.toString().padStart(8, '0')}`, `Song ${n}`, duration);

function row(identity: TrackIdentity, updatedAt: number, transpose = 0): HistoryEntry {
  return {
    identity,
    params: { ...DEFAULT_PARAMS, transpose },
    pageUrl: identity.normalizedUrl,
    createdAt: updatedAt,
    updatedAt,
  };
}

function fav(identity: TrackIdentity, updatedAt: number, lastAccessedAt = updatedAt): FavoriteEntry {
  return { ...row(identity, updatedAt), favoritedAt: updatedAt, lastAccessedAt };
}

const chart = (computedAt: number): ChordChart => ({
  segments: [{ startT: 0, endT: 2, label: 'C', confidence: 1 }],
  key: null,
  coverage: 1,
  analyzedFrom: 0,
  analyzedTo: 2,
  computedAt,
});

function record(identity: TrackIdentity, updatedAt: number, markers: number, withChart = false): TrackData {
  return {
    identity,
    markers: Array.from({ length: markers }, (_, i) => ({ id: `m${i}`, t: i, label: '' })),
    snippets: [],
    sequenceLoop: false,
    sequenceCountIn: false,
    chordChart: withChart ? chart(updatedAt) : null,
    updatedAt,
  };
}

function backup(patch: Partial<Backup> = {}): Backup {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: T0,
    appVersion: '',
    settings: { ...DEFAULT_SETTINGS },
    uiPrefs: JSON.parse(JSON.stringify(DEFAULT_UI_PREFS)),
    history: [],
    favorites: [],
    eqPresets: [],
    tracks: [],
    deletions: {},
    ...patch,
  };
}

const keys = (list: { identity: TrackIdentity }[]) => list.map((e) => e.identity.key);

test('a row the other side trimmed away survives; the newer copy of a shared row wins', () => {
  const local = backup({ history: [row(song(1), T0 + 1000, 1), row(song(2), T0)] });
  const remote = backup({ history: [row(song(1), T0 + 5000, 3)] });
  const merged = mergeBackups(local, remote, true, NOW);
  assert.deepEqual(keys(merged.history), [song(1).key, song(2).key]);
  assert.equal(merged.history[0].params.transpose, 3, 'newer copy');
});

test('history is matched by song, so a drifted duration does not make a twin', () => {
  const local = backup({ history: [row(song(1, 200), T0)] });
  const remote = backup({ history: [row(song(1, 201), T0 + 1)] });
  const merged = mergeBackups(local, remote, false, NOW);
  assert.equal(merged.history.length, 1);
  assert.equal(merged.history[0].identity.durationSec, 201);
});

test('a deletion beats the copy it postdates, but not a later re-play', () => {
  const gone = song(1);
  const local = backup({ deletions: { [historyDeletion(gone.key)]: T0 + 2000 } });
  const remote = backup({ history: [row(gone, T0 + 1000), row(song(2), T0)] });
  assert.deepEqual(keys(mergeBackups(local, remote, true, NOW).history), [song(2).key]);
  const replayed = backup({ history: [row(gone, T0 + 3000)] });
  assert.deepEqual(keys(mergeBackups(local, replayed, true, NOW).history), [gone.key]);
});

test('"Clear Recent" travels and wipes older rows on the other side', () => {
  const local = backup({ deletions: { [HISTORY_CLEARED]: T0 + 5000 } });
  const remote = backup({ history: [row(song(1), T0 + 1000), row(song(2), T0 + 6000)] });
  const merged = mergeBackups(local, remote, true, NOW);
  assert.deepEqual(keys(merged.history), [song(2).key]);
  assert.equal(merged.deletions[HISTORY_CLEARED], T0 + 5000, 'the record travels on');
});

test('history is newest-first and capped', () => {
  const local = backup({
    history: Array.from({ length: HISTORY_LIMIT }, (_, i) => row(song(i), T0 + i)),
  });
  const remote = backup({ history: [row(song(999), T0 + 100_000)] });
  const merged = mergeBackups(local, remote, false, NOW);
  assert.equal(merged.history.length, HISTORY_LIMIT);
  assert.equal(merged.history[0].identity.key, song(999).key);
});

test('favorites: union in the winner order, deletions honoured, last access kept', () => {
  const a = song(1);
  const b = song(2);
  const c = song(3);
  const local = backup({
    favorites: [fav(b, T0, T0 + 9000), fav(a, T0)],
    deletions: { [favoriteDeletion(c.key)]: T0 + 100 },
  });
  const remote = backup({ favorites: [fav(a, T0 + 1), fav(c, T0)] });
  const merged = mergeBackups(local, remote, true, NOW);
  assert.deepEqual(keys(merged.favorites), [a.key, b.key], 'remote order first, c deleted');
  assert.equal(merged.favorites[0].updatedAt, T0 + 1);
  assert.equal(merged.favorites[1].lastAccessedAt, T0 + 9000);
});

test('favorites: a newer copy adopts the other side’s later access time', () => {
  const a = song(1);
  const local = backup({ favorites: [fav(a, T0, T0 + 9000)] });
  const remote = backup({ favorites: [fav(a, T0 + 5, T0 + 5)] });
  const merged = mergeBackups(local, remote, true, NOW);
  assert.equal(merged.favorites[0].updatedAt, T0 + 5);
  assert.equal(merged.favorites[0].lastAccessedAt, T0 + 9000);
});

test('tracks: the newer record wins whole, an emptied one included', () => {
  const a = song(1);
  const local = backup({ tracks: [record(a, T0 + 1000, 0)] });
  const remote = backup({ tracks: [record(a, T0, 5), record(song(2), T0, 2)] });
  const merged = mergeBackups(local, remote, true, NOW);
  assert.equal(merged.tracks.length, 2);
  assert.equal(merged.tracks.find((t) => t.identity.key === a.key)?.markers.length, 0);
});

test('tracks: a winner without a chart adopts the other side’s', () => {
  const a = song(1);
  const local = backup({ tracks: [record(a, T0 + 1000, 3)] });
  const remote = backup({ tracks: [record(a, T0, 1, true)] });
  const merged = mergeBackups(local, remote, false, NOW);
  assert.equal(merged.tracks[0].markers.length, 3);
  assert.ok(merged.tracks[0].chordChart?.segments.length);
});

test('ties go to the winning side', () => {
  const a = song(1);
  const local = backup({ history: [row(a, T0, 1)], tracks: [record(a, T0, 1)] });
  const remote = backup({ history: [row(a, T0, 2)], tracks: [record(a, T0, 2)] });
  assert.equal(mergeBackups(local, remote, true, NOW).history[0].params.transpose, 2);
  assert.equal(mergeBackups(local, remote, true, NOW).tracks[0].markers.length, 2);
  assert.equal(mergeBackups(local, remote, false, NOW).history[0].params.transpose, 1);
  assert.equal(mergeBackups(local, remote, false, NOW).tracks[0].markers.length, 1);
});

test('settings and prefs come from the winner; EQ presets are a union', () => {
  const local = backup({
    settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
    eqPresets: [{ name: 'Mine', gains: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
  });
  const remote = backup({
    settings: { ...DEFAULT_SETTINGS, theme: 'light' },
    eqPresets: [{ name: 'Theirs', gains: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0] }, { name: 'Mine', gains: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9] }],
  });
  const remoteWins = mergeBackups(local, remote, true, NOW);
  assert.equal(remoteWins.settings.theme, 'light');
  assert.deepEqual(remoteWins.eqPresets.map((p) => p.name), ['Theirs', 'Mine']);
  assert.equal(remoteWins.eqPresets[1].gains[0], 9, 'winner’s copy of a shared name');
  const localWins = mergeBackups(local, remote, false, NOW);
  assert.equal(localWins.settings.theme, 'dark');
  assert.deepEqual(localWins.eqPresets.map((p) => p.name), ['Mine', 'Theirs']);
  assert.equal(localWins.eqPresets[0].gains[0], 1);
});

test('deletions are merged newest-per-key and expired ones dropped', () => {
  const old = NOW - 40 * 24 * 60 * 60_000;
  const local = backup({ deletions: { 'h:a': T0, 'h:old': old } });
  const remote = backup({ deletions: { 'h:a': T0 + 1, 'f:b': T0 } });
  assert.deepEqual(mergeBackups(local, remote, true, NOW).deletions, { 'h:a': T0 + 1, 'f:b': T0 });
});

test('merging a library with itself changes nothing', () => {
  const b = backup({
    history: [row(song(1), T0), row(song(2), T0 + 1)],
    favorites: [fav(song(2), T0)],
    tracks: [record(song(1), T0, 2, true)],
    deletions: { 'h:x': T0 },
  });
  const merged = mergeBackups(b, b, true, NOW);
  assert.deepEqual(merged.history, [...b.history].sort((x, y) => y.updatedAt - x.updatedAt));
  assert.deepEqual(merged.favorites, b.favorites);
  assert.deepEqual(merged.tracks, b.tracks);
  assert.deepEqual(merged.deletions, b.deletions);
});
