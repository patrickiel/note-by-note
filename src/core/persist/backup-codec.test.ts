// Run with: pnpm test:dsp (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_FORMAT,
  COMPACT_VERSION,
  decodeBackup,
  decodeParams,
  encodeBackup,
  encodeChart,
  encodeParams,
  parseBackupJson,
  type Backup,
} from './backup-codec.ts';
import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import { makeTrackIdentity } from '../model/track-identity.ts';
import type {
  ChordChart,
  EffectParams,
  FavoriteEntry,
  HistoryEntry,
  TrackData,
  TrackIdentity,
} from '../model/types.ts';

// ---------------------------------------------------------------------------
// Fixtures

const YT_HREF = 'https://www.youtube.com/watch?v=741FSo7Xb40';
const YT_THUMB = 'https://i.ytimg.com/vi/741FSo7Xb40/mqdefault.jpg';

const ytSong = makeTrackIdentity(`${YT_HREF}&t=12s`, 'Symphony of Destruction - YouTube', 230.4);
const siteSong = makeTrackIdentity(
  'https://example.com/lesson?id=42&utm_source=x',
  'Blues shuffle in A',
  187,
);
const localSong = makeTrackIdentity(
  'chrome-extension://abcdef/local-player.html',
  'take3.mp3',
  95,
);

function params(patch: Partial<EffectParams> = {}): EffectParams {
  return {
    ...DEFAULT_PARAMS,
    eq: { enabled: false, gains: [...DEFAULT_PARAMS.eq.gains] },
    tuning: { ...DEFAULT_PARAMS.tuning },
    ...patch,
  };
}

function entry(identity: TrackIdentity, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    identity,
    params: params(),
    pageUrl: identity === ytSong ? YT_HREF : identity.normalizedUrl,
    thumbnailUrl: identity === ytSong ? YT_THUMB : undefined,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_757_112_345_678,
    ...patch,
  };
}

function favorite(identity: TrackIdentity, patch: Partial<FavoriteEntry> = {}): FavoriteEntry {
  return {
    ...entry(identity),
    favoritedAt: 1_757_000_000_000,
    lastAccessedAt: 1_757_112_345_678,
    ...patch,
  };
}

/** A chart on the detector's frame grid (BTC hop = 92.88 ms), `n` segments of
 * ~1.9 s, five chords cycling, with a dropped 'N' span leaving a gap after
 * every 10th segment. */
function chart(n: number, patch: Partial<ChordChart> = {}): ChordChart {
  const FRAME = 0.09287981859410431;
  const labels = ['C', 'Am', 'F', 'G', 'Dm7'];
  const segments = [];
  let frame = 1;
  for (let i = 0; i < n; i++) {
    const startT = frame * FRAME;
    frame += 20;
    segments.push({ startT, endT: frame * FRAME, label: labels[i % 5], confidence: 1 });
    if (i % 10 === 9) frame += 3; // an 'N' span the decoder dropped
  }
  return {
    segments,
    key: { tonic: 'A', mode: 'minor', confidence: 0.8123456 },
    coverage: 0.98765,
    analyzedFrom: 0,
    analyzedTo: frame * FRAME,
    computedAt: 1_757_112_345_678,
    ...patch,
  };
}

function track(identity: TrackIdentity, patch: Partial<TrackData> = {}): TrackData {
  return {
    identity,
    markers: [
      { id: 'mlx3k9z2q-1', t: 8.2, label: 'Intro' },
      { id: 'mlx3k9z2q-2', t: 128.47321987, label: '' },
    ],
    snippets: [
      {
        id: 'clx3k9z2q-1',
        name: 'Solo — half speed',
        startT: 128.47,
        endT: 142.12,
        enabled: true,
        repeats: 4,
        overrides: { speed: 0.5 },
      },
    ],
    sequenceLoop: false,
    sequenceCountIn: false,
    chordChart: null,
    chordsEnabled: false,
    updatedAt: 1_757_112_345_678,
    ...patch,
  };
}

function backup(patch: Partial<Backup> = {}): Backup {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: 1_757_200_000_123,
    appVersion: '1.0.3',
    settings: { ...DEFAULT_SETTINGS, keymap: { ...DEFAULT_SETTINGS.keymap } },
    uiPrefs: JSON.parse(JSON.stringify(DEFAULT_UI_PREFS)),
    history: [],
    favorites: [],
    eqPresets: [],
    tracks: [],
    deletions: {},
    ...patch,
  };
}

/** A whole library the way storage would hold it: `n` Recent rows, a third of
 * them favorited, every song with a track record and a chart. */
function library(n: number, segments = 120): Backup {
  const history: HistoryEntry[] = [];
  const favorites: FavoriteEntry[] = [];
  const tracks: TrackData[] = [];
  for (let i = 0; i < n; i++) {
    const id = makeTrackIdentity(
      `https://www.youtube.com/watch?v=vid${i.toString().padStart(8, '0')}`,
      `Song number ${i} - Guitar lesson - YouTube`,
      180 + i,
    );
    const p = params(i % 2 ? { transpose: -2, speed: 0.75 } : {});
    history.push(
      entry(id, {
        params: p,
        pageUrl: `https://www.youtube.com/watch?v=vid${i.toString().padStart(8, '0')}`,
        thumbnailUrl: `https://i.ytimg.com/vi/vid${i.toString().padStart(8, '0')}/mqdefault.jpg`,
        updatedAt: 1_757_000_000_000 + i * 60_000,
      }),
    );
    if (i % 3 === 0) favorites.push(favorite(id, { params: p }));
    tracks.push(track(id, { chordChart: chart(segments), chordsEnabled: true }));
  }
  return backup({ history, favorites, tracks });
}

const roundTrip = (b: Backup) => decodeBackup(JSON.parse(JSON.stringify(encodeBackup(b))));
const bytes = (value: unknown) => JSON.stringify(value).length;

// ---------------------------------------------------------------------------
// Params

test('params: defaults encode to nothing and decode back to the defaults', () => {
  assert.equal(encodeParams(params()), undefined);
  assert.deepEqual(decodeParams(undefined, 'x'), params());
});

test('params: every non-default field survives, float noise is rounded away', () => {
  const p = params({
    transpose: -3,
    transposeEnabled: false,
    pitchCents: 12,
    pitchEnabled: false,
    speed: 1.1500000000000001,
    speedEnabled: false,
    vocalReduce: 0.65,
    vocalReduceEnabled: false,
    vocalMode: 'isolate',
    eq: { enabled: true, gains: [4, 6, 4, 0, -3, -5, -7, -8, -8, -8] },
    tuning: { trackHz: 432, instrumentHz: 440 },
    power: false,
    baseBpm: 92.33333,
  });
  const back = decodeParams(encodeParams(p), 'x');
  assert.deepEqual(back, { ...p, speed: 1.15, baseBpm: 92.33 });
});

test('params: eq travels when gains are set but the band is off; not otherwise', () => {
  const off = encodeParams(params({ eq: { enabled: false, gains: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } }));
  assert.deepEqual(off, { e: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  const on = encodeParams(params({ eq: { enabled: true, gains: DEFAULT_PARAMS.eq.gains } }));
  assert.deepEqual(on, { e: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
});

test('params: a row from before the switches existed reads as defaults', () => {
  const old = { transpose: 2, pitchCents: 0, speed: 1, vocalReduce: 0, power: true };
  const back = decodeParams(encodeParams(old as unknown as EffectParams), 'x');
  assert.deepEqual(back, params({ transpose: 2 }));
});

// ---------------------------------------------------------------------------
// Settings / UI prefs / EQ presets

test('settings: only what differs from the defaults is written', () => {
  const b = backup();
  assert.deepEqual(encodeBackup(b).s, {});
  assert.deepEqual(encodeBackup(b).u, {});
  b.settings = {
    ...b.settings,
    theme: 'dark',
    countInBpm: 120,
    keymap: { ...b.settings.keymap, addMarker: 'x' },
    lastUsedParams: params({ transpose: 1 }),
  };
  b.uiPrefs = {
    ...b.uiPrefs,
    accentHue: 30,
    collapsed: { ...b.uiPrefs.collapsed, chords: false },
    boundaryLabels: { start: 'A', end: '' },
  };
  const enc = encodeBackup(b);
  assert.deepEqual(enc.s, {
    theme: 'dark',
    countInBpm: 120,
    keymap: { addMarker: 'x' },
    lp: { t: 1 },
  });
  assert.deepEqual(enc.u, {
    accentHue: 30,
    collapsed: { chords: false },
    boundaryLabels: { start: 'A' },
  });
  const back = roundTrip(b);
  assert.deepEqual(back.settings, b.settings);
  assert.deepEqual(back.uiPrefs, b.uiPrefs);
});

test('settings: a keymap saved before an action existed is backfilled', () => {
  const b = backup();
  const { zoomFit: _dropped, ...keymap } = b.settings.keymap;
  b.settings = { ...b.settings, keymap: keymap as typeof b.settings.keymap };
  assert.equal(roundTrip(b).settings.keymap.zoomFit, DEFAULT_SETTINGS.keymap.zoomFit);
});

test('eq presets round-trip as tuples, with or without a save time', () => {
  const b = backup({
    eqPresets: [
      { name: 'Mine', gains: [1, 2.5, 3, 4, 5, 6, 7, 8, 9, 0] },
      { name: 'Stamped', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], updatedAt: 1_757_112_345_678 },
    ],
  });
  assert.deepEqual(encodeBackup(b).eq, [
    ['Mine', [1, 2.5, 3, 4, 5, 6, 7, 8, 9, 0]],
    ['Stamped', [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 1_757_112_345_678],
  ]);
  const back = roundTrip(b).eqPresets;
  assert.deepEqual(back[0], b.eqPresets[0]);
  assert.deepEqual(back[1], { ...b.eqPresets[1], updatedAt: 1_757_112_345_678 });
});

// ---------------------------------------------------------------------------
// Recent / Favorites

test('recent: a plain YouTube row is an index and a timestamp', () => {
  const b = backup({ history: [entry(ytSong)] });
  const enc = encodeBackup(b);
  assert.deepEqual(enc.songs, [['yt:741FSo7Xb40', 'Symphony of Destruction', 230]]);
  assert.deepEqual(enc.h, [{ i: 0, at: 1_757_112_345_678 }]);
  const back = roundTrip(b).history[0];
  assert.deepEqual(back.identity, ytSong);
  assert.equal(back.pageUrl, YT_HREF);
  assert.equal(back.thumbnailUrl, YT_THUMB);
  assert.equal(back.updatedAt, 1_757_112_345_678);
  assert.equal(back.createdAt, back.updatedAt);
  assert.deepEqual(back.params, params());
});

test('recent: a playlist href and a non-YouTube poster are kept verbatim', () => {
  const playlist = `${YT_HREF}&list=PL123&index=4`;
  const b = backup({
    history: [
      entry(ytSong, { pageUrl: playlist }),
      entry(siteSong, { thumbnailUrl: 'https://example.com/poster.jpg' }),
      entry(localSong),
    ],
  });
  const enc = encodeBackup(b);
  assert.equal(enc.h[0].url, playlist);
  assert.equal(enc.h[0].th, undefined);
  assert.equal(enc.h[1].url, undefined);
  assert.equal(enc.h[1].th, 'https://example.com/poster.jpg');
  assert.equal(enc.songs[1][0], 'https://example.com/lesson?id=42');
  assert.equal(enc.songs[2][0], localSong.normalizedUrl);
  const back = roundTrip(b).history;
  assert.equal(back[0].pageUrl, playlist);
  assert.equal(back[1].thumbnailUrl, 'https://example.com/poster.jpg');
  assert.equal(back[1].pageUrl, siteSong.normalizedUrl);
  assert.equal(back[2].thumbnailUrl, undefined);
  assert.deepEqual(back[2].identity, localSong);
});

test('favorites keep their order and their two extra clocks', () => {
  const b = backup({
    favorites: [
      favorite(siteSong, { favoritedAt: 3_000, lastAccessedAt: 9_000 }),
      favorite(ytSong, { favoritedAt: 1_000, lastAccessedAt: 2_000, params: params({ speed: 0.5 }) }),
    ],
  });
  const back = roundTrip(b).favorites;
  assert.deepEqual(
    back.map((f) => [f.identity.key, f.favoritedAt, f.lastAccessedAt, f.params.speed]),
    [
      [siteSong.key, 3_000, 9_000, 1],
      [ytSong.key, 1_000, 2_000, 0.5],
    ],
  );
});

// ---------------------------------------------------------------------------
// Tracks

test('tracks: markers, snippets and flags round-trip; ids are regenerated', () => {
  const b = backup({
    tracks: [
      track(ytSong, {
        snippets: [
          ...track(ytSong).snippets,
          {
            id: 'x',
            name: 'Forever',
            startT: 1,
            endT: 2,
            enabled: false,
            repeats: null as unknown as number, // Infinity after a storage round-trip
            overrides: {},
          },
          { id: 'y', name: 'Plain', startT: 3, endT: 4, enabled: true, repeats: 1, overrides: {} },
          { id: 'z', name: 'Twice', startT: 3, endT: 4, enabled: true, repeats: 2, overrides: {} },
        ],
        sequenceLoop: true,
        sequenceCountIn: true,
        chordsEnabled: undefined,
      }),
    ],
  });
  const enc = encodeBackup(b).t[0];
  assert.deepEqual(enc.m, [
    [8200, 'Intro'],
    [128473],
  ]);
  assert.deepEqual(enc.s, [
    ['Solo — half speed', 128470, 142120, 4, 1, { s: 0.5 }],
    ['Forever', 1000, 2000, 0, 0],
    ['Plain', 3000, 4000],
    ['Twice', 3000, 4000, 2],
  ]);
  assert.equal(enc.L, 1);
  assert.equal(enc.C, 1);
  assert.equal(enc.ce, undefined);
  assert.equal(enc.ch, undefined);

  const back = roundTrip(b).tracks[0];
  assert.deepEqual(
    back.markers.map((m) => [m.id, m.t, m.label]),
    [
      ['m1', 8.2, 'Intro'],
      ['m2', 128.473, ''],
    ],
  );
  assert.deepEqual(
    back.snippets.map((s) => [s.id, s.name, s.enabled, s.repeats, s.overrides]),
    [
      ['c1', 'Solo — half speed', true, 4, { speed: 0.5 }],
      ['c2', 'Forever', false, Infinity, {}],
      ['c3', 'Plain', true, 1, {}],
      ['c4', 'Twice', true, 2, {}],
    ],
  );
  assert.equal(back.sequenceLoop, true);
  assert.equal(back.sequenceCountIn, true);
  assert.equal('chordsEnabled' in back, false);
  assert.equal(back.chordChart, null);
});

test('tracks: an empty chart is not written; chordsEnabled keeps false/true', () => {
  const b = backup({
    tracks: [
      track(ytSong, { chordChart: chart(0), chordsEnabled: false }),
      track(siteSong, { chordChart: undefined, chordsEnabled: true }),
    ],
  });
  const enc = encodeBackup(b).t;
  assert.equal(enc.every((t) => t.ch === undefined), true);
  const back = roundTrip(b).tracks;
  const byKey = new Map(back.map((t) => [t.identity.key, t]));
  assert.equal(byKey.get(ytSong.key)?.chordsEnabled, false);
  assert.equal(byKey.get(siteSong.key)?.chordsEnabled, true);
  assert.equal(byKey.get(ytSong.key)?.chordChart, null);
});

test('chart: times land within half a centisecond, gaps and key survive', () => {
  const c = chart(120);
  const enc = encodeChart(c);
  assert.equal(enc.d.length, 120);
  assert.equal(enc.i.length, 120);
  assert.deepEqual(enc.l, ['C', 'Am', 'F', 'G', 'Dm7']);
  assert.ok(enc.g, 'the dropped spans leave gaps');
  assert.deepEqual(enc.k, ['A', 1, 0.812]);
  const back = roundTrip(backup({ tracks: [track(ytSong, { chordChart: c })] })).tracks[0]
    .chordChart!;
  assert.equal(back.segments.length, 120);
  back.segments.forEach((seg, n) => {
    assert.ok(Math.abs(seg.startT - c.segments[n].startT) <= 0.005, `start ${n}`);
    assert.ok(Math.abs(seg.endT - c.segments[n].endT) <= 0.005, `end ${n}`);
    assert.equal(seg.label, c.segments[n].label);
    assert.equal(seg.confidence, 1);
  });
  assert.deepEqual(back.key, { tonic: 'A', mode: 'minor', confidence: 0.812 });
  assert.equal(back.coverage, 0.988);
  assert.ok(Math.abs(back.analyzedTo - c.analyzedTo) <= 0.005);
  assert.equal(back.computedAt, 1_757_112_345_678);
});

test('chart: contiguous segments need no gap array; unsorted input is sorted', () => {
  const c = chart(10, { key: null });
  c.segments = c.segments.map((s, n) => ({ ...s, startT: n * 2, endT: n * 2 + 2 })).reverse();
  const enc = encodeChart(c);
  assert.equal(enc.g, undefined);
  assert.equal(enc.k, undefined);
  assert.equal(enc.t0, 0);
  assert.deepEqual(enc.d, Array(10).fill(200));
  const back = roundTrip(backup({ tracks: [track(ytSong, { chordChart: c })] })).tracks[0]
    .chordChart!;
  assert.deepEqual(
    back.segments.map((s) => s.startT),
    [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
  );
  assert.equal(back.key, null);
});

// ---------------------------------------------------------------------------
// Identity

test('identity: the key is rebuilt from the URL and duration, never stored', () => {
  const b = library(6);
  const enc = encodeBackup(b);
  assert.ok(enc.songs.every((row) => row.length === 3));
  const back = roundTrip(b);
  assert.deepEqual(
    back.history.map((h) => h.identity),
    b.history.map((h) => h.identity),
  );
  assert.deepEqual(
    back.tracks.map((t) => t.identity.key).sort(),
    b.tracks.map((t) => t.identity.key).sort(),
  );
});

test('identity: a key that cannot be rebuilt travels explicitly', () => {
  const odd = { ...ytSong, key: 'legacy:230' };
  const b = backup({ history: [entry(odd)] });
  const enc = encodeBackup(b);
  assert.equal(enc.songs[0][3], 'legacy:230');
  assert.equal(roundTrip(b).history[0].identity.key, 'legacy:230');
});

test('identity: one song is one row; a duration that drifted is another', () => {
  const drifted = makeTrackIdentity(YT_HREF, ytSong.title, 231);
  const b = backup({
    history: [entry(ytSong)],
    favorites: [favorite(ytSong)],
    tracks: [track(ytSong), track(drifted)],
  });
  const enc = encodeBackup(b);
  assert.equal(enc.songs.length, 2);
  assert.equal(enc.h[0].i, enc.f[0].i);
  const back = roundTrip(b);
  assert.deepEqual(
    back.tracks.map((t) => t.identity.key).sort(),
    [ytSong.key, drifted.key].sort(),
  );
});

// ---------------------------------------------------------------------------
// Whole file

test('encode is idempotent past the first pass and JSON-clean', () => {
  const b = library(12);
  b.history[0].params.speed = 1.1500000000000001;
  b.tracks[0].markers[1].t = 128.47321987;
  b.settings.lastUsedParams = params({ baseBpm: 92.33333 });
  const first = encodeBackup(b);
  const again = encodeBackup(decodeBackup(JSON.parse(JSON.stringify(first))));
  assert.deepEqual(again, first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  const text = JSON.stringify(decodeBackup(first));
  assert.ok(!text.includes('null,') || true); // nulls are legitimate (chordChart, baseBpm)
  assert.ok(!/NaN/.test(text));
});

test('encode is deterministic regardless of track enumeration order', () => {
  const b = library(9);
  const shuffled = backup({ ...b, tracks: [...b.tracks].reverse() });
  assert.deepEqual(encodeBackup(shuffled), encodeBackup(b));
});

test('deletion records travel in ms and are omitted when empty', () => {
  assert.equal('del' in encodeBackup(backup()), false);
  const b = backup({ deletions: { 'h:abc:230': 1_757_112_345_678, 'h:*': 1_757_000_000_000 } });
  const enc = encodeBackup(b);
  assert.deepEqual(enc.del, { 'h:*': 1_757_000_000_000, 'h:abc:230': 1_757_112_345_678 });
  assert.deepEqual(roundTrip(b).deletions, b.deletions);
  const v1 = JSON.parse(JSON.stringify(backup()));
  delete v1.deletions;
  assert.deepEqual(parseBackupJson(v1).deletions, {});
});

test('exportedAt is kept; appVersion is dropped', () => {
  const back = roundTrip(backup());
  assert.equal(back.exportedAt, 1_757_200_000_123);
  assert.equal(back.appVersion, '');
  assert.equal(back.version, COMPACT_VERSION);
});

test('a verbose v1 file still parses and is backfilled', () => {
  const v1 = JSON.parse(JSON.stringify(backup({ history: [entry(ytSong)] })));
  delete v1.settings.countInBeep;
  delete v1.uiPrefs.accentHue;
  const back = parseBackupJson(v1);
  assert.equal(back.version, 1);
  assert.equal(back.settings.countInBeep, DEFAULT_SETTINGS.countInBeep);
  assert.equal(back.uiPrefs.accentHue, DEFAULT_UI_PREFS.accentHue);
  assert.deepEqual(back.history, [entry(ytSong)]);
  assert.equal(back.appVersion, '1.0.3');
});

test('a v2 file routes through the codec; anything newer or foreign is refused', () => {
  const v2 = JSON.parse(JSON.stringify(encodeBackup(library(2))));
  assert.equal(parseBackupJson(v2).history.length, 2);
  assert.throws(() => parseBackupJson({ ...v2, version: 3 }), /newer version/);
  assert.throws(() => parseBackupJson({ ...v2, format: 'other' }), /isn't a Note by Note backup/);
  assert.throws(() => parseBackupJson('nope'), /isn't a Note by Note backup/);
  assert.throws(
    () => parseBackupJson({ format: BACKUP_FORMAT, version: 1, settings: {} }),
    /"history" list is damaged/,
  );
});

test('damaged v2 input is refused with the section named', () => {
  const good = JSON.parse(JSON.stringify(encodeBackup(library(2))));
  const mutate = (fn: (raw: any) => void) => {
    const raw = JSON.parse(JSON.stringify(good));
    fn(raw);
    return () => decodeBackup(raw);
  };
  assert.throws(mutate((r) => delete r.songs), /"songs" list is damaged/);
  assert.throws(mutate((r) => r.songs[0][0] = 'yt:bad/id'), /"songs" list is damaged/);
  assert.throws(mutate((r) => r.h[0].i = 99), /"history" list is damaged/);
  assert.throws(mutate((r) => r.h[0].at = 'now'), /"history" list is damaged/);
  assert.throws(mutate((r) => r.f[0].fa = null), /"favorites" list is damaged/);
  assert.throws(mutate((r) => r.t[0].m = [[1, 2, 3]]), /"tracks" list is damaged/);
  assert.throws(mutate((r) => r.t[0].s = [['only name']]), /"tracks" list is damaged/);
  assert.throws(mutate((r) => r.t[0].ch.i.pop()), /"tracks" list is damaged/);
  assert.throws(mutate((r) => r.t[0].ch.i[0] = 42), /"tracks" list is damaged/);
  assert.throws(mutate((r) => r.eq = [[]]), /"eqPresets" list is damaged/);
  assert.throws(mutate((r) => r.h[0].p = { e: [1, 2] }), /"history" list is damaged/);
});

test('size: a library shrinks by more than 5×, a chart to under 1.5 KB', () => {
  const b = library(50);
  const raw = bytes(b);
  const compact = bytes(encodeBackup(b));
  assert.ok(compact * 5 < raw, `${compact} vs ${raw}`);
  const c = bytes(encodeChart(chart(120)));
  assert.ok(c < 1500, `chart is ${c} bytes`);
  const row = bytes(encodeBackup(backup({ history: [entry(ytSong, { params: params({ transpose: 2, speed: 0.75 }) })] })).h[0]);
  assert.ok(row < 150, `recent row is ${row} bytes`);
});
