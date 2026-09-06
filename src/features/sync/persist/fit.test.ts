// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBackup, LibraryTooLargeError } from './fit.ts';
import { BACKUP_FORMAT, encodeBackup, type Backup } from '../../../core/persist/backup-codec.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../../../core/model/defaults.ts';
import { makeTrackIdentity } from '../../../core/model/track-identity.ts';
import type {
  ChordChart,
  FavoriteEntry,
  HistoryEntry,
  TrackData,
  TrackIdentity,
} from '../../../core/model/types.ts';

const measure = (b: Backup) => JSON.stringify(encodeBackup(b)).length;

const T0 = 1_757_000_000_000;

function song(n: number): TrackIdentity {
  return makeTrackIdentity(
    `https://www.youtube.com/watch?v=vid${n.toString().padStart(8, '0')}`,
    `Song ${n}`,
    200 + n,
  );
}

function chart(segments: number, computedAt: number): ChordChart {
  return {
    segments: Array.from({ length: segments }, (_, i) => ({
      startT: i * 2,
      endT: i * 2 + 2,
      label: ['C', 'G', 'Am', 'F'][i % 4],
      confidence: 1,
    })),
    key: null,
    coverage: 1,
    analyzedFrom: 0,
    analyzedTo: segments * 2,
    computedAt,
  };
}

function row(identity: TrackIdentity, updatedAt: number): HistoryEntry {
  return {
    identity,
    params: { ...DEFAULT_PARAMS, transpose: 1 },
    pageUrl: `https://www.youtube.com/watch?v=${identity.normalizedUrl.slice(-11)}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

function record(identity: TrackIdentity, updatedAt: number, withChart: boolean): TrackData {
  return {
    identity,
    markers: [{ id: 'm1', t: 10, label: 'Verse' }],
    snippets: [],
    sequenceLoop: false,
    sequenceCountIn: false,
    chordChart: withChart ? chart(40, updatedAt) : null,
    updatedAt,
  };
}

/**
 * `recent` non-favorited songs (row + record + chart), `favorites` favorited
 * ones (row + favorite + record + chart), `orphans` records with no row.
 * Song n was touched at T0 + n minutes, so higher n = newer everywhere.
 */
function library(recent: number, favorites: number, orphans = 0): Backup {
  const history: HistoryEntry[] = [];
  const favs: FavoriteEntry[] = [];
  const tracks: TrackData[] = [];
  let n = 0;
  for (let i = 0; i < recent; i++, n++) {
    const id = song(n);
    const at = T0 + n * 60_000;
    history.push(row(id, at));
    tracks.push(record(id, at, true));
  }
  for (let i = 0; i < favorites; i++, n++) {
    const id = song(n);
    const at = T0 + n * 60_000;
    history.push(row(id, at));
    favs.push({ ...row(id, at), favoritedAt: at, lastAccessedAt: at });
    tracks.push(record(id, at, true));
  }
  for (let i = 0; i < orphans; i++, n++) {
    const id = song(n);
    tracks.push(record(id, T0 + n * 60_000, false));
  }
  // Storage enumeration order is arbitrary; make sure nothing relies on it.
  tracks.reverse();
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: T0,
    appVersion: '',
    settings: DEFAULT_SETTINGS,
    uiPrefs: DEFAULT_UI_PREFS,
    history,
    favorites: favs,
    eqPresets: [],
    tracks,
  };
}

const keys = (list: { identity: TrackIdentity }[]) => list.map((e) => e.identity.key).sort();
const charts = (b: Backup) => b.tracks.filter((t) => t.chordChart?.segments.length).length;

test('nothing is cut while the library fits', () => {
  const b = library(5, 2);
  const result = fitBackup(b, measure(b), measure);
  assert.equal(result.trimmed, false);
  assert.equal(result.size, measure(b));
  assert.deepEqual(result.backup, b);
});

test('recent songs go first, oldest first, taking their records along', () => {
  const b = library(6, 2);
  const withoutTwoOldest = fitBackup(b, measure(b) - 1, measure).backup;
  assert.ok(withoutTwoOldest.history.length < b.history.length);
  assert.equal(withoutTwoOldest.favorites.length, 2, 'favorites untouched');
  assert.equal(charts(withoutTwoOldest), charts(b) - (b.history.length - withoutTwoOldest.history.length), 'only the cut songs lost their charts');
  // The rows that survived are the newest ones.
  const survivors = withoutTwoOldest.history.map((h) => h.updatedAt);
  const cut = b.history
    .filter((h) => !survivors.includes(h.updatedAt))
    .map((h) => h.updatedAt);
  assert.ok(Math.max(...cut) < Math.min(...survivors));
  // Records follow their rows.
  assert.deepEqual(keys(withoutTwoOldest.tracks), keys([...withoutTwoOldest.history]));
});

test('charts go next, oldest first; favorites and their markers stay', () => {
  const b = library(3, 3);
  const noRecent = fitBackup(b, measure(b), measure);
  // Find the budget at which every non-favorite is gone but charts remain.
  const favoritesOnly = { ...b, history: b.history.slice(3), tracks: b.tracks.filter((t) => keys(b.favorites).includes(t.identity.key)) };
  const result = fitBackup(b, measure(favoritesOnly) - 1, measure);
  assert.equal(result.trimmed, true);
  assert.equal(result.backup.favorites.length, 3);
  assert.equal(result.backup.history.length, 3, 'favorites keep their Recent rows');
  assert.equal(result.backup.tracks.length, 3, 'favorites keep their records');
  assert.ok(result.backup.tracks.every((t) => t.markers.length === 1), 'markers intact');
  const kept = charts(result.backup);
  assert.ok(kept > 0 && kept < 3, `some charts cut, not all: ${kept}`);
  const keptAt = result.backup.tracks
    .filter((t) => t.chordChart)
    .map((t) => t.chordChart!.computedAt);
  const cutAt = result.backup.tracks
    .filter((t) => !t.chordChart)
    .map((t) => t.updatedAt);
  assert.ok(Math.max(...cutAt) < Math.min(...keptAt), 'the oldest charts went');
  assert.equal(noRecent.trimmed, false);
});

test('favorites go last, least recently accessed first', () => {
  const b = library(2, 4);
  // Exactly the two newest favorites, with their rows and chart-less records.
  const newest = keys(b.favorites.slice(2));
  const expected = {
    ...b,
    history: b.history.filter((h) => newest.includes(h.identity.key)),
    favorites: b.favorites.slice(2),
    tracks: b.tracks
      .filter((t) => newest.includes(t.identity.key))
      .map((t) => ({ ...t, chordChart: null })),
  };
  const result = fitBackup(b, measure(expected), measure);
  assert.equal(charts(result.backup), 0, 'every chart went before a favorite');
  assert.equal(result.backup.favorites.length, 2);
  const survivors = result.backup.favorites.map((f) => f.lastAccessedAt);
  const cut = b.favorites
    .filter((f) => !survivors.includes(f.lastAccessedAt))
    .map((f) => f.lastAccessedAt);
  assert.ok(Math.max(...cut) < Math.min(...survivors));
  assert.deepEqual(keys(result.backup.tracks), keys(result.backup.favorites), 'records follow');
  assert.deepEqual(keys(result.backup.history), keys(result.backup.favorites), 'rows follow');
});

test('orphan records sit in the recent tier by their own edit time', () => {
  const b = library(2, 1, 2);
  const oneOrphanLess = { ...b, tracks: b.tracks.filter((t) => t.identity.key !== song(3).key) };
  const result = fitBackup(b, measure(oneOrphanLess), measure);
  assert.equal(result.trimmed, true);
  const kept = keys(result.backup.tracks);
  assert.ok(!kept.includes(song(0).key), 'the oldest recent song went first');
  assert.ok(kept.includes(song(4).key), 'the newest orphan is newer than the recents and stays');
});

test('the result is the largest plan that fits', () => {
  const b = library(12, 0);
  for (const keep of [1, 5, 11]) {
    const exact = { ...b, history: b.history.slice(12 - keep), tracks: b.tracks.filter((t) => keys(b.history.slice(12 - keep)).includes(t.identity.key)) };
    const result = fitBackup(b, measure(exact), measure);
    assert.equal(result.backup.history.length, keep, `budget for ${keep}`);
    assert.equal(result.size, measure(exact));
  }
});

test('deterministic for equal input', () => {
  const a = fitBackup(library(8, 3), 900, measure);
  const b = fitBackup(library(8, 3), 900, measure);
  assert.deepEqual(a, b);
});

test('too large when settings plus favorites alone are over budget', () => {
  const b = library(2, 2);
  const floor = measure({ ...b, history: [], tracks: [], favorites: [] });
  assert.throws(() => fitBackup(b, floor - 1, measure), LibraryTooLargeError);
  assert.doesNotThrow(() => fitBackup(b, floor, measure));
});
