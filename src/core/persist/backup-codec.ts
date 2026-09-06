import {
  DEFAULT_KEYMAP,
  DEFAULT_PARAMS,
  DEFAULT_SETTINGS,
  DEFAULT_UI_PREFS,
} from '../model/defaults.ts';
import { youtubeThumbnailUrl } from '../model/thumbnail.ts';
import { identityKey } from '../model/track-identity.ts';
import { normalizeDeletions, type Deletions } from './deletions.ts';
import type {
  ChordChart,
  ChordSegment,
  EffectParams,
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  Marker,
  Settings,
  Snippet,
  SnippetOverrides,
  TrackData,
  TrackIdentity,
  UiPrefs,
} from '../model/types';

/**
 * The backup file format — the verbose in-memory `Backup` (v1) and its
 * compact serialization (v2), which is what the export writes and what will
 * ride the browser's sync storage. Nothing in `storage.local` changes: the
 * codec shrinks the wire shape only, and `decodeBackup` hands back today's
 * types.
 *
 * Pure and DOM-free so it runs under `node --test`; hence relative `.ts`
 * imports and no `#imports` (see CLAUDE.md).
 *
 * Where the bytes go, and what v2 does about it: identities were repeated in
 * Recent, Favorites and the track record (one `songs` table, referenced by
 * index); every Recent row carried the full 13-field params object (a delta
 * against the defaults, usually empty); chord charts spelled out four keys and
 * 17-digit floats per segment (parallel arrays on a centisecond grid, labels
 * through a per-chart table); settings/UI prefs carried every default (deep
 * diff). Things derivable from what is kept are dropped: the identity key,
 * YouTube thumbnails, the plain watch-page URL, marker/snippet ids.
 *
 * Every rounding is idempotent — `encode(decode(encode(x)))` deep-equals
 * `encode(x)` — which is what will let two devices compare content hashes of
 * data that both went through this.
 */

/** Marks a file as ours, so a stray JSON can be rejected on sight. */
export const BACKUP_FORMAT = 'note-by-note-backup';

/** The verbose shape: what `createBackup` builds and what exports were
 * before the compact format. Still accepted on import. */
export const BACKUP_VERSION = 1;

/** The compact shape below. `parseBackupJson` rejects anything newer. */
export const COMPACT_VERSION = 2;

/** Everything a user owns, in one file. Host permissions are deliberately out:
 * they live in the browser's permission store, and only a prompt can grant
 * them — a backup that listed origins would restore access it can't give. */
export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  appVersion: string;
  settings: Settings;
  uiPrefs: UiPrefs;
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  eqPresets: EqPreset[];
  /** Per-track markers and snippets, one entry per saved track. */
  tracks: TrackData[];
  /** What was deleted and when — see `deletions.ts`. Absent in files from
   * before sync merged; `{}` then. */
  deletions: Deletions;
}

// ---------------------------------------------------------------------------
// Compact shape

/** Effect params as a delta against `DEFAULT_PARAMS`; absent = default. */
export interface CompactParams {
  /** transpose (semitones) */
  t?: number;
  /** transposeEnabled off */
  te?: 0;
  /** pitchCents */
  c?: number;
  /** pitchEnabled off */
  ce?: 0;
  /** speed */
  s?: number;
  /** speedEnabled off */
  se?: 0;
  /** vocalReduce */
  v?: number;
  /** vocalReduceEnabled off */
  ve?: 0;
  /** vocalMode 'isolate' */
  vm?: 1;
  /** eq: [enabled, ...gains] — present when enabled or any gain is non-zero */
  e?: number[];
  /** tuning: [trackHz, instrumentHz] — present when not 440/440 */
  tu?: [number, number];
  /** power off */
  pw?: 0;
  /** baseBpm */
  b?: number;
}

/** `[normalizedUrl, title, durationSec, key?]`. YouTube watch URLs are
 * shortened to `yt:<id>`. `key` appears only when it can't be rebuilt from the
 * other two — a safety net, never the case for keys this build made. */
export type CompactSong = [string, string, number] | [string, string, number, string];

export interface CompactEntry {
  /** Index into `songs`. */
  i: number;
  /** updatedAt, seconds. */
  at: number;
  p?: CompactParams;
  /** pageUrl, when not the song's plain page. */
  url?: string;
  /** thumbnailUrl, when not derivable from the page URL. */
  th?: string;
}

export interface CompactFavorite extends CompactEntry {
  /** favoritedAt, seconds. */
  fa: number;
  /** lastAccessedAt, seconds. */
  la: number;
}

/** `[t_ms, label?]` — label omitted when empty. */
export type CompactMarker = [number] | [number, string];

/** `[name, start_ms, end_ms, repeats?, enabled?, overrides?]`, trailing
 * defaults omitted (`1`, `1`, `{}`). `repeats` 0 stands for Infinity. */
export type CompactSnippet = [string, number, number, number?, number?, CompactOverrides?];

export interface CompactOverrides {
  s?: number;
  t?: number;
  v?: number;
}

/** Segments as parallel arrays on a centisecond grid. */
export interface CompactChart {
  /** First segment start. */
  t0: number;
  /** Durations. */
  d: number[];
  /** Gap before each segment (index 0 is always 0); omitted when all zero. */
  g?: number[];
  /** Label table, first-appearance order. */
  l: string[];
  /** Label index per segment. */
  i: number[];
  /** Key signature: [tonic, minor, confidence]; omitted when none. */
  k?: [string, 0 | 1, number];
  cov: number;
  a0: number;
  a1: number;
  /** computedAt, seconds. */
  c: number;
}

export interface CompactTrack {
  i: number;
  /** updatedAt, seconds. */
  at: number;
  m?: CompactMarker[];
  s?: CompactSnippet[];
  /** sequenceLoop */
  L?: 1;
  /** sequenceCountIn */
  C?: 1;
  /** chordsEnabled, only when the record has the switch at all. */
  ce?: 0 | 1;
  ch?: CompactChart;
}

export interface CompactBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof COMPACT_VERSION;
  /** exportedAt, seconds. */
  at: number;
  /** Settings that differ from the defaults (`lastUsedParams` as `lp`). */
  s: Record<string, unknown>;
  /** UI prefs that differ from the defaults. */
  u: Record<string, unknown>;
  /** `[name, ...gains]` per saved EQ preset. */
  eq: (string | number)[][];
  songs: CompactSong[];
  h: CompactEntry[];
  f: CompactFavorite[];
  t: CompactTrack[];
  /** Deletion records, dates in seconds; omitted when there are none. */
  del?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Shared helpers

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function damaged(section: string): Error {
  return new Error(`This backup's "${section}" list is damaged.`);
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`This backup's "${field}" list is missing or damaged.`);
  }
  return value;
}

/** Entries are keyed by `identity.key`; without one they can't be stored or
 * matched back to a track, so a file carrying them is not usable. */
export function requireKeyedArray<T>(value: unknown, field: string): T[] {
  const list = requireArray(value, field);
  const keyed = list.every(
    (e) => isRecord(e) && isRecord(e.identity) && typeof e.identity.key === 'string',
  );
  if (!keyed) throw damaged(field);
  return list as T[];
}

const roundTo = (dp: number) => {
  const f = 10 ** dp;
  return (x: number) => Math.round(x * f) / f;
};
const round2 = roundTo(2);
const round3 = roundTo(3);
const millis = (seconds: number) => Math.round(seconds * 1000);
const centis = (seconds: number) => Math.round(seconds * 100);
const secs = (ms: number) => Math.round((Number.isFinite(ms) ? ms : 0) / 1000);

function num(value: unknown, section: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw damaged(section);
  return value;
}

function str(value: unknown, section: string): string {
  if (typeof value !== 'string') throw damaged(section);
  return value;
}

function arr(value: unknown, section: string): unknown[] {
  if (!Array.isArray(value)) throw damaged(section);
  return value;
}

function rec(value: unknown, section: string): Record<string, unknown> {
  if (!isRecord(value)) throw damaged(section);
  return value;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys of `value` whose (JSON) value differs from `defaults`, recursing into
 * plain objects. Keys unknown to `defaults` are kept verbatim. */
function diffPlain(
  value: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const d = defaults[key];
    if (isRecord(v) && isRecord(d)) {
      const nested = diffPlain(v, d);
      if (Object.keys(nested).length) out[key] = nested;
    } else if (!(key in defaults) || !jsonEqual(v, d)) {
      out[key] = v;
    }
  }
  return out;
}

/** The inverse of `diffPlain`: a deep clone of `defaults` with `diff` laid
 * over it. */
function mergePlain(
  defaults: Record<string, unknown>,
  diff: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(defaults));
  for (const [key, v] of Object.entries(diff)) {
    if (v === undefined) continue;
    const d = out[key];
    out[key] = isRecord(v) && isRecord(d) ? mergePlain(d, v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effect params

/** Old rows may predate a field (the switches, tuning, vocalMode, baseBpm);
 * a missing one reads as its default, which is how the UI treats it too. */
export function encodeParams(p: EffectParams): CompactParams | undefined {
  const out: CompactParams = {};
  const transpose = round3(p.transpose ?? 0);
  if (transpose !== 0) out.t = transpose;
  if (p.transposeEnabled === false) out.te = 0;
  const cents = round3(p.pitchCents ?? 0);
  if (cents !== 0) out.c = cents;
  if (p.pitchEnabled === false) out.ce = 0;
  const speed = round3(p.speed ?? 1);
  if (speed !== 1) out.s = speed;
  if (p.speedEnabled === false) out.se = 0;
  const vocal = round3(p.vocalReduce ?? 0);
  if (vocal !== 0) out.v = vocal;
  if (p.vocalReduceEnabled === false) out.ve = 0;
  if (p.vocalMode === 'isolate') out.vm = 1;
  const eq = p.eq ?? DEFAULT_PARAMS.eq;
  const gains = (eq.gains ?? DEFAULT_PARAMS.eq.gains).map(round2);
  if (eq.enabled || gains.some((g) => g !== 0)) out.e = [eq.enabled ? 1 : 0, ...gains];
  const tuning = p.tuning ?? DEFAULT_PARAMS.tuning;
  const trackHz = round2(tuning.trackHz ?? 440);
  const instrumentHz = round2(tuning.instrumentHz ?? 440);
  if (trackHz !== 440 || instrumentHz !== 440) out.tu = [trackHz, instrumentHz];
  if (p.power === false) out.pw = 0;
  if (typeof p.baseBpm === 'number' && Number.isFinite(p.baseBpm)) out.b = round2(p.baseBpm);
  return Object.keys(out).length ? out : undefined;
}

function defaultParams(): EffectParams {
  return {
    ...DEFAULT_PARAMS,
    eq: { enabled: false, gains: [...DEFAULT_PARAMS.eq.gains] },
    tuning: { ...DEFAULT_PARAMS.tuning },
  };
}

export function decodeParams(raw: unknown, section: string): EffectParams {
  const p = defaultParams();
  if (raw === undefined) return p;
  const c = rec(raw, section);
  if (c.t !== undefined) p.transpose = num(c.t, section);
  if (c.te !== undefined) p.transposeEnabled = false;
  if (c.c !== undefined) p.pitchCents = num(c.c, section);
  if (c.ce !== undefined) p.pitchEnabled = false;
  if (c.s !== undefined) p.speed = num(c.s, section);
  if (c.se !== undefined) p.speedEnabled = false;
  if (c.v !== undefined) p.vocalReduce = num(c.v, section);
  if (c.ve !== undefined) p.vocalReduceEnabled = false;
  if (c.vm !== undefined) p.vocalMode = 'isolate';
  if (c.e !== undefined) {
    const e = arr(c.e, section);
    if (e.length !== 1 + p.eq.gains.length) throw damaged(section);
    p.eq = { enabled: num(e[0], section) === 1, gains: e.slice(1).map((g) => num(g, section)) };
  }
  if (c.tu !== undefined) {
    const tu = arr(c.tu, section);
    if (tu.length !== 2) throw damaged(section);
    p.tuning = { trackHz: num(tu[0], section), instrumentHz: num(tu[1], section) };
  }
  if (c.pw !== undefined) p.power = false;
  if (c.b !== undefined) p.baseBpm = num(c.b, section);
  return p;
}

// ---------------------------------------------------------------------------
// Settings / UI prefs

const SETTINGS_DEFAULTS: Record<string, unknown> = {
  ...DEFAULT_SETTINGS,
  keymap: { ...DEFAULT_KEYMAP },
};

export function encodeSettings(settings: Settings): Record<string, unknown> {
  const { lastUsedParams, ...rest } = settings;
  const out = diffPlain(rest, SETTINGS_DEFAULTS);
  if (lastUsedParams) out.lp = encodeParams(lastUsedParams) ?? {};
  return out;
}

export function decodeSettings(raw: unknown): Settings {
  const diff = raw === undefined ? {} : rec(raw, 'settings');
  const { lp, ...rest } = diff;
  const settings = mergePlain(SETTINGS_DEFAULTS, rest) as unknown as Settings;
  if (lp !== undefined) settings.lastUsedParams = decodeParams(lp, 'settings');
  return settings;
}

export function encodeUiPrefs(uiPrefs: UiPrefs): Record<string, unknown> {
  return diffPlain(
    uiPrefs as unknown as Record<string, unknown>,
    DEFAULT_UI_PREFS as unknown as Record<string, unknown>,
  );
}

export function decodeUiPrefs(raw: unknown): UiPrefs {
  const diff = raw === undefined ? {} : rec(raw, 'uiPrefs');
  return mergePlain(
    DEFAULT_UI_PREFS as unknown as Record<string, unknown>,
    diff,
  ) as unknown as UiPrefs;
}

// ---------------------------------------------------------------------------
// Songs (identities)

const YT_WATCH = 'https://youtube.com/watch?v=';
const YT_ID_RE = /^[\w-]+$/;

function shortUrl(normalizedUrl: string): string {
  if (normalizedUrl.startsWith(YT_WATCH)) {
    const id = normalizedUrl.slice(YT_WATCH.length);
    if (YT_ID_RE.test(id)) return `yt:${id}`;
  }
  return normalizedUrl;
}

function longUrl(short: string): string {
  if (short.startsWith('yt:')) {
    const id = short.slice(3);
    if (!YT_ID_RE.test(id)) throw damaged('songs');
    return YT_WATCH + id;
  }
  return short;
}

/** The page a song is opened at when the entry carries no `url` of its own:
 * the engine records `location.href`, which on YouTube is the `www.` form of
 * the watch page — so that, not the normalized URL, is the default there. */
function defaultPageUrl(normalizedUrl: string): string {
  if (normalizedUrl.startsWith(YT_WATCH)) {
    return `https://www.youtube.com/watch?v=${normalizedUrl.slice(YT_WATCH.length)}`;
  }
  return normalizedUrl;
}

/** One row per distinct (url, title, duration) — not per URL: the duration is
 * part of the key, and a song whose duration drifted legitimately has two. */
class SongTable {
  rows: CompactSong[] = [];
  #index = new Map<string, number>();

  add(identity: TrackIdentity): number {
    const url = identity.normalizedUrl ?? '';
    const title = identity.title ?? '';
    const duration = Number.isFinite(identity.durationSec) ? identity.durationSec : 0;
    const key = identity.key ?? identityKey(url, duration);
    const tableKey = `${url}\n${title}\n${duration}\n${key}`;
    const existing = this.#index.get(tableKey);
    if (existing !== undefined) return existing;
    const row: CompactSong =
      key === identityKey(url, duration)
        ? [shortUrl(url), title, duration]
        : [shortUrl(url), title, duration, key];
    this.rows.push(row);
    this.#index.set(tableKey, this.rows.length - 1);
    return this.rows.length - 1;
  }
}

function decodeSongs(raw: unknown): TrackIdentity[] {
  return requireArray(raw, 'songs').map((row) => {
    const r = arr(row, 'songs');
    if (r.length < 3 || r.length > 4) throw damaged('songs');
    const normalizedUrl = longUrl(str(r[0], 'songs'));
    const title = str(r[1], 'songs');
    const durationSec = num(r[2], 'songs');
    const key = r.length === 4 ? str(r[3], 'songs') : identityKey(normalizedUrl, durationSec);
    return { key, normalizedUrl, title, durationSec };
  });
}

function songAt(songs: TrackIdentity[], index: unknown, section: string): TrackIdentity {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= songs.length) {
    throw damaged(section);
  }
  return songs[index];
}

// ---------------------------------------------------------------------------
// Recent / Favorites

function encodeEntry(entry: HistoryEntry, songs: SongTable): CompactEntry {
  const out: CompactEntry = { i: songs.add(entry.identity), at: secs(entry.updatedAt) };
  const params = encodeParams(entry.params ?? DEFAULT_PARAMS);
  if (params) out.p = params;
  const pageUrl = entry.pageUrl ?? '';
  if (pageUrl !== defaultPageUrl(entry.identity.normalizedUrl)) out.url = pageUrl;
  if (entry.thumbnailUrl && entry.thumbnailUrl !== youtubeThumbnailUrl(pageUrl)) {
    out.th = entry.thumbnailUrl;
  }
  return out;
}

function decodeEntry(raw: unknown, songs: TrackIdentity[], section: string): HistoryEntry {
  const c = rec(raw, section);
  const identity = songAt(songs, c.i, section);
  const updatedAt = num(c.at, section) * 1000;
  const pageUrl = c.url === undefined ? defaultPageUrl(identity.normalizedUrl) : str(c.url, section);
  const thumbnailUrl = c.th === undefined ? youtubeThumbnailUrl(pageUrl) : str(c.th, section);
  const entry: HistoryEntry = {
    identity: { ...identity },
    params: decodeParams(c.p, section),
    pageUrl,
    createdAt: updatedAt,
    updatedAt,
  };
  if (thumbnailUrl !== undefined) entry.thumbnailUrl = thumbnailUrl;
  return entry;
}

function encodeFavorite(entry: FavoriteEntry, songs: SongTable): CompactFavorite {
  return {
    ...encodeEntry(entry, songs),
    fa: secs(entry.favoritedAt),
    la: secs(entry.lastAccessedAt),
  };
}

function decodeFavorite(raw: unknown, songs: TrackIdentity[]): FavoriteEntry {
  const c = rec(raw, 'favorites');
  return {
    ...decodeEntry(c, songs, 'favorites'),
    favoritedAt: num(c.fa, 'favorites') * 1000,
    lastAccessedAt: num(c.la, 'favorites') * 1000,
  };
}

// ---------------------------------------------------------------------------
// Tracks

function encodeMarker(marker: Marker): CompactMarker {
  const t = millis(marker.t);
  return marker.label ? [t, marker.label] : [t];
}

function decodeMarker(raw: unknown, index: number): Marker {
  const r = arr(raw, 'tracks');
  if (r.length < 1 || r.length > 2) throw damaged('tracks');
  return {
    id: `m${index + 1}`,
    t: num(r[0], 'tracks') / 1000,
    label: r.length === 2 ? str(r[1], 'tracks') : '',
  };
}

function encodeOverrides(overrides: SnippetOverrides | undefined): CompactOverrides {
  const out: CompactOverrides = {};
  if (!overrides) return out;
  if (typeof overrides.speed === 'number') out.s = round3(overrides.speed);
  if (typeof overrides.transpose === 'number') out.t = round3(overrides.transpose);
  if (typeof overrides.vocalReduce === 'number') out.v = round3(overrides.vocalReduce);
  return out;
}

function decodeOverrides(raw: unknown): SnippetOverrides {
  const c = rec(raw, 'tracks');
  const out: SnippetOverrides = {};
  if (c.s !== undefined) out.speed = num(c.s, 'tracks');
  if (c.t !== undefined) out.transpose = num(c.t, 'tracks');
  if (c.v !== undefined) out.vocalReduce = num(c.v, 'tracks');
  return out;
}

function encodeSnippet(snippet: Snippet): CompactSnippet {
  // `repeats: Infinity` is `null` once it has been through JSON (storage);
  // both mean "forever", written as 0 — real counts start at 1.
  const repeats =
    typeof snippet.repeats === 'number' && Number.isFinite(snippet.repeats) ? snippet.repeats : 0;
  const overrides = encodeOverrides(snippet.overrides);
  const out: CompactSnippet = [
    snippet.name ?? '',
    millis(snippet.startT),
    millis(snippet.endT),
    repeats,
    snippet.enabled === false ? 0 : 1,
    overrides,
  ];
  if (Object.keys(overrides).length === 0) {
    out.pop();
    if (out[4] === 1) {
      out.pop();
      if (out[3] === 1) out.pop();
    }
  }
  return out;
}

function decodeSnippet(raw: unknown, index: number): Snippet {
  const r = arr(raw, 'tracks');
  if (r.length < 3 || r.length > 6) throw damaged('tracks');
  const repeats = r.length > 3 ? num(r[3], 'tracks') : 1;
  return {
    id: `c${index + 1}`,
    name: str(r[0], 'tracks'),
    startT: num(r[1], 'tracks') / 1000,
    endT: num(r[2], 'tracks') / 1000,
    enabled: r.length > 4 ? num(r[4], 'tracks') === 1 : true,
    repeats: repeats === 0 ? Infinity : repeats,
    overrides: r.length > 5 ? decodeOverrides(r[5]) : {},
  };
}

export function encodeChart(chart: ChordChart): CompactChart {
  const segments = [...chart.segments].sort((a, b) => a.startT - b.startT);
  const d: number[] = [];
  const g: number[] = [];
  const l: string[] = [];
  const i: number[] = [];
  const labelIndex = new Map<string, number>();
  let t0 = 0;
  let prevEnd = 0;
  let anyGap = false;
  segments.forEach((seg, n) => {
    const start = centis(seg.startT);
    const end = Math.max(start, centis(seg.endT));
    if (n === 0) {
      t0 = start;
      g.push(0);
    } else {
      const gap = start - prevEnd;
      if (gap !== 0) anyGap = true;
      g.push(gap);
    }
    d.push(end - start);
    let li = labelIndex.get(seg.label);
    if (li === undefined) {
      li = l.length;
      l.push(seg.label);
      labelIndex.set(seg.label, li);
    }
    i.push(li);
    prevEnd = end;
  });
  const out: CompactChart = {
    t0,
    d,
    l,
    i,
    cov: round3(chart.coverage ?? 0),
    a0: centis(chart.analyzedFrom ?? 0),
    a1: centis(chart.analyzedTo ?? 0),
    c: secs(chart.computedAt),
  };
  if (anyGap) out.g = g;
  if (chart.key) {
    out.k = [chart.key.tonic, chart.key.mode === 'minor' ? 1 : 0, round3(chart.key.confidence)];
  }
  return out;
}

export function decodeChart(raw: unknown): ChordChart {
  const c = rec(raw, 'tracks');
  const d = arr(c.d, 'tracks');
  const l = arr(c.l, 'tracks').map((label) => str(label, 'tracks'));
  const i = arr(c.i, 'tracks');
  const g = c.g === undefined ? undefined : arr(c.g, 'tracks');
  if (i.length !== d.length || (g !== undefined && g.length !== d.length)) throw damaged('tracks');
  const segments: ChordSegment[] = [];
  let acc = num(c.t0, 'tracks');
  for (let n = 0; n < d.length; n++) {
    const li = num(i[n], 'tracks');
    if (!Number.isInteger(li) || li < 0 || li >= l.length) throw damaged('tracks');
    const start = acc + (g === undefined ? 0 : num(g[n], 'tracks'));
    const end = start + num(d[n], 'tracks');
    segments.push({ startT: start / 100, endT: end / 100, label: l[li], confidence: 1 });
    acc = end;
  }
  let key: ChordChart['key'] = null;
  if (c.k !== undefined) {
    const k = arr(c.k, 'tracks');
    if (k.length !== 3) throw damaged('tracks');
    key = {
      tonic: str(k[0], 'tracks'),
      mode: num(k[1], 'tracks') === 1 ? 'minor' : 'major',
      confidence: num(k[2], 'tracks'),
    };
  }
  return {
    segments,
    key,
    coverage: num(c.cov, 'tracks'),
    analyzedFrom: num(c.a0, 'tracks') / 100,
    analyzedTo: num(c.a1, 'tracks') / 100,
    computedAt: num(c.c, 'tracks') * 1000,
  };
}

function encodeTrack(track: TrackData, songs: SongTable): CompactTrack {
  const out: CompactTrack = { i: songs.add(track.identity), at: secs(track.updatedAt) };
  if (track.markers?.length) out.m = track.markers.map(encodeMarker);
  if (track.snippets?.length) out.s = track.snippets.map(encodeSnippet);
  if (track.sequenceLoop) out.L = 1;
  if (track.sequenceCountIn) out.C = 1;
  if (track.chordsEnabled !== undefined) out.ce = track.chordsEnabled ? 1 : 0;
  if (track.chordChart && track.chordChart.segments?.length) {
    out.ch = encodeChart(track.chordChart);
  }
  return out;
}

function decodeTrack(raw: unknown, songs: TrackIdentity[]): TrackData {
  const c = rec(raw, 'tracks');
  const track: TrackData = {
    identity: { ...songAt(songs, c.i, 'tracks') },
    markers: c.m === undefined ? [] : arr(c.m, 'tracks').map(decodeMarker),
    snippets: c.s === undefined ? [] : arr(c.s, 'tracks').map(decodeSnippet),
    sequenceLoop: c.L !== undefined,
    sequenceCountIn: c.C !== undefined,
    chordChart: c.ch === undefined ? null : decodeChart(c.ch),
    updatedAt: num(c.at, 'tracks') * 1000,
  };
  if (c.ce !== undefined) track.chordsEnabled = num(c.ce, 'tracks') === 1;
  return track;
}

// ---------------------------------------------------------------------------
// Whole backup

function encodeEqPreset(preset: EqPreset): (string | number)[] {
  return [preset.name ?? '', ...(preset.gains ?? []).map(round2)];
}

function decodeEqPreset(raw: unknown): EqPreset {
  const r = arr(raw, 'eqPresets');
  if (r.length < 1) throw damaged('eqPresets');
  return { name: str(r[0], 'eqPresets'), gains: r.slice(1).map((g) => num(g, 'eqPresets')) };
}

const byKey = (a: { identity: TrackIdentity }, b: { identity: TrackIdentity }) =>
  a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0;

/** Deterministic for equal input: tracks are sorted by key (their storage
 * enumeration order is arbitrary) and the song table is filled in Recent,
 * Favorites, tracks order. */
export function encodeBackup(backup: Backup): CompactBackup {
  const songs = new SongTable();
  const h = backup.history.map((e) => encodeEntry(e, songs));
  const f = backup.favorites.map((e) => encodeFavorite(e, songs));
  const t = [...backup.tracks].sort(byKey).map((track) => encodeTrack(track, songs));
  const out: CompactBackup = {
    format: BACKUP_FORMAT,
    version: COMPACT_VERSION,
    at: secs(backup.exportedAt),
    s: encodeSettings(backup.settings),
    u: encodeUiPrefs(backup.uiPrefs),
    eq: backup.eqPresets.map(encodeEqPreset),
    songs: songs.rows,
    h,
    f,
    t,
  };
  const deletions = Object.entries(normalizeDeletions(backup.deletions)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (deletions.length) out.del = Object.fromEntries(deletions.map(([k, when]) => [k, secs(when)]));
  return out;
}

/** Reads a compact (v2) backup, or throws an `Error` whose message is safe to
 * show the user. Unknown keys are ignored so the format can grow. */
export function decodeBackup(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT || raw.version !== COMPACT_VERSION) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  const songs = decodeSongs(raw.songs);
  return {
    format: BACKUP_FORMAT,
    version: COMPACT_VERSION,
    exportedAt: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at * 1000 : 0,
    appVersion: '',
    settings: decodeSettings(raw.s),
    uiPrefs: decodeUiPrefs(raw.u),
    history: requireArray(raw.h, 'history').map((e) => decodeEntry(e, songs, 'history')),
    favorites: requireArray(raw.f, 'favorites').map((e) => decodeFavorite(e, songs)),
    eqPresets: requireArray(raw.eq, 'eqPresets').map(decodeEqPreset),
    tracks: requireArray(raw.t, 'tracks').map((t) => decodeTrack(t, songs)),
    deletions: Object.fromEntries(
      Object.entries(normalizeDeletions(raw.del)).map(([k, when]) => [k, when * 1000]),
    ),
  };
}

/** The verbose v1 file: today's in-memory shape, written out as is. Objects
 * are backfilled from the defaults so a file from an older build gains any
 * setting added since. */
function normalizeV1(raw: Record<string, unknown>): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    settings: {
      ...DEFAULT_SETTINGS,
      ...(isRecord(raw.settings) ? raw.settings : {}),
    } as Settings,
    uiPrefs: {
      ...(JSON.parse(JSON.stringify(DEFAULT_UI_PREFS)) as UiPrefs),
      ...(isRecord(raw.uiPrefs) ? raw.uiPrefs : {}),
    },
    history: requireKeyedArray<HistoryEntry>(raw.history, 'history'),
    favorites: requireKeyedArray<FavoriteEntry>(raw.favorites, 'favorites'),
    eqPresets: requireArray(raw.eqPresets, 'eqPresets') as EqPreset[],
    tracks: requireKeyedArray<TrackData>(raw.tracks, 'tracks'),
    deletions: normalizeDeletions(raw.deletions),
  };
}

/**
 * Reads a parsed backup file (any version this build knows) into a `Backup`,
 * or throws an `Error` whose message is safe to show the user.
 */
export function parseBackupJson(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  if (typeof raw.version !== 'number' || raw.version > COMPACT_VERSION) {
    throw new Error('That backup was made by a newer version of Note by Note.');
  }
  return raw.version === COMPACT_VERSION ? decodeBackup(raw) : normalizeV1(raw);
}
