// Read-only adapter for previously supported backup formats. New writes use the library schema.
import {
  DEFAULT_PARAMS,
  DEFAULT_SETTINGS,
  DEFAULT_UI_PREFS,
} from '../model/defaults.ts';

import { youtubeThumbnailUrl } from '../model/thumbnail.ts';

import { songKey } from '../model/track-identity.ts';

import { rekeyByIdentity } from './rekey.ts';

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

export const BACKUP_FORMAT = 'note-by-note-backup';

export const BACKUP_VERSION = 1;

export const COMPACT_VERSION = 3;

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function damaged(section: string): Error {
  return new Error(`This backup's "${section}" list is damaged.`);
}

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

function identifiedArr<T>(value: unknown, section: string): T[] {
  const list = arr(value, section);
  const identified = list.every(
    (e) => isRecord(e) && isRecord(e.identity) && typeof e.identity.normalizedUrl === 'string',
  );
  if (!identified) throw damaged(section);
  return list as T[];
}

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

export function decodeParams(raw: unknown, section: string): EffectParams {
  const p = structuredClone(DEFAULT_PARAMS);
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

export function decodeSettings(raw: unknown): Settings {
  const diff = raw === undefined ? {} : rec(raw, 'settings');
  const { lp, ...rest } = diff;
  const settings = mergePlain({ ...DEFAULT_SETTINGS }, rest) as unknown as Settings;
  if (lp !== undefined) settings.lastUsedParams = decodeParams(lp, 'settings');
  return settings;
}

export function decodeUiPrefs(raw: unknown): UiPrefs {
  const diff = raw === undefined ? {} : rec(raw, 'uiPrefs');
  return mergePlain(
    DEFAULT_UI_PREFS as unknown as Record<string, unknown>,
    diff,
  ) as unknown as UiPrefs;
}

const YT_WATCH = 'https://youtube.com/watch?v=';

const YT_ID_RE = /^[\w-]+$/;

function longUrl(short: string): string {
  if (short.startsWith('yt:')) {
    const id = short.slice(3);
    if (!YT_ID_RE.test(id)) throw damaged('songs');
    return YT_WATCH + id;
  }
  return short;
}

function defaultPageUrl(normalizedUrl: string): string {
  if (normalizedUrl.startsWith(YT_WATCH)) {
    return `https://www.youtube.com/watch?v=${normalizedUrl.slice(YT_WATCH.length)}`;
  }
  return normalizedUrl;
}

function decodeSongs(raw: unknown): TrackIdentity[] {
  return arr(raw, 'songs').map((row) => {
    const r = arr(row, 'songs');
    if (r.length !== 3) throw damaged('songs');
    const normalizedUrl = longUrl(str(r[0], 'songs'));
    const title = str(r[1], 'songs');
    const durationSec = num(r[2], 'songs');
    return { key: songKey({ normalizedUrl, title }), normalizedUrl, title, durationSec };
  });
}

function songAt(songs: TrackIdentity[], index: unknown, section: string): TrackIdentity {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= songs.length) {
    throw damaged(section);
  }
  return songs[index];
}

function decodeEntry(raw: unknown, songs: TrackIdentity[], section: string): HistoryEntry {
  const c = rec(raw, section);
  const identity = songAt(songs, c.i, section);
  const updatedAt = num(c.at, section);
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
  if (c.x === 1) entry.deleted = true;
  return entry;
}

function decodeFavorite(raw: unknown, songs: TrackIdentity[]): FavoriteEntry {
  const c = rec(raw, 'favorites');
  const favorite: FavoriteEntry = {
    ...decodeEntry(c, songs, 'favorites'),
    favoritedAt: num(c.fa, 'favorites'),
    lastAccessedAt: num(c.la, 'favorites'),
  };
  if (c.oa !== undefined) favorite.orderedAt = num(c.oa, 'favorites');
  return favorite;
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

function decodeOverrides(raw: unknown): SnippetOverrides {
  const c = rec(raw, 'tracks');
  const out: SnippetOverrides = {};
  if (c.s !== undefined) out.speed = num(c.s, 'tracks');
  if (c.t !== undefined) out.transpose = num(c.t, 'tracks');
  if (c.v !== undefined) out.vocalReduce = num(c.v, 'tracks');
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
    computedAt: num(c.c, 'tracks'),
  };
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
    updatedAt: num(c.at, 'tracks'),
  };
  if (c.ce !== undefined) track.chordsEnabled = num(c.ce, 'tracks') === 1;
  return track;
}

function decodeEqPreset(raw: unknown): EqPreset {
  const r = arr(raw, 'eqPresets');
  if (r.length < 2 || r.length > 4) throw damaged('eqPresets');
  const preset: EqPreset = {
    name: str(r[0], 'eqPresets'),
    gains: arr(r[1], 'eqPresets').map((g) => num(g, 'eqPresets')),
  };
  if (r.length >= 3) preset.updatedAt = num(r[2], 'eqPresets');
  if (r.length === 4) preset.deleted = true;
  return preset;
}

export function decodeBackup(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT || raw.version !== COMPACT_VERSION) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  const songs = decodeSongs(raw.songs);
  const settings = decodeSettings(raw.s);
  const uiPrefs = decodeUiPrefs(raw.u);
  if (typeof raw.sat === 'number' && Number.isFinite(raw.sat)) settings.updatedAt = raw.sat;
  if (typeof raw.uat === 'number' && Number.isFinite(raw.uat)) uiPrefs.updatedAt = raw.uat;
  return {
    format: BACKUP_FORMAT,
    version: COMPACT_VERSION,
    exportedAt: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    appVersion: '',
    settings,
    uiPrefs,
    history: arr(raw.h, 'history').map((e) => decodeEntry(e, songs, 'history')),
    favorites: arr(raw.f, 'favorites').map((e) => decodeFavorite(e, songs)),
    eqPresets: arr(raw.eq, 'eqPresets').map(decodeEqPreset),
    tracks: arr(raw.t, 'tracks').map((t) => decodeTrack(t, songs)),
  };
}

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
    history: rekeyByIdentity(identifiedArr<HistoryEntry>(raw.history, 'history')),
    favorites: rekeyByIdentity(identifiedArr<FavoriteEntry>(raw.favorites, 'favorites')),
    eqPresets: arr(raw.eqPresets, 'eqPresets') as EqPreset[],
    tracks: rekeyByIdentity(identifiedArr<TrackData>(raw.tracks, 'tracks')),
  };
}

export function parseBackupJson(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > COMPACT_VERSION) {
    throw new Error('That backup was made by a newer version of Note by Note.');
  }
  if (version === COMPACT_VERSION) return decodeBackup(raw);
  if (version === BACKUP_VERSION) return normalizeV1(raw);
  // Only 2 lands here, and only from the branch this format grew on.
  throw new Error('That backup is in a format this version of Note by Note no longer reads.');
}
