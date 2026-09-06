import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults.ts';
import type {
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  Settings,
  TrackData,
  UiPrefs,
} from '../model/types.ts';
import { normalizeDeletions, type Deletions } from './deletions.ts';

/** The backup file's shape and validation, kept free of storage/`#imports` so
 * the sync codec (and its `node --test` suite) can share it with `backup.ts`.
 * Relative `.ts` imports for the same reason — see CLAUDE.md. */

/** Marks a file as ours, so a stray JSON can be rejected on sight. */
export const BACKUP_FORMAT = 'note-by-note-backup';

/** Bump only for changes older files can't be read as; `normalizeBackup`
 * accepts anything up to this and backfills what a lower version lacked. */
export const BACKUP_VERSION = 1;

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
  /** What was deleted and when — carried so sync can tell a deletion from
   * an item left out to fit. Files from older builds lack it (backfilled). */
  deletions: Deletions;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (!keyed) throw new Error(`This backup's "${field}" list is damaged.`);
  return list as T[];
}

/**
 * Validates parsed JSON into a `Backup`, or throws an `Error` whose message is
 * safe to show the user. Objects are backfilled from the defaults so a file
 * from an older build gains any setting added since.
 */
export function normalizeBackup(raw: unknown): Backup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) {
    throw new Error('That backup was made by a newer version of Note by Note.');
  }
  return {
    format: BACKUP_FORMAT,
    version: raw.version,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    settings: { ...DEFAULT_SETTINGS, ...(isRecord(raw.settings) ? raw.settings : {}) },
    uiPrefs: {
      ...structuredClone(DEFAULT_UI_PREFS),
      ...(isRecord(raw.uiPrefs) ? raw.uiPrefs : {}),
    },
    history: requireKeyedArray<HistoryEntry>(raw.history, 'history'),
    favorites: requireKeyedArray<FavoriteEntry>(raw.favorites, 'favorites'),
    eqPresets: requireArray(raw.eqPresets, 'eqPresets') as EqPreset[],
    tracks: requireKeyedArray<TrackData>(raw.tracks, 'tracks'),
    deletions: normalizeDeletions(raw.deletions),
  };
}
