import { DEFAULT_PARAMS, DEFAULT_SETTINGS, DEFAULT_UI_PREFS, HISTORY_LIMIT } from '../model/defaults.ts';
import type { ChordChart, EffectParams, FavoriteEntry, HistoryEntry, Settings, TrackData, TrackIdentity, UiPrefs } from '../model/types';

export interface Practice extends Omit<TrackData, 'chordChart'> {
  params?: EffectParams;
  pageUrl: string;
  thumbnailUrl?: string;
}
export interface SavedSong {
  practice: Practice;
  /** Display metadata, not a sync revision. Null means not favorited. */
  favoritedAt: number | null;
}
/** The same snapshot is saved locally and sent to browser sync. */
export interface SharedLibrary {
  updatedAt: number;
  settings: Settings;
  songs: Record<string, SavedSong>;
  presets: Record<string, number[]>;
  favoriteOrder: string[];
}
export interface Library {
  shared: SharedLibrary;
  local: {
    uiPrefs: UiPrefs;
    recent: Record<string, number>;
    lastAccessed: Record<string, number>;
    charts: Record<string, ChordChart | null>;
    lastUsedParams?: EffectParams;
    /** Invalidates edits from sessions opened before a replacement import. */
    importRevision?: number;
  };
}

/** Preset names may spell object properties such as __proto__. */
export function defineEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
export function emptyLibrary(): Library {
  return {
    shared: { updatedAt: 0, settings: structuredClone(DEFAULT_SETTINGS), songs: {}, presets: {}, favoriteOrder: [] },
    local: { uiPrefs: structuredClone(DEFAULT_UI_PREFS), recent: {}, lastAccessed: {}, charts: {} },
  };
}

/** One winner for the entire library. On equal timestamps the synced copy wins. */
export function newestSnapshot(local: SharedLibrary, remote: SharedLibrary): SharedLibrary {
  if (local.updatedAt === remote.updatedAt && JSON.stringify(local) === JSON.stringify(remote)) return local;
  return local.updatedAt > remote.updatedAt ? local : remote;
}

export type UiPrefsPatch = {
  [K in keyof UiPrefs]?: UiPrefs[K] extends object ? Partial<UiPrefs[K]> : UiPrefs[K];
};

/** Shared with the panel, which shows a preference before the writer confirms it. */
export function mergeUiPrefs(current: UiPrefs, patch: UiPrefsPatch): UiPrefs {
  return {
    ...current, ...patch,
    collapsed: { ...current.collapsed, ...patch.collapsed },
    collapsedSections: { ...current.collapsedSections, ...patch.collapsedSections },
    boundaryLabels: { ...current.boundaryLabels, ...patch.boundaryLabels },
  };
}

export type LibraryCommand =
  | { type: 'practice'; identity: TrackIdentity; patch: Partial<Practice>; recent: boolean; importRevision?: number }
  | { type: 'favorite'; key: string; value: boolean }
  | { type: 'order'; keys: string[] }
  | { type: 'visit'; key: string }
  | { type: 'recent.remove'; key?: string }
  | { type: 'chart'; key: string; chart: ChordChart | null; importRevision?: number }
  | { type: 'settings'; patch: Partial<Settings>; reset?: boolean; importRevision?: number }
  | { type: 'uiPrefs'; patch: UiPrefsPatch }
  | { type: 'preset'; name: string; gains: number[] | null }
  | { type: 'import'; library: Library };

/** Only the background writes. Commands from panels patch the current snapshot. */
export function applyCommand(library: Library, command: LibraryCommand, now = Date.now()): Library {
  if ((command.type === 'practice' || command.type === 'chart'
    || (command.type === 'settings' && command.importRevision !== undefined))
    && (command.importRevision ?? 0) !== (library.local.importRevision ?? 0)) {
    throw new Error('A backup was imported. Reload the song before saving more practice edits.');
  }
  const next = structuredClone(command.type === 'import' ? command.library : library);
  const { shared, local } = next;
  switch (command.type) {
    case 'import': local.importRevision = (library.local.importRevision ?? 0) + 1; break;
    case 'practice': {
      const key = command.identity.key;
      const song = shared.songs[key] ?? { practice: {
        identity: command.identity, pageUrl: command.identity.normalizedUrl, updatedAt: now,
        markers: [], snippets: [], sequenceLoop: false, sequenceCountIn: false,
      }, favoritedAt: null };
      song.practice = { ...song.practice, ...command.patch, identity: command.identity, updatedAt: now };
      defineEntry(shared.songs, key, song);
      if (command.recent || key in local.recent) local.recent[key] = now;
      local.lastAccessed[key] = now;
      local.recent = Object.fromEntries(Object.entries(local.recent).sort((a, b) => b[1] - a[1]).slice(0, HISTORY_LIMIT));
      break;
    }
    case 'favorite': {
      const song = shared.songs[command.key];
      if (!song) {
        if (command.value) throw new Error('This song is no longer in the library. Save it before adding it to Favorites.');
        break;
      }
      song.favoritedAt = command.value ? now : null;
      shared.favoriteOrder = shared.favoriteOrder.filter((key) => key !== command.key);
      if (command.value) shared.favoriteOrder.unshift(command.key);
      break;
    }
    case 'order': shared.favoriteOrder = [...new Set(command.keys)].filter((key) => shared.songs[key]?.favoritedAt != null); break;
    case 'visit': {
      if (shared.songs[command.key]) local.lastAccessed[command.key] = now;
      break;
    }
    case 'recent.remove': {
      // Clearing history also forgets songs no list can reach: ones pushed past
      // HISTORY_LIMIT, and ones saved while Auto Save was off.
      const keys = command.key === undefined
        ? [...new Set([...Object.keys(local.recent), ...Object.keys(shared.songs)])]
        : [command.key];
      for (const key of keys) {
        delete local.recent[key];
        if (shared.songs[key]?.favoritedAt != null) continue;
        delete shared.songs[key];
        delete local.lastAccessed[key];
        delete local.charts[key];
      }
      break;
    }
    case 'chart': local.charts[command.key] = command.chart; break;
    case 'settings': {
      const { lastUsedParams, ...patch } = command.patch;
      if (lastUsedParams) local.lastUsedParams = lastUsedParams;
      shared.settings = { ...(command.reset ? structuredClone(DEFAULT_SETTINGS) : shared.settings), ...patch };
      if (patch.rememberSettings) shared.settings.autoReset = false;
      if (patch.autoReset) shared.settings.rememberSettings = false;
      if (command.reset) delete local.lastUsedParams;
      break;
    }
    case 'uiPrefs': local.uiPrefs = mergeUiPrefs(local.uiPrefs, command.patch); break;
    case 'preset': {
      if (command.gains === null) delete shared.presets[command.name];
      else defineEntry(shared.presets, command.name, command.gains);
      break;
    }
  }
  // Local activity never makes an older shared snapshot win. Imports are an
  // explicit replacement, even when the file happens to contain the same data.
  if (command.type === 'import' || JSON.stringify(shared) !== JSON.stringify(library.shared)) {
    shared.updatedAt = Math.max(now, library.shared.updatedAt + 1, shared.updatedAt + 1);
  }
  return next;
}

/** UI rows are projections. They are never written back as library copies. */
function songEntry(key: string, library: Library): HistoryEntry | null {
  const practice = library.shared.songs[key]?.practice;
  if (!practice) return null;
  return {
    identity: practice.identity, pageUrl: practice.pageUrl, thumbnailUrl: practice.thumbnailUrl,
    params: practice.params ?? structuredClone(DEFAULT_PARAMS),
    updatedAt: library.local.recent[key] ?? practice.updatedAt,
  };
}
export function recentEntries(library: Library): HistoryEntry[] {
  return Object.keys(library.local.recent).map((key) => songEntry(key, library))
    .filter((entry) => entry !== null).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function favoriteEntries(library: Library): FavoriteEntry[] {
  const keys = [...new Set([...library.shared.favoriteOrder, ...Object.keys(library.shared.songs).sort()])];
  return keys.flatMap((key) => {
    const song = library.shared.songs[key];
    const entry = songEntry(key, library);
    return song?.favoritedAt != null && entry ? [{ ...entry, favoritedAt: song.favoritedAt,
      lastAccessedAt: library.local.lastAccessed[key] ?? song.favoritedAt }] : [];
  });
}
