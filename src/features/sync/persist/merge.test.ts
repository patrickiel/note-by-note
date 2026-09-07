// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBackups } from './merge.ts';
import { backupFixture as backup } from '../../../core/persist/backup.fixture.ts';
import { encodeBackup } from '../../../core/persist/backup-codec.ts';
import { isLive, replaceAll, tombstone } from '../../../core/persist/deletions.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS, HISTORY_LIMIT } from '../../../core/model/defaults.ts';
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
  return { ...row(identity, updatedAt), favoritedAt: updatedAt, lastAccessedAt, orderedAt: updatedAt };
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

/** What a screen would show: the panel stores filter tombstones out. */
const live = <T extends { deleted?: true }>(list: T[]) => list.filter(isLive);
const keys = (list: { identity: TrackIdentity }[]) => list.map((e) => e.identity.key);
const shown = (list: { identity: TrackIdentity; deleted?: true }[]) => keys(live(list));

test('a row the other side trimmed away survives; the newer copy of a shared row wins', () => {
  const local = backup({ history: [row(song(1), T0 + 1000, 1), row(song(2), T0)] });
  const remote = backup({ history: [row(song(1), T0 + 5000, 3)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.deepEqual(shown(merged.history), [song(1).key, song(2).key]);
  assert.equal(merged.history[0].params.transpose, 3, 'newer copy');
});

test('history is matched by song, so a drifted duration does not make a twin', () => {
  const local = backup({ history: [row(song(1, 200), T0)] });
  const remote = backup({ history: [row(song(1, 201), T0 + 1)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.equal(merged.history.length, 1);
  assert.equal(merged.history[0].identity.durationSec, 201);
});

test('a tombstone beats the copy it postdates, but not a later re-play', () => {
  const gone = song(1);
  const local = backup({ history: [tombstone(row(gone, T0), T0 + 2000)] });
  const remote = backup({ history: [row(gone, T0 + 1000), row(song(2), T0)] });
  assert.deepEqual(shown(mergeBackups(local, remote, NOW).history), [song(2).key]);
  const replayed = backup({ history: [row(gone, T0 + 3000)] });
  assert.deepEqual(shown(mergeBackups(local, replayed, NOW).history), [gone.key]);
});

test('"Clear Recent" travels row by row and wipes older copies on the other side', () => {
  // What `clearHistory` writes: every row it held, marked and dated.
  const local = backup({
    history: [tombstone(row(song(1), T0), T0 + 5000), tombstone(row(song(2), T0), T0 + 5000)],
  });
  const remote = backup({ history: [row(song(1), T0 + 1000), row(song(2), T0 + 6000)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.deepEqual(shown(merged.history), [song(2).key], 'the row played since survives');
  assert.equal(merged.history.length, 2, 'the tombstone travels on');
});

test('history is newest-first and capped', () => {
  const local = backup({
    history: Array.from({ length: HISTORY_LIMIT }, (_, i) => row(song(i), T0 + i)),
  });
  const remote = backup({ history: [row(song(999), T0 + 100_000)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.equal(merged.history.length, HISTORY_LIMIT);
  assert.equal(merged.history[0].identity.key, song(999).key);
});

test('the cap counts live rows only, and never drops a favorited song’s row', () => {
  const old = song(1);
  const local = backup({
    favorites: [fav(old, T0)],
    history: [
      row(old, T0),
      tombstone(row(song(500), T0), T0 + 1),
      ...Array.from({ length: HISTORY_LIMIT }, (_, i) => row(song(i + 2), T0 + 1000 + i)),
    ],
  });
  const merged = mergeBackups(local, backup({}), NOW);
  assert.equal(live(merged.history).length, HISTORY_LIMIT, 'a plain row went instead');
  assert.ok(shown(merged.history).includes(old.key));
  assert.equal(merged.history.length, HISTORY_LIMIT + 1, 'the tombstone is not what got cut');
});

test('favorites: union, tombstones honoured, last access kept', () => {
  const a = song(1);
  const b = song(2);
  const c = song(3);
  const local = backup({
    favorites: [fav(b, T0 + 20, T0 + 9000), fav(a, T0 + 10), tombstone(fav(c, T0), T0 + 100)],
  });
  const remote = backup({ favorites: [fav(a, T0 + 10), fav(c, T0)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.deepEqual(shown(merged.favorites), [b.key, a.key], 'by rank, c unstarred');
  assert.equal(live(merged.favorites)[1].lastAccessedAt, T0 + 10);
  assert.equal(live(merged.favorites)[0].lastAccessedAt, T0 + 9000);
});

test('favorites: practice on the other device does not undo an unfavorite', () => {
  const a = song(1);
  // Starred long ago, unfavorited here; the other device then played it, which
  // refreshes the row's cached fields but no longer dates it.
  const local = backup({ favorites: [tombstone(fav(a, T0), T0 + 5000)] });
  const practised: FavoriteEntry = { ...fav(a, T0), lastAccessedAt: T0 + 9000, params: row(a, T0, 5).params };
  const remote = backup({ favorites: [practised] });
  assert.deepEqual(shown(mergeBackups(local, remote, NOW).favorites), []);
  // Genuinely starring it again does beat the tombstone.
  const restarred = backup({ favorites: [fav(a, T0 + 6000)] });
  assert.deepEqual(shown(mergeBackups(local, restarred, NOW).favorites), [a.key]);
});

test('favorites: a newer copy adopts the other side’s later access time', () => {
  const a = song(1);
  const local = backup({ favorites: [fav(a, T0, T0 + 9000)] });
  const remote = backup({ favorites: [fav(a, T0 + 5, T0 + 5)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.equal(merged.favorites[0].updatedAt, T0 + 5);
  assert.equal(merged.favorites[0].lastAccessedAt, T0 + 9000);
});

test('a manual reorder carries to the other device', () => {
  const [a, b, c] = [song(1), song(2), song(3)];
  const before = [fav(a, T0), fav(b, T0), fav(c, T0)];
  // What `setFavoritesOrder([c, a, b])` writes: the rank, in the rows.
  const reordered = [c, a, b].map((s, i) => ({
    ...before.find((f) => f.identity.key === s.key)!,
    orderedAt: T0 + 5000 - i,
  }));
  const merged = mergeBackups(backup({ favorites: before }), backup({ favorites: reordered }), NOW);
  assert.deepEqual(shown(merged.favorites), [c.key, a.key, b.key]);
});

test('tracks: the newer record wins whole, an emptied one included', () => {
  const a = song(1);
  const local = backup({ tracks: [record(a, T0 + 1000, 0)] });
  const remote = backup({ tracks: [record(a, T0, 5), record(song(2), T0, 2)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.equal(merged.tracks.length, 2);
  assert.equal(merged.tracks.find((t) => t.identity.key === a.key)?.markers.length, 0);
});

test('tracks: a winner without a chart adopts the other side’s', () => {
  const a = song(1);
  const local = backup({ tracks: [record(a, T0 + 1000, 3)] });
  const remote = backup({ tracks: [record(a, T0, 1, true)] });
  const merged = mergeBackups(local, remote, NOW);
  assert.equal(merged.tracks[0].markers.length, 3);
  assert.ok(merged.tracks[0].chordChart?.segments.length);
});

test('a deleted chart beats stale analysis and later marker edits, but allows re-analysis', () => {
  const deleted = backup({ tracks: [{ ...record(song(1), T0 + 1, 0), chordChart: { ...chart(T0 + 1), segments: [] } }] });
  const stale = backup({ tracks: [{ ...record(song(1), T0 + 2, 3), chordChart: chart(T0) }] });
  for (const [x, y] of [[deleted, stale], [stale, deleted]] as const) {
    const merged = mergeBackups(x, y, NOW);
    assert.equal(merged.tracks[0].markers.length, 3);
    assert.deepEqual(merged.tracks[0].chordChart?.segments, []);
    const reanalyzed = backup({ tracks: [{ ...stale.tracks[0], chordChart: chart(T0 + 3) }] });
    assert.equal(mergeBackups(merged, reanalyzed, NOW).tracks[0].chordChart?.computedAt, T0 + 3);
  }
});

test('a song’s two library copies come out of a merge with the same settings', () => {
  const a = song(1);
  // Starred here at +3; the other device, which hasn’t got the star yet,
  // practised the song since and left it at 0.
  const starred: FavoriteEntry = { ...fav(a, T0), params: row(a, T0, 3).params };
  const local = backup({ favorites: [starred], history: [row(a, T0, 3)] });
  const remote = backup({ history: [row(a, T0 + 1000, 0)] });
  for (const [x, y] of [[local, remote], [remote, local]] as const) {
    const merged = mergeBackups(x, y, NOW);
    assert.equal(merged.history[0].params.transpose, 0);
    assert.equal(merged.favorites[0].params.transpose, 0, 'the favorite follows the newer row');
  }
  assert.notEqual(
    mergeBackups(local, remote, NOW).history[0].params,
    mergeBackups(local, remote, NOW).favorites[0].params,
    'a copy each, not one object shared by both lists',
  );
});

test('a manual import re-adds rows the devices had deleted', () => {
  const a = song(1);
  const file = backup({
    history: [row(a, T0)],
    favorites: [fav(a, T0)],
    eqPresets: [{ name: 'Mine', gains: [1] }],
  });
  const current = backup({
    history: [tombstone(row(a, T0), NOW)],
    favorites: [tombstone(fav(a, T0), NOW)],
    eqPresets: [{ name: 'Mine', gains: [], updatedAt: NOW, deleted: true }],
  });
  const imported = replaceAll(file, current, NOW);
  // The other device still holds the tombstones the import is undoing.
  const merged = mergeBackups(imported, current, NOW);
  assert.deepEqual(shown(merged.history), [a.key]);
  assert.deepEqual(shown(merged.favorites), [a.key]);
  assert.deepEqual(live(merged.eqPresets).map((p) => p.name), ['Mine']);
  assert.equal(file.history[0].updatedAt, T0, 'the original backup is unchanged');
});

test('a replacement import removes what this device held, and only that', () => {
  const kept = song(1);
  const dropped = song(2);
  const theirs = song(3);
  const file = backup({ history: [row(kept, T0)], tracks: [record(kept, T0, 1)] });
  const current = backup({
    history: [row(kept, T0), row(dropped, T0)],
    favorites: [fav(dropped, T0)],
    eqPresets: [{ name: 'Gone', gains: [1], updatedAt: T0 }],
  });
  const imported = replaceAll(file, current, NOW);
  const remote = backup({
    history: [row(dropped, T0), row(theirs, T0)],
    favorites: [fav(dropped, T0)],
    eqPresets: [{ name: 'Gone', gains: [1], updatedAt: T0 }],
  });
  const merged = mergeBackups(imported, remote, NOW);
  assert.deepEqual(shown(merged.history).sort(), [kept.key, theirs.key].sort(), 'their own song stays');
  assert.deepEqual(shown(merged.favorites), []);
  assert.deepEqual(live(merged.eqPresets), []);
  // What the other device does after the import is not the import's to undo.
  const later = backup({ history: [row(dropped, NOW + 5000)] });
  assert.equal(live(mergeBackups(imported, later, NOW).history).length, 2);
});

test('an item with no date of its own is not swept away by an unrelated deletion', () => {
  // Legacy EQ presets and pre-`updatedAt` track records read as 0. Nothing but
  // a tombstone of their own name may remove them.
  const legacy = backup({ eqPresets: [{ name: 'Old', gains: [1] }] });
  const deleter = backup({
    history: [tombstone(row(song(1), T0), NOW)],
    eqPresets: [{ name: 'Other', gains: [], updatedAt: NOW, deleted: true }],
  });
  assert.deepEqual(live(mergeBackups(legacy, deleter, NOW).eqPresets).map((p) => p.name), ['Old']);
});

test('a tie goes to the tombstone, and both devices break it the same way', () => {
  const a = song(1);
  const local = backup({ history: [row(a, T0, 1)] });
  const gone = backup({ history: [tombstone(row(a, T0, 2), T0)] });
  assert.deepEqual(shown(mergeBackups(local, gone, NOW).history), []);
  assert.deepEqual(shown(mergeBackups(gone, local, NOW).history), []);
  const other = backup({ history: [row(a, T0, 2)] });
  assert.equal(
    mergeBackups(local, other, NOW).history[0].params.transpose,
    mergeBackups(other, local, NOW).history[0].params.transpose,
  );
});

test('a deletion reaches the song however its duration drifted', () => {
  const url = 'https://www.youtube.com/watch?v=drifted0001';
  const s201 = makeTrackIdentity(url, 'Song', 201);
  const s200 = makeTrackIdentity(url, 'Song', 200);
  assert.equal(s201.key, s200.key, 'one song, one key — duration is metadata');
  const local = backup({
    history: [tombstone(row(s201, T0), T0 + 5000)],
    favorites: [tombstone(fav(s201, T0), T0 + 5000)],
    tracks: [{ ...record(s201, T0 + 5000, 0), markers: [] }],
  });
  const remote = backup({
    history: [row(s200, T0)],
    favorites: [fav(s200, T0)],
    tracks: [record(s200, T0, 3)],
  });
  const merged = mergeBackups(local, remote, NOW);
  assert.equal(live(merged.history).length, 0);
  assert.equal(live(merged.favorites).length, 0);
  assert.equal(merged.tracks.length, 1, 'and its record is one record, not two');
  // A different song at the same URL (local files share one) is untouched.
  const other = makeTrackIdentity(url, 'Other song', 200);
  const kept = mergeBackups(local, backup({ history: [row(other, T0)] }), NOW);
  assert.equal(live(kept.history).length, 1);
});

test('a deleted EQ preset stays deleted; a later save of the name brings it back', () => {
  const gains = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const deleter = backup({ eqPresets: [{ name: 'Mine', gains: [], updatedAt: T0 + 2000, deleted: true }] });
  const keeper = backup({ eqPresets: [{ name: 'Mine', gains, updatedAt: T0 + 1000 }] });
  assert.deepEqual(live(mergeBackups(deleter, keeper, NOW).eqPresets), []);
  assert.deepEqual(live(mergeBackups(keeper, deleter, NOW).eqPresets), [], 'either way round');
  const unstamped = backup({ eqPresets: [{ name: 'Mine', gains }] });
  assert.deepEqual(live(mergeBackups(deleter, unstamped, NOW).eqPresets), [], 'an undated preset loses');
  const resaved = backup({ eqPresets: [{ name: 'Mine', gains, updatedAt: T0 + 3000 }] });
  assert.equal(live(mergeBackups(deleter, resaved, NOW).eqPresets).length, 1);
  assert.equal(mergeBackups(deleter, resaved, NOW).eqPresets.length, 1, 'and the tombstone is spent');
});

test('a shared preset name goes to the later save; the list reads the same on both', () => {
  const local = backup({ eqPresets: [{ name: 'Mine', gains: [1, 0], updatedAt: T0 + 5 }] });
  const remote = backup({
    eqPresets: [{ name: 'Theirs', gains: [0, 1], updatedAt: T0 + 1 }, { name: 'Mine', gains: [9, 9], updatedAt: T0 + 1 }],
  });
  for (const [x, y] of [[local, remote], [remote, local]] as const) {
    const merged = mergeBackups(x, y, NOW);
    assert.deepEqual(merged.eqPresets.map((p) => p.name), ['Mine', 'Theirs']);
    assert.equal(merged.eqPresets[0].gains[0], 1, 'later save wins');
  }
});

test('settings and prefs go by their own date, not by whose merge it is', () => {
  const local = backup({ settings: { ...DEFAULT_SETTINGS, theme: 'dark', updatedAt: T0 + 5 } });
  const remote = backup({ settings: { ...DEFAULT_SETTINGS, theme: 'light', updatedAt: T0 + 1 } });
  assert.equal(mergeBackups(local, remote, NOW).settings.theme, 'dark');
  assert.equal(mergeBackups(remote, local, NOW).settings.theme, 'dark', 'the same on both devices');
});

test('undated settings on both sides still resolve the same way on both devices', () => {
  const local = backup({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } });
  const remote = backup({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } });
  assert.equal(
    mergeBackups(local, remote, NOW).settings.theme,
    mergeBackups(remote, local, NOW).settings.theme,
  );
});

test('tombstones expire', () => {
  const old = NOW - 40 * 24 * 60 * 60_000;
  const local = backup({ history: [tombstone(row(song(1), old), old), tombstone(row(song(2), T0), T0)] });
  const merged = mergeBackups(local, backup({}), NOW);
  assert.deepEqual(keys(merged.history), [song(2).key]);
});

test('merging a library with itself changes nothing', () => {
  const b = backup({
    history: [row(song(1), T0), row(song(2), T0 + 1), tombstone(row(song(9), T0), T0 + 2)],
    favorites: [fav(song(2), T0)],
    tracks: [record(song(1), T0, 2, true)],
  });
  const merged = mergeBackups(b, b, NOW);
  assert.deepEqual(encodeBackup(merged), encodeBackup(mergeBackups(merged, b, NOW)));
  assert.deepEqual(live(merged.favorites), b.favorites);
  assert.deepEqual(merged.tracks, b.tracks);
});

test('both devices compute the same merge, and it absorbs a third pass', () => {
  const a = backup({
    history: [row(song(1), T0 + 2), row(song(2), T0)],
    favorites: [fav(song(2), T0, T0 + 9), { ...fav(song(4), T0), orderedAt: T0 + 50 }],
    eqPresets: [{ name: 'Mine', gains: [1], updatedAt: T0 + 5 }],
    tracks: [record(song(1), T0 + 3, 2, true)],
    settings: { ...DEFAULT_SETTINGS, theme: 'dark', updatedAt: T0 + 7 },
  });
  const b = backup({
    history: [row(song(3), T0 + 1), tombstone(row(song(2), T0), T0 + 4)],
    favorites: [fav(song(4), T0 + 6), tombstone(fav(song(2), T0), T0 + 4)],
    eqPresets: [{ name: 'Theirs', gains: [2], updatedAt: T0 + 2 }],
    tracks: [record(song(1), T0, 5), record(song(3), T0, 1)],
  });
  const ab = mergeBackups(a, b, NOW);
  const ba = mergeBackups(b, a, NOW);
  assert.deepEqual(encodeBackup(ba), encodeBackup(ab), 'the same blob from either side');
  // Whoever pushed second has nothing to send back: re-merging your own copy
  // against the published result reproduces it exactly. This is what stops
  // two devices trading pushes for ever.
  assert.deepEqual(encodeBackup(mergeBackups(a, ab, NOW)), encodeBackup(ab));
  assert.deepEqual(encodeBackup(mergeBackups(b, ab, NOW)), encodeBackup(ab));
});
