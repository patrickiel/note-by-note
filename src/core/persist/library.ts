import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS, HISTORY_LIMIT } from '../model/defaults.ts';
import type { ChordChart, EffectParams, FavoriteEntry, HistoryEntry, Settings, TrackData, TrackIdentity, UiPrefs } from '../model/types';

/** One revision per independently editable value. Null/false are durable deletions. */
export interface Versioned<T> { at: number; value: T }
export interface Practice extends Omit<TrackData, 'updatedAt' | 'chordChart'> {
  params?: EffectParams;
  pageUrl: string;
  thumbnailUrl?: string;
}
export interface SavedSong {
  practice: Versioned<Practice | null>;
  favorite: Versioned<boolean>;
}
export interface SharedLibrary {
  settings: Versioned<Settings>;
  songs: Record<string, SavedSong>;
  presets: Record<string, Versioned<number[] | null>>;
  favoriteOrder: Versioned<string[]>;
}
export interface Library {
  shared: SharedLibrary;
  local: {
    uiPrefs: UiPrefs;
    recent: Record<string, { updatedAt: number; lastAccessedAt: number }>;
    charts: Record<string, ChordChart | null>;
    lastUsedParams?: EffectParams;
  };
}

export const cell = <T>(value: T, at = 0): Versioned<T> => ({ at, value });
export function emptyLibrary(): Library {
  return {
    shared: { settings: cell(structuredClone(DEFAULT_SETTINGS)), songs: {}, presets: {}, favoriteOrder: cell([]) },
    local: { uiPrefs: structuredClone(DEFAULT_UI_PREFS), recent: {}, charts: {} },
  };
}

/** Stable comparison for equal revisions; also the JSON form used on the wire. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function newest<T>(a: Versioned<T>, b: Versioned<T>): Versioned<T> {
  if (a.at === b.at) {
    const deleted = (value: T) => value === null || value === false;
    if (deleted(a.value) !== deleted(b.value)) return deleted(a.value) ? a : b;
  }
  return a.at > b.at || (a.at === b.at && canonical(a.value) >= canonical(b.value)) ? a : b;
}
function mergeMap<T>(a: Record<string, T>, b: Record<string, T>, merge: (a: T, b: T) => T) {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .map((key) => [key, Object.hasOwn(a, key) && Object.hasOwn(b, key) ? merge(a[key], b[key]) : Object.hasOwn(a, key) ? a[key] : b[key]]));
}
export function mergeShared(a: SharedLibrary, b: SharedLibrary): SharedLibrary {
  return {
    settings: newest(a.settings, b.settings),
    songs: mergeMap(a.songs, b.songs, (x, y) => ({
      practice: newest(x.practice, y.practice), favorite: newest(x.favorite, y.favorite),
    })),
    presets: mergeMap(a.presets, b.presets, newest),
    favoriteOrder: newest(a.favoriteOrder, b.favoriteOrder),
  };
}
/** Every local edit follows all revisions this installation has observed. */
export function nextRevision(shared: SharedLibrary, now = Date.now()): number {
  let at = Math.max(now, shared.settings.at, shared.favoriteOrder.at);
  for (const song of Object.values(shared.songs)) at = Math.max(at, song.practice.at, song.favorite.at);
  for (const preset of Object.values(shared.presets)) at = Math.max(at, preset.at);
  return at + 1;
}

export type LibraryCommand =
  | { type: 'practice'; identity: TrackIdentity; patch: Partial<Practice>; recent: boolean }
  | { type: 'favorite'; key: string; value: boolean }
  | { type: 'order'; keys: string[] }
  | { type: 'visit'; key: string }
  | { type: 'recent.remove'; key?: string }
  | { type: 'chart'; key: string; chart: ChordChart | null }
  | { type: 'settings'; patch: Partial<Settings>; reset?: boolean }
  | { type: 'uiPrefs'; value: UiPrefs }
  | { type: 'preset'; name: string; gains: number[] | null }
  | { type: 'import'; library: Library };

/** Called only by the background writer. Incoming edits patch current saved data. */
export function applyCommand(library: Library, command: LibraryCommand, now = Date.now()): Library {
  const next = structuredClone(library);
  const { shared, local } = next;
  const at = nextRevision(shared, now);
  switch (command.type) {
    case 'practice': {
      const key = command.identity.key;
      const song = shared.songs[key] ?? { practice: cell<Practice | null>(null), favorite: cell(false) };
      const base: Practice = song.practice.value ?? {
        identity: command.identity, pageUrl: command.identity.normalizedUrl,
        markers: [], snippets: [], sequenceLoop: false, sequenceCountIn: false,
      };
      song.practice = cell({ ...base, ...command.patch, identity: command.identity }, at);
      shared.songs[key] = song;
      if (command.recent || local.recent[key]) local.recent[key] = { updatedAt: now, lastAccessedAt: now };
      const keep = Object.entries(local.recent).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, HISTORY_LIMIT);
      local.recent = Object.fromEntries(keep);
      break;
    }
    case 'favorite': {
      const song = shared.songs[command.key];
      if (!song?.practice.value) break;
      song.favorite = cell(command.value, at);
      if (command.value) shared.favoriteOrder = cell([command.key, ...shared.favoriteOrder.value.filter((k) => k !== command.key)], at);
      break;
    }
    case 'order': shared.favoriteOrder = cell([...new Set(command.keys)], at); break;
    case 'visit': {
      const recent = local.recent[command.key];
      if (recent) recent.lastAccessedAt = now;
      break;
    }
    case 'recent.remove':
      if (command.key === undefined) local.recent = {};
      else delete local.recent[command.key];
      break;
    case 'chart': local.charts[command.key] = command.chart; break;
    case 'settings': {
      const { lastUsedParams, updatedAt: ignored, ...patch } = command.patch;
      if (lastUsedParams) local.lastUsedParams = lastUsedParams;
      if (command.reset || Object.keys(patch).length) {
        const value = { ...(command.reset ? DEFAULT_SETTINGS : shared.settings.value), ...patch };
        if (patch.rememberSettings) value.autoReset = false;
        if (patch.autoReset) value.rememberSettings = false;
        shared.settings = cell(value, at);
      }
      if (command.reset) delete local.lastUsedParams;
      break;
    }
    case 'uiPrefs': local.uiPrefs = command.value; break;
    case 'preset': Object.defineProperty(shared.presets, command.name, {
      value: cell(command.gains, at), enumerable: true, writable: true, configurable: true,
    }); break;
    case 'import': {
      const file = structuredClone(command.library);
      const revision = Math.max(at, nextRevision(file.shared, now));
      // Replacement names the records this device knows; absence is never a remote delete.
      for (const key of new Set([...Object.keys(shared.songs), ...Object.keys(file.shared.songs)])) {
        const song = file.shared.songs[key];
        shared.songs[key] = { practice: cell(song?.practice.value ?? null, revision), favorite: cell(song?.favorite.value ?? false, revision) };
      }
      for (const name of new Set([...Object.keys(shared.presets), ...Object.keys(file.shared.presets)])) {
        Object.defineProperty(shared.presets, name, { value: cell(Object.hasOwn(file.shared.presets, name) ? file.shared.presets[name].value : null, revision),
          enumerable: true, writable: true, configurable: true });
      }
      shared.settings = cell(file.shared.settings.value, revision);
      shared.favoriteOrder = cell(file.shared.favoriteOrder.value, revision);
      next.local = file.local;
      break;
    }
  }
  return next;
}

/** UI rows are projections. They are never written back as library copies. */
export function songEntry(key: string, library: Library): HistoryEntry | null {
  const song = library.shared.songs[key];
  const practice = song?.practice.value;
  if (!practice) return null;
  return {
    identity: practice.identity, pageUrl: practice.pageUrl, thumbnailUrl: practice.thumbnailUrl,
    params: practice.params ?? structuredClone(DEFAULT_PARAMS),
    createdAt: song.practice.at, updatedAt: library.local.recent[key]?.updatedAt ?? song.practice.at,
  };
}
export function recentEntries(library: Library): HistoryEntry[] {
  return Object.keys(library.local.recent).map((key) => songEntry(key, library))
    .filter((entry) => entry !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function favoriteEntries(library: Library): FavoriteEntry[] {
  const keys = [...new Set([...library.shared.favoriteOrder.value, ...Object.keys(library.shared.songs).sort()])];
  return keys.flatMap((key) => {
    const song = library.shared.songs[key];
    const entry = songEntry(key, library);
    return song?.favorite.value && entry ? [{ ...entry, favoritedAt: song.favorite.at,
      lastAccessedAt: library.local.recent[key]?.lastAccessedAt ?? song.favorite.at }] : [];
  });
}
