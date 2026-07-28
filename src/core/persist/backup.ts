import { DEFAULT_SETTINGS, DEFAULT_UI_PREFS } from '../model/defaults';
import type {
  EqPreset,
  FavoriteEntry,
  HistoryEntry,
  Settings,
  TrackData,
  UiPrefs,
} from '../model/types';
import {
  eqPresetsItem,
  favoritesItem,
  historyItem,
  removeAllTrackData,
  saveTrackData,
  settingsItem,
  uiPrefsItem,
} from './storage';

/** Marks a file as ours, so a stray JSON can be rejected on sight. */
const FORMAT = 'note-by-note-backup';

/** Bump only for changes older files can't be read as; `parseBackup` accepts
 * anything up to this and backfills what a lower version lacked. */
const VERSION = 1;

/** Everything a user owns, in one file. Host permissions are deliberately out:
 * they live in the browser's permission store, and only a prompt can grant
 * them — a backup that listed origins would restore access it can't give. */
export interface Backup {
  format: typeof FORMAT;
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

/** Raw storage keys have no `local:` prefix — see `trackDataKey`. */
async function loadAllTrackData(): Promise<TrackData[]> {
  const snapshot = await browser.storage.local.get(null);
  return Object.entries(snapshot)
    .filter(([key]) => key.startsWith('track:'))
    .map(([, value]) => value as TrackData);
}

export async function createBackup(): Promise<Backup> {
  const [settings, uiPrefs, history, favorites, eqPresets, tracks] =
    await Promise.all([
      settingsItem.getValue(),
      uiPrefsItem.getValue(),
      historyItem.getValue(),
      favoritesItem.getValue(),
      eqPresetsItem.getValue(),
      loadAllTrackData(),
    ]);
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    appVersion: browser.runtime.getManifest().version,
    settings,
    uiPrefs,
    history,
    favorites,
    eqPresets,
    tracks,
  };
}

/** Suggested download name, e.g. `note-by-note-backup-2026-07-17.json`. */
export function backupFilename(exportedAt: number): string {
  const day = new Date(exportedAt).toISOString().slice(0, 10);
  return `note-by-note-backup-${day}.json`;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`This backup's "${field}" list is missing or damaged.`);
  }
  return value;
}

/** Entries are keyed by `identity.key`; without one they can't be stored or
 * matched back to a track, so a file carrying them is not usable. */
function requireKeyedArray<T>(value: unknown, field: string): T[] {
  const list = requireArray(value, field);
  const keyed = list.every(
    (e) => isRecord(e) && isRecord(e.identity) && typeof e.identity.key === 'string',
  );
  if (!keyed) throw new Error(`This backup's "${field}" list is damaged.`);
  return list as T[];
}

/**
 * Reads a backup file's text into a `Backup`, or throws an `Error` whose
 * message is safe to show the user. Objects are backfilled from the defaults
 * so a file from an older build gains any setting added since.
 */
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isRecord(raw) || raw.format !== FORMAT) {
    throw new Error("That file isn't a Note by Note backup.");
  }
  if (typeof raw.version !== 'number' || raw.version > VERSION) {
    throw new Error('That backup was made by a newer version of Note by Note.');
  }
  return {
    format: FORMAT,
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
  };
}

/**
 * Replaces every stored value with the backup's, dropping data the file does
 * not carry — a restore reproduces the machine it came from rather than
 * merging into whatever is here. Host permissions are left untouched.
 */
export async function restoreBackup(backup: Backup): Promise<void> {
  await removeAllTrackData();
  await Promise.all([
    settingsItem.setValue(backup.settings),
    uiPrefsItem.setValue(backup.uiPrefs),
    historyItem.setValue(backup.history),
    favoritesItem.setValue(backup.favorites),
    eqPresetsItem.setValue(backup.eqPresets),
    ...backup.tracks.map(saveTrackData),
  ]);
}
