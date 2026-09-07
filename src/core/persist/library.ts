import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS, DELETION_LIMIT, HISTORY_LIMIT, SONG_LIMIT } from '../model/defaults.ts';
import type { ChordChart, EffectParams, FavoriteEntry, HistoryEntry, Settings, TrackData, TrackIdentity, UiPrefs } from '../model/types';

/** One revision per independently editable value. Null/false are durable deletions. */
interface Versioned<T> { at: number; value: T }
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
    recent: Record<string, number>;
    lastAccessed: Record<string, number>;
    charts: Record<string, ChordChart | null>;
    lastUsedParams?: EffectParams;
  };
}

export const cell = <T>(value: T, at = 0): Versioned<T> => ({ at, value });
/** Song keys and preset names are user data, so they may spell an object
 * property (`__proto__`, `constructor`). Defining the entry writes the map the
 * plain assignment would only appear to. */
export function defineEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
export function emptyLibrary(): Library {
  return {
    shared: { settings: cell(structuredClone(DEFAULT_SETTINGS)), songs: {}, presets: {}, favoriteOrder: cell([]) },
    local: { uiPrefs: structuredClone(DEFAULT_UI_PREFS), recent: {}, lastAccessed: {}, charts: {} },
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

/** A song is kept while it is favorited, listed in Recent, or among the most
 * recently opened. Anything else becomes a dated deletion so that dropping it
 * crosses devices instead of being merged straight back; the oldest deletions
 * are finally forgotten. Without this every song ever played would stay in
 * `shared.songs` forever and eventually fill the sync quota, after which
 * nothing at all syncs. */
function prune(library: Library, at: number): void {
  const { shared, local } = library;
  const kept = new Set(Object.keys(shared.songs)
    .filter((key) => shared.songs[key].favorite.value || key in local.recent));
  const rest = Object.keys(shared.songs)
    .filter((key) => !kept.has(key) && shared.songs[key].practice.value !== null)
    .sort((a, b) => (local.lastAccessed[b] ?? 0) - (local.lastAccessed[a] ?? 0));
  for (const key of rest.slice(Math.max(0, SONG_LIMIT - kept.size))) {
    defineEntry(shared.songs, key, { practice: cell(null, at), favorite: cell(false, at) });
  }
  const deleted = Object.keys(shared.songs).filter((key) => shared.songs[key].practice.value === null)
    .sort((a, b) => shared.songs[b].practice.at - shared.songs[a].practice.at);
  for (const key of deleted.slice(DELETION_LIMIT)) delete shared.songs[key];
  for (const key of deleted) {
    delete local.recent[key];
    delete local.lastAccessed[key];
    delete local.charts[key];
  }
  // A star that no longer names a saved song only costs sync bytes.
  const order = shared.favoriteOrder.value.filter((key) => shared.songs[key]?.favorite.value);
  if (order.length !== shared.favoriteOrder.value.length) shared.favoriteOrder = cell(order, at);
}

/** Every path that writes the library prunes, not only edits: a merge or a
 * migration can carry in more songs than the sync limits allow, and nothing else
 * would ever bring it back under them. Idempotent — with nothing to drop the
 * result is identical, so it never manufactures a write of its own. */
export function pruned(library: Library, now = Date.now()): Library {
  const next = structuredClone(library);
  prune(next, nextRevision(next.shared, now));
  return next;
}

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
      defineEntry(shared.songs, key, song);
      if (command.recent || key in local.recent) local.recent[key] = now;
      local.lastAccessed[key] = now;
      const keep = Object.entries(local.recent).sort((a, b) => b[1] - a[1]).slice(0, HISTORY_LIMIT);
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
      if (shared.songs[command.key]?.practice.value) local.lastAccessed[command.key] = now;
      break;
    }
    case 'recent.remove': {
      // "Remove from history" is the only delete the UI offers, so it removes
      // the saved song itself. A favorite is kept — its own row only unstars —
      // and falls back to the limit above once it is neither.
      const keys = command.key === undefined ? Object.keys(local.recent) : [command.key];
      for (const key of keys) {
        delete local.recent[key];
        const song = shared.songs[key];
        if (song && !song.favorite.value) song.practice = cell(null, at);
      }
      break;
    }
    case 'chart': local.charts[command.key] = command.chart; break;
    case 'settings': {
      const { lastUsedParams, ...patch } = command.patch;
      if (lastUsedParams) local.lastUsedParams = lastUsedParams;
      if (command.reset || Object.keys(patch).length) {
        const value = { ...(command.reset ? structuredClone(DEFAULT_SETTINGS) : shared.settings.value), ...patch };
        if (patch.rememberSettings) value.autoReset = false;
        if (patch.autoReset) value.rememberSettings = false;
        shared.settings = cell(value, at);
      }
      if (command.reset) delete local.lastUsedParams;
      break;
    }
    case 'uiPrefs': local.uiPrefs = command.value; break;
    case 'preset': defineEntry(shared.presets, command.name, cell(command.gains, at)); break;
    case 'import': {
      const file = structuredClone(command.library);
      const revision = Math.max(at, nextRevision(file.shared, now));
      // Replacement names the records this device knows; absence is never a remote delete.
      for (const key of new Set([...Object.keys(shared.songs), ...Object.keys(file.shared.songs)])) {
        const song = file.shared.songs[key];
        defineEntry(shared.songs, key, { practice: cell(song?.practice.value ?? null, revision), favorite: cell(song?.favorite.value ?? false, revision) });
      }
      for (const name of new Set([...Object.keys(shared.presets), ...Object.keys(file.shared.presets)])) {
        defineEntry(shared.presets, name,
          cell(Object.hasOwn(file.shared.presets, name) ? file.shared.presets[name].value : null, revision));
      }
      shared.settings = cell(file.shared.settings.value, revision);
      shared.favoriteOrder = cell(file.shared.favoriteOrder.value, revision);
      next.local = file.local;
      break;
    }
  }
  prune(next, at);
  return next;
}

/** UI rows are projections. They are never written back as library copies. */
function songEntry(key: string, library: Library): HistoryEntry | null {
  const song = library.shared.songs[key];
  const practice = song?.practice.value;
  if (!practice) return null;
  return {
    identity: practice.identity, pageUrl: practice.pageUrl, thumbnailUrl: practice.thumbnailUrl,
    params: practice.params ?? structuredClone(DEFAULT_PARAMS),
    updatedAt: library.local.recent[key] ?? song.practice.at,
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
      lastAccessedAt: library.local.lastAccessed[key] ?? song.favorite.at }] : [];
  });
}
